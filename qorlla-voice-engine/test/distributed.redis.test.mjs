// v1.3/v1.4 gates DR-02, DR-03, DR-06, DR-08 with REAL PostgreSQL and REAL Redis (a disposable container of our own): two replicas, a Redis outage, a replica restart, dropped database connections.
// These are single-machine failure-injection tests. They are evidence for the design, not a substitute for a staged failover drill on the real infrastructure (see CERTIFICATION.md).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from 'redis';
import { isolatedDb, identityProvider, wait } from './helpers.mjs';
import { harness, redisContainer, until, SDP } from './harness.mjs';
import { CHANNEL, validateEnvelope } from '../src/bus.mjs';
import { VoiceRouter } from '../src/router.mjs';

let db, idp, h, redis, redisOk = false, ext;
before(async () => {
  db = await isolatedDb(); if (!db) return; idp = await identityProvider(); h = harness({ db, idp });
  redis = redisContainer(); redisOk = !!redis && (await redis.ping());
});
after(async () => { if (h) await h.closeAll(); if (idp) await idp.close(); if (db) await db.drop(); if (redis) redis.remove(); });
const skip = (t) => { if (!db) { t.skip('no PostgreSQL reachable'); return true; } if (!redisOk) { t.skip('no docker/redis image available'); return true; } return false; };
const busUp = (...rs) => until(() => rs.every((r) => r.voice.bus.up), 15000);
const metrics = async (r) => (await fetch(r.base + '/v1/voice/admin/metrics', { headers: { 'x-voice-admin-secret': 'a'.repeat(40) } })).json();
const endAll = () => db.pool.query("UPDATE voice_calls SET status='ended', ended_at=now() WHERE status IN ('ringing','active')");

test('DR-06: two replicas share one truth: events, signaling and device ownership agree across nodes', async (t) => {
  if (skip(t)) return;
  const r1 = await h.replica({ redisUrl: redis.url, maintenance: false }), r2 = await h.replica({ redisUrl: redis.url, maintenance: false }); assert.ok(await busUp(r1, r2), 'both replicas connected to Redis');
  ext = await h.people(r1, ['alice', 'bob', 'carol', 'dave']);
  const a = await r1.connect('alice', 'd1'), b = await r2.connect('bob', 'd1');                                                           // different replicas
  const d = await r1.dial('alice', ext.bob); assert.equal(d.status, 201); const id = d.body.call.id;
  const inc = await until(() => b.of('incoming')[0]); assert.ok(inc && inc.call.id === id && inc.eventId, 'the callee on the OTHER replica was told');
  assert.equal((await r2.answer(id, 'bob')).status, 200);                                                                                 // answered through the other node
  assert.ok(await until(() => a.of('state', (m) => m.call.status === 'active')[0]));
  a.send({ type: 'offer', callId: id, generation: 1, sdp: SDP }); assert.ok(await until(() => b.of('offer')[0]), 'SDP crossed replicas');
  b.send({ type: 'answer', callId: id, generation: 1, sdp: SDP }); assert.ok(await until(() => a.of('answer')[0]));
  a.send({ type: 'ice', callId: id, generation: 1, candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } }); assert.ok(await until(() => b.of('ice')[0]));
  // takeover decided on replica 2 binds replica 1 immediately, because both read the lease from PostgreSQL
  const a2 = await r2.connect('alice', 'd2'); const claim = await r2.api('alice', 'POST', `/v1/voice/calls/${id}/device`, { deviceId: r2.device('alice', 'd2') }); assert.equal(claim.body.generation, 2);
  assert.ok(await until(() => a.of('device_revoked')[0]), 'the replaced device (on replica 1) was told by replica 2'); assert.ok(await until(() => b.of('device_claimed')[0]));
  const n = b.of('offer').length; a.send({ type: 'offer', callId: id, generation: 1, sdp: SDP }); a.send({ type: 'offer', callId: id, generation: 2, sdp: SDP }); await wait(300); assert.equal(b.of('offer').length, n, 'replica 1 refused the replaced device');
  a2.send({ type: 'offer', callId: id, generation: 2, sdp: SDP }); assert.ok(await until(() => b.of('offer').length === n + 1));
  // two replicas racing to claim for the same account: serialised by PostgreSQL, unique generations
  const [c1, c2] = await Promise.all([r1.api('alice', 'POST', `/v1/voice/calls/${id}/device`, { deviceId: r1.device('alice', 'd3') }), r2.api('alice', 'POST', `/v1/voice/calls/${id}/device`, { deviceId: r2.device('alice', 'd4') })]);
  assert.deepEqual([c1.body.generation, c2.body.generation].sort(), [3, 4]);
  assert.equal(Number((await db.pool.query("SELECT count(*) n FROM voice_media_leases WHERE call_id=$1 AND account_id='alice'", [id])).rows[0].n), 1);
  await r1.api('bob', 'POST', `/v1/voice/calls/${id}/end`, {}); await r1.stop(); await r2.stop();
});

