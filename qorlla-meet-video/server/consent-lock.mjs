// Every write to a meeting's AI-consent records (a person's answer, the host's request or cancellation) runs inside ONE transaction that holds this meeting's advisory lock.
// Why: sequence numbers are taken at insert time, but a row only becomes visible when its transaction commits. Without the lock, answer 6 could be visible to the portal while answer 5 (from another
// person, still committing) is not, and the portal - having recorded "I have seen revision 6" - would later meet a withdrawal numbered 5. With the lock, numbers and commit order agree within a meeting,
// and a person's check-then-insert cannot interleave with their own second request.
export async function withConsentLock(db, meetingId, fn) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['ai-consent:' + meetingId]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* connection already gone */ } throw e; }
  finally { c.release(); }
}
