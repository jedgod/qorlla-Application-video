import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerBreakouts } from '../server/breakouts.mjs';
import { registerCollab } from '../server/collab.mjs';
import { registerClassroom, balancedPlan } from '../server/classroom.mjs';

// Breakout rooms V1.2 to V1.7 (v4.31): move epochs, group leads, Mission Board, exercises, room whiteboard, reports, dashboard. Real PostgreSQL (TEST_PG_URL; a scratch database is created and dropped).
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres';
const SQL = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];
const dbName = 'cls_' + Math.random().toString(36).slice(2, 10);
let admin, pool;
test.before(async () => {
  admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${dbName}`);
  pool = new pg.Pool({ connectionString: URL.replace(/\/[^/]*$/, '/' + dbName), max: 8 }); pool.on('error', () => {});
  for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8'));
});
test.after(async () => { await pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {}); await admin?.end(); });

async function harness() {
  const sent = []; const sockMap = new Map(); const active = new Map();
  const io = { sockets: { sockets: sockMap }, to: (sid) => ({ emit: (type, payload) => sent.push({ sid, type, payload }) }) };
  const fail = (res, status, error) => res.status(status).json({ error });
  const app = express(); app.use(express.json({ limit: '128kb' }));
  const auth = (req, res, next) => { try { req.user = JSON.parse(req.get('x-user')); next(); } catch { fail(res, 401, 'Authentication required'); } };
  const member = async (req, res, next) => {
    if (req.user.meetingId !== req.params.id) return fail(res, 403, 'Wrong meeting');
    const { rows } = await pool.query("SELECT m.ended_at FROM meetings m JOIN participants p ON p.meeting_id=m.id WHERE m.id=$1 AND p.id=$2 AND p.admission='admitted'", [req.params.id, req.user.participantId]);
    if (!rows.length || rows[0].ended_at) return fail(res, 403, 'Meeting unavailable'); next();
  };
  const room = (id) => 'meeting:' + id;
  const b = registerBreakouts({ app, io, db: pool, auth, member, fail, active, room, tickMs: 3600_000 });
  const names = new Map(); const cls = registerClassroom({ app, io, db: pool, auth, member, fail, breakouts: b, tickMs: 3600_000 });
  registerCollab({ app, io, db: pool, auth, fail, room, audit: () => {}, getRoster: () => [], getName: (mid, pid) => names.get(pid) || 'Someone', toolOn: async () => true,
    scopeOf: b.scopeOf, mayLead: b.mayLead, roomsOf: async (mid) => (await b.ensure(mid)).rooms, roomsOpen: b.isActive, emitToScope: b.emitToScope, emitScopeAndHosts: b.emitScopeAndHosts });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, path, user, body) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'x-user': JSON.stringify(user) }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; };
  const meeting = async () => {
    const mid = randomUUID(); await pool.query("INSERT INTO meetings(id,title,host_secret_hash) VALUES($1,'t','x')", [mid]);
    const people = {};
    for (const [i, name] of ['Host', 'Ann', 'Bo', 'Cy', 'Di'].entries()) { const id = randomUUID(); await pool.query('INSERT INTO participants(id,meeting_id,display_name,role,admission) VALUES($1,$2,$3,$4,$5)', [id, mid, name, i ? 'guest' : 'host', 'admitted']); names.set(id, name); people[name.toLowerCase()] = { id, user: { meetingId: mid, participantId: id, role: i ? 'guest' : 'host', name } }; }
    await b.ensure(mid); active.set(mid, new Map());
    for (const k of Object.keys(people)) { const sid = 'sock-' + k + '-' + mid.slice(0, 4); active.get(mid).set(people[k].id, sid); sockMap.set(sid, { data: { user: people[k].user } }); }
    return { mid, ...people, sid: (k) => active.get(mid).get(people[k].id), P: (s = '') => `/api/meetings/${mid}/breakouts${s}`, A: (s) => `/api/meetings/${mid}${s}` };
  };
  return { b, sent, call, meeting, active, cls, close: async () => { b.stop(); cls.stop(); await new Promise((r) => server.close(r)); } };
}
const to = (h, sid, type) => h.sent.filter((e) => e.sid === sid && e.type === type);
// Ann + Bo in room A, Cy in room B, Di and the host in the main room, session running
async function running(h) {
  const m = await h.meeting(); const a = (await h.call('POST', m.P('/rooms'), m.host.user, { name: 'A' })).body.id, bR = (await h.call('POST', m.P('/rooms'), m.host.user, { name: 'B' })).body.id;
  for (const [p, r] of [[m.ann, a], [m.bo, a], [m.cy, bR]]) await h.call('POST', m.P('/assign'), m.host.user, { participantId: p.id, roomId: r });
  assert.equal((await h.call('POST', m.P('/start'), m.host.user, { minutes: 10 })).status, 200); await h.b.settle(m.mid);
  return { m, a, bR };
}
const lead = (h, m, a, p, caps) => h.call('PUT', m.P('/rooms/' + a + '/leads/' + p.id), m.host.user, { capabilities: caps });
const memberOf = async (h, m, name) => (await h.call('GET', m.P(''), m.host.user)).body.rooms.flatMap((r) => r.members).find((p) => p.name === name);

test('V1.2 epochs: every move bumps the epoch, it is stored and logged, a stale report is ignored, and a restart keeps it', async () => {
  const h = await harness(); const { m, a, bR } = await running(h);
  assert.equal(h.b.epochOf(m.mid, m.ann.id), 1); assert.equal(h.b.epochOf(m.mid, m.di.id), 0); assert.equal(h.b.scopeInfo(m.mid, m.ann.id).epoch, 1);
  await h.call('POST', m.P('/assign'), m.host.user, { participantId: m.ann.id, roomId: bR }); await h.b.settle(m.mid);
  assert.equal(h.b.epochOf(m.mid, m.ann.id), 2);
  const log = (await pool.query('SELECT epoch, state, from_room, to_room FROM more_breakout_moves WHERE meeting_id=$1 AND participant_id=$2 ORDER BY epoch', [m.mid, m.ann.id])).rows;
  assert.deepEqual(log.map((r) => [Number(r.epoch), r.state]), [[1, 'superseded'], [2, 'pending']]); assert.equal(log[1].from_room, a); assert.equal(log[1].to_room, bR);
  h.b.ready(m.mid, m.ann.id, { epoch: 1, ok: true });                                                               // a report for the OLD move
  assert.equal((await memberOf(h, m, 'Ann')).media, 'switching');
  h.b.ready(m.mid, m.ann.id, { epoch: 2, ok: false }); await h.b.settle(m.mid);
  assert.equal((await memberOf(h, m, 'Ann')).media, 'failed');                                                      // never shown as connected
  assert.equal((await pool.query('SELECT state FROM more_breakout_moves WHERE meeting_id=$1 AND participant_id=$2 AND epoch=2', [m.mid, m.ann.id])).rows[0].state, 'failed');
  h.b.ready(m.mid, m.bo.id, { epoch: 1, ok: true }); await h.b.settle(m.mid);
  assert.equal((await pool.query('SELECT state FROM more_breakout_moves WHERE meeting_id=$1 AND participant_id=$2 AND epoch=1', [m.mid, m.bo.id])).rows[0].state, 'client_reported');
  const h2 = await harness(); await h2.b.ensure(m.mid); assert.equal(h2.b.epochOf(m.mid, m.ann.id), 2);
  await h.close(); await h2.close();
});

test('V1.2 group leads: only the host grants, only inside the room, powers are room-only and vanish with the room', async () => {
  const h = await harness(); const { m, a, bR } = await running(h);
  assert.equal((await lead(h, m, a, m.ann, ['room_polls'])).status, 200);
  assert.equal((await h.call('PUT', m.P('/rooms/' + a + '/leads/' + m.bo.id), m.ann.user, { capabilities: ['room_polls'] })).status, 403);             // a lead cannot make leads
  assert.equal((await lead(h, m, a, m.cy, ['room_polls'])).status, 409);                                              // Cy is in B, not A
  assert.equal((await lead(h, m, a, m.di, ['room_polls'])).status, 409);
  assert.equal((await lead(h, m, a, m.ann, ['room_polls', 'owner'])).status, 400);                                    // no host-level power exists
  assert.equal((await lead(h, m, a, m.host, ['room_polls'])).status, 409);
  const poll = { question: 'Which?', kind: 'single', options: ['x', 'y'], launch: true };
  assert.equal((await h.call('POST', m.A('/polls'), m.bo.user, poll)).status, 403);                                   // Bo is no lead
  const made = await h.call('POST', m.A('/polls'), m.ann.user, { ...poll, roomId: bR }); assert.equal(made.status, 201); assert.equal(made.body.roomId, a);   // the lead's poll can only belong to her own room
  assert.equal((await h.call('POST', m.A('/polls'), m.ann.user, { ...poll, roomId: 'main' })).body.roomId, a);
  assert.equal((await h.call('POST', m.A('/polls/' + made.body.id + '/close'), m.ann.user, {})).status, 200);
  const hostPoll = (await h.call('POST', m.A('/polls'), m.host.user, { ...poll, roomId: bR })).body;
  assert.equal((await h.call('POST', m.A('/polls/' + hostPoll.id + '/close'), m.ann.user, {})).status, 404);          // another room's poll does not exist for her
  // announcements
  assert.equal((await h.call('POST', m.P('/announce'), m.ann.user, { text: 'hi' })).status, 403);                     // she was not given that power
  await lead(h, m, a, m.ann, ['room_announcement', 'help_triage']); h.sent.length = 0;
  assert.equal((await h.call('POST', m.P('/announce'), m.ann.user, { text: 'Five minutes left', roomId: bR })).status, 200);
  assert.ok(to(h, m.sid('bo'), 'breakout-announcement').length === 1 && to(h, m.sid('ann'), 'breakout-announcement').length === 1);
  for (const k of ['cy', 'di', 'host']) assert.equal(to(h, m.sid(k), 'breakout-announcement').length, 0, k + ' is outside room A');          // her roomId was ignored
  assert.equal((await h.call('POST', m.P('/announce'), m.host.user, { text: 'To everyone in a room' })).status, 200); assert.equal(to(h, m.sid('cy'), 'breakout-announcement').length, 1); assert.equal(to(h, m.sid('di'), 'breakout-announcement').length, 0);
  // help triage: she is told about her room's requests and resolves them, but not another room's
  h.sent.length = 0; const ask = await h.call('POST', m.P('/help'), m.bo.user, {}); assert.equal(to(h, m.sid('ann'), 'breakout-help').length, 1);
  assert.equal((await h.call('GET', m.P(''), m.ann.user)).body.me.roomHelp.length, 1);
  await pool.query("UPDATE more_breakout_help SET created_at = now() - interval '1 minute' WHERE meeting_id=$1", [m.mid]);
  const other = await h.call('POST', m.P('/help'), m.cy.user, {}); assert.equal(to(h, m.sid('ann'), 'breakout-help').length, 1);        // Cy's request in room B is not hers
  assert.equal((await h.call('POST', m.P('/help/' + other.body.id + '/resolve'), m.ann.user, {})).status, 404);
  assert.equal((await h.call('POST', m.P('/help/' + ask.body.id + '/resolve'), m.bo.user, {})).status, 403);
  assert.equal((await h.call('POST', m.P('/help/' + ask.body.id + '/resolve'), m.ann.user, {})).status, 200);
  // her powers go the moment she leaves the room, even before the stored grant is cleaned up
  assert.deepEqual(h.b.capsOf(m.mid, m.ann.id).sort(), ['help_triage', 'room_announcement']);
  await h.call('POST', m.P('/return'), m.ann.user, {}); assert.equal(h.b.mayLead(m.mid, m.ann.id, 'room_announcement'), false); await h.b.settle(m.mid);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM more_breakout_leads WHERE meeting_id=$1 AND participant_id=$2', [m.mid, m.ann.id])).rows[0].n, 0);
  await h.call('POST', m.P('/assign'), m.host.user, { participantId: m.ann.id, roomId: a }); assert.deepEqual(h.b.capsOf(m.mid, m.ann.id), []);          // back in the room: not a lead again until the host says so
  await lead(h, m, a, m.bo, ['room_notes']); await h.call('POST', m.P('/recall'), m.host.user, {}); await h.b.settle(m.mid);
  assert.equal(h.b.mayLead(m.mid, m.bo.id, 'room_notes'), false); assert.equal((await pool.query('SELECT count(*)::int AS n FROM more_breakout_leads WHERE meeting_id=$1', [m.mid])).rows[0].n, 0);
  await h.close();
});

test('V1.3 Mission Board: room-only, lead or host edits, assignee updates, optimistic versions, one report, closed rooms hide it from guests', async () => {
  const h = await harness(); const { m, a, bR } = await running(h); const B = (rid) => m.P('/rooms/' + rid + '/board');
  assert.equal((await h.call('GET', B(a), m.cy.user)).status, 404); assert.equal((await h.call('GET', B(a), m.di.user)).status, 404);          // another room / the main room: it does not exist
  assert.equal((await h.call('GET', B(a), m.ann.user)).status, 200); assert.equal((await h.call('GET', B(a), m.host.user)).status, 200);
  assert.equal((await h.call('POST', m.P('/rooms/' + a + '/missions'), m.ann.user, { title: 'Plan' })).status, 403);                  // not a lead yet
  await lead(h, m, a, m.ann, ['room_notes']); h.sent.length = 0;
  assert.equal((await h.call('POST', m.P('/rooms/' + a + '/missions'), m.ann.user, { title: '' })).status, 400);
  const mi = await h.call('POST', m.P('/rooms/' + a + '/missions'), m.ann.user, { title: 'Plan the trip', instructions: 'Be brief' }); assert.equal(mi.status, 201);
  assert.ok(to(h, m.sid('bo'), 'classroom-changed').length === 1 && to(h, m.sid('host'), 'classroom-changed').length === 1); assert.equal(to(h, m.sid('cy'), 'classroom-changed').length, 0);   // only the room and the host
  assert.equal((await h.call('POST', m.P('/rooms/' + bR + '/missions'), m.ann.user, { title: 'x' })).status, 404);                    // not her room
  const t1 = (await h.call('POST', m.P('/missions/' + mi.body.id + '/tasks'), m.ann.user, { title: 'Book', assigneeId: m.bo.id })).body, t2 = (await h.call('POST', m.P('/missions/' + mi.body.id + '/tasks'), m.ann.user, { title: 'Pack', assigneeId: m.ann.id })).body;
  assert.equal((await h.call('POST', m.P('/missions/' + mi.body.id + '/tasks'), m.ann.user, { title: 'Bad', assigneeId: m.cy.id })).status, 403);   // assignee outside the room
  assert.equal((await h.call('POST', m.P('/missions/' + mi.body.id + '/tasks'), m.cy.user, { title: 'x' })).status, 404);               // Cy cannot even reach this mission
  assert.equal((await h.call('PATCH', m.P('/tasks/' + t1.id), m.bo.user, { state: 'doing', expectedVersion: 1 })).status, 200);
  assert.equal((await h.call('PATCH', m.P('/tasks/' + t1.id), m.bo.user, { state: 'done', expectedVersion: 1 })).status, 409);          // stale version: nobody is silently overwritten
  assert.equal((await h.call('PATCH', m.P('/tasks/' + t2.id), m.bo.user, { state: 'done', expectedVersion: 1 })).status, 403);          // somebody else's task
  assert.equal((await h.call('PATCH', m.P('/tasks/' + t1.id), m.cy.user, { state: 'done', expectedVersion: 2 })).status, 404);
  assert.equal((await h.call('PATCH', m.P('/tasks/' + t1.id), m.bo.user, { state: 'done', expectedVersion: 2 })).status, 200);
  const board = (await h.call('GET', B(a), m.bo.user)).body; assert.equal(board.missions[0].tasks.length, 2); assert.equal(board.missions[0].done, 1); assert.equal(board.canManage, false); assert.equal((await h.call('GET', B(a), m.ann.user)).body.canManage, true);
  assert.equal((await h.call('POST', m.P('/missions/' + mi.body.id + '/report'), m.bo.user, { report: 'x' })).status, 403);
  assert.equal((await h.call('POST', m.P('/missions/' + mi.body.id + '/report'), m.ann.user, { report: 'We booked it' })).status, 201);
  assert.equal((await h.call('POST', m.P('/missions/' + mi.body.id + '/report'), m.ann.user, { report: 'again' })).status, 409);       // one report per mission
  assert.equal((await h.call('POST', m.P('/missions/' + mi.body.id + '/tasks'), m.ann.user, { title: 'late' })).status, 409);           // submitted: closed to changes
  assert.equal((await h.call('GET', B(a), m.bo.user)).body.missions[0].report.text, 'We booked it');
  assert.ok((await pool.query("SELECT count(*)::int AS n FROM more_events WHERE meeting_id=$1 AND kind LIKE 'classroom.%'", [m.mid])).rows[0].n >= 6);          // audited
  await h.call('POST', m.P('/recall'), m.host.user, {}); await h.b.settle(m.mid);
  assert.equal((await h.call('GET', B(a), m.bo.user)).status, 404);                                                    // rooms closed: guests lose it
  assert.equal((await h.call('GET', B(a), m.host.user)).body.missions[0].title, 'Plan the trip');                        // the host keeps reading
  assert.equal((await h.call('POST', m.P('/rooms/' + a + '/missions'), m.host.user, { title: 'late' })).status, 409);    // and nothing new is written
  await h.close();
});

test('V1.4/V1.5 exercises: the database clock ends them, one answer each, answers private to managers, nothing crosses rooms', async () => {
  const h = await harness(); const { m, a } = await running(h); await lead(h, m, a, m.ann, ['room_notes']);
  assert.equal((await h.call('POST', m.P('/rooms/' + a + '/exercises'), m.bo.user, { title: 'Quiz', durationSeconds: 60 })).status, 403);
  assert.equal((await h.call('POST', m.P('/rooms/' + a + '/exercises'), m.ann.user, { title: 'Quiz', durationSeconds: 5 })).status, 400);
  const ex = (await h.call('POST', m.P('/rooms/' + a + '/exercises'), m.ann.user, { title: 'Quiz', prompt: 'Name two', durationSeconds: 60 })).body;
  assert.equal((await h.call('POST', m.P('/exercises/' + ex.id + '/submit'), m.bo.user, { answer: 'early' })).status, 409);              // not started
  assert.equal((await h.call('POST', m.P('/exercises/' + ex.id + '/start'), m.bo.user, {})).status, 403);
  assert.equal((await h.call('POST', m.P('/exercises/' + ex.id + '/start'), m.ann.user, {})).status, 200);
  assert.equal((await h.call('POST', m.P('/exercises/' + ex.id + '/start'), m.ann.user, {})).status, 409);
  assert.equal((await h.call('POST', m.P('/exercises/' + ex.id + '/submit'), m.cy.user, { answer: 'sneaky' })).status, 404);             // another room
  assert.equal((await h.call('POST', m.P('/exercises/' + ex.id + '/submit'), m.bo.user, { answer: 'cats and dogs' })).status, 201);
  assert.equal((await h.call('POST', m.P('/exercises/' + ex.id + '/submit'), m.bo.user, { answer: 'second try' })).status, 409);          // one answer per person
  const asBo = (await h.call('GET', m.P('/rooms/' + a + '/board'), m.bo.user)).body.exercises[0]; assert.equal(asBo.state, 'running'); assert.ok(asBo.leftS > 50 && asBo.leftS <= 60); assert.equal(asBo.mine.answer, 'cats and dogs'); assert.equal(asBo.answers, undefined);
  const asAnn = (await h.call('GET', m.P('/rooms/' + a + '/board'), m.ann.user)).body.exercises[0]; assert.equal(asAnn.answers.length, 1); assert.equal(asAnn.answers[0].name, 'Bo');
  await pool.query("UPDATE more_class_exercises SET ends_at = now() - interval '1 second' WHERE id=$1", [ex.id]);                      // time runs out (the database clock decides)
  assert.equal((await h.call('POST', m.P('/exercises/' + ex.id + '/submit'), m.ann.user, { answer: 'too late' })).status, 409);
  assert.equal((await h.call('GET', m.P('/rooms/' + a + '/board'), m.bo.user)).body.exercises[0].state, 'closed');                    // reported as closed even before the sweep
  h.sent.length = 0; assert.equal(await h.cls.closeExpired(), 1); assert.equal(to(h, m.sid('bo'), 'classroom-changed').length, 1);            // the sweep stores it and tells the room
  assert.equal((await pool.query('SELECT state FROM more_class_exercises WHERE id=$1', [ex.id])).rows[0].state, 'closed');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM more_class_submissions WHERE exercise_id=$1', [ex.id])).rows[0].n, 1);
  const ex2 = (await h.call('POST', m.P('/rooms/' + a + '/exercises'), m.host.user, { title: 'Two', durationSeconds: 60 })).body; await h.call('POST', m.P('/exercises/' + ex2.id + '/start'), m.host.user, {});
  assert.equal((await h.call('POST', m.P('/exercises/' + ex2.id + '/close'), m.ann.user, {})).status, 200); assert.equal((await h.call('POST', m.P('/exercises/' + ex2.id + '/submit'), m.bo.user, { answer: 'x' })).status, 409);
  await h.close();
});

test('V1.5 room whiteboard: an operation log replayed by cursor, idempotent, validated, undo your own, clear needs a manager, nothing crosses rooms', async () => {
  const h = await harness(); const { m, a } = await running(h); await lead(h, m, a, m.ann, ['room_notes']); const W = (rid) => m.P('/rooms/' + rid + '/whiteboard');
  const stroke = (x = 0.1) => ({ opId: randomUUID(), kind: 'stroke', points: [{ x, y: 0.2 }, { x: 0.5, y: 0.5 }], color: '#ff0000', width: 3 });
  assert.equal((await h.call('POST', W(a), m.cy.user, stroke())).status, 404); assert.equal((await h.call('GET', W(a), m.cy.user)).status, 404); assert.equal((await h.call('GET', W(a), m.di.user)).status, 404);
  const s1 = stroke(); h.sent.length = 0; const r1 = await h.call('POST', W(a), m.bo.user, s1); assert.equal(r1.status, 201);
  assert.ok(to(h, m.sid('ann'), 'room-board').length === 1 && to(h, m.sid('host'), 'room-board').length === 1); assert.equal(to(h, m.sid('cy'), 'room-board').length, 0);
  const again = await h.call('POST', W(a), m.bo.user, s1); assert.equal(again.status, 200); assert.equal(again.body.accepted, false);          // the same opId is taken once
  const wrong = [{ opId: randomUUID(), kind: 'stroke', points: [] }, { opId: randomUUID(), kind: 'stroke', points: [{ x: 2, y: 0 }] }, { opId: 'nope', kind: 'stroke', points: [{ x: 0, y: 0 }] }, { opId: randomUUID(), kind: 'stroke', points: [{ x: 0, y: 0 }], color: 'red' }, { opId: randomUUID(), kind: 'text', points: [{ x: 0.1, y: 0.1 }], text: '' }, { opId: randomUUID(), kind: 'fire' }];
  for (const w of wrong) assert.equal((await h.call('POST', W(a), m.bo.user, w)).status, 400);
  assert.equal((await h.call('POST', W(a), m.ann.user, { opId: randomUUID(), kind: 'text', points: [{ x: 0.3, y: 0.3 }], text: 'Hello' })).status, 201);
  const got = (await h.call('GET', W(a), m.ann.user)).body; assert.equal(got.ops.length, 2); assert.equal(got.ops[0].kind, 'stroke'); assert.equal(got.canClear, true);
  assert.equal((await h.call('GET', W(a) + '?after=' + got.ops[0].id, m.bo.user)).body.ops.length, 1);                            // replay from a cursor
  assert.equal((await h.call('POST', W(a), m.ann.user, { opId: randomUUID(), kind: 'undo', target: s1.opId })).status, 201);          // a lead may undo anything in her room
  const s2 = stroke(0.3); await h.call('POST', W(a), m.bo.user, s2);
  assert.equal((await h.call('POST', W(a), m.host.user, { opId: randomUUID(), kind: 'clear' })).status, 201);
  assert.equal((await h.call('POST', W(a), m.bo.user, { opId: randomUUID(), kind: 'clear' })).status, 403);
  const s3 = stroke(0.4); await h.call('POST', W(a), m.ann.user, s3); assert.equal((await h.call('POST', W(a), m.bo.user, { opId: randomUUID(), kind: 'undo', target: s3.opId })).status, 403);          // not yours
  assert.equal((await h.call('POST', W(a), m.bo.user, { opId: randomUUID(), kind: 'undo', target: randomUUID() })).status, 404);
  await h.call('POST', m.P('/recall'), m.host.user, {}); await h.b.settle(m.mid);
  assert.equal((await h.call('GET', W(a), m.bo.user)).status, 404); assert.ok((await h.call('GET', W(a), m.host.user)).body.ops.length >= 4);
  await h.close();
});

test('V1.7 reports and the host dashboard; the balanced plan is deterministic and applies through the move path', async () => {
  const h = await harness(); const { m, a, bR } = await running(h); await lead(h, m, a, m.ann, ['room_notes']);
  assert.equal((await h.call('POST', m.P('/rooms/' + a + '/reports'), m.bo.user, { title: 'R', content: 'x' })).status, 403);
  assert.equal((await h.call('POST', m.P('/rooms/' + a + '/reports'), m.ann.user, { title: 'Findings', content: 'We agree' })).status, 201);
  assert.equal((await h.call('POST', m.P('/rooms/' + a + '/reports'), m.ann.user, { title: 'Findings', content: '' })).status, 400);
  assert.equal((await h.call('GET', m.P('/classroom/dashboard'), m.ann.user)).status, 403); assert.equal((await h.call('GET', m.P('/classroom/reports'), m.ann.user)).status, 403);
  await h.call('POST', m.P('/rooms/' + a + '/missions'), m.ann.user, { title: 'M' });
  const d = (await h.call('GET', m.P('/classroom/dashboard'), m.host.user)).body; const ra = d.rooms.find((r) => r.id === a); assert.equal(d.open, true); assert.equal(ra.members, 2); assert.equal(ra.reports, 1); assert.equal(ra.missions, 1); assert.equal(d.rooms.find((r) => r.id === bR).members, 1);
  assert.equal((await h.call('GET', m.P('/classroom/reports'), m.host.user)).body.reports[0].roomName, 'A');
  const people = [{ id: 'c', name: 'Cy' }, { id: 'a', name: 'Ann' }, { id: 'b', name: 'Bo' }];
  assert.deepEqual(balancedPlan(people, ['r1', 'r2'], 2).map((p) => [p.name, p.roomId]), [['Ann', 'r1'], ['Bo', 'r2'], ['Cy', 'r1']]);
  assert.throws(() => balancedPlan(people, ['r1'], 2), /capacity/); assert.throws(() => balancedPlan(people, [], 2)); assert.throws(() => balancedPlan(people, ['r1', 'r1'], 5)); assert.throws(() => balancedPlan(people, ['r1'], 0));
  assert.equal((await h.call('POST', m.P('/classroom/plan'), m.ann.user, {})).status, 403);
  const plan = (await h.call('POST', m.P('/classroom/plan'), m.host.user, { maxPerRoom: 4 })).body.plan; assert.equal(plan.length, 4); assert.ok(plan.every((p) => p.roomName));
  assert.equal((await h.call('POST', m.P('/classroom/plan'), m.host.user, { maxPerRoom: 1 })).status, 409);                          // 4 people, 2 rooms of 1
  assert.equal((await h.call('POST', m.P('/classroom/plan'), m.host.user, { roomIds: [randomUUID()] })).status, 404);
  const before = h.b.epochOf(m.mid, m.ann.id); h.sent.length = 0;
  const done = await h.call('POST', m.P('/classroom/apply'), m.host.user, { plan: [{ participantId: m.ann.id, roomId: bR }, { participantId: m.di.id, roomId: a }, { participantId: randomUUID(), roomId: a }] });
  assert.deepEqual(done.body.results.map((r) => r.ok), [true, true, false]);
  assert.equal(h.b.scopeOf(m.mid, m.ann.id), bR); assert.equal(h.b.scopeOf(m.mid, m.di.id), a); assert.ok(h.b.epochOf(m.mid, m.ann.id) > before);       // a real move: scope, epoch, roster
  assert.ok(to(h, m.sid('ann'), 'roster').length >= 1); assert.equal(h.b.mayLead(m.mid, m.ann.id, 'room_notes'), false);               // her lead powers left the room with her
  assert.equal((await h.call('POST', m.P('/classroom/apply'), m.host.user, { plan: [{ participantId: m.ann.id, roomId: a }, { participantId: m.ann.id, roomId: bR }] })).status, 400);
  await h.close();
});

test('V1.2 signal gate: same scope only, a signal from before the last move of the sender is refused, the recipient epoch is stamped', async () => {
  const h = await harness(); const { m, a, bR } = await running(h);
  const g = (from, to, data) => h.b.signalGate(m.mid, from.id, to.id, data);
  assert.deepEqual(g(m.ann, m.bo, { type: 'offer' }), { toEpoch: 1 });                                              // no epoch sent: allowed (an old page), but still scoped
  assert.deepEqual(g(m.ann, m.bo, { type: 'offer', se: 1 }), { toEpoch: 1 });
  assert.equal(g(m.ann, m.cy, { type: 'offer', se: 1 }).error, 'Participant offline');                               // another room
  assert.equal(g(m.ann, m.di, { type: 'offer', se: 1 }).error, 'Participant offline');                               // the main room
  await h.call('POST', m.P('/assign'), m.host.user, { participantId: m.bo.id, roomId: bR });                       // Bo moves to B: epoch 2
  assert.equal(g(m.bo, m.cy, { type: 'candidate', se: 1 }).error, 'Stale room epoch');                              // Bo's page still holds the old epoch: refused even though Bo and Cy now share a room
  assert.deepEqual(g(m.bo, m.cy, { type: 'candidate', se: 2 }), { toEpoch: 1 });
  assert.equal(g(m.cy, m.bo, { type: 'answer', se: 1 }).toEpoch, 2);                                                // stamped with Bo's CURRENT epoch: Bo's page drops anything older
  await h.close();
});