test('DR-06: forged or malformed bus messages are dropped, and the envelope rules hold', async (t) => {
  if (skip(t)) return;
  const good = { version: 1, id: '11111111-1111-4111-8111-111111111111', source: 's', account: 'dave', device: null, ts: Date.now(), payload: { type: 'state' } };
  assert.equal(validateEnvelope(good), true);
  for (const bad of [null, {}, { ...good, version: 2 }, { ...good, id: 'x' }, { ...good, ts: Date.now() - 60000 }, { ...good, ts: 'now' }, { ...good, account: 7 }, { ...good, device: 5 }, { ...good, payload: 'x'.repeat(80000) }, { ...good, source: 'x'.repeat(200) }]) assert.equal(validateEnvelope(bad), false);
  const r = await h.replica({ redisUrl: redis.url, maintenance: false }); assert.ok(await busUp(r));
  assert.ok(await until(async () => (await metrics(r)).outbox.pending === 0, 20000), 'earlier tests left nothing undelivered');                    // late events from earlier tests must not be mistaken for forged ones
  const b = await r.connect('dave', 'd1');
  const rogue = createClient({ url: redis.url }); await rogue.connect();
  await rogue.publish(CHANNEL, 'not json'); await rogue.publish(CHANNEL, JSON.stringify({ ...good, ts: 1 })); await rogue.publish(CHANNEL, JSON.stringify({ ...good, version: 9 }));
  await wait(400); assert.equal(b.of('state').length, 0, 'invalid envelopes never reach a socket');
  await rogue.publish(CHANNEL, JSON.stringify({ ...good, id: '22222222-2222-4222-8222-222222222222', ts: Date.now() })); assert.ok(await until(() => b.of('state')[0]), 'a valid envelope is delivered (so Redis must be protected by ACL/TLS: see the runbook)');
  await rogue.quit(); await r.stop();
});

test('DR-02 + DR-03: a Redis outage loses no durable event; a device that was offline recovers everything on a DIFFERENT node, in order, and only its own', async (t) => {
  if (skip(t)) return;
  await endAll();
  const r1 = await h.replica({ redisUrl: redis.url, maintenance: false }), r2 = await h.replica({ redisUrl: redis.url, maintenance: false }); assert.ok(await busUp(r1, r2));
  const a = await r1.connect('alice', 'd1'), b = await r2.connect('bob', 'd1'), cursor = b.of('ready')[0].cursor; b.close(); await b.closed;       // bob goes offline (his phone is off)
  const stranger = await r2.connect('carol', 'd1');
  redis.stop(); t.after(() => { redis.start(); });                                                                                          // whatever happens, Redis comes back for the next test
  assert.ok(await until(async () => !r1.voice.bus.up && !r2.voice.bus.up, 15000), 'both replicas noticed the outage');
  const ready = await fetch(r1.base + '/readyz').then((x) => x.json()); assert.equal(ready.ok, true); assert.deepEqual(ready.degraded, ['redis']);   // degraded, not down: the database is the source of truth
  const c1 = await r1.dial('alice', ext.bob); assert.equal(c1.status, 201, 'calls still work during the outage');                              // call 1 rings while bob is offline and Redis is down
  assert.equal((await r1.api('alice', 'POST', `/v1/voice/calls/${c1.body.call.id}/end`, {})).status, 200);
  const c2 = await r1.dial('alice', ext.bob); assert.equal(c2.status, 201);
  await wait(1200); const during = await metrics(r1); assert.ok(during.outbox.pending >= 3, 'the events are retained in PostgreSQL, not lost: ' + JSON.stringify(during.outbox)); assert.equal(during.bus, 'down');
  redis.start(); assert.ok(await redis.ping()); assert.ok(await busUp(r1, r2), 'the replicas reconnected by themselves');
  assert.ok(await until(() => a.of('state', (m) => m.call.id === c1.body.call.id && m.call.status === 'ended')[0], 20000), 'alice, on her node, learned that call 1 ended (by local delivery or by the bus after recovery)');
  assert.ok(await until(async () => (await metrics(r1)).outbox.pending === 0, 30000), 'the publisher drained the backlog after recovery: ' + JSON.stringify(await metrics(r1)));
  // bob comes back on the OTHER node and asks for what he missed
  const b2 = await r1.connect('bob', 'd1', { resumeAfter: cursor }); const batch = await until(() => b2.of('resume_batch')[0]); assert.ok(batch);
  assert.deepEqual(batch.events.map((e) => e.kind), ['incoming', 'state', 'incoming']); const ids = batch.events.map((e) => e.id); assert.deepEqual(ids, [...ids].sort((x, y) => x - y));
  assert.deepEqual(batch.events.map((e) => e.payload.call.id), [c1.body.call.id, c1.body.call.id, c2.body.call.id]);
  assert.ok(batch.events.every((e) => e.payload.call.callee_id === 'bob'));                                                                   // nothing that belongs to anybody else
  assert.equal(stranger.of('incoming').length, 0); assert.ok(!JSON.stringify(batch).includes('carol'));
  assert.equal((await r1.api('bob', 'GET', '/v1/voice/calls/live')).body.call.id, c2.body.call.id);                                           // the snapshot agrees with the replayed events
  await r1.api('alice', 'POST', `/v1/voice/calls/${c2.body.call.id}/end`, {}); await r1.stop(); await r2.stop();
});

