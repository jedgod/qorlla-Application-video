// Tamper-evident recording audit. Every event is chained to the previous one for the same meeting (hash = SHA-256 of the previous hash and this event), written
// under a per-meeting lock so concurrent writers cannot fork the chain. The table is also append-only in the database (trigger), so editing or deleting an event
// is refused, and verifyChain() shows where a chain was broken if someone bypasses that.
import crypto from 'node:crypto';

const canon = (v) => (v && typeof v === 'object' ? (Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}') : JSON.stringify(v ?? null));
const digest = (prev, ref, meetingId, sessionId, actor, role, action, detail, at) => crypto.createHash('sha256').update(prev + '|' + canon([ref, meetingId, sessionId, actor, role, action, detail, at])).digest('hex');

export function makeAudit(db) {
  return async function audit(meetingId, sessionId, actor, role, action, detail = {}) {
    const ref = crypto.randomUUID(), at = new Date(), c = await db.connect();
    try {
      await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['rec-audit:' + meetingId]);
      const { rows: [last] } = await c.query('SELECT hash FROM recording_audit WHERE meeting_id=$1 AND hash IS NOT NULL ORDER BY id DESC LIMIT 1', [meetingId]); const prev = last?.hash || '';
      const clean = JSON.parse(JSON.stringify(detail)), hash = digest(prev, ref, meetingId, sessionId, actor, role, action, clean, at.toISOString());
      await c.query('INSERT INTO recording_audit(audit_ref,meeting_id,session_id,actor,actor_role,action,detail,created_at,prev_hash,hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [ref, meetingId, sessionId, actor, role, action, JSON.stringify(clean), at, prev, hash]);
      await c.query('COMMIT'); return ref;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  };
}

/** Recompute the chain for a meeting. Returns { ok, checked, brokenAt } (brokenAt = id of the first event that does not verify). */
export async function verifyChain(db, meetingId) {
  const { rows } = await db.query('SELECT id,audit_ref,meeting_id,session_id,actor,actor_role,action,detail,created_at,prev_hash,hash FROM recording_audit WHERE meeting_id=$1 AND hash IS NOT NULL ORDER BY id', [meetingId]);
  let prev = '';
  for (const r of rows) {
    const want = digest(prev, r.audit_ref, r.meeting_id, r.session_id, r.actor, r.actor_role, r.action, r.detail, r.created_at.toISOString());
    if (r.prev_hash !== prev || r.hash !== want) return { ok: false, checked: rows.length, brokenAt: Number(r.id) };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length, brokenAt: null };
}
