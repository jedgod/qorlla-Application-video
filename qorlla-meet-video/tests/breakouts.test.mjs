import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerBreakouts } from '../server/breakouts.mjs';
import { registerChat } from '../server/chat.mjs';

// Breakout rooms (v4.29) against a REAL PostgreSQL (TEST_PG_URL; a scratch database is created and dropped). Sockets are recorded per socket id, so "who was told what" is exact.
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres';
const SQL = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f) && !f.endsWith('.rollback.sql')).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];
const dbName = 'bk_' + Math.random().toString(36).slice(2, 10);
let admin, pool;
test.before(async () => {
  admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${dbName}`);
  pool = new pg.Pool({ connectionString: URL.replace(/\/[^/]*$/, '/' + dbName), max: 8 }); pool.on('error', () => {});
  for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8'));
});
test.after(async () => { await pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {}); await admin?.end(); });

async function harness(opts = {}) {
  const sent = []; const sockMap = new Map(); const active = new Map();
  const io = { sockets: { sockets: sockMap }, to: (sid) => ({ emit: (type, payload) => sent.push({ sid, type, payload }) }) };
  const fail = (res, status, error) => res.status(status).json({ error });
  const app = express(); app.use(express.json({ limit: '32kb' }));
  const auth = (req, res, next) => { try { req.user = JSON.parse(req.get('x-user')); next(); } catch { fail(res, 401, 'Authentication required'); } };
  const member = async (req, res, next) => {
    if (req.user.meetingId !== req.params.id) return fail(res, 403, 'Wrong meeting');
    const { rows } = await pool.query("SELECT m.ended_at FROM meetings m JOIN participants p ON p.meeting_id=m.id WHERE m.id=$1 AND p.id=$2 AND p.admission='admitted'", [req.params.id, req.user.participantId]);
    if (!rows.length || rows[0].ended_at) return fail(res, 403, 'Meeting unavailable'); next();
  };
  const b = registerBreakouts({ app, io, db: pool, auth, member, fail, active, room: (id) => 'meeting:' + id, tickMs: 3600_000, ...opts });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, path, user, body) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'x-user': JSON.stringify(user) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const meeting = async (n = 4) => {
    const mid = randomUUID(); await pool.query("INSERT INTO meetings(id,title,host_secret_hash) VALUES($1,'t','x')", [mid]);
    const people = {}; const names = ['Host', 'Ann', 'Bo', 'Cy', 'Di', 'Ed'].slice(0, n + 1);
    for (const [i, name] of names.entries()) { const id = randomUUID(); await pool.query('INSERT INTO participants(id,meeting_id,display_name,role,admission) VALUES($1,$2,$3,$4,$5)', [id, mid, name, i ? 'guest' : 'host', 'admitted']); people[name.toLowerCase()] = { id, user: { meetingId: mid, participantId: id, role: i ? 'guest' : 'host', name } }; }
    const wid = randomUUID(); await pool.query("INSERT INTO participants(id,meeting_id,display_name,role,admission) VALUES($1,$2,'Wes','guest','waiting')", [wid, mid]); people.wes = { id: wid, user: { meetingId: mid, participantId: wid, role: 'guest', name: 'Wes' } };
    await b.ensure(mid); active.set(mid, new Map());
    for (const k of Object.keys(people)) { if (k === 'wes') continue; const sid = 'sock-' + k + '-' + mid.slice(0, 4); active.get(mid).set(people[k].id, sid); sockMap.set(sid, { data: { user: people[k].user } }); }
    return { mid, ...people, sid: (k) => active.get(mid).get(people[k].id), P: (s = '') => `/api/meetings/${mid}/breakouts${s}` };
  };
  return { b, sent, call, meeting, active, pool: () => pool, close: async () => { b.stop(); await new Promise((r) => server.close(r)); } };
}
const to = (h, sid, type) => h.sent.filter((e) => e.sid === sid && e.type === type);

test('setup is host only; rooms, assignment and validation', async () => {
  const h = await harness(); const m = await h.meeting();
  assert.equal((await h.call('POST', m.P('/rooms'), m.ann.user, { name: 'x' })).status, 403);
  assert.equal((await h.call('POST', m.P('/rooms'), m.host.user, { name: '   ' })).status, 400);
  assert.equal((await h.call('POST', m.P('/rooms'), m.host.user, { name: 'x'.repeat(61) })).status, 400);
  const r1 = await h.call('POST', m.P('/rooms'), m.host.user, { name: 'Design' }); assert.equal(r1.status, 201);
  assert.equal((await h.call('POST', m.P('/assign'), m.host.user, { participantId: m.host.id, roomId: r1.body.id })).status, 400);       // the host uses Visit
  assert.equal((await h.call('POST', m.P('/assign'), m.host.user, { participantId: m.wes.id, roomId: r1.body.id })).status, 404);         // not admitted
  assert.equal((await h.call('POST', m.P('/assign'), m.host.user, { participantId: m.ann.id, roomId: randomUUID() })).status, 404);
  assert.equal((await h.call('POST', m.P('/assign'), m.host.user, { participantId: 'nope', roomId: r1.body.id })).status, 400);
  assert.equal((await h.call('POST', m.P('/assign'), m.host.user, { participantId: m.ann.id, roomId: r1.body.id })).status, 200);
  const st = (await h.call('GET', m.P(''), m.host.user)).body; assert.equal(st.rooms[0].members.length, 1); assert.equal(st.rooms[0].members[0].name, 'Ann'); assert.ok(st.unassigned.some((u) => u.name === 'Bo'));
  const gs = (await h.call('GET', m.P(''), m.ann.user)).body; assert.equal(gs.rooms, undefined); assert.equal(gs.me.roomId, null); assert.equal(gs.session.active, false);          // a guest sees no setup, and nothing is active yet
  assert.equal((await h.call('POST', m.P('/start'), m.ann.user, { minutes: 5 })).status, 403);
  assert.equal((await h.call('POST', m.P('/start'), m.host.user, { minutes: 0 })).status, 400); assert.equal((await h.call('POST', m.P('/start'), m.host.user, { minutes: 241 })).status, 400); assert.equal((await h.call('POST', m.P('/start'), m.host.user, { minutes: '5' })).status, 400);
  assert.equal((await h.call('DELETE', m.P('/rooms/' + r1.body.id), m.ann.user)).status, 403);
  await h.close();
});

test('start: people move to their rooms, everyone else stays; the old scope sees them leave, the new scope sees them arrive; each mover gets a fresh roster', async () => {
  const h = await harness(); const m = await h.meeting(); const a = (await h.call('POST', m.P('/rooms'), m.host.user, { name: 'A' })).body.id, bR = (await h.call('POST', m.P('/rooms'), m.host.user, { name: 'B' })).body.id;
  for (const [p, r] of [[m.ann, a], [m.bo, a], [m.cy, bR]]) await h.call('POST', m.P('/assign'), m.host.user, { participantId: p.id, roomId: r });
  assert.equal((await h.call('POST', m.P('/start'), m.host.user, { minutes: 10 })).status, 200);
  assert.equal(h.b.scopeOf(m.mid, m.ann.id), a); assert.equal(h.b.scopeOf(m.mid, m.bo.id), a); assert.equal(h.b.scopeOf(m.mid, m.cy.id), bR); assert.equal(h.b.scopeOf(m.mid, m.host.id), null); assert.equal(h.b.scopeOf(m.mid, m.di.id), null);
  assert.ok(h.b.sameScope(m.mid, m.ann.id, m.bo.id)); assert.ok(!h.b.sameScope(m.mid, m.ann.id, m.cy.id)); assert.ok(!h.b.sameScope(m.mid, m.ann.id, m.host.id));          // the signaling gate
  const last = (sid, type) => to(h, sid, type).at(-1)?.payload;
  const boRoster = last(m.sid('bo'), 'roster'); assert.ok(boRoster.includes(m.ann.id) && boRoster.includes(m.bo.id) && !boRoster.includes(m.cy.id) && !boRoster.includes(m.host.id) && !boRoster.includes(m.di.id));          // Bo arrived second: Bo's page offers to Ann
  assert.deepEqual(last(m.sid('cy'), 'roster').sort(), [m.cy.id]);                                                                             // alone in room B
  assert.equal(last(m.sid('ann'), 'breakout-scope').roomId, a); assert.equal(last(m.sid('ann'), 'breakout-scope').roomName, 'A'); assert.ok(last(m.sid('ann'), 'breakout-scope').deadline);
  assert.ok(to(h, m.sid('host'), 'participant-offline').some((e) => e.payload.participantId === m.ann.id));                                       // the host saw Ann leave the main room
  assert.ok(!to(h, m.sid('host'), 'participant-online').some((e) => e.payload.participantId === m.ann.id));
  assert.ok(to(h, m.sid('bo'), 'participant-online').some((e) => e.payload.participantId === m.ann.id) || to(h, m.sid('ann'), 'participant-online').some((e) => e.payload.participantId === m.bo.id));      // the two arrivals meet
  assert.equal(to(h, m.sid('di'), 'roster').length, 0);                                                                                           // Di was never moved: no new roster, no churn
  // concurrent starts and re-starts are refused
  assert.equal((await h.call('POST', m.P('/start'), m.host.user, { minutes: 5 })).status, 409);
  await h.close();
});

test('start needs rooms with people; recording blocks it; the host can visit a room and come back; recall returns everyone', async () => {
  const h = await harness(); const m = await h.meeting();
  assert.equal((await h.call('POST', m.P('/start'), m.host.user, { minutes: 5 })).status, 409);                                                   // nothing to start
  const a = (await h.call('POST', m.P('/rooms'), m.host.user, { name: 'A' })).body.id; await h.call('POST', m.P('/assign'), m.host.user, { participantId: m.ann.id, roomId: a });
  await pool.query("INSERT INTO recording_sessions(id, meeting_id, status) VALUES (gen_random_uuid(), $1, 'recording')", [m.mid]).catch(() => null);
  const recorded = await pool.query("SELECT 1 FROM recording_sessions WHERE meeting_id=$1", [m.mid]).catch(() => ({ rowCount: 0 }));
  if (recorded.rowCount) assert.equal((await h.call('POST', m.P('/start'), m.host.user, { minutes: 5 })).status, 409);
  await pool.query('DELETE FROM recording_sessions WHERE meeting_id=$1', [m.mid]).catch(() => null);
  assert.equal((await h.call('POST', m.P('/visit'), m.host.user, { roomId: a })).status, 409);                                                    // not open yet
  assert.equal((await h.call('POST', m.P('/start'), m.host.user, { minutes: 5 })).status, 200);
  assert.equal((await h.call('POST', m.P('/visit'), m.host.user, { roomId: a })).status, 200); assert.ok(h.b.sameScope(m.mid, m.host.id, m.ann.id));
  assert.equal((await h.call('POST', m.P('/visit'), m.ann.user, { roomId: null })).status, 403);
  assert.equal((await h.call('POST', m.P('/visit'), m.host.user, { roomId: null })).status, 200); assert.equal(h.b.scopeOf(m.mid, m.host.id), null);
  assert.equal((await h.call('DELETE', m.P('/rooms/' + a), m.host.user)).status, 409);                                                            // not while open
  assert.equal((await h.call('POST', m.P('/recall'), m.ann.user)).status, 403);
  h.sent.length = 0; assert.equal((await h.call('POST', m.P('/recall'), m.host.user)).status, 200);
  assert.equal(h.b.scopeOf(m.mid, m.ann.id), null); assert.equal(h.b.isActive(m.mid), false);
  assert.ok(to(h, m.sid('ann'), 'roster').at(-1).payload.includes(m.host.id)); assert.ok(to(h, m.sid('ann'), 'breakout-ended').length === 1);   // Ann is back with the host
  const row = await pool.query('SELECT state FROM more_breakout_sessions WHERE meeting_id=$1', [m.mid]); assert.equal(row.rows[0].state, 'idle');
  assert.equal((await h.call('POST', m.P('/recall'), m.host.user)).status, 409);
  assert.equal((await h.call('DELETE', m.P('/rooms/' + a), m.host.user)).status, 200);
  await h.close();
});

test('autosplit spreads the people who are here over the rooms; late changes move people while a session runs', async () => {
  const h = await harness(); const m = await h.meeting(5);
  assert.equal((await h.call('POST', m.P('/autosplit'), m.host.user, { rooms: 1 })).status, 400);
  const sp = await h.call('POST', m.P('/autosplit'), m.host.user, { rooms: 2 }); assert.equal(sp.status, 200); assert.equal(sp.body.assigned, 5);
  const st = (await h.call('GET', m.P(''), m.host.user)).body; assert.equal(st.rooms.length, 2); assert.deepEqual(st.rooms.map((r) => r.members.length).sort(), [2, 3]); assert.equal(st.unassigned.length, 0);
  assert.equal((await h.call('POST', m.P('/start'), m.host.user, { minutes: 5 })).status, 200);
  const rooms = st.rooms; const other = rooms.find((r) => !r.members.some((x) => x.id === m.ann.id)).id;
  assert.equal((await h.call('POST', m.P('/assign'), m.host.user, { participantId: m.ann.id, roomId: other })).status, 200); assert.equal(h.b.scopeOf(m.mid, m.ann.id), other);        // moved live
  assert.equal((await h.call('POST', m.P('/assign'), m.host.user, { participantId: m.ann.id, roomId: null })).status, 200); assert.equal(h.b.scopeOf(m.mid, m.ann.id), null);            // sent back live
  assert.equal((await h.call('POST', m.P('/autosplit'), m.host.user, { rooms: 2 })).status, 409);
  await h.close();
});

test('time runs out: the tick ends the session once and everyone is back in the main room', async () => {
  const h = await harness(); const m = await h.meeting(); const a = (await h.call('POST', m.P('/rooms'), m.host.user, { name: 'A' })).body.id;
  await h.call('POST', m.P('/assign'), m.host.user, { participantId: m.ann.id, roomId: a }); await h.call('POST', m.P('/start'), m.host.user, { minutes: 5 });
  assert.equal(await h.b.tick(), 0); assert.equal(h.b.isActive(m.mid), true);                                                                      // not yet
  await pool.query("UPDATE more_breakout_sessions SET deadline = now() - interval '1 second' WHERE meeting_id=$1", [m.mid]);
  h.sent.length = 0; assert.equal(await h.b.tick(), 1); assert.equal(await h.b.tick(), 0);                                                         // exactly once
  assert.equal(h.b.scopeOf(m.mid, m.ann.id), null); assert.equal(to(h, m.sid('ann'), 'breakout-ended')[0].payload.reason, 'time');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM more_breakout_assignments WHERE meeting_id=$1 AND room_id IS NOT NULL', [m.mid])).rows[0].n, 0);
  assert.ok((await pool.query("SELECT 1 FROM more_events WHERE meeting_id=$1 AND kind='breakout.ended'", [m.mid])).rowCount >= 1);                // the audit trail has it
  await h.close();
});

test('a server restart loses nothing: the scope map is rebuilt from PostgreSQL', async () => {
  const h = await harness(); const m = await h.meeting(); const a = (await h.call('POST', m.P('/rooms'), m.host.user, { name: 'A' })).body.id;
  await h.call('POST', m.P('/assign'), m.host.user, { participantId: m.ann.id, roomId: a }); await h.call('POST', m.P('/start'), m.host.user, { minutes: 5 });
  const h2 = await harness(); await h2.b.ensure(m.mid);                                                                                          // a second process that never saw the moves
  assert.equal(h2.b.scopeOf(m.mid, m.ann.id), a); assert.equal(h2.b.isActive(m.mid), true); assert.equal(h2.b.scopeInfo(m.mid, m.ann.id).roomName, 'A');
  await h.close(); await h2.close();
});

test('chat: an Everyone message written in a room stays in that room (live, history, save, edit, delete); main-room chat is separate', async () => {
  const h = await harness(); const m = await h.meeting(); const a = (await h.call('POST', m.P('/rooms'), m.host.user, { name: 'A' })).body.id;
  await h.call('POST', m.P('/assign'), m.host.user, { participantId: m.ann.id, roomId: a }); await h.call('POST', m.P('/assign'), m.host.user, { participantId: m.bo.id, roomId: a });
  await h.call('POST', m.P('/start'), m.host.user, { minutes: 5 });
  const fail = (res, status, error) => res.status(status).json({ error });
  const app = express(); app.use(express.json());
  const events = []; const io = { to: (sid) => ({ emit: (type, payload) => events.push({ sid, type, payload }) }) };
  const auth = (req, res, next) => { req.user = JSON.parse(req.get('x-user')); next(); }; const member = (req, res, next) => next();
  const chat = registerChat({ app, io, db: pool, auth, member, room: (id) => 'meeting:' + id, fail, socketOf: (mid, pid) => h.active.get(mid)?.get(pid), scopeOf: h.b.scopeOf, giphyKey: '', attachmentsEnabled: false });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); const base = 'http://127.0.0.1:' + srv.address().port;
  const call = async (method, path, user, body) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'x-user': JSON.stringify(user) }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = r.headers.get('content-type') || ''; return { status: r.status, body: t.includes('json') ? await r.json() : await r.text() }; };
  const msg = await chat.post({ meetingId: m.mid, participantId: m.ann.id, role: 'guest', body: 'inside room A' }); await chat.deliver(m.mid, msg);
  const got = (k) => events.some((e) => e.sid === m.sid(k) && e.type === 'chat' && e.payload.body === 'inside room A');
  assert.ok(got('ann') && got('bo')); assert.ok(!got('host') && !got('cy') && !got('di'));                                                          // only Ann and Bo
  const main = await chat.post({ meetingId: m.mid, participantId: m.host.id, role: 'host', body: 'back in main' }); await chat.deliver(m.mid, main);
  assert.ok(events.some((e) => e.sid === m.sid('di') && e.type === 'chat' && e.payload.body === 'back in main') && events.some((e) => e.sid === m.sid('host') && e.payload.body === 'back in main'));
  assert.ok(!events.some((e) => e.sid === m.sid('ann') && e.payload.body === 'back in main'));
  const hist = async (u) => (await call('GET', `/api/meetings/${m.mid}/chat`, u)).body.messages.map((x) => x.body);
  assert.deepEqual(await hist(m.bo.user), ['inside room A']); assert.deepEqual(await hist(m.host.user), ['back in main']); assert.deepEqual(await hist(m.di.user), ['back in main']);
  assert.equal((await call('GET', `/api/meetings/${m.mid}/chat/export`, m.host.user)).body.includes('inside room A'), false); assert.equal((await call('GET', `/api/meetings/${m.mid}/chat/export`, m.ann.user)).body.includes('inside room A'), true);
  assert.equal((await call('DELETE', `/api/meetings/${m.mid}/chat/${msg.id}`, m.host.user)).status, 404);                                          // the host in the main room cannot even address a room message
  events.length = 0; assert.equal((await call('PATCH', `/api/meetings/${m.mid}/chat/${msg.id}`, m.ann.user, { body: 'edited in A' })).status, 200);
  assert.ok(events.some((e) => e.type === 'chat-edit' && e.sid === m.sid('bo')) && !events.some((e) => e.type === 'chat-edit' && (e.sid === m.sid('host') || e.sid === m.sid('di'))));
  await h.call('POST', m.P('/recall'), m.host.user);                                                                                              // after the session the room text stays out of the main chat
  assert.deepEqual(await hist(m.di.user), ['back in main']);
  await new Promise((r) => srv.close(r)); await h.close();
});

test('telephone admission blocks breakout start until the call terminates', async()=>{
 const h=await harness();try{const m=await h.meeting(1);const r=(await h.call('POST',m.P('/rooms'),m.host.user,{name:'Team'})).body;
 await h.call('POST',m.P('/assign'),m.host.user,{participantId:m.ann.id,roomId:r.id});
 const call=randomUUID();await pool.query("INSERT INTO phone_calls(id,meeting_id,provider,provider_call_id,caller_hash,status,state) VALUES($1,$2,'gateway',$3,'test-caller','waiting','APPROVED')",[call,m.mid,call]);
 const blocked=await h.call('POST',m.P('/start'),m.host.user,{minutes:5});assert.equal(blocked.status,409);assert.match(blocked.body.error,/telephone/);assert.equal(h.b.isActive(m.mid),false);
 await pool.query("UPDATE phone_calls SET state='TERMINATED',status='ended' WHERE id=$1",[call]);assert.equal((await h.call('POST',m.P('/start'),m.host.user,{minutes:5})).status,200);
 }finally{await h.close();}
});