test('DR-08: a signaling node is killed mid-call and a new one takes over: no duplicate call, state intact, the device recovers by claiming a new generation', async (t) => {
  if (skip(t)) return;
  await endAll();
  const r1 = await h.replica({ redisUrl: redis.url, maintenance: false }), r2 = await h.replica({ redisUrl: redis.url, maintenance: false }); assert.ok(await busUp(r1, r2));
  const a = await r1.connect('alice', 'd1'), b = await r2.connect('bob', 'd1'), key = 'restart-key-' + Date.now();
  const d = await r1.dial('alice', ext.bob, 'd1', key); const id = d.body.call.id; await r2.answer(id, 'bob'); assert.ok(await until(() => a.of('state', (m) => m.call.status === 'active')[0]));
  const lastSeen = Math.max(...a.of('state').map((m) => m.eventId || 0));
  await r1.stop();                                                                                                                             // kill the node that holds alice's socket
  assert.equal(await a.closed >= 1000, true);
  const row = (await db.pool.query('SELECT status, version FROM voice_calls WHERE id=$1', [id])).rows[0]; assert.equal(row.status, 'active');          // the control state survived
  const r3 = await h.replica({ redisUrl: redis.url, maintenance: false }); assert.ok(await busUp(r3));
  const a3 = await r3.connect('alice', 'd1', { resumeAfter: lastSeen }); assert.ok(await until(() => a3.of('resume_batch')[0]));
  const retry = await r3.dial('alice', ext.bob, 'd1', key); assert.equal(retry.status, 200); assert.equal(retry.body.reused, true); assert.equal(retry.body.call.id, id);   // the client's retry of the same request: same call
  assert.equal(Number((await db.pool.query("SELECT count(*) n FROM voice_calls WHERE caller_id='alice' AND status IN ('ringing','active')")).rows[0].n), 1);
  assert.equal((await r3.api('alice', 'GET', '/v1/voice/calls/live')).body.call.status, 'active');
  const claim = await r3.api('alice', 'POST', `/v1/voice/calls/${id}/device`, { deviceId: r3.device('alice', 'd1') }); assert.equal(claim.body.generation, 2);        // recovery: a fresh generation for the same device
  assert.ok(await until(() => b.of('device_claimed')[0]));
  a3.send({ type: 'offer', callId: id, generation: 2, sdp: SDP }); assert.ok(await until(() => b.of('offer').find((m) => m.gen === 2)), 'signaling works through the new node');
  b.send({ type: 'answer', callId: id, generation: 1, sdp: SDP }); assert.ok(await until(() => a3.of('answer')[0]));
  // database connections are cut under load: the engine recovers by itself and the state is exactly what it was
  const before = (await db.pool.query('SELECT status, version FROM voice_calls WHERE id=$1', [id])).rows[0];
  await db.admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND pid <> pg_backend_pid()', [db.appName]);
  let live = null; for (let i = 0; i < 8 && !live; i++) { const x = await r3.api('alice', 'GET', '/v1/voice/calls/live'); if (x.status === 200) live = x.body.call; else await wait(300); }
  assert.ok(live && live.id === id && live.status === 'active', 'the engine recovered after its database connections were killed');
  const after = (await db.pool.query('SELECT status, version FROM voice_calls WHERE id=$1', [id])).rows[0]; assert.deepEqual(after, before);                    // no invalid transition happened
  assert.equal(Number((await db.pool.query("SELECT count(*) n FROM voice_media_leases WHERE call_id=$1", [id])).rows[0].n), 2);
  assert.equal((await r3.api('bob', 'POST', `/v1/voice/calls/${id}/end`, {})).status, 200); await r2.stop(); await r3.stop();
});

