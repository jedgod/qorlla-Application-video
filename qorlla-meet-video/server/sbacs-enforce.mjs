// Meet's SBACS enforcement points. A valid subscription is NECESSARY, NEVER SUFFICIENT: every check here runs AFTER Meet's own authentication, meeting membership, host-only rules and
// recording-consent state machine, and never replaces them.
//
// POLICY (documented, tested):
//   * New protected operations - creating a meeting, requesting or starting a recording, accepting the first bytes of a recording block - need an entitlement and, where metered, a reservation.
//   * When SBACS_MODE=enforce and the entitlement service is unreachable, a NEW protected operation FAILS CLOSED (503, retryable). It is never allowed "because we could not ask".
//   * Already-authorised work is not cut off by a subscription change or an outage: a meeting in progress is never interrupted (nothing here runs per participant or per message), and a recording
//     that was authorised at its start keeps being stored. Media accepted while the service says no (suspended / not in plan) or cannot answer is written to the settlement outbox and recorded later
//     under the same stable operation key, within a bounded grace per recording (SBACS_GRACE_MIB). Beyond the grace the chunk is refused (the recorder finalises what was received).
//   * A QUOTA ceiling is different: when storage is exhausted new media is refused at once ('storage_quota_reached'); content already stored is untouched.
//   * Recording CONSENT is independent: nothing here can start, skip or satisfy a consent step.
//   * With no host account on the meeting the work cannot be attributed to a plan, so in enforce mode it is refused ('no_account').
import { createSbacsClient } from './sbacs-client.mjs';

const MIB = 1024 * 1024;

// a PEM can be given directly (SBACS_<SERVICE>_PRIVATE_KEY_PEM) or base64-encoded (..._B64), which is what a container env file can carry
const keyOf = (pem, b64) => pem || (b64 ? Buffer.from(b64, 'base64').toString('utf8') : '');

export function sbacsFromEnv(env, db, log = (lvl, msg, o) => (lvl === 'error' ? console.error : console.log)('[sbacs]', msg, JSON.stringify(o || {}))) {
  const mode = String(env.SBACS_MODE || 'off').toLowerCase();
  if (mode === 'off') return createEnforcement({ mode, db, log });
  const common = { mode, baseUrl: env.SBACS_URL || '', audience: env.SBACS_AUDIENCE || undefined, timeoutMs: Number(env.SBACS_TIMEOUT_MS) || 2500, log };
  return createEnforcement({ mode, db, log, graceMib: Number(env.SBACS_GRACE_MIB) >= 0 && env.SBACS_GRACE_MIB !== undefined ? Number(env.SBACS_GRACE_MIB) : 64,
    meetClient: createSbacsClient({ ...common, service: 'meet', privateKeyPem: keyOf(env.SBACS_MEET_PRIVATE_KEY_PEM, env.SBACS_MEET_PRIVATE_KEY_B64) }),
    storageClient: createSbacsClient({ ...common, service: 'storage', privateKeyPem: keyOf(env.SBACS_STORAGE_PRIVATE_KEY_PEM, env.SBACS_STORAGE_PRIVATE_KEY_B64) }) });   // throws at start-up if enforce/shadow is mis-configured
}

