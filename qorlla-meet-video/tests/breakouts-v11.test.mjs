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

// Breakout rooms V1.1 (v4.30): room-scoped Polls and Notes, return to the main room, ask for help, ready acknowledgement. Real PostgreSQL (TEST_PG_URL; a scratch database is created and dropped).
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres';
const SQL = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];
const dbName = 'bk11_' + Math.random().toString(36).slice(2, 10);
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
  const names = new Map();
  registerCollab({ app, io, db: pool, auth, fail, room, audit: () => {}, getRoster: () => [], getName: (mid, pid) => names.get(pid) || 'Someone', toolOn: async () => true,
    scopeOf: b.scopeOf, roomsOf: async (mid) => (await b.ensure(mid)).rooms, roomsOpen: b.isActive, emitToScope: b.emitToScope, emitScopeAndHosts: b.emitScopeAndHosts });
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
  return { b, sent, call, meeting, active, close: async () => { b.stop(); await new Promise((r) => server.close(r)); } };
}
const to = (h, sid, type) => h.sent.filter((e) => e.sid === sid && e.type === type);
// Ann + Bo in room A, Cy in room B, Di and the host in the main room, session running
async function running(h) {
  const m = await h.meeting(); const a = (await h.call('POST', m.P('/rooms'), m.host.user, { name: 'A' })).body.id, bR = (await h.call('POST', m.P('/rooms'), m.host.user, { name: 'B' })).body.id;
  for (const [p, r] of [[m.ann, a], [m.bo, a], [m.cy, bR]]) await h.call('POST', m.P('/assign'), m.host.user, { participantId: p.id, roomId: r });
  assert.equal((await h.call('POST', m.P('/start'), m.host.user, { minutes: 10 })).status, 200);
  return { m, a, bR };
}

test('ask for help: only a person in a room, only the host is told, one open request, a cool-down, resolve, and a session end closes it', async () => {
  const h = await harness(); const { m, a } = await running(h);
  assert.equal((await h.call('POST', m.P('/help'), m.di.user, {})).status, 409);                                    // Di is in the main room
  assert.equal((await h.call('POST', m.P('/help'), m.host.user, {})).status, 403);
  h.sent.length = 0; const r = await h.call('POST', m.P('/help'), m.ann.user, {}); assert.equal(r.status, 201);
  const told = to(h, m.sid('host'), 'breakout-help'); assert.equal(told.length, 1); assert.equal(told[0].payload.roomId, a); assert.equal(told[0].payload.roomName, 'A'); assert.equal(told[0].payload.name, 'Ann');
  for (const k of ['ann', 'bo', 'cy', 'di']) assert.equal(to(h, m.sid(k), 'breakout-help').length, 0, k + ' must not learn about the request');                // hosts only
  assert.equal((await h.call('POST', m.P('/help'), m.ann.user, {})).status, 409);                                   // already open
  const hs = (await h.call('GET', m.P(''), m.host.user)).body; assert.equal(hs.help.length, 1); assert.equal(hs.help[0].name, 'Ann'); assert.equal(hs.help[0].roomName, 'A');
  assert.ok((await h.call('GET', m.P(''), m.ann.user)).body.me.help); assert.equal((await h.call('GET', m.P(''), m.bo.user)).body.me.help, null);
  assert.equal((await h.call('GET', m.P(''), m.ann.user)).body.help, undefined);                                    // a guest never gets the host list
  assert.equal((await h.call('POST', m.P('/help/' + r.body.id + '/resolve'), m.ann.user, {})).status, 403);
  assert.equal((await h.call('POST', m.P('/help/' + randomUUID() + '/resolve'), m.host.user, {})).status, 404);
  h.sent.length = 0; assert.equal((await h.call('POST', m.P('/help/' + r.body.id + '/resolve'), m.host.user, {})).status, 200);
  assert.equal(to(h, m.sid('ann'), 'breakout-help-resolved').length, 1); assert.equal((await h.call('GET', m.P(''), m.host.user)).body.help.length, 0);
  assert.equal((await h.call('POST', m.P('/help/' + r.body.id + '/resolve'), m.host.user, {})).status, 404);       // already resolved
  assert.equal((await h.call('POST', m.P('/help'), m.ann.user, {})).status, 429);                                   // 30 s cool-down
  await pool.query("UPDATE more_breakout_help SET created_at = now() - interval '1 minute' WHERE meeting_id=$1", [m.mid]);
  const again = await h.call('POST', m.P('/help'), m.bo.user, {}); assert.equal(again.status, 201);
  assert.equal((await h.call('DELETE', m.P('/help'), m.bo.user)).status, 200); assert.equal((await h.call('GET', m.P(''), m.host.user)).body.help.length, 0);   // cancelled by the asker
  await pool.query("UPDATE more_breakout_help SET created_at = now() - interval '1 minute' WHERE meeting_id=$1", [m.mid]);
  assert.equal((await h.call('POST', m.P('/help'), m.ann.user, {})).status, 201);
  await h.call('POST', m.P('/recall'), m.host.user); assert.equal((await pool.query("SELECT count(*)::int AS n FROM more_breakout_help WHERE meeting_id=$1 AND status='open'", [m.mid])).rows[0].n, 0);
  assert.ok((await pool.query("SELECT 1 FROM more_events WHERE meeting_id=$1 AND kind='breakout.help.requested'", [m.mid])).rowCount >= 1);
  await h.close();
});

