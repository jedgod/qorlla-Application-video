// Voice engine consumer of the Numbers & Plans authority. A PROJECTION: it never provisions, releases or activates anything.
// Delivery is at-least-once, so every rule is idempotent: events are de-duplicated by id, ordered by the authority's per-number version, and a missing version is a GAP (refused, recorded, healed by a snapshot).
import { validAccountId } from './core.mjs';

const SID = /^[A-Za-z0-9_-]{8,64}$/, E164 = /^\+[1-9][0-9]{7,14}$/, STATES = ['provisioning', 'active', 'suspended', 'releasing', 'released'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class SyncError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }

/** Validates the envelope and the payload against each other: a payload may not describe another number or another version than the envelope claims. */
export function parseEvent(ev) {
  const p = ev && ev.payload;
  if (!ev || typeof ev !== 'object' || !UUID.test(String(ev.eventId)) || !SID.test(String(ev.providerNumberId)) || !Number.isSafeInteger(ev.version) || ev.version < 1 || !['number.changed', 'number.snapshot'].includes(ev.type) || !p || typeof p !== 'object') throw new SyncError('invalid_event');
  if (p.providerNumberId !== ev.providerNumberId || p.version !== ev.version) throw new SyncError('payload_mismatch');
  return normalizeState(p);
}
export function normalizeState(p) {
  if (!SID.test(String(p.providerNumberId)) || !E164.test(String(p.e164)) || !['personal', 'dialin'].includes(p.kind) || !STATES.includes(p.state) || !Number.isSafeInteger(p.version) || p.version < 1 || (p.accountId != null && !validAccountId(p.accountId)) || typeof p.callerIdVerified !== 'boolean' || (p.country != null && !/^[A-Z]{2}$/.test(p.country))) throw new SyncError('invalid_event');
  if (p.kind === 'dialin' && p.accountId) throw new SyncError('dialin_cannot_be_assigned');                 // shared dial-in numbers never belong to a person
  return { sid: p.providerNumberId, e164: p.e164, country: p.country || null, kind: p.kind, accountId: p.accountId || null, state: p.state, callerIdVerified: p.callerIdVerified, hold: !!p.hold, version: p.version };
}
export const usable = (row) => !!row && row.state === 'active' && row.kind === 'personal' && !row.hold && !row.conflict && !row.stale && !!row.account_id;

