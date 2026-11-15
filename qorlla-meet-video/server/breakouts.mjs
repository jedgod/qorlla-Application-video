// Meet breakout rooms (v4.29): real WebRTC room switching on Meet's own signaling.
//
// How it works: every participant has a SCOPE: the main room (null) or one breakout room. Meet already builds one RTCPeerConnection per person listed in the `roster` event, so scoping is
// done where those lists and messages are made: the server only lists, announces and relays WebRTC signals between people in the same scope. Moving someone sends them a new roster
// (the page closes every old peer connection and tile and negotiates the new ones: the same path as joining a meeting), tells the old scope they left and the new scope they arrived.
// Chat (Everyone), hands, reactions, media state, Q&A, whiteboard and the meeting timer are delivered per scope too, and a person inside a room is refused the main-room tools (409).
//
// Authority: Meet's token (`auth`) + the admitted-participant check (`member`); only the host runs rooms (Meet has two roles; the package's "cohost" does not exist here). The host stays
// in the main room unless they choose to visit a room. Assignments and the session (state, deadline, revision) live in PostgreSQL; the in-memory scope map is rebuilt from it on demand.
// A background tick ends sessions whose deadline passed (one atomic UPDATE, so a second instance cannot double-fire). Single-instance for the in-memory scope map: a multi-instance
// deployment needs the scope map shared (Redis or the Socket.IO adapter); see docs/MEET_BREAKOUTS.md.
//
// V1.1 (v4.30): Polls and Notes are room-scoped (server/collab.mjs asks this module for the scope), a person can return to the main room by themselves, and can ask the host for help.
// V1.2 (v4.31): every move bumps the person's EPOCH (stored, and logged in more_breakout_moves); signals carry it, so a message sent before a move is refused after it (server/index.js). Group leads
// (help_triage, room_announcement, room_notes, room_polls) are room-only powers that vanish the moment the person leaves the room. The Mission Board, exercises and room whiteboard are in server/classroom.mjs.
// Not covered here (documented, not hidden): the portal's AI export reads all Everyone-chat of consenting people.
import { randomInt } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const LIMITS = Object.freeze({ maxRooms: 20, minMinutes: 1, maxMinutes: 240, nameMax: 60 });
export const CAPS = Object.freeze(['help_triage', 'room_announcement', 'room_notes', 'room_polls']);
const bad = (status, error) => Object.assign(new Error(error), { status });

