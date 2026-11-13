// Host-controlled tools in a Meet room.
//   * Share screen, Polls, Breakout rooms and Whiteboard are HOST tools. Guests see none of them, and the server refuses them, until the host switches each one on
//     (meetings.guest_tools). Sharing can also be granted to one named person (participants.can_share) without opening it to everybody.
//   * The host can mute a guest, mute everyone, and ASK a guest to unmute. A microphone is never switched on remotely: the guest gets a prompt and decides.
// Every permission is decided here; the browser only mirrors it. (Screen and audio travel peer to peer, so the signalling flag is what the server controls: a guest without
// permission cannot announce a share, and the other people's pages ignore a share that was not announced.)
export const TOOLS = ['share', 'polls', 'breakout', 'whiteboard'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerHostControls({ app, io, db, auth, member, fail, room, audit, socketOf, ascsEnabled = false, relayEnabled = false, onPermissionChange = null }) {
  // onPermissionChange(meetingId): called AFTER a permission to share was changed, so a share that is no longer allowed is ended before the host's request returns.
  // A failure here is logged and never fails the request (the permission itself has already been saved).
  // It returns false when the follow-up could not be done: the route then says so (503) instead of pretending the share is over. The permission itself is already saved, and
  // ASCS keeps checking (heartbeat, signalling gate and its sweeper), so an unauthorized share still ends by itself within seconds.
  const UNCONFIRMED = 'The permission was changed, but ending the current share could not be confirmed. It will be ended automatically within seconds; check again.';
  const permissionChanged = async (meetingId) => { try { await onPermissionChange?.(meetingId); return true; } catch (e) { console.error('[host-controls] could not end a share that is no longer allowed:', e.message); return false; } };
  const hostOnly = (req, res, next) => (req.user.role === 'host' ? next() : fail(res, 403, 'Only the host can do this'));
  const guard = (fn, msg) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error('[host-controls]', msg, e.message); if (!res.headersSent) fail(res, 500, msg); } };
  const clean = (t) => Object.fromEntries(TOOLS.map((k) => [k, t?.[k] === true]));

  /** What THIS person may use right now. The host always has everything. */
  async function effective(meetingId, pid, role) {
    if (role === 'host') return Object.fromEntries(TOOLS.map((k) => [k, true]));
    const { rows: [r] } = await db.query('SELECT m.guest_tools, p.can_share FROM meetings m JOIN participants p ON p.meeting_id=m.id WHERE m.id=$1 AND p.id=$2', [meetingId, pid]);
    const t = clean(r?.guest_tools); if (r?.can_share) t.share = true; return t;
  }
  const mayUse = async (meetingId, pid, role, tool) => (await effective(meetingId, pid, role))[tool] === true;

  app.get(['/api/meetings/:id/tools', '/api/v1/meetings/:id/tools'], auth, member, guard(async (req, res) => {
    const tools = await effective(req.params.id, req.user.participantId, req.user.role);
    const out = { tools, ascs: ascsEnabled === true, relay: relayEnabled === true };
    if (req.user.role === 'host') {
      const { rows: [m] } = await db.query('SELECT guest_tools FROM meetings WHERE id=$1', [req.params.id]); out.guestTools = clean(m?.guest_tools);
      out.sharers = (await db.query("SELECT id AS \"participantId\" FROM participants WHERE meeting_id=$1 AND can_share", [req.params.id])).rows.map((r) => r.participantId);
    }
    res.set('Cache-Control', 'no-store').json(out);
  }, 'Tools unavailable'));

  // the host switches a tool ON or OFF for guests
  app.patch(['/api/meetings/:id/tools', '/api/v1/meetings/:id/tools'], auth, member, hostOnly, guard(async (req, res) => {
    const b = req.body || {}, patch = {};
    for (const k of TOOLS) if (b[k] !== undefined) { if (typeof b[k] !== 'boolean') return fail(res, 400, k + ' must be true or false'); patch[k] = b[k]; }
    if (!Object.keys(patch).length) return fail(res, 400, 'Nothing to change');
    const { rows: [m] } = await db.query("UPDATE meetings SET guest_tools = COALESCE(guest_tools, '{}'::jsonb) || $2::jsonb WHERE id=$1 AND ended_at IS NULL RETURNING guest_tools", [req.params.id, JSON.stringify(patch)]);
    if (!m) return fail(res, 404, 'Meeting unavailable');
    audit(req.params.id, req.user.participantId, 'meeting.tools_changed', patch);
    const ended = await permissionChanged(req.params.id);        // first: a share that is no longer allowed is ended with the right reason, THEN pages hear that the tools changed
    io.to(room(req.params.id)).emit('tools-changed', { guestTools: clean(m.guest_tools) });
    if (!ended) return res.status(503).json({ error: UNCONFIRMED, guestTools: clean(m.guest_tools) });
    res.json({ guestTools: clean(m.guest_tools) });
  }, 'Could not change the tools'));

  // the host lets one person share (or takes it back)
  app.post(['/api/meetings/:id/participants/:pid/share', '/api/v1/meetings/:id/participants/:pid/share'], auth, member, hostOnly, guard(async (req, res) => {
    if (!UUID.test(req.params.pid) || typeof req.body?.allow !== 'boolean') return fail(res, 400, 'Invalid request');
    const { rowCount } = await db.query("UPDATE participants SET can_share=$3 WHERE id=$2 AND meeting_id=$1 AND role<>'host'", [req.params.id, req.params.pid, req.body.allow]);
    if (!rowCount) return fail(res, 404, 'No such participant');
    audit(req.params.id, req.user.participantId, req.body.allow ? 'participant.share_granted' : 'participant.share_revoked', { participantId: req.params.pid });
    const ended = await permissionChanged(req.params.id);        // first (see above)
    const sid = socketOf(req.params.id, req.params.pid); if (sid) io.to(sid).emit('tools-changed', { refresh: true });
    if (!ended) return res.status(503).json({ error: UNCONFIRMED, participantId: req.params.pid, canShare: req.body.allow });
    res.json({ participantId: req.params.pid, canShare: req.body.allow });
  }, 'Could not change sharing'));

  /** Called for every socket once it is in the room. */
  function attach(socket, { id, pid, role }) {
    if (role !== 'host') return;
    socket.on('host-mute', ({ to, all } = {}) => {
      const targets = all === true ? [...(io.sockets.adapter.rooms.get(room(id)) || [])].filter((s) => s !== socket.id) : [socketOf(id, to)].filter(Boolean);
      for (const sid of targets) io.to(sid).emit('force-mute', {});
    });
    socket.on('host-ask-unmute', ({ to } = {}) => { const sid = socketOf(id, to); if (sid) io.to(sid).emit('unmute-request', {}); });
  }
  return { attach, mayUse, effective };
}