test('DR-07: a slow consumer is closed instead of letting the send buffer grow, and a full bus cannot grow memory (publishing is awaited and bounded by the outbox)', async (t) => {
  if (!db) { t.skip('no PostgreSQL'); return; }
  const closed = []; const slow = { account: 'x', deviceId: 'd', readyState: 1, bufferedAmount: 2 * 1024 * 1024, send() { throw Error('must not send to a slow socket'); }, close(code, reason) { closed.push([code, reason]); } };
  const fast = { account: 'x', deviceId: 'd2', readyState: 1, bufferedAmount: 0, sent: [], send(m) { this.sent.push(m); }, close() {} };
  const router = new VoiceRouter(); router.attach(slow); router.attach(fast); router.local('x', null, { type: 'state' });
  assert.deepEqual(closed, [[1013, 'slow_consumer']]); assert.equal(fast.sent.length, 1); assert.equal(router.slowClosed, 1);
  router.local('x', 'd2', { type: 'ice' }); assert.equal(fast.sent.length, 2); router.local('x', 'someone-else', { type: 'ice' }); assert.equal(fast.sent.length, 2);          // device-targeted: only that device
  const down = new VoiceRouter({ bus: { up: false, publish: async () => { throw Error('distributed_bus_unavailable'); } } });
  await assert.rejects(down.deliverDurable('x', { type: 'state' }), /distributed_bus_unavailable/);                                           // so the outbox keeps the event
  assert.doesNotThrow(() => down.send('x', { type: 'ice' }));                                                                                 // transient signaling never throws
});

test('Redis security: the engine runs as a least-privilege Redis user (publish/subscribe on its one channel only), and that user cannot do anything else', async (t) => {
  if (skip(t)) return;
  const pw = 'acl' + Math.random().toString(36).slice(2, 12), set = redis.exec('ACL', 'SETUSER', 'voicetest', 'on', '>' + pw, 'resetchannels', '&qorlla:voice:v1:signals', '-@all', '+publish', '+subscribe', '+ping', '+hello', '+auth', '+client|setinfo', '+client|setname', '+quit');
  assert.match(String(set.stdout), /OK/, 'the ACL user was created'); t.after(() => redis.exec('ACL', 'DELUSER', 'voicetest'));
  const url = redis.url.replace('redis://', 'redis://voicetest:' + pw + '@'), r1 = await h.replica({ redisUrl: url, maintenance: false }), r2 = await h.replica({ redisUrl: url, maintenance: false }); assert.ok(await busUp(r1, r2), 'both replicas connect as the restricted user');
  const a = await r1.connect('alice', 'acl1'), b = await r2.connect('bob', 'acl1'); await endAll();
  const d = await r1.dial('alice', ext.bob, 'acl1'); assert.equal(d.status, 201); assert.ok(await until(() => b.of('incoming')[0]), 'the call rings on the other replica through the restricted user'); await r2.answer(d.body.call.id, 'bob', 'acl1');
  a.send({ type: 'offer', callId: d.body.call.id, generation: 1, sdp: SDP }); assert.ok(await until(() => b.of('offer')[0]), 'and SDP crosses too'); await r1.api('alice', 'POST', '/v1/voice/calls/' + d.body.call.id + '/end', {});
  const probe = createClient({ url }); probe.on('error', () => {}); await probe.connect();
  try { for (const cmd of [['GET', 'k'], ['SET', 'k', 'v'], ['KEYS', '*'], ['FLUSHALL'], ['CONFIG', 'GET', 'requirepass'], ['ACL', 'LIST']]) await assert.rejects(probe.sendCommand(cmd), /NOPERM/, cmd[0] + ' must be denied');
    await assert.rejects(probe.publish('some:other:channel', 'x'), /NOPERM/, 'publishing to any other channel is denied'); } finally { await probe.quit(); }
  const wrong = createClient({ url: redis.url.replace('redis://', 'redis://voicetest:wrong@'), socket: { reconnectStrategy: false } }); wrong.on('error', () => {}); await assert.rejects(wrong.connect(), /WRONGPASS|invalid username-password/i, 'a wrong password is refused');
  await r1.stop(); await r2.stop();
});
