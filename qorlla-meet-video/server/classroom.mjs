// Meet Smart Classroom (v4.31): the Room Mission Board (V1.3), timed exercises, the room whiteboard and group reports (V1.4 to V1.7), and the host's classroom dashboard and balanced plan.
//
// Adapted to Meet from the supplied qorlla-smartrooms-v13 and qorlla-smartclassroom-v14-v17 packages. The packages' adapter seams (verifyActor, moveParticipant, outbox, a "cohost" role, `meet_breakouts.*` tables)
// do not exist in Meet, so the same rules sit on Meet's token (`auth`), admitted-participant check (`member`), the breakout SCOPE (server/breakouts.mjs) and `more_*` tables.
//
// Who may do what (the scope is the authority, never a role or room id sent by the browser):
//  * a person in a room reads their own room's board, takes part in its exercises, draws on its whiteboard and updates the tasks given to them;
//  * the host (any room), or a lead holding `room_notes` (their own room), creates missions, tasks, exercises, reports, and clears the whiteboard;
//  * a person outside a room gets 404: another room does not exist for them. Once the rooms close, guests lose access; the host keeps reading (and exporting) everything.
// Every change is audited in `more_events` (kind classroom.*) and tells the people of that room (and the host) to reload: event `classroom-changed`.
// Honest limits: the AI report worker is NOT built (it needs the Portal AI gateway, consent and quota; see docs/MEET_BREAKOUTS.md); the whiteboard is an operation log replayed by cursor, not a CRDT.
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CLASS_LIMITS = Object.freeze({ title: 180, text: 12000, report: 20000, missions: 30, tasks: 60, exercises: 30, boardOps: 5000, maxPerRoom: 30 });
const bad = (status, error) => Object.assign(new Error(error), { status });
const str = (v, max, { empty = false } = {}) => typeof v === 'string' && (empty || v.trim().length > 0) && v.length <= max;

/** deterministic balanced plan: names sorted, dealt round-robin. Pure, so it can be tested; applying it goes through the move path (epoch, scope, roster). */
export function balancedPlan(people, roomIds, maxPerRoom = 8) {
  if (!Array.isArray(people) || !Array.isArray(roomIds) || !roomIds.length) throw bad(400, 'Choose at least one room');
  if (!Number.isInteger(maxPerRoom) || maxPerRoom < 1 || maxPerRoom > CLASS_LIMITS.maxPerRoom) throw bad(400, 'Room size must be 1 to ' + CLASS_LIMITS.maxPerRoom);
  if (new Set(roomIds).size !== roomIds.length) throw bad(400, 'Duplicate rooms');
  if (people.length > roomIds.length * maxPerRoom) throw bad(409, 'Not enough room capacity for ' + people.length + ' people');
  return [...people].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map((p, i) => ({ participantId: p.id, name: p.name, roomId: roomIds[i % roomIds.length] }));
}