test('return to the main room: a guest leaves a room by themselves, the scopes and rosters follow, the choice survives a restart, and no media crosses', async () => {
  const h = await harness(); const { m, a } = await running(h);
  assert.equal((await h.call('POST', m.P('/return'), m.di.user, {})).status, 409);                                  // not in a room
  assert.equal((await h.call('POST', m.P('/return'), m.host.user, {})).status, 400);
  assert.equal((await h.call('POST', m.P('/help'), m.ann.user, {})).status, 201);
  h.sent.length = 0; assert.equal((await h.call('POST', m.P('/return'), m.ann.user, {})).status, 200);
  assert.equal(h.b.scopeOf(m.mid, m.ann.id), null); assert.equal(h.b.scopeOf(m.mid, m.bo.id), a);
  const roster = to(h, m.sid('ann'), 'roster').at(-1).payload; assert.ok(roster.includes(m.host.id) && roster.includes(m.di.id) && !roster.includes(m.bo.id));       // Ann is with the main room now
  assert.ok(to(h, m.sid('bo'), 'participant-offline').some((e) => e.payload.participantId === m.ann.id));          // Bo saw Ann leave the room
  assert.ok(to(h, m.sid('di'), 'participant-online').some((e) => e.payload.participantId === m.ann.id));           // the main room saw Ann arrive
  assert.ok(!h.b.sameScope(m.mid, m.ann.id, m.bo.id)); assert.ok(h.b.sameScope(m.mid, m.ann.id, m.di.id));          // the signaling gate follows at once
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM more_breakout_help WHERE meeting_id=$1 AND status='open'", [m.mid])).rows[0].n, 0);          // her open request went with her
  assert.equal((await h.call('POST', m.P('/return'), m.ann.user, {})).status, 409);                                // already back
  const h2 = await harness(); await h2.b.ensure(m.mid); assert.equal(h2.b.scopeOf(m.mid, m.ann.id), null); assert.equal(h2.b.scopeOf(m.mid, m.bo.id), a);      // a restart keeps it
  assert.equal((await h.call('POST', m.P('/assign'), m.host.user, { participantId: m.ann.id, roomId: a })).status, 200); assert.equal(h.b.scopeOf(m.mid, m.ann.id), a);   // the host can still send her back
  assert.ok((await pool.query("SELECT 1 FROM more_events WHERE meeting_id=$1 AND kind='breakout.returned'", [m.mid])).rowCount === 1);
  await h.close(); await h2.close();
});

test('ready acknowledgement: a moved person shows as connecting until their page says the new peers are up', async () => {
  const h = await harness(); const { m } = await running(h);
  const st = async () => (await h.call('GET', m.P(''), m.host.user)).body; const ann = async () => (await st()).rooms.flatMap((r) => r.members).find((p) => p.name === 'Ann');
  assert.equal((await ann()).connecting, true);
  h.sent.length = 0; h.b.ready(m.mid, m.ann.id); assert.equal((await ann()).connecting, false); assert.ok(to(h, m.sid('host'), 'breakouts-changed').length >= 1);      // the host's list refreshes
  assert.equal(to(h, m.sid('cy'), 'breakouts-changed').length, 0);                                                  // other people are not bothered
  await h.close();
});

