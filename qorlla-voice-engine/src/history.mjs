// Group call history (v1.10-v1.11): what the Recent Calls screen shows for rooms, plus retention, user deletion and legal holds.
//   * A person sees only calls they were invited to or took part in; other participants are counted, never named.
//   * Retention: ended rooms older than VOICE_HISTORY_RETENTION_DAYS are deleted (members, stays and timeline go with them). A room under a legal hold is never deleted.
//   * Deletion: a person can delete their own record of an ENDED call. Their stays and timeline entries go; other people's records are untouched. Under a legal hold the record is hidden from them at once
//     and deleted when the hold is released. A call still in progress cannot be deleted.
//   * None of this touches live rooms or one-to-one calls, and it never touches undelivered events (the reliable-event outbox): only the person's own already-delivered copies of the room events are removed.
// Pagination is by (created_at, id) with an exact-microsecond cursor, so a page boundary can never skip or repeat a call.
export const MAX_PAGE_SIZE = 100, DEFAULT_RETENTION_DAYS = 365;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bad = (code) => Object.assign(new Error(code), { code });
export const validRoomId = (v) => typeof v === 'string' && UUID.test(v);
export function pageSize(value) { const n = Number(value ?? 25); if (!Number.isSafeInteger(n) || n < 1 || n > MAX_PAGE_SIZE) throw bad('invalid_input'); return n; }
export function encodeCursor(at, id) { return Buffer.from(JSON.stringify({ at, id })).toString('base64url'); }
export function decodeCursor(value) {
  if (value === undefined || value === null || value === '') return null;
  try {
    if (typeof value !== 'string' || value.length > 512) throw Error();
    const raw = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof raw.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$/.test(raw.at) || typeof raw.id !== 'string' || !UUID.test(raw.id)) throw Error();
    return raw;
  } catch { throw bad('invalid_cursor'); }
}
/** VOICE_HISTORY_RETENTION_DAYS: unset = 365; 0 = keep for ever (retention off); otherwise 7..3650. Anything else falls back to the default and says so, never to "keep for ever" by accident. */
export function parseRetentionDays(value) {
  if (value === undefined || value === null || value === '') return { days: DEFAULT_RETENTION_DAYS, warning: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || (n > 0 && n < 7) || n > 3650) return { days: DEFAULT_RETENTION_DAYS, warning: `VOICE_HISTORY_RETENTION_DAYS=${JSON.stringify(value)} is not 0 or 7-3650: using ${DEFAULT_RETENTION_DAYS}` };
  return { days: n, warning: null };
}
/** One member's outcome for one room. Kicked stays kicked; a member who is in a live room is "ongoing"; a person who ever joined has "completed" it; otherwise the recorded outcome, or "ringing" while the invitation is open. */
const STATUS_SQL = `CASE WHEN m.outcome = 'kicked' THEN 'kicked'
  WHEN m.status = 'joined' AND r.status = 'live' THEN 'ongoing'
  WHEN EXISTS (SELECT 1 FROM voice_room_segments s WHERE s.room_id = r.id AND s.account_id = m.account_id) THEN 'completed'
  WHEN m.outcome IS NOT NULL THEN m.outcome
  WHEN m.status = 'invited' THEN 'ringing' ELSE 'missed' END`;
const DURATION_SQL = `COALESCE((SELECT SUM(GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(s.left_at, now()) - s.joined_at))))::bigint FROM voice_room_segments s WHERE s.room_id = r.id AND s.account_id = m.account_id), 0)`;
const COMMON = `r.id AS call_id, r.title AS room_name, r.status AS room_status, r.created_at, r.ended_at, r.end_reason, m.role, ${STATUS_SQL} AS status, ${DURATION_SQL} AS duration_seconds,
  (SELECT min(s.joined_at) FROM voice_room_segments s WHERE s.room_id = r.id) AS started_at,
  COALESCE(r.participant_count, (SELECT count(DISTINCT s.account_id) FROM voice_room_segments s WHERE s.room_id = r.id))::int AS participants`;
const HELD = 'EXISTS (SELECT 1 FROM voice_legal_holds h WHERE h.room_id = r.id)';