export function createEnforcement({ mode = 'off', db, meetClient = null, storageClient = null, graceMib = 64, log = () => {}, now = () => Date.now() }) {
  const active = mode !== 'off' && !!meetClient && !!storageClient;
  const clientFor = (feature) => (feature.startsWith('storage.') ? storageClient : meetClient);
  const refusal = (r) => (r.kind === 'unavailable'
    ? { status: 503, body: { error: 'entitlement_service_unavailable', retryable: true } }
    : { status: 403, body: { error: 'subscription_access_denied', reason: r.reason || 'denied', ...(r.upgradeAvailable ? { upgradeAvailable: true } : {}) } });
  const accountOf = async (meetingId) => (await db.query('SELECT host_account_id FROM meetings WHERE id=$1', [meetingId])).rows[0]?.host_account_id || null;

  /** Entitlement check only (no reservation). `accountId` is the meeting host's main-app account. */
  async function gate(feature, accountId) {
    if (!active) return { ok: true };
    if (!accountId) return { ok: false, ...refusal({ kind: 'denied', reason: 'no_account' }) };
    const r = await meetClient.check({ accountId, feature });
    return r.ok ? { ok: true } : { ok: false, ...refusal(r) };
  }
  const gateMeeting = async (feature, meetingId) => (active ? gate(feature, await accountOf(meetingId)) : { ok: true });

  // ---- settlement outbox ---------------------------------------------------------------------------------------------------------------------------------------
  async function outbox({ opKey, kind, accountId, feature, units, reservationId = null, meetingId = null, recordingId = null, error = null }) {
    await db.query(`INSERT INTO sbacs_outbox(op_key, kind, account_id, feature, units, reservation_id, meeting_id, recording_id, last_error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (op_key) DO UPDATE SET kind = CASE WHEN sbacs_outbox.settled_at IS NULL THEN EXCLUDED.kind ELSE sbacs_outbox.kind END, reservation_id = COALESCE(EXCLUDED.reservation_id, sbacs_outbox.reservation_id)`,
      [opKey, kind, accountId, feature, units, reservationId, meetingId, recordingId, error]);
  }
  /** Settle what could not be settled earlier. Safe to call concurrently and repeatedly: every operation is idempotent by its key. Stops at the first sign the service is still down. */
  async function drain(limit = 50) {
    if (!active) return { settled: 0 };
    const rows = (await db.query('SELECT * FROM sbacs_outbox WHERE settled_at IS NULL ORDER BY created_at LIMIT $1', [limit])).rows; let settled = 0;
    for (const o of rows) {
      const c = clientFor(o.feature);
      const r = o.kind === 'record' ? await c.record({ accountId: o.account_id, feature: o.feature, units: o.units, idempotencyKey: o.op_key })
        : o.kind === 'finalize' ? await c.finalize({ accountId: o.account_id, reservationId: o.reservation_id }) : await c.release({ accountId: o.account_id, reservationId: o.reservation_id });
      if (r.ok) { await db.query('UPDATE sbacs_outbox SET settled_at=now(), attempts=attempts+1, last_error=NULL WHERE op_key=$1', [o.op_key]); settled++; continue; }
      if (r.kind === 'unavailable') { await db.query('UPDATE sbacs_outbox SET attempts=attempts+1, last_error=$2 WHERE op_key=$1', [o.op_key, r.reason]); break; }
      // a refusal that will never change (not a member any more, unknown reservation): stop retrying after a while, keep the row as evidence
      await db.query(`UPDATE sbacs_outbox SET attempts=attempts+1, last_error=$2, settled_at = CASE WHEN attempts >= 9 THEN now() ELSE NULL END WHERE op_key=$1`, [o.op_key, r.reason || r.kind]);
    }
    return { settled };
  }
  async function settle(kind, t) {   // finalize | release a reservation; if the service cannot be reached, remember to do it later
    const r = await clientFor(t.feature)[kind]({ accountId: t.accountId, reservationId: t.reservationId });
    if (!r.ok && r.kind === 'unavailable') await outbox({ opKey: t.opKey, kind, accountId: t.accountId, feature: t.feature, units: t.units, reservationId: t.reservationId, meetingId: t.meetingId, recordingId: t.recordingId, error: r.reason });
    return r;
  }

  // ---- recording initiation: the entitlement, then ONE metered recording per started session ---------------------------------------------------------------------
  async function beginRecording(meetingId, sessionId) {
    if (!active) return { ok: true, ticket: null };
    const accountId = await accountOf(meetingId); if (!accountId) return { ok: false, ...refusal({ kind: 'denied', reason: 'no_account' }) };
    const r = await meetClient.reserve({ accountId, feature: 'meet.recording', units: 1, idempotencyKey: 'recstart:' + sessionId });
    if (!r.ok) return { ok: false, ...refusal(r) };
    return { ok: true, ticket: r.reservationId ? { feature: 'meet.recording', accountId, reservationId: r.reservationId, opKey: 'recstart:' + sessionId, units: 1, meetingId } : null };
  }
  const endRecording = async (ticket, started) => (ticket ? settle(started ? 'finalize' : 'release', ticket) : null);

  // ---- storage: reserve before accepting bytes, finalize once durably stored, release after a verified failure ---------------------------------------------------
  const deferredMib = async (recordingId) => Number((await db.query(`SELECT COALESCE(sum(units),0) AS n FROM sbacs_outbox WHERE recording_id=$1 AND kind='record' AND settled_at IS NULL`, [recordingId])).rows[0].n);
  /** Accounting unit = MiB blocks: a chunk is charged for the blocks it newly crosses, so the total always equals ceil(bytes / 1 MiB) whatever the chunking, and a retry of a chunk has the same key and units. */
  async function beforeChunk({ meetingId, recordingId, seq, bytesBefore, size }) {
    if (!active) return { ok: true, ticket: null };
    const accountId = await accountOf(meetingId); if (!accountId) return { ok: false, ...refusal({ kind: 'denied', reason: 'no_account' }) };
    const units = Math.ceil((bytesBefore + size) / MIB) - Math.ceil(bytesBefore / MIB);
    if (units <= 0) return { ok: true, ticket: null };
    const opKey = `chunk:${recordingId}:${seq}`, base = { feature: 'storage.mb', accountId, opKey, units, meetingId, recordingId };
    const r = await storageClient.reserve({ accountId, feature: 'storage.mb', units, idempotencyKey: opKey });
    if (r.ok) return { ok: true, ticket: r.reservationId ? { ...base, reservationId: r.reservationId } : null };
    if (r.kind === 'quota') return { ok: false, status: 403, body: { error: 'storage_quota_reached', reason: 'quota_exhausted', ...(r.upgradeAvailable ? { upgradeAvailable: true } : {}) } };
    // the recording was authorised when it started: keep accepting media for a bounded grace and record it afterwards (idempotently); beyond the grace, refuse
    if ((await deferredMib(recordingId)) + units <= graceMib) { log('info', 'sbacs.chunk_deferred', { recordingId, seq, units, why: r.reason || r.kind }); return { ok: true, ticket: { ...base, deferred: true } }; }
    return { ok: false, ...refusal(r) };
  }
  async function afterChunk(ticket, stored) {
    if (!ticket) return;
    if (ticket.deferred) { if (stored) await outbox({ opKey: ticket.opKey, kind: 'record', accountId: ticket.accountId, feature: ticket.feature, units: ticket.units, meetingId: ticket.meetingId, recordingId: ticket.recordingId, error: 'deferred' }); return; }
    await settle(stored ? 'finalize' : 'release', ticket);
  }
  return { mode, active, gate, gateMeeting, beginRecording, endRecording, beforeChunk, afterChunk, drain, accountOf, outboxOpen: async () => Number((await db.query('SELECT count(*)::int n FROM sbacs_outbox WHERE settled_at IS NULL')).rows[0].n) };
}
