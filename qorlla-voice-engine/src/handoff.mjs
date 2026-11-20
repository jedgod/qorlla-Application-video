// Phone -> Meeting hand-off authority (v2.2). The server, not either page, decides when the phone call ends.
//
//   start     initiator: call live, member; Shield asked; a single-use token is stored (hash only) in voice_handoffs; one open hand-off per call (partial unique index).
//   accept    recipient: ONE atomic UPDATE consumes the token (pending -> accepted); the Shield is asked again; each side receives its own readiness nonce.
//   ready     each side, from inside the Meet session: {nonce, meetingId, sessionId, inboundAudioBytes}. Evidence is accepted only when it is bound to THIS hand-off
//             (nonce), THIS meeting, ONE Meet session (it cannot change), plausibly timed, and shows audio GROWING between two reports that the server itself received >= 1 s apart.
//   complete  either side may ask, as often as it likes (idempotent): only when BOTH sides' evidence is fresh (<= FRESH_MS old, by the server's clock), the call is still live,
//             the deadline has not passed and the Shield still allows the pair does the server end the phone call (reason moved_to_meeting), exactly once.
//   cancel / expiry never touch the call; clients restore their microphones when they see the state change.
// Everything is in PostgreSQL: a restart or a second engine instance sees the same state. A crash between "completing" and "completed" is finished by the next call.
// Honest limit: the byte counts are measured by the client inside Meet; the server verifies freshness, binding and growth over time, not the media itself.
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';

const MEETING_ID = /^[0-9][0-9 ]{8,14}[0-9]$/;
const sha = (t) => createHash('sha256').update(String(t)).digest('hex');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const OPEN = ['pending', 'accepted', 'completing'];