export function createHistory({ db, tx }) {
  async function list(account, { limit, cursor } = {}) {
    const size = pageSize(limit), c = decodeCursor(cursor);
    const { rows } = await db.query(`SELECT ${COMMON}, to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM voice_room_members m JOIN voice_rooms r ON r.id = m.room_id
      WHERE m.account_id = $1 AND m.history_hidden_at IS NULL AND ($2::timestamptz IS NULL OR (r.created_at, r.id) < ($2::timestamptz, $3::uuid))
      ORDER BY r.created_at DESC, r.id DESC LIMIT $4`, [account, c?.at ?? null, c?.id ?? null, size + 1]);
    const more = rows.length > size, last = rows[size - 1];
    return { items: rows.slice(0, size).map(({ cursor_at, ...r }) => ({ ...r, duration_seconds: Number(r.duration_seconds) })), nextCursor: more ? encodeCursor(last.cursor_at, last.call_id) : null };
  }
  /** One call as this person experienced it. Other people are not identified: their events appear as "other" and the others are only counted. */
  async function detail(account, callId) {
    if (!validRoomId(callId)) throw bad('invalid_input');
    const self = (await db.query(`SELECT ${COMMON} FROM voice_room_members m JOIN voice_rooms r ON r.id = m.room_id WHERE m.account_id = $1 AND r.id = $2 AND m.history_hidden_at IS NULL`, [account, callId])).rows[0];
    if (!self) return null;
    const [segments, events] = await Promise.all([
      db.query('SELECT segment_id, joined_at, left_at FROM voice_room_segments WHERE room_id = $1 AND account_id = $2 ORDER BY joined_at, segment_id', [callId, account]),
      db.query(`SELECT kind AS event_type, occurred_at, CASE WHEN subject_account_id = $2 THEN 'self' ELSE 'other' END AS subject_scope FROM voice_room_events
        WHERE room_id = $1 AND (subject_account_id = $2 OR kind = 'host_transferred') ORDER BY id LIMIT 200`, [callId, account])
    ]);
    return { ...self, duration_seconds: Number(self.duration_seconds), segments: segments.rows, events: events.rows };
  }

  const log = (c, kind, rooms, detail = null) => c.query('INSERT INTO voice_history_ops(kind, rooms, detail) VALUES($1,$2,$3)', [kind, rooms, detail]);
  /** Removes ONE person's record of an ended room: their stays, their timeline entries, their member row, and their already-delivered copies of that room's events. Others' records are untouched. */
  async function eraseMember(c, roomId, account) {
    await c.query('UPDATE voice_rooms SET participant_count = COALESCE(participant_count, (SELECT count(DISTINCT account_id) FROM voice_room_segments WHERE room_id = $1)) WHERE id = $1', [roomId]);   // the others keep seeing the same head count
    await c.query('DELETE FROM voice_room_events WHERE room_id = $1 AND subject_account_id = $2', [roomId, account]);
    await c.query('UPDATE voice_room_events SET actor_account_id = NULL WHERE room_id = $1 AND actor_account_id = $2', [roomId, account]);                                                        // what this person did to others stays, anonymously
    await c.query('DELETE FROM voice_room_members WHERE room_id = $1 AND account_id = $2', [roomId, account]);                                                                                      // cascades their stays
    await c.query(`DELETE FROM voice_reliable_events e USING voice_outbox o WHERE o.event_id = e.id AND o.delivered_at IS NOT NULL AND e.account_id = $1 AND e.kind IN ('room_state','room_invite') AND e.payload->'room'->>'id' = $2`, [account, roomId]);   // never an undelivered event
    await c.query(`DELETE FROM voice_rooms r WHERE r.id = $1 AND r.status = 'ended' AND NOT EXISTS (SELECT 1 FROM voice_room_members WHERE room_id = r.id) AND NOT ${HELD}`, [roomId]);          // the last record goes with the room
  }
  /** Delete my record of one call. Returns { deleted } or { retained } (legal hold). Throws not_found, call_in_progress. */
  async function remove(account, callId) {
    if (!validRoomId(callId)) throw bad('invalid_input');
    return tx(async (c) => {
      const room = (await c.query('SELECT id, status, EXISTS (SELECT 1 FROM voice_legal_holds h WHERE h.room_id = id) AS held FROM voice_rooms WHERE id = $1 FOR UPDATE', [callId])).rows[0];
      const m = room && (await c.query('SELECT history_hidden_at FROM voice_room_members WHERE room_id = $1 AND account_id = $2 FOR UPDATE', [callId, account])).rows[0];
      if (!room || !m || m.history_hidden_at) throw bad('not_found');
      if (room.status !== 'ended') throw bad('call_in_progress');                                                                   // a live call, or an open invitation, is never deleted
      if (room.held) { await c.query('UPDATE voice_room_members SET history_hidden_at = now() WHERE room_id = $1 AND account_id = $2', [callId, account]); await log(c, 'user_delete', 0, 'hidden: legal hold'); return { deleted: 0, retained: 1 }; }
      await eraseMember(c, callId, account); await log(c, 'user_delete', 1); return { deleted: 1, retained: 0 };
    });
  }
  /** Delete my record of every ended call (a batch at a time: call again while `remaining` is above 0). Live calls and open invitations are skipped. */
  async function clear(account, { batch = 200 } = {}) {
    const ids = (await db.query(`SELECT r.id FROM voice_room_members m JOIN voice_rooms r ON r.id = m.room_id WHERE m.account_id = $1 AND m.history_hidden_at IS NULL AND r.status = 'ended' ORDER BY r.ended_at LIMIT $2`, [account, batch])).rows.map((x) => x.id);
    let deleted = 0, retained = 0;
    for (const id of ids) { try { const r = await remove(account, id); deleted += r.deleted; retained += r.retained; } catch (e) { if (e.code !== 'not_found' && e.code !== 'call_in_progress') throw e; } }
    const left = (await db.query(`SELECT count(*)::int n FROM voice_room_members m JOIN voice_rooms r ON r.id = m.room_id WHERE m.account_id = $1 AND m.history_hidden_at IS NULL AND r.status = 'ended'`, [account])).rows[0].n;
    const skippedLive = (await db.query(`SELECT count(*)::int n FROM voice_room_members m JOIN voice_rooms r ON r.id = m.room_id WHERE m.account_id = $1 AND r.status = 'live'`, [account])).rows[0].n;
    await tx((c) => log(c, 'user_clear', deleted + retained)); return { deleted, retained, remaining: left, skippedLive };
  }

  /** Scheduled cleanup (safe on several replicas at once: rows are taken with SKIP LOCKED). Ended rooms past retention go with everything attached; a held room stays; people whose deletion was waiting on a hold now go. */
  async function purgeExpired({ days = DEFAULT_RETENTION_DAYS, batch = 200 } = {}) {
    let rooms = 0, members = 0;
    if (days > 0) rooms += await tx(async (c) => {
      const ids = (await c.query(`SELECT r.id FROM voice_rooms r WHERE r.status = 'ended' AND r.ended_at < now() - make_interval(days => $1::int) AND NOT ${HELD} ORDER BY r.ended_at LIMIT $2 FOR UPDATE OF r SKIP LOCKED`, [days, batch])).rows.map((x) => x.id);
      if (ids.length) await c.query('DELETE FROM voice_rooms WHERE id = ANY($1::uuid[])', [ids]);                                   // members, stays and timeline cascade
      return ids.length;
    });
    members += await tx(async (c) => {
      const rows = (await c.query(`SELECT m.room_id, m.account_id FROM voice_room_members m JOIN voice_rooms r ON r.id = m.room_id WHERE m.history_hidden_at IS NOT NULL AND r.status = 'ended' AND NOT ${HELD} ORDER BY m.history_hidden_at LIMIT $1 FOR UPDATE OF m SKIP LOCKED`, [batch])).rows;
      for (const x of rows) await eraseMember(c, x.room_id, x.account_id);
      return rows.length;
    });
    if (rooms || members) await tx((c) => log(c, 'retention', rooms, members ? `${members} deletion request(s) completed after a hold` : null));
    return { rooms, members };
  }

  // ---- legal holds (administrators only; the engine never decides one)
  async function placeHold(roomId, placedBy, reason) {
    if (!validRoomId(roomId) || typeof placedBy !== 'string' || !placedBy || placedBy.length > 128 || typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw bad('invalid_input');
    return tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM voice_rooms WHERE id = $1 FOR SHARE', [roomId])).rowCount) throw bad('not_found');
      const r = await c.query('INSERT INTO voice_legal_holds(room_id, placed_by, reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [roomId, placedBy, reason.trim()]);
      if (r.rowCount) await log(c, 'hold_placed', 1); return { held: true, created: r.rowCount === 1 };
    });
  }
  async function releaseHold(roomId) {
    if (!validRoomId(roomId)) throw bad('invalid_input');
    return tx(async (c) => { const r = await c.query('DELETE FROM voice_legal_holds WHERE room_id = $1', [roomId]); if (r.rowCount) await log(c, 'hold_released', 1); return { released: r.rowCount === 1 }; });
  }
  const listHolds = async () => (await db.query('SELECT room_id, placed_by, reason, placed_at FROM voice_legal_holds ORDER BY placed_at DESC LIMIT 500')).rows;
  /** Numbers for the operator: what the cleanup has done, and what is waiting. */
  async function stats() {
    const ops = (await db.query(`SELECT kind, COALESCE(sum(rooms),0)::int AS rooms, max(at) AS last_at FROM voice_history_ops GROUP BY kind`)).rows;
    const held = (await db.query('SELECT count(*)::int n FROM voice_legal_holds')).rows[0].n, hidden = (await db.query('SELECT count(*)::int n FROM voice_room_members WHERE history_hidden_at IS NOT NULL')).rows[0].n;
    return { ops: Object.fromEntries(ops.map((o) => [o.kind, { rooms: o.rooms, lastAt: o.last_at }])), legalHolds: held, deletionsWaitingOnHold: hidden };
  }
  return { list, detail, remove, clear, purgeExpired, placeHold, releaseHold, listHolds, stats };
}
