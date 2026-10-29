// Durable events (v1.4). appendEvent() is called INSIDE the transaction that changes call or room state, so the state and the events about it commit together or not at all (DR-01).
// SDP and ICE are never stored here. Event ids are global and increase; a cursor is per account, and gaps are normal.
export const MAX_REPLAY = 200, KINDS = ['incoming', 'state', 'device_revoked', 'device_claimed', 'room_invite', 'room_state'];
export const safeCursor = (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
export const backoff = (attempt) => Math.min(60000, 500 * 2 ** Math.min(7, Math.max(0, attempt - 1)));
export const safeEvent = (kind, payload) => KINDS.includes(kind) && !!payload && typeof payload === 'object' && JSON.stringify(payload).length <= 32000;
const bad = (code) => Object.assign(new Error(code), { code });

/** Ordering guarantee (the v1.9 audit's open blocker): event ids come from an identity column and are assigned at INSERT, not at COMMIT, so two concurrent transactions could commit in the opposite
 * order to their ids and a reader whose cursor had moved past the lower id would skip it for ever. Every writer therefore takes a per-account advisory lock BEFORE inserting and holds it to COMMIT:
 * for one account, id order = commit order, so `id > cursor` never skips an event. Writers that touch several accounts must lock them in sorted order (lockEvents) to avoid deadlocks. */
export async function lockEvents(c, accounts) { for (const a of [...new Set(accounts)].sort()) await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['voice-events:' + a]); }

export async function appendEvent(c, { account, callId = null, kind, payload }) {
  if (!safeEvent(kind, payload)) throw bad('invalid_reliable_event');
  await lockEvents(c, [account]);
  const { rows } = await c.query('INSERT INTO voice_reliable_events(account_id, call_id, kind, payload) VALUES($1,$2,$3,$4::jsonb) RETURNING id', [account, callId, kind, JSON.stringify(payload)]);
  await c.query('INSERT INTO voice_outbox(event_id) VALUES($1)', [rows[0].id]);
  return Number(rows[0].id);
}

export function createReliability(db) {
  /** Everything the account missed after `after`, oldest first, at most MAX_REPLAY at a time (continue while hasMore). Only this account's events are ever returned. */
  async function replay(account, after = 0) {
    if (!safeCursor(after)) throw bad('invalid_cursor');
    const { rows } = await db.query('SELECT id, kind, payload, created_at FROM voice_reliable_events WHERE account_id=$1 AND id>$2 ORDER BY id LIMIT $3', [account, after, MAX_REPLAY + 1]);
    return { events: rows.slice(0, MAX_REPLAY).map((r) => ({ id: Number(r.id), kind: r.kind, payload: r.payload, created_at: r.created_at })), hasMore: rows.length > MAX_REPLAY };
  }
  const latest = async (account) => Number((await db.query('SELECT COALESCE(max(id),0) AS id FROM voice_reliable_events WHERE account_id=$1', [account])).rows[0].id);
  /** A device may only acknowledge an event that is really its account's (never another account's, never a future id). The cursor only moves forward. */
  async function acknowledge(account, deviceId, cursor) {
    if (!safeCursor(cursor)) throw bad('invalid_cursor');
    if (cursor !== 0 && !(await db.query('SELECT 1 FROM voice_reliable_events WHERE account_id=$1 AND id=$2', [account, cursor])).rowCount) throw bad('invalid_cursor');
    const r = await db.query(`INSERT INTO voice_resume_cursors(account_id, device_id, last_ack) VALUES($1,$2,$3)
      ON CONFLICT (account_id, device_id) DO UPDATE SET last_ack=GREATEST(voice_resume_cursors.last_ack, EXCLUDED.last_ack), updated_at=now() RETURNING last_ack`, [account, deviceId, cursor]);
    return Number(r.rows[0].last_ack);
  }
  /** For a server-side consumer of durable events (for example a future Meet bridge): true the FIRST time this consumer sees this event, false on every redelivery. */
  async function markProcessed(consumerId, eventId) {
    if (typeof consumerId !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(consumerId) || !safeCursor(eventId)) throw bad('invalid_input');
    return (await db.query('INSERT INTO voice_delivery_dedupe(consumer_id, event_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [consumerId, eventId])).rowCount === 1;
  }
  /** Queue depth and age: the numbers an operator alerts on, and what the engine checks before it accepts new calls (DR-07). */
  async function queueStats() {
    const r = (await db.query(`SELECT count(*)::int AS pending, COALESCE(EXTRACT(EPOCH FROM (now() - min(e.created_at))),0)::float AS oldest_seconds, COALESCE(max(o.attempts),0)::int AS max_attempts
      FROM voice_outbox o JOIN voice_reliable_events e ON e.id=o.event_id WHERE o.delivered_at IS NULL`)).rows[0];
    return { pending: r.pending, oldestSeconds: Math.round(r.oldest_seconds), maxAttempts: r.max_attempts };
  }
  /** Delivered events older than the retention window go; an undelivered event is never deleted. */
  async function prune(hours = 168) {
    const h = Math.max(1, Math.min(24 * 90, Math.round(hours)));
    return (await db.query(`DELETE FROM voice_reliable_events e USING voice_outbox o WHERE o.event_id=e.id AND o.delivered_at IS NOT NULL AND e.created_at < now() - make_interval(hours => $1::int)`, [h])).rowCount;
  }
  return { replay, latest, acknowledge, markProcessed, queueStats, prune };
}
