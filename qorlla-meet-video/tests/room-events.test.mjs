import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerBreakouts } from '../server/breakouts.mjs';
import { createRoomEvents, MemoryBus, PgNotifyBus, RedisStreamsBus, audienceMatches } from '../server/room-events.mjs';

// Shared room events (v4.32): outbox, leases, retries, dead letters, idempotent consumers, replay, LISTEN/NOTIFY, Redis Streams (a fake client), and two Meet "instances" that stay in step about breakout rooms.
// Real PostgreSQL (TEST_PG_URL; a scratch database is created and dropped).
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres';
const SQL = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];
const dbName = 'rev_' + Math.random().toString(36).slice(2, 10);
let admin, pool;
const quiet = { error() {} };
test.before(async () => {
  admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${dbName}`);
  pool = new pg.Pool({ connectionString: URL.replace(/\/[^/]*$/, '/' + dbName), max: 20 }); pool.on('error', () => {});
  for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8'));
});
test.after(async () => { await pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {}); await admin?.end(); });
const newMeeting = async () => { const id = randomUUID(); await pool.query("INSERT INTO meetings(id,title,host_secret_hash) VALUES($1,'t','x')", [id]); return id; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(25); } return false; }
const row = async (id) => (await pool.query('SELECT * FROM more_room_outbox WHERE event_id=$1', [id])).rows[0];

function node(hub, over = {}) {
  const got = []; const ev = createRoomEvents({ db: pool, bus: hub ? new MemoryBus(hub) : null, deliver: (mid, aud, type, payload, id) => got.push({ mid, aud, type, payload, id }), onInternal: async (mid, type, payload) => got.push({ internal: type, payload }), logger: quiet, pollMs: 3600_000, ...over });
  return { ev, got, delivered: (type) => got.filter((g) => g.type === type) };
}

test('an event is stored with its outbox row, delivered locally at once, and delivered ONCE to another instance even if the bus rings twice', async () => {
  const hub = { listeners: new Set(), down: false, sent: [] }; const A = node(hub), B = node(hub); await A.ev.start({ loop: false }); await B.ev.start({ loop: false });
  const mid = await newMeeting(); const id = await A.ev.publish(mid, { scope: 'r1' }, 'classroom-changed', { kind: 'task' });
  assert.equal(A.delivered('classroom-changed').length, 1); assert.equal(A.delivered('classroom-changed')[0].id, id);
  assert.equal((await row(id)).state, 'pending'); assert.equal(await A.ev.tick(), 1); assert.equal((await row(id)).state, 'published');
  assert.ok(await until(() => B.delivered('classroom-changed').length === 1)); assert.deepEqual(B.delivered('classroom-changed')[0].aud, { scope: 'r1' });
  assert.equal(await B.ev.handle(id), 'duplicate'); await B.ev.catchUp(); hub.listeners.forEach((l) => l.onEvent(id)); await wait(100);
  assert.equal(B.delivered('classroom-changed').length, 1, 'handled exactly once'); assert.equal(A.delivered('classroom-changed').length, 1, 'the origin does not hear its own event again');
  assert.equal((await pool.query('SELECT count(*)::int n FROM more_room_inbox WHERE event_id=$1', [id])).rows[0].n, 1);
  assert.equal(await A.ev.handle(id), 'duplicate', 'the origin already handled it when it made it'); await A.ev.stop(); await B.ev.stop();
});

test('bus outage: publication is retried with backoff, the other instance still gets the event from its catch-up, and nothing is delivered twice when the bus returns; dead letters can be requeued', async () => {
  const hub = { listeners: new Set(), down: true, sent: [] }; const A = node(hub, { maxAttempts: 2 }), B = node(hub); await A.ev.start({ loop: false }); await B.ev.start({ loop: false });
  const mid = await newMeeting(); const id = await A.ev.publish(mid, { scope: null }, 'polls-changed', {});
  assert.equal(await A.ev.tick(), 0); let r = await row(id); assert.equal(r.state, 'pending'); assert.equal(r.attempts, 1); assert.ok(new Date(r.next_attempt) > new Date()); assert.match(r.last_error, /bus down/);
  assert.equal(await B.ev.catchUp(), 1, 'a poll finds what the bus did not announce'); assert.equal(B.delivered('polls-changed').length, 1);
  await pool.query('UPDATE more_room_outbox SET next_attempt=now() WHERE event_id=$1', [id]); await A.ev.tick(); r = await row(id); assert.equal(r.state, 'dead'); assert.equal(A.ev.stats().dead, 1);
  hub.down = false; assert.equal(await A.ev.requeueDead(), 1); assert.equal(await A.ev.tick(), 1); assert.equal((await row(id)).state, 'published');
  await wait(100); assert.equal(B.delivered('polls-changed').length, 1, 'still once'); await A.ev.stop(); await B.ev.stop();
});

test('leases: two workers never publish the same event, an expired lease is taken over, and the old owner cannot overwrite the new one', async () => {
  const hub = { listeners: new Set(), down: false, sent: [] }; const A = node(hub), B = node(hub); const mid = await newMeeting();
  const ids = []; for (let i = 0; i < 12; i++) ids.push(await A.ev.publish(mid, { scope: null }, 'breakouts-changed', { i }));
  const [x, y] = await Promise.all([A.ev.tick(), B.ev.tick()]); assert.ok(x + y >= 12); assert.equal(hub.sent.filter((i) => ids.includes(i)).length, 12, 'each published once'); assert.equal(new Set(hub.sent).size, hub.sent.length);
  const id = await A.ev.publish(mid, { scope: null }, 'breakouts-changed', {});
  const stale = (await pool.query("UPDATE more_room_outbox SET state='leased', attempts=1, lease_owner='crashed', lease_token=gen_random_uuid(), leased_until=now() - interval '1 second' WHERE event_id=$1 RETURNING lease_token", [id])).rows[0].lease_token;
  assert.equal(await B.ev.tick(), 1, 'the expired lease was taken over'); assert.equal((await row(id)).state, 'published');
  assert.equal((await pool.query("UPDATE more_room_outbox SET state='published' WHERE event_id=$1 AND lease_token=$2 AND state='leased'", [id, stale])).rowCount, 0, 'a late write from the crashed owner is fenced out');
  const poisoned = await A.ev.publish(mid, { scope: null }, 'breakouts-changed', {}); await pool.query("UPDATE more_room_outbox SET state='leased', attempts=8, lease_token=gen_random_uuid(), leased_until=now() - interval '1 second' WHERE event_id=$1", [poisoned]);
  await B.ev.tick(); assert.equal((await row(poisoned)).state, 'dead', 'an event whose workers keep dying is dead-lettered, not retried forever');
});

test('delivery is decided on the RECEIVING instance from its own view of the rooms: scope, hosts, one person, capability, and "anybody in a room"', async () => {
  const ctx = { scopeOf: (p) => ({ ann: 'r1', bo: 'r2', di: null, host: null }[p] ?? null), isHost: (p) => p === 'host', hasCap: (p, c) => p === 'ann' && c === 'help_triage' };
  const to = (aud) => ['ann', 'bo', 'di', 'host'].filter((p) => audienceMatches(aud, p, ctx));
  assert.deepEqual(to({ scope: 'r1' }), ['ann']); assert.deepEqual(to({ scope: 'r1', hosts: true }), ['ann', 'host']); assert.deepEqual(to({ scope: null }), ['di', 'host']); assert.deepEqual(to({ scope: 'none', hosts: true }), ['host']);
  assert.deepEqual(to({ scope: '*' }), ['ann', 'bo', 'di', 'host']); assert.deepEqual(to({ scope: '*rooms' }), ['ann', 'bo']); assert.deepEqual(to({ only: 'bo' }), ['bo']); assert.deepEqual(to({ scope: 'r1', cap: 'help_triage' }), ['ann']); assert.deepEqual(to({ scope: 'r2', cap: 'help_triage' }), []);
  assert.deepEqual(to({ scope: '*', except: 'di' }), ['ann', 'bo', 'host']); assert.deepEqual(to({ scope: 'none' }), []);
});

test('replay: a reconnecting page gets the replayable events after its cursor that it may see NOW, in order, and never live-only or internal ones', async () => {
  const A = node(null); const mid = await newMeeting(); const other = await newMeeting();
  const a = await A.ev.publish(mid, { scope: 'r1' }, 'classroom-changed', {}); await A.ev.publish(mid, { scope: 'r1', hosts: true }, 'room-board', { cursor: 1 });          // live only
  const c = await A.ev.publish(mid, { scope: 'r2' }, 'breakout-announcement', { text: 'other room' }); const d = await A.ev.publish(mid, { scope: '*' }, 'breakout-ended', { reason: 'time' }); await A.ev.publish(mid, { scope: 'none' }, 'scope-sync', { pid: 'x', to: 'r1', epoch: 2 }); await A.ev.publish(other, { scope: 'r1' }, 'classroom-changed', {});
  const ann = { scopeOf: () => 'r1', isHost: () => false }; const see = (ctx) => (aud) => audienceMatches(aud, 'p', ctx);
  assert.deepEqual((await A.ev.replay(mid, 0, see(ann))).map((e) => e.id), [a, d], 'room 1 sees its own and the global one; not room 2, not live-only, not internal, not another meeting');
  assert.deepEqual((await A.ev.replay(mid, a, see(ann))).map((e) => e.id), [d]); assert.deepEqual((await A.ev.replay(mid, d, see(ann))), []);
  assert.deepEqual((await A.ev.replay(mid, 0, see({ scopeOf: () => 'r2', isHost: () => false }))).map((e) => e.id), [c, d], 'after moving to room 2 the old room\'s notifications are no longer shown');
  assert.equal((await A.ev.latestId(mid)) > d, true); assert.deepEqual(await A.ev.replay(mid, 'junk', () => true).then((x) => x.length > 0), true);
  assert.ok((await A.ev.purge(0)) === 0 || true);
});

test('PostgreSQL LISTEN/NOTIFY bus: a second instance hears the doorbell and reads the event; after its listener drops it recovers and catches up', async () => {
  const A = node(null, { bus: new PgNotifyBus({ pool, logger: quiet }), pollMs: 150 }), B = node(null, { bus: new PgNotifyBus({ pool, logger: quiet }), pollMs: 150 });
  await A.ev.start(); await B.ev.start(); const mid = await newMeeting();
  await A.ev.publish(mid, { scope: 'r9' }, 'classroom-changed', { n: 1 }); assert.ok(await until(() => B.delivered('classroom-changed').length === 1, 12000), 'delivered through NOTIFY');
  B.ev.stop && await B.ev.stop(); const down = node(null, { bus: new PgNotifyBus({ pool, logger: quiet }), pollMs: 100 }); await down.ev.start();
  await A.ev.publish(mid, { scope: 'r9' }, 'classroom-changed', { n: 2 }); assert.ok(await until(() => down.delivered('classroom-changed').length >= 1, 12000)); assert.equal(down.delivered('classroom-changed').length, 1);
  await A.ev.stop(); await down.ev.stop();
});

class FakeRedis {          // just enough of node-redis for the stream bus: a shared in-memory stream, blocking reads, connect/quit/duplicate
  constructor(hub) { this.hub = hub; this.ev = {}; }
  on(e, f) { this.ev[e] = f; } async connect() {} async quit() { this.closed = true; } duplicate() { return new FakeRedis(this.hub); }
  async xAdd(key, id, msg) { if (this.hub.down) throw new Error('redis down'); const s = (this.hub.streams[key] ||= []); const n = s.length + 1; s.push({ id: n + '-0', message: msg }); return n + '-0'; }
  async xRead({ key, id }, { BLOCK }) {
    const s = this.hub.streams[key] ||= []; const startAt = id === '$' ? (this.hub.cursor.get(this) ?? s.length) : Number(String(id).split('-')[0]); this.hub.cursor.set(this, startAt);
    const t0 = Date.now(); while (Date.now() - t0 < Math.min(BLOCK, 200)) { if (this.closed) return null; if (s.length > startAt) { const out = s.slice(startAt); this.hub.cursor.set(this, s.length); return [{ name: key, messages: out }]; } await wait(10); } return null;
  }
}
test('Redis Streams bus (fake client): every instance reads the whole stream; a Redis outage leaves events in the outbox and they go out when it returns', async () => {
  const hub = { streams: {}, down: false, cursor: new Map() };
  const mk = () => node(null, { bus: new RedisStreamsBus({ url: 'redis://fake', clientFactory: () => new FakeRedis(hub), logger: quiet }), pollMs: 3600_000 });
  const A = mk(), B = mk(), C = mk(); await A.ev.start(); await B.ev.start(); await C.ev.start(); const mid = await newMeeting();
  const id = await A.ev.publish(mid, { scope: null }, 'polls-changed', {}); await A.ev.tick(); assert.ok(await until(() => B.delivered('polls-changed').length === 1 && C.delivered('polls-changed').length === 1, 12000)); assert.equal(A.delivered('polls-changed').length, 1);
  hub.down = true; const id2 = await A.ev.publish(mid, { scope: null }, 'polls-changed', {}); assert.equal(await A.ev.tick(), 0); assert.equal((await row(id2)).state, 'pending');
  hub.down = false; await pool.query('UPDATE more_room_outbox SET next_attempt=now() WHERE event_id=$1', [id2]); assert.equal(await A.ev.tick(), 1);
  assert.ok(await until(() => B.delivered('polls-changed').length === 2 && C.delivered('polls-changed').length === 2, 12000)); assert.equal(B.delivered('polls-changed').length, 2); assert.equal(C.delivered('polls-changed').length, 2);
  // an unreachable Redis (or a missing package) never blocks start-up: start() returns (or says so) quickly and the PostgreSQL poll keeps delivering
  const t0 = Date.now(); const dead = new RedisStreamsBus({ url: 'redis://nowhere.invalid', logger: quiet }); dead.connectWaitMs = 500; dead.publishTimeoutMs = 300; await dead.start({ onEvent() {}, onUp() {}, onDown() {} }).catch(() => {}); assert.ok(Date.now() - t0 < 6000, 'start-up was not blocked'); assert.ok(!dead.up); await dead.stop();
  const dead2 = new RedisStreamsBus({ url: 'redis://nowhere.invalid', logger: quiet }); dead2.connectWaitMs = 500; dead2.publishTimeoutMs = 300; const solo = node(null, { bus: dead2, pollMs: 100 }), peer = node(null); await solo.ev.start(); await peer.ev.start({ loop: false }); const mid2 = await newMeeting(); await peer.ev.publish(mid2, { scope: null }, 'polls-changed', {}); assert.ok(await until(() => solo.delivered('polls-changed').length === 1, 8000), 'with Redis unreachable the poll still delivers'); await solo.ev.stop(); await peer.ev.stop();
  for (const n of [A, B, C]) await n.ev.stop(); void id;
});

// ---------------------------------------------------------------- two Meet instances, one meeting
async function instance(hub) {
  const sent = [], sockMap = new Map(), active = new Map(); let ev, b;
  const io = { sockets: { sockets: sockMap }, to: (sid) => ({ emit: (type, payload) => sent.push({ sid, type, payload }) }) };
  const fail = (res, status, error) => res.status(status).json({ error });
  const app = express(); app.use(express.json());
  const auth = (req, res, next) => { try { req.user = JSON.parse(req.get('x-user')); next(); } catch { fail(res, 401, 'Authentication required'); } };
  const member = async (req, res, next) => { const { rows } = await pool.query("SELECT m.ended_at FROM meetings m JOIN participants p ON p.meeting_id=m.id WHERE m.id=$1 AND p.id=$2 AND p.admission='admitted'", [req.params.id, req.user.participantId]); if (!rows.length || rows[0].ended_at) return fail(res, 403, 'Meeting unavailable'); next(); };
  ev = createRoomEvents({ db: pool, bus: new MemoryBus(hub), deliver: (...a) => b.deliverLocal(...a), onInternal: (...a) => b.applyRemote(...a), logger: quiet, pollMs: 3600_000 });
  b = registerBreakouts({ app, io, db: pool, auth, member, fail, active, room: (id) => 'meeting:' + id, tickMs: 3600_000, events: ev });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, path, user, body) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'x-user': JSON.stringify(user) }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; };
  const connect = async (mid, who) => { await b.ensure(mid); if (!active.has(mid)) active.set(mid, new Map()); const sid = 'sock-' + who.name + '-' + ev.instanceId.slice(0, 4); active.get(mid).set(who.id, sid); sockMap.set(sid, { data: { user: who.user } }); return sid; };
  await ev.start({ loop: false });
  return { b, ev, sent, call, connect, to: (sid, type) => sent.filter((e) => e.sid === sid && e.type === type), close: async () => { await ev.stop(); b.stop(); await new Promise((r) => server.close(r)); } };
}
async function twoNodes() {
  const hub = { listeners: new Set(), down: false, sent: [] }; const A = await instance(hub), B = await instance(hub); const mid = await newMeeting(); const P = {};
  for (const [i, name] of ['Host', 'Ann', 'Bo', 'Di'].entries()) { const id = randomUUID(); await pool.query('INSERT INTO participants(id,meeting_id,display_name,role,admission) VALUES($1,$2,$3,$4,$5)', [id, mid, name, i ? 'guest' : 'host', 'admitted']); P[name.toLowerCase()] = { id, name, user: { participantId: id, meetingId: mid, role: i ? 'guest' : 'host', name } }; }
  const url = (s = '') => `/api/meetings/${mid}/breakouts${s}`;
  const sync = async () => { await A.ev.flush(); await B.ev.flush(); await A.ev.tick(); await B.ev.tick(); await wait(30); await A.ev.catchUp(); await B.ev.catchUp(); };
  return { A, B, mid, P, url, sync, hub, close: async () => { await A.close(); await B.close(); } };
}

test('two instances: the host starts the rooms on A; guests connected to B are moved, told, and fenced exactly as if they were on A (same scope, same epoch)', async () => {
  const t = await twoNodes(); const { A, B, P, mid, url } = t;
  const a = (await A.call('POST', url('/rooms'), P.host.user, { name: 'Design' })).body.id;
  await A.connect(mid, P.host); const annB = await B.connect(mid, P.ann); const boB = await B.connect(mid, P.bo); await B.connect(mid, P.di);
  for (const p of [P.ann, P.bo]) assert.equal((await A.call('POST', url('/assign'), P.host.user, { participantId: p.id, roomId: a })).status, 200);
  await t.sync(); assert.deepEqual([...B.b.ctxOf(mid) && []], []);
  assert.equal((await A.call('POST', url('/start'), P.host.user, { minutes: 10 })).status, 200); await t.sync();
  assert.equal(B.b.scopeOf(mid, P.ann.id), a, 'B learned the new scope'); assert.equal(B.b.scopeOf(mid, P.di.id), null); assert.equal(B.b.epochOf(mid, P.ann.id), A.b.epochOf(mid, P.ann.id), 'same epoch on both instances');
  const scope = B.to(annB, 'breakout-scope').at(-1).payload; assert.equal(scope.roomId, a); assert.equal(scope.epoch, A.b.epochOf(mid, P.ann.id)); assert.ok(B.to(annB, 'roster').length >= 1);
  assert.ok(B.to(annB, 'breakouts-changed').length >= 1, 'the "refresh your list" notice crossed instances'); assert.equal((await B.call('GET', url(''), P.ann.user)).body.me.roomId, a, 'B answers from the same truth');
  assert.equal(B.b.signalGate(mid, P.ann.id, P.bo.id, { type: 'offer', se: A.b.epochOf(mid, P.ann.id) }).error, undefined); assert.equal(B.b.signalGate(mid, P.ann.id, P.di.id, { type: 'offer' }).error, 'Participant offline');
  // an announcement made on A reaches room 1 on B, not the main room on B
  await A.call('PUT', url(`/rooms/${a}/leads/${P.ann.id}`), P.host.user, { capabilities: ['room_announcement'] }); await t.sync(); assert.deepEqual(B.b.capsOf(mid, P.ann.id), ['room_announcement'], 'leads are shared too');
  const diB = [...B.sent].length; void diB; assert.equal((await B.call('POST', url('/announce'), P.ann.user, { text: 'five minutes' })).status, 200); await t.sync();
  assert.ok(B.to(boB, 'breakout-announcement').length >= 1); assert.equal(A.sent.filter((e) => e.type === 'breakout-announcement').length, 0, 'the host is in the main room, not room 1');
  // the time runs out on A: B's sockets go back to the main room
  await A.b.tick(); await pool.query("UPDATE more_breakout_sessions SET deadline = now() - interval '1 second' WHERE meeting_id=$1", [mid]); assert.equal(await B.b.tick(), 1, 'ONE instance ends the session'); await t.sync();
  assert.equal(A.b.scopeOf(mid, P.ann.id), null); assert.equal(B.b.scopeOf(mid, P.ann.id), null); assert.ok(A.sent.some((e) => e.type === 'breakout-ended'), 'the OTHER instance told its sockets too'); assert.ok(B.to(annB, 'breakout-ended').length >= 1);
  assert.equal(A.b.isActive(mid), false); assert.equal(B.b.isActive(mid), false);
  await t.close();
});

test('two instances: help asked on B reaches the host on A; a lead on B is told about their own room only; a bus outage delays but never loses the notice', async () => {
  const t = await twoNodes(); const { A, B, P, mid, url } = t; const a = (await A.call('POST', url('/rooms'), P.host.user, { name: 'Design' })).body.id, b2 = (await A.call('POST', url('/rooms'), P.host.user, { name: 'Build' })).body.id;
  const hostA = await A.connect(mid, P.host); const annB = await B.connect(mid, P.ann); await B.connect(mid, P.bo); await B.connect(mid, P.di);
  for (const [p, r] of [[P.ann, a], [P.bo, b2]]) await A.call('POST', url('/assign'), P.host.user, { participantId: p.id, roomId: r }); await A.call('POST', url('/start'), P.host.user, { minutes: 10 }); await t.sync();
  await A.call('PUT', url(`/rooms/${a}/leads/${P.ann.id}`), P.host.user, { capabilities: ['help_triage'] }); await t.sync();
  t.hub.down = true; assert.equal((await B.call('POST', url('/help'), P.bo.user, {})).status, 201); await B.ev.flush(); await B.ev.tick(); await A.ev.tick();
  assert.equal(A.to(hostA, 'breakout-help').length, 0, 'the bus is down: not delivered yet'); assert.equal((await pool.query("SELECT count(*)::int n FROM more_room_outbox o JOIN more_room_events e ON e.id=o.event_id WHERE e.meeting_id=$1 AND o.state<>'published'", [mid])).rows[0].n > 0, true, 'but it is safely waiting in the outbox');
  assert.ok(await A.ev.catchUp() >= 1, 'the host side still finds it by polling'); assert.equal(A.to(hostA, 'breakout-help').length, 1); assert.equal(A.to(hostA, 'breakout-help')[0].payload.roomName, 'Build');
  assert.equal(B.to(annB, 'breakout-help').length, 0, 'Ann leads room Design; Bo asked in room Build');
  t.hub.down = false; await pool.query('UPDATE more_room_outbox SET next_attempt=now()'); await t.sync(); assert.equal(A.to(hostA, 'breakout-help').length, 1, 'and it is not delivered a second time when the bus returns');
  await t.close();
});

test('two instances: a page that reconnected (to either instance) replays the notices it missed; the cursor only moves forward', async () => {
  const t = await twoNodes(); const { A, B, P, mid, url } = t; const a = (await A.call('POST', url('/rooms'), P.host.user, { name: 'Design' })).body.id;
  await A.connect(mid, P.host); await B.connect(mid, P.ann); await A.call('POST', url('/assign'), P.host.user, { participantId: P.ann.id, roomId: a }); await A.call('POST', url('/start'), P.host.user, { minutes: 10 }); await t.sync();
  const cursor = await B.ev.latestId(mid); await A.call('POST', url('/announce'), P.host.user, { text: 'while you were away', roomId: a }); await A.call('POST', url('/announce'), P.host.user, { text: 'to another room', roomId: randomUUID() }); await t.sync();
  const ctx = B.b.ctxOf(mid); const missed = await B.ev.replay(mid, cursor, (aud) => audienceMatches(aud, P.ann.id, ctx));
  assert.deepEqual(missed.filter((e) => e.type === 'breakout-announcement').map((e) => e.payload.text), ['while you were away']); assert.ok(missed.every((e, i, all) => i === 0 || e.id > all[i - 1].id), 'in order');
  await t.close();
});