test('polls are room-scoped: only the room votes and sees them, the host oversees all, events stay in the room, ended rooms hide them from guests', async () => {
  const h = await harness(); const { m, a } = await running(h);
  const poll = { question: 'Which?', kind: 'single', options: ['x', 'y'], launch: true };
  assert.equal((await h.call('POST', m.A('/polls'), m.ann.user, { ...poll })).status, 403);                         // guests never create
  assert.equal((await h.call('POST', m.A('/polls'), m.host.user, { ...poll, roomId: randomUUID() })).status, 404);
  h.sent.length = 0; const pa = await h.call('POST', m.A('/polls'), m.host.user, { ...poll, roomId: a }); assert.equal(pa.status, 201); assert.equal(pa.body.roomName, 'A');
  assert.ok(to(h, m.sid('ann'), 'polls-changed').length && to(h, m.sid('bo'), 'polls-changed').length && to(h, m.sid('host'), 'polls-changed').length);       // the room and the host
  for (const k of ['cy', 'di']) assert.equal(to(h, m.sid(k), 'polls-changed').length, 0, k + ' must not be told');
  const list = async (u) => (await h.call('GET', m.A('/polls'), u)).body.polls.map((p) => p.question + '@' + (p.roomName || 'main'));
  assert.deepEqual(await list(m.ann.user), ['Which?@A']); assert.deepEqual(await list(m.bo.user), ['Which?@A']); assert.deepEqual(await list(m.cy.user), []); assert.deepEqual(await list(m.di.user), []); assert.deepEqual(await list(m.host.user), ['Which?@A']);
  assert.equal((await h.call('POST', m.A(`/polls/${pa.body.id}/votes`), m.cy.user, { choices: [0] })).status, 404);  // another room: it does not even exist
  assert.equal((await h.call('POST', m.A(`/polls/${pa.body.id}/votes`), m.di.user, { choices: [0] })).status, 404);
  assert.equal((await h.call('POST', m.A(`/polls/${pa.body.id}/votes`), m.host.user, { choices: [0] })).status, 403);   // the host votes only inside the poll's room
  assert.equal((await h.call('POST', m.A(`/polls/${pa.body.id}/votes`), m.ann.user, { choices: [0] })).status, 201);
  assert.equal((await h.call('GET', m.A(`/polls/${pa.body.id}/results`), m.cy.user)).status, 404);
  assert.equal((await h.call('GET', m.A(`/polls/${pa.body.id}/export.csv`), m.cy.user)).status, 403);
  // a main-room poll (host in the main room) is for the main room only
  const pm = await h.call('POST', m.A('/polls'), m.host.user, { ...poll, question: 'Main?' }); assert.equal(pm.status, 201); assert.equal(pm.body.roomId, null);
  assert.deepEqual(await list(m.di.user), ['Main?@main']); assert.deepEqual(await list(m.ann.user), ['Which?@A']); assert.deepEqual((await list(m.host.user)).sort(), ['Main?@main', 'Which?@A']);
  assert.equal((await h.call('POST', m.A(`/polls/${pm.body.id}/votes`), m.ann.user, { choices: [0] })).status, 404);
  // the host walking into room B makes room-B polls by default
  await h.call('POST', m.P('/visit'), m.host.user, { roomId: (await h.call('GET', m.P(''), m.host.user)).body.rooms[1].id });
  const pb = await h.call('POST', m.A('/polls'), m.host.user, { ...poll, question: 'In B?' }); assert.equal(pb.body.roomName, 'B'); assert.deepEqual(await list(m.cy.user), ['In B?@B']);
  assert.equal((await h.call('POST', m.A('/polls'), m.host.user, { ...poll, question: 'Back?', roomId: 'main' })).body.roomId, null);
  await h.call('POST', m.P('/recall'), m.host.user);
  assert.equal((await h.call('POST', m.A('/polls'), m.host.user, { ...poll, roomId: a })).status, 409);              // rooms are closed
  assert.ok(!(await list(m.ann.user)).some((q) => q.includes('@A')) && !(await list(m.cy.user)).some((q) => q.includes('@B')));                          // room polls are no longer guests' business
  assert.ok((await list(m.host.user)).includes('Which?@A'));                                                         // the host keeps them for review
  await h.close();
});