export function registerClassroom({ app, io, db, auth, member, fail, breakouts: B, tickMs = 3000 }) {
  const paths = (p) => ['/api/meetings/:id/breakouts' + p, '/api/v1/meetings/:id/breakouts' + p];
  const hostOnly = (req, res, next) => (req.user.role === 'host' ? next() : fail(res, 403, 'Only the host can do this'));
  const run = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { if (e.status) return fail(res, e.status, e.message); console.error('[classroom]', e.message); fail(res, 500, 'Something went wrong'); } };
  const inRoom = (mid, rid, kind) => B.emitScopeAndHosts(mid, rid, 'classroom-changed', { roomId: rid, kind });
  const audit = (mid, actor, kind, payload) => B.logEvent(mid, actor, 'classroom.' + kind, payload);
  const uuid = (v, what) => { if (!UUID.test(String(v))) throw bad(400, 'Invalid ' + what); return String(v); };

  /** the one gate: which room, may this person see it, may they manage it, and (for writes) are the rooms open */
  async function gate(req, rid, { manage = false, write = false } = {}) {
    const mid = req.params.id, pid = req.user.participantId, m = await B.ensure(mid), host = req.user.role === 'host';
    if (!UUID.test(String(rid)) || !m.rooms.has(rid)) throw bad(404, 'Room not found');
    if (!host && (!m.active || B.scopeOf(mid, pid) !== rid)) throw bad(404, 'Room not found');          // another room does not exist for you
    if (write && !m.active) throw bad(409, 'Breakout rooms are not open');
    const lead = !host && B.mayLead(mid, pid, 'room_notes');
    if (manage && !host && !lead) throw bad(403, 'Only the host or a room lead can do this');
    return { mid, pid, m, host, rid, manager: host || lead, name: m.rooms.get(rid) };
  }
  async function roomOf(req, table, id, what) {          // a mission / exercise id names its room; the caller then passes the gate for that room
    const r = await db.query(`SELECT room_id FROM ${table} WHERE id=$1 AND meeting_id=$2`, [uuid(id, what), req.params.id]); if (!r.rows[0]) throw bad(404, 'Not found'); return r.rows[0].room_id;
  }

  // ------------------------------------------------------------------ the board of one room
  async function boardOf(g) {
    const { mid, rid } = g;
    const [ms, ts, rp, ex, sb, rs, mem] = await Promise.all([
      db.query('SELECT id, title, instructions, state, version, created_at FROM more_room_missions WHERE meeting_id=$1 AND room_id=$2 ORDER BY created_at, id', [mid, rid]),
      db.query('SELECT t.id, t.mission_id, t.title, t.assignee_id, t.state, t.version, p.display_name FROM more_mission_tasks t JOIN more_room_missions m ON m.id=t.mission_id LEFT JOIN participants p ON p.id=t.assignee_id WHERE m.meeting_id=$1 AND m.room_id=$2 ORDER BY t.updated_at, t.id', [mid, rid]),
      db.query('SELECT r.mission_id, r.report, r.submitted_at, p.display_name FROM more_mission_reports r JOIN more_room_missions m ON m.id=r.mission_id LEFT JOIN participants p ON p.id=r.submitted_by WHERE m.meeting_id=$1 AND m.room_id=$2', [mid, rid]),
      db.query("SELECT id, mission_id, title, prompt, duration_s, started_at, ends_at, CASE WHEN state='running' AND ends_at<=now() THEN 'closed' ELSE state END AS state, GREATEST(0, EXTRACT(EPOCH FROM (ends_at - now())))::float AS left_s FROM more_class_exercises WHERE meeting_id=$1 AND room_id=$2 ORDER BY created_at, id", [mid, rid]),
      db.query('SELECT s.exercise_id, s.participant_id, s.answer, s.submitted_at, p.display_name FROM more_class_submissions s JOIN more_class_exercises e ON e.id=s.exercise_id LEFT JOIN participants p ON p.id=s.participant_id WHERE e.meeting_id=$1 AND e.room_id=$2 ORDER BY s.submitted_at', [mid, rid]),
      db.query('SELECT id, title, content, mission_id, created_at FROM more_class_reports WHERE meeting_id=$1 AND room_id=$2 ORDER BY created_at DESC LIMIT 30', [mid, rid]),
      db.query("SELECT p.id, p.display_name FROM more_breakout_assignments a JOIN participants p ON p.id=a.participant_id WHERE a.meeting_id=$1 AND a.room_id=$2 AND p.admission='admitted' ORDER BY p.display_name", [mid, rid]),
    ]);
    const taskOf = new Map(), reportOf = new Map(rp.rows.map((r) => [r.mission_id, { text: r.report, by: r.display_name, at: r.submitted_at }]));
    for (const t of ts.rows) { if (!taskOf.has(t.mission_id)) taskOf.set(t.mission_id, []); taskOf.get(t.mission_id).push({ id: t.id, title: t.title, assigneeId: t.assignee_id, assignee: t.display_name || null, state: t.state, version: Number(t.version) }); }
    const subs = new Map(); for (const s of sb.rows) { if (!subs.has(s.exercise_id)) subs.set(s.exercise_id, []); subs.get(s.exercise_id).push(s); }
    return {
      room: { id: rid, name: g.name }, canManage: g.manager, rooms: { open: g.m.active }, me: g.pid,
      missions: ms.rows.map((x) => { const t = taskOf.get(x.id) || []; return { id: x.id, title: x.title, instructions: x.instructions, state: x.state, version: Number(x.version), tasks: t, done: t.filter((y) => y.state === 'done').length, report: reportOf.get(x.id) || null }; }),
      exercises: ex.rows.map((x) => { const all = subs.get(x.id) || [], mine = all.find((s) => s.participant_id === g.pid);
        return { id: x.id, title: x.title, prompt: x.prompt, state: x.state, durationS: x.duration_s, leftS: x.state === 'running' ? Math.round(x.left_s) : 0, endsAt: x.ends_at, missionId: x.mission_id, submissions: all.length, mine: mine ? { answer: mine.answer, at: mine.submitted_at } : null,
          answers: g.manager ? all.map((s) => ({ name: s.display_name || 'Someone', answer: s.answer, at: s.submitted_at })) : undefined }; }),
      reports: rs.rows.map((x) => ({ id: x.id, title: x.title, content: x.content, missionId: x.mission_id, at: x.created_at })),
      members: mem.rows.map((p) => ({ id: p.id, name: p.display_name })),
    };
  }
  app.get(paths('/rooms/:rid/board'), auth, member, run(async (req, res) => { const g = await gate(req, req.params.rid); res.set('Cache-Control', 'no-store').json(await boardOf(g)); }));

  // missions and tasks
  app.post(paths('/rooms/:rid/missions'), auth, member, run(async (req, res) => {
    const g = await gate(req, req.params.rid, { manage: true, write: true }); const { title, instructions = '' } = req.body || {};
    if (!str(title, CLASS_LIMITS.title) || !str(instructions, CLASS_LIMITS.text, { empty: true })) throw bad(400, 'Give the mission a title (up to 180 characters)');
    if ((await db.query('SELECT count(*)::int AS n FROM more_room_missions WHERE meeting_id=$1 AND room_id=$2', [g.mid, g.rid])).rows[0].n >= CLASS_LIMITS.missions) throw bad(409, 'Too many missions in this room');
    const { rows } = await db.query('INSERT INTO more_room_missions(meeting_id, room_id, title, instructions, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [g.mid, g.rid, title.trim(), instructions, g.pid]);
    await audit(g.mid, g.pid, 'mission.created', { id: rows[0].id, roomId: g.rid }); inRoom(g.mid, g.rid, 'mission'); res.status(201).json({ id: rows[0].id });
  }));
  app.post(paths('/missions/:xid/tasks'), auth, member, run(async (req, res) => {
    const rid = await roomOf(req, 'more_room_missions', req.params.xid, 'mission'); const g = await gate(req, rid, { manage: true, write: true });
    const { title, assigneeId = null } = req.body || {}; if (!str(title, CLASS_LIMITS.title)) throw bad(400, 'Give the task a title (up to 180 characters)');
    const mi = (await db.query('SELECT state FROM more_room_missions WHERE id=$1', [req.params.xid])).rows[0]; if (mi.state !== 'open') throw bad(409, 'This mission is no longer open');
    if ((await db.query('SELECT count(*)::int AS n FROM more_mission_tasks WHERE mission_id=$1', [req.params.xid])).rows[0].n >= CLASS_LIMITS.tasks) throw bad(409, 'Too many tasks in this mission');
    if (assigneeId !== null && !(UUID.test(String(assigneeId)) && (await db.query('SELECT 1 FROM more_breakout_assignments WHERE meeting_id=$1 AND room_id=$2 AND participant_id=$3', [g.mid, rid, assigneeId])).rowCount)) throw bad(403, 'That person is not in this room');
    const { rows } = await db.query('INSERT INTO more_mission_tasks(mission_id, title, assignee_id) VALUES ($1,$2,$3) RETURNING id', [req.params.xid, title.trim(), assigneeId]);
    await audit(g.mid, g.pid, 'task.created', { id: rows[0].id, missionId: req.params.xid }); inRoom(g.mid, rid, 'task'); res.status(201).json({ id: rows[0].id });
  }));
  app.patch(paths('/tasks/:tid'), auth, member, run(async (req, res) => {
    const t = (await db.query('SELECT t.id, t.assignee_id, t.version, t.state, m.room_id, m.state AS mstate FROM more_mission_tasks t JOIN more_room_missions m ON m.id=t.mission_id WHERE t.id=$1 AND m.meeting_id=$2', [uuid(req.params.tid, 'task'), req.params.id])).rows[0]; if (!t) throw bad(404, 'Not found');
    const g = await gate(req, t.room_id, { write: true }); const { state, expectedVersion } = req.body || {};
    if (!['todo', 'doing', 'done'].includes(state) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw bad(400, 'Invalid task update');
    if (t.mstate !== 'open') throw bad(409, 'This mission is no longer open'); if (!g.manager && t.assignee_id !== g.pid) throw bad(403, 'This task is assigned to someone else');
    const r = await db.query('UPDATE more_mission_tasks SET state=$2, version=version+1, updated_at=now() WHERE id=$1 AND version=$3 RETURNING version', [t.id, state, expectedVersion]);          // optimistic: two people cannot silently overwrite each other
    if (!r.rowCount) throw bad(409, 'Someone changed this task first. The board was refreshed.');
    await audit(g.mid, g.pid, 'task.updated', { id: t.id, state }); inRoom(g.mid, t.room_id, 'task'); res.json({ id: t.id, state, version: Number(r.rows[0].version) });
  }));
  app.post(paths('/missions/:xid/report'), auth, member, run(async (req, res) => {
    const rid = await roomOf(req, 'more_room_missions', req.params.xid, 'mission'); const g = await gate(req, rid, { manage: true, write: true }); const report = req.body?.report;
    if (!str(report, CLASS_LIMITS.text)) throw bad(400, 'Write the report (up to 12000 characters)');
    const c = await db.connect();
    try { await c.query('BEGIN'); const u = await c.query("UPDATE more_room_missions SET state='submitted', version=version+1, updated_at=now() WHERE id=$1 AND state='open' RETURNING id", [req.params.xid]);
      if (!u.rowCount) { await c.query('ROLLBACK'); throw bad(409, 'This mission already has a report'); }
      await c.query('INSERT INTO more_mission_reports(mission_id, submitted_by, report) VALUES ($1,$2,$3)', [req.params.xid, g.pid, report]); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    await audit(g.mid, g.pid, 'mission.submitted', { id: req.params.xid }); inRoom(g.mid, rid, 'mission'); res.status(201).json({ id: req.params.xid, state: 'submitted' });
  }));

  // timed exercises: the DATABASE clock starts and ends them; one submission per person
  app.post(paths('/rooms/:rid/exercises'), auth, member, run(async (req, res) => {
    const g = await gate(req, req.params.rid, { manage: true, write: true }); const { title, prompt = '', durationSeconds = 900, missionId = null } = req.body || {};
    if (!str(title, CLASS_LIMITS.title) || !str(prompt, CLASS_LIMITS.text, { empty: true }) || !Number.isInteger(durationSeconds) || durationSeconds < 30 || durationSeconds > 14400) throw bad(400, 'Give the exercise a title and a length of 30 seconds to 4 hours');
    if (missionId !== null && !(UUID.test(String(missionId)) && (await db.query('SELECT 1 FROM more_room_missions WHERE id=$1 AND meeting_id=$2 AND room_id=$3', [missionId, g.mid, g.rid])).rowCount)) throw bad(404, 'Mission not found in this room');
    if ((await db.query('SELECT count(*)::int AS n FROM more_class_exercises WHERE meeting_id=$1 AND room_id=$2', [g.mid, g.rid])).rows[0].n >= CLASS_LIMITS.exercises) throw bad(409, 'Too many exercises in this room');
    const { rows } = await db.query('INSERT INTO more_class_exercises(meeting_id, room_id, mission_id, title, prompt, duration_s, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [g.mid, g.rid, missionId, title.trim(), prompt, durationSeconds, g.pid]);
    await audit(g.mid, g.pid, 'exercise.created', { id: rows[0].id, roomId: g.rid }); inRoom(g.mid, g.rid, 'exercise'); res.status(201).json({ id: rows[0].id, state: 'draft' });
  }));
  app.post(paths('/exercises/:eid/start'), auth, member, run(async (req, res) => {
    const rid = await roomOf(req, 'more_class_exercises', req.params.eid, 'exercise'); const g = await gate(req, rid, { manage: true, write: true });
    const r = await db.query("UPDATE more_class_exercises SET state='running', started_at=now(), ends_at=now() + make_interval(secs => duration_s) WHERE id=$1 AND state='draft' RETURNING ends_at", [req.params.eid]); if (!r.rowCount) throw bad(409, 'This exercise was already started');
    await audit(g.mid, g.pid, 'exercise.started', { id: req.params.eid }); inRoom(g.mid, rid, 'exercise'); res.json({ id: req.params.eid, state: 'running', endsAt: r.rows[0].ends_at });
  }));
  app.post(paths('/exercises/:eid/close'), auth, member, run(async (req, res) => {
    const rid = await roomOf(req, 'more_class_exercises', req.params.eid, 'exercise'); const g = await gate(req, rid, { manage: true, write: true });
    const r = await db.query("UPDATE more_class_exercises SET state='closed', ends_at=LEAST(ends_at, now()) WHERE id=$1 AND state='running'", [req.params.eid]); if (!r.rowCount) throw bad(409, 'This exercise is not running');
    await audit(g.mid, g.pid, 'exercise.closed', { id: req.params.eid }); inRoom(g.mid, rid, 'exercise'); res.json({ ok: true });
  }));
  app.post(paths('/exercises/:eid/submit'), auth, member, run(async (req, res) => {
    const rid = await roomOf(req, 'more_class_exercises', req.params.eid, 'exercise'); const g = await gate(req, rid, { write: true }); const answer = req.body?.answer;
    if (!str(answer, CLASS_LIMITS.text)) throw bad(400, 'Write your answer (up to 12000 characters)');
    const r = await db.query("INSERT INTO more_class_submissions(exercise_id, participant_id, answer) SELECT e.id, $2, $3 FROM more_class_exercises e WHERE e.id=$1 AND e.state='running' AND e.ends_at>now() ON CONFLICT (exercise_id, participant_id) DO NOTHING RETURNING id", [req.params.eid, g.pid, answer]);
    if (!r.rowCount) { const dup = await db.query('SELECT 1 FROM more_class_submissions WHERE exercise_id=$1 AND participant_id=$2', [req.params.eid, g.pid]); throw bad(409, dup.rowCount ? 'You already submitted an answer' : 'Time is up for this exercise'); }
    await audit(g.mid, g.pid, 'exercise.submitted', { id: req.params.eid }); inRoom(g.mid, rid, 'submission'); res.status(201).json({ id: r.rows[0].id });
  }));
  const closeExpired = async () => {          // the database clock is the authority; this only tells the room so every screen stops at the same moment
    const { rows } = await db.query("UPDATE more_class_exercises SET state='closed' WHERE state='running' AND ends_at<=now() RETURNING meeting_id, room_id");
    const seen = new Set(); for (const r of rows) { const k = r.meeting_id + r.room_id; if (!seen.has(k)) { seen.add(k); inRoom(r.meeting_id, r.room_id, 'exercise'); } } return rows.length;
  };
  const timer = setInterval(() => { closeExpired().catch((e) => console.error('[classroom] expiry failed', e.message)); }, tickMs); timer.unref?.();

  // the room whiteboard: an append-only operation log; everybody in the room (and the host) replays it from a cursor, so a late joiner or a reconnect sees the same board
  const rate = new Map();          // pid -> recent op times (a person may add 30 operations per 10 s)
  const okRate = (pid) => { const now = Date.now(), a = (rate.get(pid) || []).filter((t) => now - t < 10000); if (a.length >= 30) { rate.set(pid, a); return false; } a.push(now); rate.set(pid, a); return true; };
  app.get(paths('/rooms/:rid/whiteboard'), auth, member, run(async (req, res) => {
    const g = await gate(req, req.params.rid); const after = Number.parseInt(req.query.after ?? '0', 10); if (!Number.isSafeInteger(after) || after < 0) throw bad(400, 'Invalid cursor');
    const { rows } = await db.query('SELECT id, op_id, actor_id, op FROM more_room_board_ops WHERE meeting_id=$1 AND room_id=$2 AND id>$3 ORDER BY id LIMIT 500', [g.mid, g.rid, after]);
    res.set('Cache-Control', 'no-store').json({ ops: rows.map((r) => ({ id: Number(r.id), opId: r.op_id, by: r.actor_id, ...r.op })), cursor: rows.length ? Number(rows.at(-1).id) : after, canClear: g.manager });
  }));
  app.post(paths('/rooms/:rid/whiteboard'), auth, member, run(async (req, res) => {
    const g = await gate(req, req.params.rid, { write: true }); const o = req.body || {};
    if (!UUID.test(String(o.opId))) throw bad(400, 'Invalid operation');
    let op;
    if (o.kind === 'stroke') {
      if (!Array.isArray(o.points) || !o.points.length || o.points.length > 1000 || !o.points.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)) throw bad(400, 'Invalid stroke');
      if (!/^#[0-9a-f]{6}$/i.test(o.color ?? '#222222') || !Number.isFinite(o.width ?? 2) || (o.width ?? 2) < 1 || (o.width ?? 2) > 24) throw bad(400, 'Invalid pen');
      op = { kind: 'stroke', points: o.points.map((p) => ({ x: +p.x.toFixed(4), y: +p.y.toFixed(4) })), color: o.color ?? '#222222', width: o.width ?? 2 };
    } else if (o.kind === 'text') {
      const p = o.points?.[0]; if (!str(o.text, 500) || !p || !(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)) throw bad(400, 'Invalid text');
      op = { kind: 'text', points: [{ x: +p.x.toFixed(4), y: +p.y.toFixed(4) }], text: o.text, color: /^#[0-9a-f]{6}$/i.test(o.color ?? '') ? o.color : '#222222' };
    } else if (o.kind === 'undo') {          // take back one of your own operations (a manager can take back any)
      if (!UUID.test(String(o.target))) throw bad(400, 'Invalid operation');
      const t = (await db.query("SELECT actor_id, op->>'kind' AS kind FROM more_room_board_ops WHERE op_id=$1 AND meeting_id=$2 AND room_id=$3", [o.target, g.mid, g.rid])).rows[0];
      if (!t || ['undo', 'clear'].includes(t.kind)) throw bad(404, 'Nothing to undo'); if (!g.manager && t.actor_id !== g.pid) throw bad(403, 'You can only undo your own drawing');
      op = { kind: 'undo', target: o.target };
    } else if (o.kind === 'clear') { if (!g.manager) throw bad(403, 'Only the host or a room lead can clear the board'); op = { kind: 'clear' }; }
    else throw bad(400, 'Invalid operation');
    if (!okRate(g.pid)) throw bad(429, 'Slow down a little');
    if ((await db.query('SELECT count(*)::int AS n FROM more_room_board_ops WHERE meeting_id=$1 AND room_id=$2', [g.mid, g.rid])).rows[0].n >= CLASS_LIMITS.boardOps) throw bad(409, 'This board is full. Ask the host to clear it.');
    const r = await db.query('INSERT INTO more_room_board_ops(meeting_id, room_id, op_id, actor_id, op) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (op_id) DO NOTHING RETURNING id', [g.mid, g.rid, o.opId, g.pid, JSON.stringify(op)]);
    if (r.rowCount) { if (op.kind === 'clear') await audit(g.mid, g.pid, 'board.cleared', { roomId: g.rid }); B.emitScopeAndHosts(g.mid, g.rid, 'room-board', { roomId: g.rid, cursor: Number(r.rows[0].id) }); }
    res.status(r.rowCount ? 201 : 200).json({ accepted: !!r.rowCount, cursor: r.rowCount ? Number(r.rows[0].id) : null });          // a repeated opId is accepted once
  }));

  // group reports
  app.post(paths('/rooms/:rid/reports'), auth, member, run(async (req, res) => {
    const g = await gate(req, req.params.rid, { manage: true, write: true }); const { title, content, missionId = null } = req.body || {};
    if (!str(title, CLASS_LIMITS.title) || !str(content, CLASS_LIMITS.report)) throw bad(400, 'Give the report a title and some text');
    if (missionId !== null && !(UUID.test(String(missionId)) && (await db.query('SELECT 1 FROM more_room_missions WHERE id=$1 AND meeting_id=$2 AND room_id=$3', [missionId, g.mid, g.rid])).rowCount)) throw bad(404, 'Mission not found in this room');
    const { rows } = await db.query('INSERT INTO more_class_reports(meeting_id, room_id, mission_id, title, content, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [g.mid, g.rid, missionId, title.trim(), content, g.pid]);
    await audit(g.mid, g.pid, 'report.saved', { id: rows[0].id, roomId: g.rid }); inRoom(g.mid, g.rid, 'report'); res.status(201).json({ id: rows[0].id });
  }));

  // ------------------------------------------------------------------ the host's classroom view
  const dashboard = async (mid) => {
    const m = await B.ensure(mid);
    const { rows } = await db.query(`SELECT r.id, r.name,
      (SELECT count(*)::int FROM more_breakout_assignments a JOIN participants p ON p.id=a.participant_id WHERE a.meeting_id=r.meeting_id AND a.room_id=r.id AND p.admission='admitted' AND p.role<>'host') AS members,
      (SELECT count(*)::int FROM more_breakout_help h WHERE h.meeting_id=r.meeting_id AND h.room_id=r.id AND h.status='open') AS open_help,
      (SELECT count(*)::int FROM more_class_exercises e WHERE e.meeting_id=r.meeting_id AND e.room_id=r.id AND e.state='running' AND e.ends_at>now()) AS running_exercises,
      (SELECT count(*)::int FROM more_class_submissions s JOIN more_class_exercises e ON e.id=s.exercise_id WHERE e.meeting_id=r.meeting_id AND e.room_id=r.id) AS submissions,
      (SELECT count(*)::int FROM more_room_missions x WHERE x.meeting_id=r.meeting_id AND x.room_id=r.id) AS missions,
      (SELECT count(*)::int FROM more_room_missions x WHERE x.meeting_id=r.meeting_id AND x.room_id=r.id AND x.state='submitted') AS submitted_missions,
      (SELECT count(*)::int FROM more_mission_tasks t JOIN more_room_missions x ON x.id=t.mission_id WHERE x.meeting_id=r.meeting_id AND x.room_id=r.id) AS tasks,
      (SELECT count(*)::int FROM more_mission_tasks t JOIN more_room_missions x ON x.id=t.mission_id WHERE x.meeting_id=r.meeting_id AND x.room_id=r.id AND t.state='done') AS tasks_done,
      (SELECT count(*)::int FROM more_class_reports c WHERE c.meeting_id=r.meeting_id AND c.room_id=r.id) AS reports
      FROM more_breakout_rooms r WHERE r.meeting_id=$1 ORDER BY r.created_at, r.id`, [mid]);
    return { open: m.active, rooms: rows.map((r) => ({ id: r.id, name: r.name, members: r.members, openHelp: r.open_help, runningExercises: r.running_exercises, submissions: r.submissions, missions: r.missions, submittedMissions: r.submitted_missions, tasks: r.tasks, tasksDone: r.tasks_done, reports: r.reports })) };
  };
  app.get(paths('/classroom/dashboard'), auth, member, hostOnly, run(async (req, res) => res.set('Cache-Control', 'no-store').json(await dashboard(req.params.id))));
  // every report of every room, for the host (still there after the rooms close)
  app.get(paths('/classroom/reports'), auth, member, hostOnly, run(async (req, res) => {
    const { rows } = await db.query('SELECT c.id, c.room_id, c.title, c.content, c.created_at, p.display_name FROM more_class_reports c LEFT JOIN participants p ON p.id=c.created_by WHERE c.meeting_id=$1 ORDER BY c.created_at', [req.params.id]);
    const m = await B.ensure(req.params.id); res.set('Cache-Control', 'no-store').json({ reports: rows.map((r) => ({ id: r.id, roomId: r.room_id, roomName: m.rooms.get(r.room_id) || 'Closed room', title: r.title, content: r.content, by: r.display_name, at: r.created_at })) });
  }));
  // a balanced plan: a suggestion only. Applying it moves people through the same path as every other move (scope, epoch, roster).
  const candidates = async (mid, ids) => {
    const { rows } = await db.query("SELECT id, display_name AS name FROM participants WHERE meeting_id=$1 AND admission='admitted' AND role<>'host' ORDER BY display_name, id", [mid]);
    if (!ids) return rows; const want = new Set(ids); return rows.filter((p) => want.has(p.id));
  };
  app.post(paths('/classroom/plan'), auth, member, hostOnly, run(async (req, res) => {
    const m = await B.ensure(req.params.id); const ids = req.body?.participantIds; if (ids !== undefined && (!Array.isArray(ids) || ids.length > 300 || ids.some((i) => !UUID.test(String(i))))) throw bad(400, 'Invalid people');
    const roomIds = req.body?.roomIds ?? [...m.rooms.keys()]; if (!Array.isArray(roomIds) || roomIds.some((r) => !m.rooms.has(r))) throw bad(404, 'Room not found');
    const plan = balancedPlan(await candidates(req.params.id, ids), roomIds, req.body?.maxPerRoom ?? 8);
    res.json({ plan: plan.map((p) => ({ ...p, roomName: m.rooms.get(p.roomId) })) });
  }));
  app.post(paths('/classroom/apply'), auth, member, hostOnly, run(async (req, res) => {
    const mid = req.params.id, m = await B.ensure(mid), plan = req.body?.plan;
    if (!Array.isArray(plan) || !plan.length || plan.length > 300 || new Set(plan.map((p) => p?.participantId)).size !== plan.length) throw bad(400, 'Invalid plan');
    const results = []; for (const p of plan) {
      if (!UUID.test(String(p?.participantId)) || (p.roomId !== null && !m.rooms.has(p.roomId))) { results.push({ participantId: p?.participantId, ok: false, error: 'invalid' }); continue; }
      try { await B.assign(mid, p.participantId, p.roomId); results.push({ participantId: p.participantId, ok: true }); } catch (e) { results.push({ participantId: p.participantId, ok: false, error: e.message }); }
    }
    await audit(mid, req.user.participantId, 'plan.applied', { people: plan.length, ok: results.filter((r) => r.ok).length }); B.broadcast(mid); res.json({ results });
  }));
  return { closeExpired, dashboard, stop: () => clearInterval(timer) };
}
