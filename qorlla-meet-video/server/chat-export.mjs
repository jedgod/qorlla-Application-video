// Read-only chat export for the Workplace portal (own secret). Since v4.32 it is ROOM-AWARE:
//   * without ?room= it returns ONLY the main-room chat (a breakout room's messages are never part of the meeting-wide export, so a meeting-wide AI report cannot absorb what people said in a room);
//   * with ?room=<id> it returns ONLY that room's messages (and its name). An unknown room is 404, never an empty answer.
// Direct (1:1) conversations are never exported. Deleted messages are never exported.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function registerChatExport({ app, db, readAuth, fail }) {
  app.get('/api/integrations/meetings/:id/chat', readAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!UUID.test(req.params.id)) return fail(res, 400, 'Invalid meeting id');
    const room = req.query.room === undefined ? null : String(req.query.room);
    if (room !== null && !UUID.test(room)) return fail(res, 400, 'Invalid room id');
    try {
      const m = await db.query('SELECT id,title,created_at,ended_at FROM meetings WHERE id=$1', [req.params.id]);
      if (!m.rowCount) return fail(res, 404, 'Meeting unavailable');
      let roomName = null;
      if (room !== null) { const r = await db.query('SELECT name FROM more_breakout_rooms WHERE id=$1 AND meeting_id=$2', [room.toLowerCase(), req.params.id]); if (!r.rowCount) return fail(res, 404, 'Room unavailable'); roomName = r.rows[0].name; }
      const { rows } = await db.query(
        'SELECT p.id AS pid, p.display_name AS name, p.role, c.body, c.created_at FROM messages c JOIN participants p ON p.id=c.participant_id WHERE c.meeting_id=$1 AND c.conversation_id IS NULL AND c.deleted_at IS NULL AND c.breakout_room IS NOT DISTINCT FROM $2 ORDER BY c.created_at,c.id LIMIT 5000',
        [req.params.id, room === null ? null : room.toLowerCase()]);
      res.json({ meetingId: m.rows[0].id, title: m.rows[0].title, startedAt: m.rows[0].created_at, endedAt: m.rows[0].ended_at, ...(room !== null ? { roomId: room.toLowerCase(), roomName } : {}),
        messages: rows.map((r) => ({ participantId: r.pid, speaker: r.name, speakerRole: r.role, text: r.body, at: r.created_at })) });
    } catch (e) { console.error('chat export failed'); fail(res, 503, 'Unavailable'); }
  });
}
