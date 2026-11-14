// Server-Sent Events for Portal Chat. The Portal has no websockets and there is no Redis, so live delivery is SSE.
//
// IMPORTANT LIMIT: fan-out is IN-PROCESS. A second Portal instance would not see events published by the first; clients on it would only catch up by
// reconnecting (replay from chat_events) or fetching ?after=<seq>. Running more than one Portal replica needs a shared adapter (Redis pub/sub or Postgres LISTEN/NOTIFY) first.
//
// Authorization: the stream is opened behind the normal `member` middleware (cookie JWT, session liveness, workspace membership). For EVERY event the audience is recomputed
// from the database (explicit conversation members, or every current workspace member for a public channel), so a person who has left a conversation or the workspace stops
// receiving at once. Every `revalidateMs` the connection re-checks the session and the membership and closes itself if either is gone.
// Replay: Last-Event-ID (or ?last_event_id=) is the id of the last chat_events row seen. Because ids are assigned at insert and commits can finish out of order, the replay
// also re-sends events from the few seconds before that row; the client applies events idempotently (a message is upserted by id).
export const REPLAY_LIMIT = 500, REPLAY_OVERLAP_SECONDS = 5, MAX_STREAMS_PER_USER = 5;

export function createChatHub({ pool, sessionActive = async () => true, heartbeatMs = 20000, revalidateMs = 60000, log = { warn() {}, error() {} } } = {}) {
  const conns = new Set();                                                 // { res, actor, workspace, sid, hb, rv }
  const send = (c, { id, event, data }) => { try { c.res.write((id ? `id: ${id}\n` : '') + `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { close(c); } };
  function close(c, reason) {
    if (!conns.has(c)) return; conns.delete(c); clearInterval(c.hb); clearInterval(c.rv);
    try { if (reason) c.res.write(`event: bye\ndata: ${JSON.stringify({ reason })}\n\n`); c.res.end(); } catch { /* already closed */ }
  }

  /** Who may see this conversation right now: explicit members who are still workspace members; every workspace member for a public channel. */
  async function audience(conversationId, workspaceId) {
    const c = (await pool.query('SELECT is_private FROM portal.chat_conversations WHERE id=$1 AND workspace_id=$2', [conversationId, workspaceId])).rows[0];
    if (!c) return new Set();
    const rows = c.is_private
      ? (await pool.query('SELECT m.user_id FROM portal.chat_members cm JOIN portal.members m ON m.workspace_id=cm.workspace_id AND m.user_id=cm.user_id WHERE cm.conversation_id=$1 AND cm.workspace_id=$2', [conversationId, workspaceId])).rows
      : (await pool.query('SELECT user_id FROM portal.members WHERE workspace_id=$1', [workspaceId])).rows;
    return new Set(rows.map((r) => String(r.user_id).toLowerCase()));
  }

  /** Deliver one change to every connected person who may see it. `payload` carries no per-viewer data (bookmarks are never broadcast). */
  async function publish({ id, workspaceId, conversationId, payload }) {
    try {
      const who = await audience(conversationId, workspaceId);
      for (const c of [...conns]) if (c.workspace === workspaceId && who.has(c.actor)) send(c, { id, event: 'chat', data: payload });
    } catch (e) { log.warn('chat publish failed', { err: e.message }); }
  }

  /** Register a stream (res is already an open text/event-stream). `replay` is an async () => [{id, payload}] run before live events. */
  function attach({ req, res, actor, workspace, sid, replay }) {
    const mine = [...conns].filter((c) => c.actor === actor).length;
    if (mine >= MAX_STREAMS_PER_USER) { res.status(429).json({ error: 'Too many open chat streams for this account', code: 'too_many_streams' }); return null; }
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    const c = { res, actor, workspace, sid, hb: null, rv: null };
    conns.add(c);
    res.write('retry: 3000\n\n');
    c.hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { close(c); } }, heartbeatMs); c.hb.unref?.();
    c.rv = setInterval(async () => {
      try {
        if (!(await sessionActive(sid))) return close(c, 'session_ended');
        const ok = await pool.query('SELECT 1 FROM portal.members WHERE workspace_id=$1 AND user_id=$2', [workspace, actor]);
        if (!ok.rowCount) close(c, 'not_a_member');
      } catch (e) { log.warn('chat stream revalidation failed', { err: e.message }); }      // a database blip must not drop everybody; the next tick retries
    }, revalidateMs); c.rv.unref?.();
    req.on('close', () => close(c));
    (async () => {
      try {
        const out = await replay();
        if (out?.resync) send(c, { event: 'resync', data: { reason: 'too_many_missed_events' } });
        else for (const e of out || []) send(c, { id: e.id, event: 'chat', data: e.payload });
        send(c, { event: 'ready', data: { ok: true } });
      } catch (e) { log.warn('chat replay failed', { err: e.message }); send(c, { event: 'resync', data: { reason: 'replay_failed' } }); }
    })();
    return c;
  }
  return { publish, attach, audience, closeAll: () => { for (const c of [...conns]) close(c); }, get size() { return conns.size; }, closeUser: (actor, reason) => { for (const c of [...conns]) if (c.actor === actor) close(c, reason); } };
}
