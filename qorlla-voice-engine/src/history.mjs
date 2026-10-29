// Group call history (v1.10): what the Recent Calls screen shows for rooms. Read-only queries over the authoritative room tables; a person sees only calls they were invited to or took part in,
// and other participants are never identified (only counted). Pagination is by (created_at, id) with an exact-microsecond cursor, so a page boundary can never skip or repeat a call.
export const MAX_PAGE_SIZE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bad = (code) => Object.assign(new Error(code), { code });
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
/** One member's outcome for one room. Kicked stays kicked; a member who is in a live room is "ongoing"; a person who ever joined has "completed" it; otherwise the recorded outcome, or "ringing" while the invitation is open. */
const STATUS_SQL = `CASE WHEN m.outcome = 'kicked' THEN 'kicked'
  WHEN m.status = 'joined' AND r.status = 'live' THEN 'ongoing'
  WHEN EXISTS (SELECT 1 FROM voice_room_segments s WHERE s.room_id = r.id AND s.account_id = m.account_id) THEN 'completed'
  WHEN m.outcome IS NOT NULL THEN m.outcome
  WHEN m.status = 'invited' THEN 'ringing' ELSE 'missed' END`;
const DURATION_SQL = `COALESCE((SELECT SUM(GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(s.left_at, now()) - s.joined_at))))::bigint FROM voice_room_segments s WHERE s.room_id = r.id AND s.account_id = m.account_id), 0)`;
const COMMON = `r.id AS call_id, r.title AS room_name, r.status AS room_status, r.created_at, r.ended_at, r.end_reason, m.role, ${STATUS_SQL} AS status, ${DURATION_SQL} AS duration_seconds,
  (SELECT min(s.joined_at) FROM voice_room_segments s WHERE s.room_id = r.id) AS started_at, (SELECT count(DISTINCT s.account_id) FROM voice_room_segments s WHERE s.room_id = r.id)::int AS participants`;

export function createHistory(db) {
  async function list(account, { limit, cursor } = {}) {
    const size = pageSize(limit), c = decodeCursor(cursor);
    const { rows } = await db.query(`SELECT ${COMMON}, to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM voice_room_members m JOIN voice_rooms r ON r.id = m.room_id
      WHERE m.account_id = $1 AND ($2::timestamptz IS NULL OR (r.created_at, r.id) < ($2::timestamptz, $3::uuid))
      ORDER BY r.created_at DESC, r.id DESC LIMIT $4`, [account, c?.at ?? null, c?.id ?? null, size + 1]);
    const more = rows.length > size, last = rows[size - 1];
    return { items: rows.slice(0, size).map(({ cursor_at, ...r }) => ({ ...r, duration_seconds: Number(r.duration_seconds) })), nextCursor: more ? encodeCursor(last.cursor_at, last.call_id) : null };
  }
  /** One call as this person experienced it. Other people are not identified: their events appear as "other" and the others are only counted. */
  async function detail(account, callId) {
    if (!UUID.test(callId)) throw bad('invalid_input');
    const self = (await db.query(`SELECT ${COMMON} FROM voice_room_members m JOIN voice_rooms r ON r.id = m.room_id WHERE m.account_id = $1 AND r.id = $2`, [account, callId])).rows[0];
    if (!self) return null;
    const [segments, events] = await Promise.all([
      db.query('SELECT segment_id, joined_at, left_at FROM voice_room_segments WHERE room_id = $1 AND account_id = $2 ORDER BY joined_at, segment_id', [callId, account]),
      db.query(`SELECT kind AS event_type, occurred_at, CASE WHEN subject_account_id = $2 THEN 'self' ELSE 'other' END AS subject_scope FROM voice_room_events
        WHERE room_id = $1 AND (subject_account_id = $2 OR kind = 'host_transferred') ORDER BY id LIMIT 200`, [callId, account])
    ]);
    return { ...self, duration_seconds: Number(self.duration_seconds), segments: segments.rows, events: events.rows };
  }
  return { list, detail };
}