export function createNumberProjection({ store }) {
  const { tx } = store, lock = (c, sid) => c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['numproj:' + sid]);
  async function upsert(c, s, eventId) {
    const clash = (await c.query("SELECT provider_number_id FROM voice_number_projection WHERE e164=$1 AND state <> 'released' AND provider_number_id <> $2", [s.e164, s.sid])).rowCount;
    if (clash) return 'conflict';                                                                                                // the same live number under two ids: refuse, never overwrite
    let conflict = false;
    if (s.kind === 'personal' && s.accountId && ['provisioning', 'active', 'suspended', 'releasing'].includes(s.state))
      conflict = (await c.query("SELECT 1 FROM voice_number_projection WHERE kind='personal' AND account_id=$1 AND provider_number_id <> $2 AND state IN ('provisioning','active','suspended','releasing') AND NOT conflict", [s.accountId, s.sid])).rowCount > 0;
    await c.query(`INSERT INTO voice_number_projection(provider_number_id, e164, country, kind, account_id, state, caller_id_verified, hold, authority_version, last_event_id, conflict, stale)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false) ON CONFLICT (provider_number_id) DO UPDATE SET e164=$2, country=$3, kind=$4, account_id=$5, state=$6, caller_id_verified=$7, hold=$8, authority_version=$9, last_event_id=$10, conflict=$11, stale=false, updated_at=now()`,
      [s.sid, s.e164, s.country, s.kind, s.accountId, s.state, s.callerIdVerified, s.hold, s.version, eventId || null, conflict]);
    await c.query('UPDATE voice_number_gaps SET resolved_at=now() WHERE provider_number_id=$1 AND resolved_at IS NULL AND $2 >= expected_version', [s.sid, s.version]);
    return conflict ? 'conflict' : 'applied';
  }

  /** -> { result: 'applied' | 'duplicate' | 'stale' | 'conflict' | 'gap', expected? } */
  async function applyEvent(ev) {
    const s = parseEvent(ev);
    return tx(async (c) => {
      await lock(c, s.sid);
      if ((await c.query('SELECT 1 FROM voice_number_events WHERE event_id=$1', [ev.eventId])).rowCount) return { result: 'duplicate' };
      const cur = (await c.query('SELECT authority_version FROM voice_number_projection WHERE provider_number_id=$1', [s.sid])).rows[0], have = cur ? Number(cur.authority_version) : 0;
      const record = (result) => c.query('INSERT INTO voice_number_events(event_id, provider_number_id, version, type, result) VALUES($1,$2,$3,$4,$5)', [ev.eventId, s.sid, s.version, ev.type, result]);
      if (s.version <= have) { await record('stale'); return { result: 'stale' }; }
      if (s.version !== have + 1 && ev.type !== 'number.snapshot' && !(have === 0 && s.version === 1)) {
        await c.query('INSERT INTO voice_number_gaps(provider_number_id, expected_version, got_version) VALUES($1,$2,$3) ON CONFLICT (provider_number_id) DO UPDATE SET expected_version=$2, got_version=$3, detected_at=now(), resolved_at=NULL', [s.sid, have + 1, s.version]);
        return { result: 'gap', expected: have + 1 };                                                                          // not recorded as an event: the same event is accepted when its predecessor arrives or a snapshot heals the gap
      }
      const result = await upsert(c, s, ev.eventId); await record(result === 'conflict' ? 'conflict' : 'applied'); return { result };
    });
  }

  /** Full-state reconciliation. The authority wins: newer versions are applied, the projection never moves backwards, rows the authority no longer lists are made unusable, and any disagreement at the SAME version is reported. */
  async function reconcile(numbers) {
    if (!Array.isArray(numbers) || numbers.length > 5000) throw new SyncError('invalid_snapshot');
    const parsed = numbers.map(normalizeState), seen = new Set(parsed.map((p) => p.sid)), out = { applied: 0, unchanged: 0, mismatched: [], orphans: [], conflicts: [] };
    for (const s of parsed) {
      await tx(async (c) => {
        await lock(c, s.sid);
        const cur = (await c.query('SELECT * FROM voice_number_projection WHERE provider_number_id=$1', [s.sid])).rows[0], have = cur ? Number(cur.authority_version) : 0;
        if (s.version > have) { const r = await upsert(c, s, null); r === 'conflict' ? out.conflicts.push(s.sid) : out.applied++; }
        else if (s.version === have) {
          const same = cur.e164 === s.e164 && cur.kind === s.kind && cur.account_id === s.accountId && cur.state === s.state && cur.caller_id_verified === s.callerIdVerified && cur.hold === s.hold;
          if (!same) out.mismatched.push(s.sid); else { out.unchanged++; if (cur.stale) await c.query('UPDATE voice_number_projection SET stale=false WHERE provider_number_id=$1', [s.sid]); }
        } else out.mismatched.push(s.sid);                                                                                   // the projection is AHEAD of the authority: something is wrong; report, never "fix" silently
      });
    }
    await tx(async (c) => {
      const rows = (await c.query("SELECT provider_number_id FROM voice_number_projection WHERE NOT stale AND state <> 'released'")).rows;
      for (const r of rows) if (!seen.has(r.provider_number_id)) { await c.query('UPDATE voice_number_projection SET stale=true, updated_at=now() WHERE provider_number_id=$1', [r.provider_number_id]); out.orphans.push(r.provider_number_id); }
    });
    return out;
  }

  /** The number a signed-in person may see/use: only when the projection is usable (the shield checks the account separately). */
  async function numberFor(accountId) {
    const r = (await tx((c) => c.query("SELECT * FROM voice_number_projection WHERE kind='personal' AND account_id=$1 AND state <> 'released' ORDER BY authority_version DESC LIMIT 1", [accountId]))).rows[0];
    return r ? { row: r, usable: usable(r) } : null;
  }
  const status = async () => (await tx((c) => c.query("SELECT (SELECT count(*)::int FROM voice_number_projection) AS numbers, (SELECT count(*)::int FROM voice_number_gaps WHERE resolved_at IS NULL) AS gaps, (SELECT count(*)::int FROM voice_number_projection WHERE conflict) AS conflicts, (SELECT count(*)::int FROM voice_number_projection WHERE stale) AS stale, (SELECT count(*)::int FROM voice_number_projection WHERE hold) AS held"))).rows[0];
  return { applyEvent, reconcile, numberFor, status };
}