test('notes are room-scoped: each room has its own document, everybody in it edits, nothing leaks, the host can read any room, history stays main-only', async () => {
  const h = await harness(); const { m, a, bR } = await running(h);
  const get = async (u, q = '') => (await h.call('GET', m.A('/notes' + q), u));
  const save = (u, text) => h.call('PATCH', m.A('/notes'), u, { sections: ['notes'], doc: { notes: text } });
  assert.equal((await get(m.ann.user)).body.room.name, 'A'); assert.equal((await get(m.ann.user)).body.canEdit, true); assert.equal((await get(m.di.user)).body.room, null);
  h.sent.length = 0; assert.equal((await save(m.ann.user, 'room A secret')).status, 200);
  assert.equal((await get(m.bo.user)).body.doc.notes, 'room A secret'); assert.equal((await get(m.cy.user)).body.doc.notes, ''); assert.equal((await get(m.di.user)).body.doc.notes, ''); assert.equal((await get(m.host.user)).body.doc.notes, '');
  assert.ok(to(h, m.sid('bo'), 'notes-updated').length === 1); for (const k of ['cy', 'di', 'host']) assert.equal(to(h, m.sid(k), 'notes-updated').length, 0, k + ' must not receive room notes');
  assert.equal((await save(m.bo.user, 'room A secret, edited by Bo')).status, 200); assert.equal((await get(m.ann.user)).body.doc.notes, 'room A secret, edited by Bo');       // both can edit
  assert.equal((await save(m.cy.user, 'room B text')).status, 200); assert.equal((await get(m.ann.user)).body.doc.notes, 'room A secret, edited by Bo');
  // the host reads every room (read-only from outside) and edits the main notes
  const ha = await get(m.host.user, '?room=' + a); assert.equal(ha.body.doc.notes, 'room A secret, edited by Bo'); assert.equal(ha.body.canEdit, false); assert.equal(ha.body.room.name, 'A');
  assert.equal((await get(m.host.user, '?room=' + bR)).body.doc.notes, 'room B text'); assert.equal((await get(m.host.user, '?room=nonsense')).status, 404); assert.equal((await get(m.host.user, '?room=' + randomUUID())).status, 404);
  assert.equal((await get(m.ann.user, '?room=' + bR)).body.doc.notes, 'room A secret, edited by Bo');               // a guest cannot read another room by asking
  assert.equal((await get(m.host.user, '?room=main')).body.room, null);
  assert.equal((await save(m.host.user, 'main notes')).status, 200); assert.equal((await get(m.di.user)).body.doc.notes, 'main notes'); assert.equal((await get(m.ann.user)).body.doc.notes, 'room A secret, edited by Bo');
  assert.equal(to(h, m.sid('di'), 'notes-updated').length, 1); assert.equal(to(h, m.sid('ann'), 'notes-updated').length, 2);                       // Di: the main save; Ann: the two room saves
  // main-only features
  assert.equal((await h.call('POST', m.A('/notes/snapshot'), m.ann.user, {})).status, 409); assert.equal((await h.call('GET', m.A('/notes/revisions'), m.ann.user)).body.revisions.length, 0);
  assert.equal((await h.call('POST', m.A('/notes/editors'), m.host.user, { participantId: m.di.id, allow: true })).status, 200);                     // the host is in the main room
  assert.ok((await h.call('GET', m.A('/notes/revisions'), m.host.user)).body.revisions.length >= 1);                                               // main history is kept
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM meeting_notes_revisions WHERE meeting_id=$1', [m.mid])).rows[0].n, 1);             // room edits wrote no main revision
  // after the session the guests are back on the main notes
  await h.call('POST', m.P('/recall'), m.host.user); assert.equal((await get(m.ann.user)).body.doc.notes, 'main notes'); assert.equal((await get(m.ann.user)).body.room, null);
  assert.equal((await get(m.host.user, '?room=' + a)).body.doc.notes, 'room A secret, edited by Bo');                                              // kept for the host
  await h.close();
});