export function createHandoff({ store, shield, enforce, requireShield = false, ttlMs = 60000, releaseWindowMs = 120000, freshMs = 10000, minGapMs = 1000, minGrowth = 200, now = () => Date.now(), maxPerMinute = 12, secret = randomBytes(32).toString('hex'), acceptBrowserEvidence = false }) {
  const hits = new Map();
  const deny = (reason, status = 403) => Object.assign(new Error('move_denied'), { code: 'move_denied', status, reason });
  const record = async (actor, decision, reason, ctx) => { try { await shield?.recordEvent?.(actor, 'move.transition', decision, reason, ctx || {}); } catch { /* auditing must never break a call */ } };
  const busy = (key, max = maxPerMinute) => { const t = now(), h = hits.get(key); if (!h || t - h.s > 60000) { hits.set(key, { s: t, n: 1 }); return false; } return ++h.n > max; };   // readiness reports come about once a second, so they get a roomier allowance
  const guard = async (c, a, b) => { if (enforce) await shield.callGuard(c, a, b); };
  const iso = (ms) => new Date(ms).toISOString();
  const nonceFor = (h, role) => createHmac('sha256', secret).update('handoff-nonce:' + h.id + ':' + role + ':' + h.token_hash).digest('base64url');

  /** Closes anything open on this call that can no longer succeed. Returns the (possibly updated) open row, or null. Runs inside the caller's transaction. */
  async function settle(c, callId) {
    const t = iso(now());
    await c.query("UPDATE voice_handoffs SET status='expired', closed_reason='token_expired', version=version+1 WHERE call_id=$1 AND status='pending' AND expires_at <= $2", [callId, t]);
    await c.query("UPDATE voice_handoffs SET status='expired', closed_reason='release_deadline_passed', version=version+1 WHERE call_id=$1 AND status='accepted' AND release_deadline <= $2", [callId, t]);
    const call = (await c.query('SELECT status, end_reason FROM voice_calls WHERE id=$1', [callId])).rows[0];
    if (!call || call.status !== 'active') {
      if (call && call.end_reason === 'moved_to_meeting') await c.query("UPDATE voice_handoffs SET status='completed', completed_at=COALESCE(completed_at, $2), version=version+1 WHERE call_id=$1 AND status='completing'", [callId, t]);   // crash recovery: the call was ended, the row was not yet marked
      await c.query("UPDATE voice_handoffs SET status='cancelled', closed_reason='call_ended', version=version+1 WHERE call_id=$1 AND status IN ('pending','accepted','completing')", [callId]);
    }
    return (await c.query("SELECT * FROM voice_handoffs WHERE call_id=$1 AND status = ANY($2) ", [callId, OPEN])).rows[0] || null;
  }
  async function member(c, account, callId) {
    const call = (await c.query('SELECT id, caller_id, callee_id, status FROM voice_calls WHERE id=$1', [callId])).rows[0];
    if (!call || ![call.caller_id, call.callee_id].includes(account)) throw deny('NOT_A_PARTICIPANT');
    if (call.status !== 'active') throw deny('CALL_NOT_ACTIVE', 409);
    return { call, peer: call.caller_id === account ? call.callee_id : call.caller_id };
  }
  const view = (h, account) => {
    if (!h) return { state: 'none' };
    const me = h.initiator_id === account ? 'initiator' : 'recipient', ready = (k) => !!(h[k + '_ready_at'] && now() - new Date(h[k + '_ready_at']).getTime() <= freshMs);
    return { state: h.status, role: me, meetingId: h.status === 'pending' && me === 'recipient' ? undefined : h.meeting_id, closedReason: h.closed_reason || null,
      msLeft: h.status === 'accepted' ? Math.max(0, new Date(h.release_deadline).getTime() - now()) : h.status === 'pending' ? Math.max(0, new Date(h.expires_at).getTime() - now()) : 0,
      you: me === 'initiator' ? { ready: ready('init') } : { ready: ready('recip') }, peer: me === 'initiator' ? { ready: ready('recip') } : { ready: ready('init') } };
  };

  async function start(account, callId, meetingId) {
    if (typeof meetingId !== 'string' || !MEETING_ID.test(meetingId)) throw deny('INVALID_MEETING', 400);
    if (busy(account)) throw deny('RATE_LIMITED', 429);
    if (requireShield && !enforce) { await record(account, 'DENY', 'SHIELD_REQUIRED_BUT_OFF', { callId }); throw Object.assign(deny('SHIELD_UNAVAILABLE', 503), { status: 503 }); }      // fail closed
    const token = randomBytes(24).toString('base64url');
    try {
      return await store.tx(async (c) => {
        let m; try { m = await member(c, account, callId); } catch (e) { await record(account, 'DENY', e.reason || 'ERROR', { callId }); throw e; }
        try { await guard(c, account, m.peer); } catch (e) { await record(account, 'DENY', 'SHIELD:' + (e.code || 'error'), { callId, to: m.peer }); throw deny('SHIELD_DENIED'); }
        const open = await settle(c, callId);
        if (open && open.status !== 'pending') throw deny('HANDOFF_IN_PROGRESS', 409);
        if (open) await c.query("UPDATE voice_handoffs SET status='cancelled', closed_reason='replaced', version=version+1 WHERE id=$1", [open.id]);
        await c.query('INSERT INTO voice_handoffs(call_id, initiator_id, recipient_id, meeting_id, token_hash, status, expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [callId, account, m.peer, meetingId, sha(token), 'pending', iso(now() + ttlMs)]);
        await record(account, 'ALLOW', 'START', { callId, to: m.peer, meetingId });
        return { token, expiresIn: Math.round(ttlMs / 1000), recipient: m.peer };
      });
    } catch (e) { if (e && e.code === '23505') throw deny('HANDOFF_IN_PROGRESS', 409); throw e; }   // two instances raced: the unique index let exactly one through
  }

  async function accept(account, callId, token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 80) throw deny('INVALID_TOKEN', 400);
    if (busy(account)) throw deny('RATE_LIMITED', 429);
    return store.tx(async (c) => {
      let m; try { m = await member(c, account, callId); } catch (e) { await record(account, 'DENY', e.reason || 'ERROR', { callId }); throw e; }
      await settle(c, callId);
      const t = now();
      // the single atomic step: only one caller, with the right token, as the right person, before expiry, can ever flip pending -> accepted
      const won = (await c.query("UPDATE voice_handoffs SET status='accepted', accepted_at=$5, release_deadline=$6, version=version+1 WHERE call_id=$1 AND token_hash=$2 AND recipient_id=$3 AND status='pending' AND expires_at > $4 RETURNING *",
        [callId, sha(token), account, iso(t), iso(t), iso(t + releaseWindowMs)])).rows[0];
      if (!won) { await record(account, 'DENY', 'TOKEN_INVALID_OR_SPENT', { callId }); throw deny('TOKEN_INVALID'); }
      try { await guard(c, won.initiator_id, account); } catch (e) { await c.query("UPDATE voice_handoffs SET status='failed', closed_reason='shield_denied_at_accept', version=version+1 WHERE id=$1", [won.id]); await record(account, 'DENY', 'SHIELD:' + (e.code || 'error'), { callId, from: won.initiator_id }); return { _denied: true }; }
      await record(account, 'ALLOW', 'ACCEPT', { callId, from: won.initiator_id, meetingId: won.meeting_id });
      return { meetingId: won.meeting_id, from: won.initiator_id, nonce: nonceFor(won, 'recip'), releaseWindowSeconds: Math.round(releaseWindowMs / 1000) };
    }).then((r) => { if (r._denied) throw deny('SHIELD_DENIED'); return r; });
  }
  async function status(account, callId) {
    return store.tx(async (c) => {
      const call = (await c.query('SELECT caller_id, callee_id FROM voice_calls WHERE id=$1', [callId])).rows[0];
      if (!call || ![call.caller_id, call.callee_id].includes(account)) throw deny('NOT_A_PARTICIPANT');
      let h = await settle(c, callId);
      if (!h) h = (await c.query('SELECT * FROM voice_handoffs WHERE call_id=$1 ORDER BY created_at DESC LIMIT 1', [callId])).rows[0] || null;
      const v = view(h, account); if (h && h.status === 'accepted') v.nonce = nonceFor(h, h.initiator_id === account ? 'init' : 'recip'); return v;
    });
  }

  async function cancel(account, callId, reason = 'cancelled_by_user') {
    return store.tx(async (c) => {
      const call = (await c.query('SELECT caller_id, callee_id FROM voice_calls WHERE id=$1', [callId])).rows[0];
      if (!call || ![call.caller_id, call.callee_id].includes(account)) throw deny('NOT_A_PARTICIPANT');
      const r = await c.query("UPDATE voice_handoffs SET status='cancelled', closed_reason=$2, version=version+1 WHERE call_id=$1 AND status IN ('pending','accepted') RETURNING id", [callId, String(reason).slice(0, 40)]);
      if (r.rowCount) await record(account, 'ALLOW', 'CANCEL', { callId });
      return { cancelled: r.rowCount > 0 };
    });
  }

  /** The evidence rule, shared by both sources, as a PURE step: from the stored row and one report to what the row should become (or a refusal). */
  function evidenceStep(h, k, sessionId, inboundAudioBytes) {
    if (h[k + '_session'] && h[k + '_session'] !== sessionId) return { deny: 'EVIDENCE_SESSION_CHANGED' };
    const t = now(), first = h[k + '_first'], last = h[k + '_last'];
    let setFirst = first, setLast = last, readyAt = h[k + '_ready_at'] ? new Date(h[k + '_ready_at']).getTime() : null;
    if (inboundAudioBytes > 0) {
      if (!first) { setFirst = { at: t, bytes: inboundAudioBytes }; setLast = setFirst; }
      else if (inboundAudioBytes < last.bytes) { /* a counter that goes backwards proves nothing (and is ignored) */ }
      else if (t - first.at >= minGapMs && inboundAudioBytes - first.bytes >= minGrowth && inboundAudioBytes > last.bytes) { setLast = { at: t, bytes: inboundAudioBytes }; readyAt = t; }
    }
    const prevReady = h[k + '_ready_at'] ? new Date(h[k + '_ready_at']).getTime() : null;
    const changed = h[k + '_session'] !== sessionId || JSON.stringify(setFirst) !== JSON.stringify(first) || JSON.stringify(setLast) !== JSON.stringify(last) || readyAt !== prevReady;
    return { setFirst, setLast, readyAt, changed, t, ready: !!readyAt && t - readyAt <= freshMs };
  }
  const evidenceSql = (k) => `UPDATE voice_handoffs SET ${k}_session=$2, ${k}_first=$3, ${k}_last=$4, ${k}_ready_at=$5, version=version+1`;

  /** Used inside a transaction by the page-reported source: `h` is the locked, accepted hand-off row and k its side ('init' | 'recip'). */
  async function applyEvidence(c, h, k, sessionId, inboundAudioBytes) {
    const r = evidenceStep(h, k, sessionId, inboundAudioBytes);
    if (r.deny) { await record(h[k === 'init' ? 'initiator_id' : 'recipient_id'], 'DENY', 'EVIDENCE_SESSION_CHANGED', { callId: h.call_id }); throw deny('EVIDENCE_REJECTED'); }
    await c.query(`${evidenceSql(k)} WHERE id=$1`, [h.id, sessionId, r.setFirst ? JSON.stringify(r.setFirst) : null, r.setLast ? JSON.stringify(r.setLast) : null, r.readyAt ? iso(r.readyAt) : null]);
    return { ready: r.ready };
  }

  /** SOURCE 1 (default, production): Qorlla Meet vouches for one of its own authenticated sessions. The caller is the Meet workload (Shield-authenticated, server to server); the
   *  account is the one Meet admitted, the session is Meet's participant id, and the bytes were reported by that session over its authenticated Meet socket. No nonce is needed: the
   *  browser cannot speak for another person, and cannot reach this route at all. */
  async function readyFromMeet({ meetingId, participantId, accountId, inboundAudioBytes }) {
    if (typeof meetingId !== 'string' || !/^[0-9 ]{9,16}$/.test(meetingId) || typeof participantId !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(participantId) || typeof accountId !== 'string' || accountId.length < 1 || accountId.length > 128 || !Number.isInteger(inboundAudioBytes) || inboundAudioBytes < 0 || inboundAudioBytes > 1e12) throw deny('INVALID_EVIDENCE', 400);
    if (busy('meet:' + accountId, 240)) throw deny('RATE_LIMITED', 429);
    const digits = meetingId.replace(/\D/g, ''), t0 = Date.now();
    // TWO statements and NO lock, however slow the database is: read the open hand-off, compute the next state, and write it with a compare-and-set on THIS side's own columns (a report from the
    // other side, which changes other columns, never conflicts). A lost race is retried a bounded number of times; a report that changes nothing (a duplicate or a flat counter) writes nothing.
    // The write itself re-checks that the hand-off is still accepted, not past its deadline, and that the call is still live, so a late write can never revive or extend anything.
    for (let attempt = 0; attempt < 3; attempt++) {
      const h = (await store.query("SELECT h.*, c.status AS call_status FROM voice_handoffs h JOIN voice_calls c ON c.id=h.call_id WHERE h.status='accepted' AND regexp_replace(h.meeting_id, '[^0-9]', '', 'g')=$1 AND (h.initiator_id=$2 OR h.recipient_id=$2) ORDER BY h.created_at DESC LIMIT 1", [digits, accountId])).rows[0];
      if (!h) return { ready: false, reason: 'no_handoff' };
      if (h.call_status !== 'active' || new Date(h.release_deadline).getTime() <= now()) return { ready: false, reason: 'not_open' };       // the next status request settles (closes) it
      const k = h.initiator_id === accountId ? 'init' : 'recip', r = evidenceStep(h, k, participantId, inboundAudioBytes);
      if (r.deny) { await record(accountId, 'DENY', 'EVIDENCE_SESSION_CHANGED', { callId: h.call_id }); throw deny('EVIDENCE_REJECTED'); }
      if (!r.changed) { return { ready: r.ready }; }
      const w = await store.query(`${evidenceSql(k)} WHERE id=$1 AND status='accepted' AND release_deadline > $6::timestamptz AND ${k}_session IS NOT DISTINCT FROM $7::text AND ${k}_last IS NOT DISTINCT FROM $8::jsonb AND EXISTS (SELECT 1 FROM voice_calls WHERE id=voice_handoffs.call_id AND status='active') RETURNING 1`,
        [h.id, participantId, r.setFirst ? JSON.stringify(r.setFirst) : null, r.setLast ? JSON.stringify(r.setLast) : null, r.readyAt ? iso(r.readyAt) : null, iso(now()), h[k + '_session'] || null, h[k + '_last'] ? JSON.stringify(h[k + '_last']) : null]);
      if (w.rowCount) { const ms = Date.now() - t0; if (ms > 1000) console.warn('slow_handoff_media', ms + 'ms'); return { ready: r.ready }; }
    }
    return { ready: false, reason: 'busy' };                                                                                                       // three lost races in a row: the caller's next report (about a second later) tries again
  }

  /** SOURCE 2 (off unless explicitly enabled; for tests and for deployments without Meet-side vouching): the page reports the numbers itself, bound by the hand-off nonce. */
  async function ready(account, callId, body) {
    if (!acceptBrowserEvidence) throw deny('EVIDENCE_SOURCE_NOT_ALLOWED');
    const { nonce, meetingId, sessionId, inboundAudioBytes, measuredAt } = body || {};
    if (typeof nonce !== 'string' || nonce.length < 20 || nonce.length > 80 || typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(sessionId) || !Number.isInteger(inboundAudioBytes) || inboundAudioBytes < 0 || inboundAudioBytes > 1e12 || !Number.isFinite(measuredAt)) throw deny('INVALID_EVIDENCE', 400);
    if (busy(account + ':ready', 240)) throw deny('RATE_LIMITED', 429);
    return store.tx(async (c) => {
      const h0 = await settle(c, callId); if (!h0 || h0.status !== 'accepted') throw deny('NO_ACTIVE_HANDOFF', 409);
      const h = (await c.query('SELECT * FROM voice_handoffs WHERE id=$1 FOR UPDATE', [h0.id])).rows[0]; if (h.status !== 'accepted') throw deny('NO_ACTIVE_HANDOFF', 409);
      const k = h.initiator_id === account ? 'init' : h.recipient_id === account ? 'recip' : null; if (!k) throw deny('NOT_A_PARTICIPANT');
      if (!same(nonce, nonceFor(h, k)) || typeof meetingId !== 'string' || meetingId !== h.meeting_id) { await record(account, 'DENY', 'EVIDENCE_NOT_BOUND', { callId }); throw deny('EVIDENCE_REJECTED'); }
      if (Math.abs(measuredAt - now()) > 15000) { await record(account, 'DENY', 'EVIDENCE_CLOCK', { callId }); throw deny('EVIDENCE_REJECTED'); }
      return applyEvidence(c, h, k, sessionId, inboundAudioBytes);
    });
  }

  /** Ends the phone call if, and only if, both sides' evidence is fresh. Idempotent: a repeat after success reports completed; a repeat before success reports not_ready. */
  async function complete(account, callId) {
    if (busy(account + ':complete', 120)) throw deny('RATE_LIMITED', 429);
    const claim = await store.tx(async (c) => {
      const call = (await c.query('SELECT caller_id, callee_id FROM voice_calls WHERE id=$1', [callId])).rows[0];
      if (!call || ![call.caller_id, call.callee_id].includes(account)) throw deny('NOT_A_PARTICIPANT');
      const done = (await c.query("SELECT id FROM voice_handoffs WHERE call_id=$1 AND status='completed' LIMIT 1", [callId])).rows[0];
      if (done) return { state: 'completed' };
      const h0 = await settle(c, callId);
      const fin = (await c.query("SELECT id FROM voice_handoffs WHERE call_id=$1 AND status='completed' LIMIT 1", [callId])).rows[0]; if (fin) return { state: 'completed' };
      if (!h0 || !['accepted', 'completing'].includes(h0.status)) return { state: h0 ? h0.status : 'none' };
      const h = (await c.query('SELECT * FROM voice_handoffs WHERE id=$1 FOR UPDATE', [h0.id])).rows[0];
      if (h.status === 'completing') return { state: 'completing', id: h.id, initiator: h.initiator_id };
      if (h.status !== 'accepted') return { state: h.status };
      const t = now(), fresh = (v) => v && t - new Date(v).getTime() <= freshMs;
      if (!fresh(h.init_ready_at) || !fresh(h.recip_ready_at) || !h.init_session || !h.recip_session) return { state: 'not_ready', you: fresh(account === h.initiator_id ? h.init_ready_at : h.recip_ready_at), peer: fresh(account === h.initiator_id ? h.recip_ready_at : h.init_ready_at) };
      try { await guard(c, h.initiator_id, h.recipient_id); } catch (e) { await c.query("UPDATE voice_handoffs SET status='failed', closed_reason='shield_denied_at_completion', version=version+1 WHERE id=$1", [h.id]); await record(account, 'DENY', 'SHIELD:' + (e.code || 'error'), { callId }); return { state: 'failed' }; }
      await c.query("UPDATE voice_handoffs SET status='completing', version=version+1 WHERE id=$1", [h.id]);
      return { state: 'completing', id: h.id, initiator: h.initiator_id };
    });
    if (claim.state !== 'completing') return claim;
    try { await store.transition(callId, claim.initiator, 'ended', 'moved_to_meeting'); }                      // the call state machine allows this exactly once; a concurrent second caller gets invalid_transition
    catch (e) { if (!(e && (e.code === 'invalid_transition' || e.message === 'invalid_transition'))) throw e; }
    await store.tx(async (c) => { await c.query("UPDATE voice_handoffs SET status='completed', completed_at=$2, version=version+1 WHERE id=$1 AND status='completing'", [claim.id, iso(now())]); await record(account, 'ALLOW', 'COMPLETE', { callId }); });
    return { state: 'completed' };
  }
  return { start, accept, status, cancel, ready, readyFromMeet, complete };
}