export function registerBreakouts({ app, io, db, auth, member, fail, active, room, tickMs = 5000 }) {
  const meetings = new Map();          // meetingId -> { active, deadline, map: Map(pid -> roomId), rooms: Map(roomId -> name) }
  const hostOnly = (req, res, next) => (req.user.role === 'host' ? next() : fail(res, 403, 'Only the host can do this'));
  const paths = (p) => ['/api/meetings/:id/breakouts' + p, '/api/v1/meetings/:id/breakouts' + p];
  const run = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { if (e.status) return fail(res, e.status, e.message); console.error('[breakouts]', e.message); fail(res, 500, 'Something went wrong'); } };

  async function ensure(mid) {
    if (meetings.has(mid)) return meetings.get(mid);
    const [s, rooms, asg, ld] = await Promise.all([
      db.query('SELECT state, deadline FROM more_breakout_sessions WHERE meeting_id=$1', [mid]),
      db.query('SELECT id, name FROM more_breakout_rooms WHERE meeting_id=$1 ORDER BY created_at, id', [mid]),
      db.query('SELECT participant_id, room_id, move_epoch FROM more_breakout_assignments WHERE meeting_id=$1', [mid]),
      db.query('SELECT participant_id, room_id, capability FROM more_breakout_leads WHERE meeting_id=$1', [mid]),
    ]);
    const on = s.rows[0]?.state === 'active';
    const m = { pending: new Map(), media: new Map(), epochs: new Map(asg.rows.map((a) => [a.participant_id, Number(a.move_epoch)])), leads: new Map(), q: Promise.resolve(), active: on, deadline: on ? s.rows[0].deadline : null, rooms: new Map(rooms.rows.map((r) => [r.id, r.name])), map: new Map(on ? asg.rows.filter((a) => a.room_id).map((a) => [a.participant_id, a.room_id]) : []) };
    if (on) for (const l of ld.rows) { const e = m.leads.get(l.participant_id) || { room: l.room_id, caps: new Set() }; e.caps.add(l.capability); m.leads.set(l.participant_id, e); }
    if (meetings.has(mid)) return meetings.get(mid); meetings.set(mid, m); return m;
  }
  const scopeOf = (mid, pid) => meetings.get(mid)?.map.get(pid) ?? null;
  const epochOf = (mid, pid) => meetings.get(mid)?.epochs.get(pid) ?? 0;
  /** a lead's powers exist only while the person is in the room they lead and the rooms are open (the scope is the authority, so a stale grant can never act) */
  const mayLead = (mid, pid, cap) => { const m = meetings.get(mid), l = m?.leads.get(pid); return !!(m?.active && l && l.caps.has(cap) && scopeOf(mid, pid) === l.room); };
  const capsOf = (mid, pid) => { const m = meetings.get(mid), l = m?.leads.get(pid); return m?.active && l && scopeOf(mid, pid) === l.room ? [...l.caps] : []; };
  const leadSocks = (mid, rid, cap) => [...sockets(mid)].filter(([p]) => scopeOf(mid, p) === rid && mayLead(mid, p, cap)).map(([, sid]) => sid);
  const sameScope = (mid, a, b) => scopeOf(mid, a) === scopeOf(mid, b);
  const sockets = (mid) => active.get(mid) || new Map();
  const userOf = (sid) => io.sockets?.sockets?.get(sid)?.data?.user;
  /** deliver to the people in `fromPid`'s scope (not to them unless self) */
  function emitScope(mid, fromPid, event, payload, { self = false } = {}) {
    const sc = scopeOf(mid, fromPid);
    for (const [p, sid] of sockets(mid)) if ((self || p !== fromPid) && scopeOf(mid, p) === sc) io.to(sid).emit(event, payload);
  }
  /** deliver to everybody currently in one scope (null = main) */
  function emitToScope(mid, scope, event, payload) { for (const [p, sid] of sockets(mid)) if (scopeOf(mid, p) === scope) io.to(sid).emit(event, payload); }
  const hostSocks = (mid) => [...sockets(mid)].filter(([, sid]) => userOf(sid)?.role === 'host').map(([, sid]) => sid);
  const emitHosts = (mid, event, payload) => { for (const sid of hostSocks(mid)) io.to(sid).emit(event, payload); };
  /** everybody in one scope, plus every host wherever they are (a host oversees all rooms) */
  function emitScopeAndHosts(mid, scope, event, payload) { for (const [p, sid] of sockets(mid)) if (scopeOf(mid, p) === scope || userOf(sid)?.role === 'host') io.to(sid).emit(event, payload); }
  /** the gate every relayed WebRTC signal passes: same scope, and not made before the sender's last move. Returns the RECIPIENT's epoch to stamp on it. */
  function signalGate(mid, from, to, data) {
    if (!sameScope(mid, from, to)) return { error: 'Participant offline' };          // never across rooms
    if (data?.se !== undefined && data.se !== epochOf(mid, from)) return { error: 'Stale room epoch' };          // sent before this person's last move: it belongs to a connection that no longer exists
    return { toEpoch: epochOf(mid, to) };
  }
  const scopedList = (mid, pid) => [...sockets(mid).keys()].filter((p) => sameScope(mid, p, pid));
  function scopeInfo(mid, pid) { const m = meetings.get(mid); const rid = scopeOf(mid, pid); return { active: !!m?.active, epoch: epochOf(mid, pid), roomId: rid, roomName: rid ? m.rooms.get(rid) || '' : null, deadline: m?.active && m.deadline ? new Date(m.deadline).toISOString() : null }; }
  function namesOf(mid, pids) { const out = {}; for (const p of pids) { const u = userOf(sockets(mid).get(p)); if (u?.name) out[p] = u.name; } return out; }

  /** move one person: the old scope sees them leave, the new scope sees them arrive, they get a new roster and their page rebuilds its peer connections */
  function move(mid, pid, to) {
    const m = meetings.get(mid); const from = scopeOf(mid, pid); if (from === to) return;
    if (to) m.map.set(pid, to); else m.map.delete(pid);
    const epoch = (m.epochs.get(pid) || 0) + 1; m.epochs.set(pid, epoch); m.media.set(pid, 'switching'); m.leads.delete(pid);          // a new epoch: every signal made before this move is stale. Leads lose their powers with the room.
    m.q = m.q.then(() => recordMove(mid, pid, from, to, epoch)).catch((e) => console.error('[breakouts] move log failed', e.message));
    const sid = sockets(mid).get(pid), u = sid ? userOf(sid) : null; if (sid) m.pending.set(pid, Date.now());          // 'connecting' until their page says its new peer connections are up (breakout-ready)
    for (const [p, s] of sockets(mid)) { if (p === pid) continue; const sc = scopeOf(mid, p);
      if (sc === from) io.to(s).emit('participant-offline', { participantId: pid });
      if (sc === to && u) io.to(s).emit('participant-online', { participantId: pid, name: u.name, role: u.role }); }
    if (sid) { const mates = scopedList(mid, pid); io.to(sid).emit('breakout-scope', scopeInfo(mid, pid)); io.to(sid).emit('names', namesOf(mid, mates)); io.to(sid).emit('roster', mates); }
  }
  async function recordMove(mid, pid, from, to, epoch) {
    await db.query(`INSERT INTO more_breakout_assignments(meeting_id, participant_id, room_id, move_epoch) VALUES ($1,$2,$3,$4) ON CONFLICT (meeting_id, participant_id) DO UPDATE SET move_epoch=GREATEST(more_breakout_assignments.move_epoch, EXCLUDED.move_epoch)`, [mid, pid, to, epoch]);
    await db.query("UPDATE more_breakout_moves SET state='superseded' WHERE meeting_id=$1 AND participant_id=$2 AND state='pending'", [mid, pid]);
    await db.query('INSERT INTO more_breakout_moves(meeting_id, participant_id, from_room, to_room, epoch) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [mid, pid, from, to, epoch]);
    await db.query('DELETE FROM more_breakout_leads WHERE meeting_id=$1 AND participant_id=$2 AND room_id IS DISTINCT FROM $3', [mid, pid, to]);
  }
  function applyScopes(mid, next) {                                    // next: Map(pid -> roomId) for the people who should be in a room; everyone else is main
    const m = meetings.get(mid); const all = new Set([...m.map.keys(), ...next.keys()]);
    for (const pid of all) move(mid, pid, next.get(pid) ?? null);
  }
  const broadcast = (mid) => { for (const [, sid] of sockets(mid)) io.to(sid).emit('breakouts-changed', {}); };
  const logEvent = (mid, actor, kind, payload) => db.query('INSERT INTO more_events(meeting_id, actor_id, kind, payload) VALUES ($1,$2,$3,$4)', [mid, actor, kind, JSON.stringify(payload)]).catch((e) => console.error('[breakouts] audit failed', e.message));

  async function state(mid, req) {
    const m = await ensure(mid); const host = req.user.role === 'host', me = scopeInfo(mid, req.user.participantId);
    const out = { me, session: { active: m.active, deadline: me.deadline }, limits: LIMITS };
    if (!host) {
      out.me.caps = capsOf(mid, req.user.participantId);
      if (me.roomId) out.me.help = (await db.query("SELECT id FROM more_breakout_help WHERE meeting_id=$1 AND requester_id=$2 AND status='open'", [mid, req.user.participantId])).rows[0]?.id || null;
      if (me.roomId && out.me.caps.includes('help_triage')) out.me.roomHelp = (await db.query("SELECT h.id, h.created_at, p.display_name FROM more_breakout_help h JOIN participants p ON p.id=h.requester_id WHERE h.meeting_id=$1 AND h.room_id=$2 AND h.status='open' ORDER BY h.created_at", [mid, me.roomId])).rows.map((h) => ({ id: h.id, name: h.display_name, at: h.created_at }));
      return out;
    }
    out.help = (await db.query("SELECT h.id, h.room_id, h.created_at, p.display_name FROM more_breakout_help h JOIN participants p ON p.id=h.requester_id WHERE h.meeting_id=$1 AND h.status='open' ORDER BY h.created_at", [mid])).rows.map((h) => ({ id: h.id, roomId: h.room_id, roomName: m.rooms.get(h.room_id) || '', name: h.display_name, at: h.created_at }));
    const [rooms, ppl, asg] = await Promise.all([
      db.query('SELECT id, name FROM more_breakout_rooms WHERE meeting_id=$1 ORDER BY created_at, id', [mid]),
      db.query("SELECT id, display_name, role FROM participants WHERE meeting_id=$1 AND admission='admitted' ORDER BY display_name", [mid]),
      db.query('SELECT participant_id, room_id FROM more_breakout_assignments WHERE meeting_id=$1 AND room_id IS NOT NULL', [mid]),
    ]);
    const of = new Map(asg.rows.map((a) => [a.participant_id, a.room_id])); const online = sockets(mid);
    const person = (p) => ({ id: p.id, name: p.display_name, role: p.role, online: online.has(p.id), connecting: online.has(p.id) && Date.now() - (m.pending.get(p.id) || 0) < 20000, media: m.media.get(p.id) || 'unknown', caps: capsOf(mid, p.id), epoch: epochOf(mid, p.id) });
    const members = (rid) => ppl.rows.filter((p) => p.role !== 'host' && of.get(p.id) === rid).map(person);
    out.rooms = rooms.rows.map((r) => ({ id: r.id, name: r.name, members: members(r.id) }));
    out.unassigned = ppl.rows.filter((p) => p.role !== 'host' && !of.get(p.id)).map(person); out.hostRoom = of.get(req.user.participantId) || null;
    return out;
  }

  app.get(paths(''), auth, member, run(async (req, res) => res.set('Cache-Control', 'no-store').json(await state(req.params.id, req))));
  app.post(paths('/rooms'), auth, member, hostOnly, run(async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''; if (!name || name.length > LIMITS.nameMax) throw bad(400, 'Give the room a name (up to 60 characters)');
    const mid = req.params.id; const m = await ensure(mid); if (m.rooms.size >= LIMITS.maxRooms) throw bad(409, 'At most ' + LIMITS.maxRooms + ' rooms');
    const { rows } = await db.query('INSERT INTO more_breakout_rooms(meeting_id, name) VALUES ($1,$2) RETURNING id', [mid, name]); m.rooms.set(rows[0].id, name);
    await logEvent(mid, req.user.participantId, 'breakout.room.created', { id: rows[0].id, name }); broadcast(mid); res.status(201).json({ id: rows[0].id, name });
  }));
  app.delete(paths('/rooms/:rid'), auth, member, hostOnly, run(async (req, res) => {
    const mid = req.params.id, m = await ensure(mid); if (m.active) throw bad(409, 'Bring everyone back before deleting rooms'); if (!UUID.test(req.params.rid)) throw bad(400, 'Invalid room');
    const r = await db.query('DELETE FROM more_breakout_rooms WHERE id=$1 AND meeting_id=$2', [req.params.rid, mid]); if (!r.rowCount) throw bad(404, 'Room not found'); m.rooms.delete(req.params.rid);
    await logEvent(mid, req.user.participantId, 'breakout.room.deleted', { id: req.params.rid }); broadcast(mid); res.json({ ok: true });
  }));
  const closeHelp = (mid, pid, why = 'cancelled') => (pid
    ? db.query("UPDATE more_breakout_help SET status=$3, resolved_at=now() WHERE meeting_id=$1 AND requester_id=$2 AND status='open'", [mid, pid, why])
    : db.query("UPDATE more_breakout_help SET status=$2, resolved_at=now() WHERE meeting_id=$1 AND status='open'", [mid, why]));
  async function assignOne(mid, m, pid, rid) {
    if (!UUID.test(pid)) throw bad(400, 'Invalid participant'); if (rid !== null && (!UUID.test(String(rid)) || !m.rooms.has(rid))) throw bad(404, 'Room not found');
    const p = await db.query("SELECT role FROM participants WHERE id=$1 AND meeting_id=$2 AND admission='admitted'", [pid, mid]); if (!p.rows[0]) throw bad(404, 'Participant not found');
    if (p.rows[0].role === 'host') throw bad(400, 'The host moves with Visit a room');
    await db.query(`INSERT INTO more_breakout_assignments(meeting_id, participant_id, room_id) VALUES ($1,$2,$3) ON CONFLICT (meeting_id, participant_id) DO UPDATE SET room_id=EXCLUDED.room_id, updated_at=now()`, [mid, pid, rid]);
    if (m.active) { if (scopeOf(mid, pid) !== rid) await closeHelp(mid, pid); move(mid, pid, rid); }
  }
  app.post(paths('/assign'), auth, member, hostOnly, run(async (req, res) => {
    const mid = req.params.id, m = await ensure(mid); const rid = req.body?.roomId ?? null;
    await assignOne(mid, m, String(req.body?.participantId || ''), rid); await logEvent(mid, req.user.participantId, 'breakout.assigned', { participantId: req.body.participantId, roomId: rid }); broadcast(mid); res.json({ ok: true });
  }));
  app.post(paths('/autosplit'), auth, member, hostOnly, run(async (req, res) => {
    const n = req.body?.rooms; if (!Number.isInteger(n) || n < 2 || n > LIMITS.maxRooms) throw bad(400, 'Choose 2 to ' + LIMITS.maxRooms + ' rooms');
    const mid = req.params.id, m = await ensure(mid); if (m.active) throw bad(409, 'Bring everyone back before splitting again');
    while (m.rooms.size < n) { const name = 'Room ' + (m.rooms.size + 1); const { rows } = await db.query('INSERT INTO more_breakout_rooms(meeting_id, name) VALUES ($1,$2) RETURNING id', [mid, name]); m.rooms.set(rows[0].id, name); }
    const ids = [...m.rooms.keys()].slice(0, n);
    const { rows: ppl } = await db.query("SELECT id FROM participants WHERE meeting_id=$1 AND admission='admitted' AND role<>'host'", [mid]);
    const here = ppl.map((p) => p.id).filter((p) => sockets(mid).has(p)); for (let i = here.length - 1; i > 0; i--) { const j = randomInt(i + 1); [here[i], here[j]] = [here[j], here[i]]; }
    for (const [i, pid] of here.entries()) await assignOne(mid, m, pid, ids[i % ids.length]);
    await logEvent(mid, req.user.participantId, 'breakout.autosplit', { rooms: n, people: here.length }); broadcast(mid); res.json({ rooms: n, assigned: here.length });
  }));
  app.post(paths('/start'), auth, member, hostOnly, run(async (req, res) => {
    const minutes = req.body?.minutes; if (!Number.isInteger(minutes) || minutes < LIMITS.minMinutes || minutes > LIMITS.maxMinutes) throw bad(400, 'Choose 1 to 240 minutes');
    const mid = req.params.id, m = await ensure(mid); if (m.active) throw bad(409, 'Breakout rooms are already open');
    const rec = await db.query("SELECT 1 FROM recording_sessions WHERE meeting_id=$1 AND status IN ('awaiting','blocked','ready','recording','paused') LIMIT 1", [mid]).catch(() => ({ rowCount: 0 }));
    if (rec.rowCount) throw bad(409, 'Stop the recording first: it would only capture the main room.');
    const { rows: asg } = await db.query("SELECT a.participant_id, a.room_id FROM more_breakout_assignments a JOIN participants p ON p.id=a.participant_id WHERE a.meeting_id=$1 AND a.room_id IS NOT NULL AND p.admission='admitted' AND p.role<>'host'", [mid]);
    if (!m.rooms.size || !asg.length) throw bad(409, 'Create rooms and put at least one person in a room first');
    const up = await db.query(`INSERT INTO more_breakout_sessions(meeting_id, state, deadline, started_by, revision) VALUES ($1,'active', now() + make_interval(mins => $2), $3, 1)
      ON CONFLICT (meeting_id) DO UPDATE SET state='active', deadline=EXCLUDED.deadline, started_by=EXCLUDED.started_by, revision=more_breakout_sessions.revision+1, updated_at=now() RETURNING deadline`, [mid, minutes, req.user.participantId]);
    m.active = true; m.deadline = up.rows[0].deadline; applyScopes(mid, new Map(asg.map((a) => [a.participant_id, a.room_id])));
    await logEvent(mid, req.user.participantId, 'breakout.started', { minutes, people: asg.length }); broadcast(mid); res.json({ deadline: new Date(m.deadline).toISOString() });
  }));
  async function end(mid, actor, reason) {
    const m = await ensure(mid); await db.query("UPDATE more_breakout_sessions SET state='idle', deadline=NULL, revision=revision+1, updated_at=now() WHERE meeting_id=$1", [mid]); await closeHelp(mid);
    await db.query('UPDATE more_breakout_assignments SET room_id=NULL, updated_at=now() WHERE meeting_id=$1 AND room_id IS NOT NULL', [mid]);
    m.active = false; m.deadline = null; applyScopes(mid, new Map()); m.leads.clear(); await db.query('DELETE FROM more_breakout_leads WHERE meeting_id=$1', [mid]);
    for (const [, sid] of sockets(mid)) io.to(sid).emit('breakout-ended', { reason }); await logEvent(mid, actor, 'breakout.ended', { reason }); broadcast(mid);
  }
  app.post(paths('/recall'), auth, member, hostOnly, run(async (req, res) => { const m = await ensure(req.params.id); if (!m.active) throw bad(409, 'Breakout rooms are not open'); await end(req.params.id, req.user.participantId, 'recalled'); res.json({ ok: true }); }));
  app.post(paths('/visit'), auth, member, hostOnly, run(async (req, res) => {                         // the host walks into a room (or back to the main room) to listen and help
    const mid = req.params.id, m = await ensure(mid); if (!m.active) throw bad(409, 'Breakout rooms are not open'); const rid = req.body?.roomId ?? null;
    if (rid !== null && (!UUID.test(String(rid)) || !m.rooms.has(rid))) throw bad(404, 'Room not found');
    await db.query(`INSERT INTO more_breakout_assignments(meeting_id, participant_id, room_id) VALUES ($1,$2,$3) ON CONFLICT (meeting_id, participant_id) DO UPDATE SET room_id=EXCLUDED.room_id, updated_at=now()`, [mid, req.user.participantId, rid]);       // remembered, so a reconnect returns the host to the room
    move(mid, req.user.participantId, rid); broadcast(mid); res.json({ roomId: rid });
  }));

  // a person in a room goes back to the main room by themselves (the host can still move them again). The scope changes on the server first, so media from the room is refused at once; their page then rebuilds its peers.
  app.post(paths('/return'), auth, member, run(async (req, res) => {
    if (req.user.role === 'host') throw bad(400, 'The host uses Leave room');
    const mid = req.params.id, pid = req.user.participantId, m = await ensure(mid); if (!m.active || scopeOf(mid, pid) === null) throw bad(409, 'You are not in a breakout room');
    const from = scopeOf(mid, pid);
    await db.query(`INSERT INTO more_breakout_assignments(meeting_id, participant_id, room_id) VALUES ($1,$2,NULL) ON CONFLICT (meeting_id, participant_id) DO UPDATE SET room_id=NULL, updated_at=now()`, [mid, pid]);
    await closeHelp(mid, pid); move(mid, pid, null);
    await logEvent(mid, pid, 'breakout.returned', { from }); broadcast(mid); res.json({ ok: true });
  }));
  // ask for help: the host (and only the host) is told which room needs them
  app.post(paths('/help'), auth, member, run(async (req, res) => {
    if (req.user.role === 'host') throw bad(403, 'Only people in a room can ask for help');
    const mid = req.params.id, pid = req.user.participantId, m = await ensure(mid), rid = scopeOf(mid, pid); if (!m.active || !rid) throw bad(409, 'You are not in a breakout room');
    if ((await db.query("SELECT 1 FROM more_breakout_help WHERE meeting_id=$1 AND requester_id=$2 AND status='open'", [mid, pid])).rowCount) throw bad(409, 'You already asked for help. The host has been told.');
    if ((await db.query("SELECT 1 FROM more_breakout_help WHERE meeting_id=$1 AND requester_id=$2 AND created_at > now() - interval '30 seconds'", [mid, pid])).rowCount) throw bad(429, 'Please wait a moment before asking again');
    let id; try { id = (await db.query('INSERT INTO more_breakout_help(meeting_id, room_id, requester_id) VALUES ($1,$2,$3) RETURNING id', [mid, rid, pid])).rows[0].id; } catch (e) { if (e.code === '23505') throw bad(409, 'You already asked for help. The host has been told.'); throw e; }
    const info = { id, roomId: rid, roomName: m.rooms.get(rid) || '', name: req.user.name || 'A participant' };
    emitHosts(mid, 'breakout-help', info); emitHosts(mid, 'breakouts-changed', {}); for (const sid of leadSocks(mid, rid, 'help_triage')) { io.to(sid).emit('breakout-help', info); io.to(sid).emit('breakouts-changed', {}); } await logEvent(mid, pid, 'breakout.help.requested', { id, roomId: rid }); res.status(201).json({ id });
  }));
  app.delete(paths('/help'), auth, member, run(async (req, res) => {
    const mid = req.params.id; const r = await db.query("UPDATE more_breakout_help SET status='cancelled', resolved_at=now() WHERE meeting_id=$1 AND requester_id=$2 AND status='open' RETURNING id", [mid, req.user.participantId]);
    if (r.rowCount) emitHosts(mid, 'breakouts-changed', {}); res.json({ ok: true });
  }));
  app.post(paths('/help/:hid/resolve'), auth, member, run(async (req, res) => {
    const mid = req.params.id; if (!UUID.test(req.params.hid)) throw bad(400, 'Invalid request'); await ensure(mid);
    const own = req.user.role === 'host' ? null : scopeOf(mid, req.user.participantId);          // a lead resolves requests of their own room only
    if (req.user.role !== 'host' && !(own && mayLead(mid, req.user.participantId, 'help_triage'))) throw bad(403, 'Only the host or a room lead can do this');
    const r = await db.query("UPDATE more_breakout_help SET status='resolved', resolved_at=now() WHERE id=$1 AND meeting_id=$2 AND status='open' AND ($3::uuid IS NULL OR room_id=$3) RETURNING requester_id", [req.params.hid, mid, own]); if (!r.rowCount) throw bad(404, 'Help request not found');
    const sid = sockets(mid).get(r.rows[0].requester_id); if (sid) io.to(sid).emit('breakout-help-resolved', { id: req.params.hid });
    emitHosts(mid, 'breakouts-changed', {}); await logEvent(mid, req.user.participantId, 'breakout.help.resolved', { id: req.params.hid }); res.json({ ok: true });
  }));
  /** a page says its peer connections for the new scope are up (or gave up waiting): the host's list stops showing 'connecting' */
  function ready(mid, pid, report) {
    const m = meetings.get(mid); if (!m) return; const epoch = Number(report?.epoch), ok = report?.ok !== false;
    if (!Number.isSafeInteger(epoch) || epoch !== epochOf(mid, pid)) return;          // a report for an older move says nothing about the current one
    const had = m.pending.delete(pid); m.media.set(pid, ok ? 'client_reported' : 'failed');
    m.q = m.q.then(() => db.query("UPDATE more_breakout_moves SET state=$4, reported_at=now() WHERE meeting_id=$1 AND participant_id=$2 AND epoch=$3 AND state='pending'", [mid, pid, epoch, ok ? 'client_reported' : 'failed'])).catch(() => {});
    if (had || !ok) emitHosts(mid, 'breakouts-changed', {});
  }
  /** group leads (V1.2): the host gives a person inside a room a few room-only powers. Empty list = take them away. */
  app.put(paths('/rooms/:rid/leads/:pid'), auth, member, hostOnly, run(async (req, res) => {
    const mid = req.params.id, { rid, pid } = req.params, m = await ensure(mid); if (!m.active) throw bad(409, 'Breakout rooms are not open');
    if (!UUID.test(rid) || !UUID.test(pid)) throw bad(400, 'Invalid request'); const caps = req.body?.capabilities;
    if (!Array.isArray(caps) || caps.length > CAPS.length || caps.some((c) => !CAPS.includes(c))) throw bad(400, 'Unknown capability');
    if (scopeOf(mid, pid) !== rid) throw bad(409, 'A lead must be inside the room they lead');
    const p = await db.query("SELECT role FROM participants WHERE id=$1 AND meeting_id=$2 AND admission='admitted'", [pid, mid]); if (!p.rows[0] || p.rows[0].role === 'host') throw bad(404, 'Participant not found');
    const set = [...new Set(caps)]; const c = await db.connect();
    try { await c.query('BEGIN'); await c.query('DELETE FROM more_breakout_leads WHERE meeting_id=$1 AND participant_id=$2', [mid, pid]);
      for (const cap of set) await c.query('INSERT INTO more_breakout_leads(meeting_id, room_id, participant_id, capability, granted_by) VALUES ($1,$2,$3,$4,$5)', [mid, rid, pid, cap, req.user.participantId]); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    if (set.length) m.leads.set(pid, { room: rid, caps: new Set(set) }); else m.leads.delete(pid);
    await logEvent(mid, req.user.participantId, 'breakout.lead.updated', { participantId: pid, roomId: rid, capabilities: set });
    const sid = sockets(mid).get(pid); if (sid) io.to(sid).emit('breakouts-changed', {}); emitHosts(mid, 'breakouts-changed', {}); res.json({ participantId: pid, roomId: rid, capabilities: set });
  }));
  /** a short message to one room (or, from the host, to all rooms). A lead needs room_announcement and reaches only their own room. */
  app.post(paths('/announce'), auth, member, run(async (req, res) => {
    const mid = req.params.id, m = await ensure(mid), pid = req.user.participantId; if (!m.active) throw bad(409, 'Breakout rooms are not open');
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''; if (!text || text.length > 300) throw bad(400, 'Write a message of up to 300 characters');
    let rid = req.body?.roomId ?? null;
    if (req.user.role !== 'host') { rid = scopeOf(mid, pid); if (!rid || !mayLead(mid, pid, 'room_announcement')) throw bad(403, 'Only the host or a room lead can do this'); }
    else if (rid !== null && (!UUID.test(String(rid)) || !m.rooms.has(rid))) throw bad(404, 'Room not found');
    const msg = { text, from: req.user.name || 'Host', roomId: rid, at: new Date().toISOString() };
    for (const [p, sid] of sockets(mid)) { const sc = scopeOf(mid, p); if (rid ? sc === rid : sc !== null) io.to(sid).emit('breakout-announcement', msg); }
    await logEvent(mid, pid, 'breakout.announced', { roomId: rid, length: text.length }); res.json({ ok: true });
  }));

  // sessions whose time is up end by themselves: ONE atomic UPDATE decides which instance ends which session
  async function tick() {
    const { rows } = await db.query("UPDATE more_breakout_sessions SET state='idle', deadline=NULL, revision=revision+1, updated_at=now() WHERE state='active' AND deadline <= now() RETURNING meeting_id, started_by");
    for (const r of rows) { try { const m = await ensure(r.meeting_id); await db.query('UPDATE more_breakout_assignments SET room_id=NULL, updated_at=now() WHERE meeting_id=$1 AND room_id IS NOT NULL', [r.meeting_id]); await closeHelp(r.meeting_id); m.active = false; m.deadline = null; applyScopes(r.meeting_id, new Map()); m.leads.clear(); await db.query('DELETE FROM more_breakout_leads WHERE meeting_id=$1', [r.meeting_id]);
      for (const [, sid] of sockets(r.meeting_id)) io.to(sid).emit('breakout-ended', { reason: 'time' }); await logEvent(r.meeting_id, r.started_by || r.meeting_id, 'breakout.ended', { reason: 'time' }); broadcast(r.meeting_id); } catch (e) { console.error('[breakouts] expiry failed', e.message); } }
    return rows.length;
  }
  const timer = setInterval(() => { tick().catch((e) => console.error('[breakouts] tick failed', e.message)); }, tickMs); timer.unref?.();

  // recording is a local capture of the host's page: with rooms open it would only hold one room, so it cannot start then
  const blockRecordingStart = async (req, res, next) => { try { const m = await ensure(req.params.id); if (m.active) return fail(res, 409, 'Recording is unavailable while breakout rooms are open (it would only capture one room). Bring everyone back first.'); next(); } catch { fail(res, 500, 'Database unavailable'); } };
  app.use(['/api/meetings/:id/recording/start', '/api/v1/meetings/:id/recording/start'], blockRecordingStart);

  return { ensure, scopeOf, epochOf, signalGate, mayLead, capsOf, assign: async (mid, pid, rid) => { await assignOne(mid, await ensure(mid), pid, rid); }, broadcast, settle: (mid) => meetings.get(mid)?.q, logEvent, hostSocks, sameScope, emitScope, emitToScope, emitScopeAndHosts, ready, scopedList, scopeInfo, namesOf, tick, stop: () => clearInterval(timer), isActive: (mid) => !!meetings.get(mid)?.active };
}
