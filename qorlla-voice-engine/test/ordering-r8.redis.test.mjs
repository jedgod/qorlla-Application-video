// R8: cross-replica event ordering. REAL PostgreSQL, REAL Redis (a disposable container of our own) and TWO engine replicas.
// Redis gives no ordering between independent publishers, and a replica delivers events it claimed itself straight to its sockets while events another replica claimed arrive through the bus a moment
// later. So a later event can overtake an earlier one on the same socket (and a lost or duplicated bus message looks the same). The guarantee these tests pin down is the RECEIVER's:
//   a socket never sees an event id go down, never sees an id twice, and never misses one (a gap is repaired from PostgreSQL, the source of truth), whatever order the bus delivers in.
// Evidence lines (ORDER-EVIDENCE) carry event ids, kinds, call ids, publisher identity, timestamps and the order the consumer processed them in. No credentials, no personal data (test account names only).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from 'redis';
import { isolatedDb, identityProvider, wait } from './helpers.mjs';
import { harness, redisContainer, until } from './harness.mjs';
import { CHANNEL } from '../src/bus.mjs';

let db, idp, h, redis, redisOk = false, ext;
before(async () => { db = await isolatedDb(); if (!db) return; idp = await identityProvider(); h = harness({ db, idp }); redis = redisContainer(); redisOk = !!redis && (await redis.ping()); });
after(async () => { if (h) await h.closeAll(); if (idp) await idp.close(); if (db) await db.drop(); if (redis) redis.remove(); });
const skip = (t) => { if (!db) { t.skip('no PostgreSQL reachable'); return true; } if (!redisOk) { t.skip('no docker/redis image available'); return true; } return false; };
const busUp = (...rs) => until(() => rs.every((r) => r.voice.bus.up), 15000);
const metrics = async (r) => (await fetch(r.base + '/v1/voice/admin/metrics', { headers: { 'x-voice-admin-secret': 'a'.repeat(40) } })).json();
const endAll = async () => { await db.pool.query("UPDATE voice_calls SET status='ended', ended_at=now() WHERE status IN ('ringing','active')"); await db.pool.query('UPDATE voice_outbox SET delivered_at=now() WHERE delivered_at IS NULL'); };   // and nothing from an earlier test is left to be delivered into this one
const ids = (c) => c.inbox.filter((m) => m.eventId).map((m) => m.eventId);
const isAscendingUnique = (a) => a.every((x, i) => i === 0 || x > a[i - 1]);

/** Real events of one account, from PostgreSQL, wrapped exactly as the outbox worker would publish them (including the previous event id of that account). */
async function realEnvelopes(account, after) {
  const rows = (await db.pool.query(`SELECT e.id, e.kind, e.payload, e.call_id, (SELECT max(p.id) FROM voice_reliable_events p WHERE p.account_id = e.account_id AND p.id < e.id) AS prev
    FROM voice_reliable_events e WHERE e.account_id=$1 AND e.id>$2 ORDER BY e.id`, [account, after])).rows;
  return rows.map((r) => ({ id: Number(r.id), call: r.call_id, kind: r.kind, prev: r.prev === null ? 0 : Number(r.prev), payload: { ...r.payload, eventId: Number(r.id), kind: r.kind } }));
}
const envelope = (e, source = 'rogue-publisher-A') => JSON.stringify({ version: 1, id: crypto.randomUUID(), source, account: 'bob', device: null, ts: Date.now(), prev: e.prev, payload: e.payload });

test('R8-1 reordered, duplicated, delayed and replayed bus deliveries reach a socket exactly once, in event-id order, with nothing missing', async (t) => {
  if (skip(t)) return; await endAll();
  const r1 = await h.replica({ redisUrl: redis.url, maintenance: false, outbox: false }), r2 = await h.replica({ redisUrl: redis.url, maintenance: false, outbox: false }); assert.ok(await busUp(r1, r2));
  ext = await h.people(r1, ['alice', 'bob']);
  const b = await r2.connect('bob', 'o1'), start = b.of('ready')[0].cursor;
  // real events for bob (the outbox workers are off, so nothing is published by the engines themselves: the test is the only publisher and controls the order)
  for (let i = 0; i < 3; i++) { const d = await r1.dial('alice', ext.bob, 'o1'); assert.equal(d.status, 201); assert.equal((await r1.api('alice', 'POST', '/v1/voice/calls/' + d.body.call.id + '/end', {})).status, 200); }
  const evs = await realEnvelopes('bob', start); assert.ok(evs.length >= 6, 'bob has a real stream: ' + evs.length);
  const rogue = createClient({ url: redis.url }); await rogue.connect();
  const pub = async (e, source) => rogue.publish(CHANNEL, envelope(e, source));
  const [e1, e2, e3, e4, e5, e6] = evs;
  // the worst order Redis could hand us: later first, a duplicate, an old replay in the middle, and the earliest events last
  const order = [e3, e1, e3, e2, e5, e4, e1, e6, e5, e2, e4, e6];
  for (const e of order) await pub(e, e.id % 2 ? 'rogue-publisher-A' : 'rogue-publisher-B');
  const expected = evs.map((e) => e.id);
  const ok = await until(() => expected.every((id) => ids(b).includes(id)), 15000);
  console.log('ORDER-EVIDENCE R8-1 injected=' + JSON.stringify(order.map((e) => [e.id, e.kind, e.call && String(e.call).slice(0, 8), e.prev])) + ' | consumer processed=' + JSON.stringify(b.inbox.filter((m) => m.eventId).map((m) => [m.eventId, m.type])));
  assert.ok(ok, 'every event reached the socket (a missing one is repaired from PostgreSQL): missing ' + JSON.stringify(expected.filter((id) => !ids(b).includes(id))));
  await wait(400);
  const got = ids(b); assert.ok(isAscendingUnique(got), 'strictly ascending, no duplicates, no overtaking: ' + JSON.stringify(got));
  assert.deepEqual(got, expected, 'exactly the account\'s events, in order');
  await rogue.quit(); await r1.stop(); await r2.stop();
});

test('R8-2 a stale or replayed event can never reverse a call that has ended, and the socket never goes back', async (t) => {
  if (skip(t)) return; await endAll();
  const r1 = await h.replica({ redisUrl: redis.url, maintenance: false, outbox: false }), r2 = await h.replica({ redisUrl: redis.url, maintenance: false, outbox: false }); assert.ok(await busUp(r1, r2));
  const b = await r2.connect('bob', 'o2'), start = b.of('ready')[0].cursor;
  const d = await r1.dial('alice', ext.bob, 'o2'); const callId = d.body.call.id; assert.equal((await r2.answer(callId, 'bob', 'o2')).status, 200); assert.equal((await r1.api('alice', 'POST', '/v1/voice/calls/' + callId + '/end', {})).status, 200);
  const evs = (await realEnvelopes('bob', start)).filter((e) => e.call === callId); assert.ok(evs.length >= 3, 'incoming, active, ended: ' + evs.map((e) => e.kind + ':' + (e.payload.call && e.payload.call.status)));
  const rogue = createClient({ url: redis.url }); await rogue.connect();
  const last = evs.at(-1); assert.equal(last.payload.call.status, 'ended');
  await rogue.publish(CHANNEL, envelope(last));                                                                                                         // the end arrives first (a fast path)
  for (const e of evs.slice(0, -1)) await rogue.publish(CHANNEL, envelope(e));                                                                             // then the older events arrive late: they must not undo it
  for (const e of evs) await rogue.publish(CHANNEL, envelope(e));                                                                                        // and a full replay of the stream
  assert.ok(await until(() => ids(b).includes(last.id), 15000)); await wait(500);
  const states = b.inbox.filter((m) => m.eventId && m.call && m.call.id === callId).map((m) => [m.eventId, m.call.status]);
  console.log('ORDER-EVIDENCE R8-2 call=' + String(callId).slice(0, 8) + ' consumer processed=' + JSON.stringify(states));
  assert.ok(isAscendingUnique(ids(b)), 'no event id goes down: ' + JSON.stringify(ids(b)));
  assert.equal(states.at(-1)[1], 'ended', 'the last thing the socket was told about this call is that it ended');
  assert.equal(states.filter(([, s]) => s === 'ended').length, 1, 'ended exactly once');
  assert.equal(ids(b).filter((i) => i === last.id).length, 1);
  assert.equal((await db.pool.query('SELECT status FROM voice_calls WHERE id=$1', [callId])).rows[0].status, 'ended', 'PostgreSQL is untouched by anything the bus carried');
  await rogue.quit(); await r1.stop(); await r2.stop();
});

test('R8-3 two live replicas, both outbox workers claiming, the bus path slowed and jittered on the consumer: still complete, ordered and without duplicates (mixed local and remote delivery)', async (t) => {
  if (skip(t)) return; await endAll();
  const r1 = await h.replica({ redisUrl: redis.url, maintenance: false, env: { VOICE_CALL_RATE_PER_MIN: '1000' } }), r2 = await h.replica({ redisUrl: redis.url, maintenance: false }); assert.ok(await busUp(r1, r2));
  const b = await r2.connect('bob', 'o3'), start = b.of('ready')[0].cursor;
  const seen = []; const orig = r2.voice.bus.onDelivery;                                                                                                // the consumer side of the bus: records the order it processed, and is slowed by 0-120 ms per message
  r2.voice.bus.onDelivery = async (m) => { seen.push([m.payload && m.payload.eventId, String(m.source).slice(0, 6), Date.now()]); await wait(Math.floor(Math.random() * 120)); return orig(m); };
  const cycle = async () => { const d = await r1.dial('alice', ext.bob, 'o3'); assert.equal(d.status, 201); assert.equal((await r1.api('alice', 'POST', '/v1/voice/calls/' + d.body.call.id + '/end', {})).status, 200); };
  for (let i = 0; i < 12; i++) await cycle();
  const expected = (await db.pool.query("SELECT id FROM voice_reliable_events WHERE account_id='bob' AND id > $1 ORDER BY id", [start])).rows.map((x) => Number(x.id)); assert.ok(expected.length >= 20, 'a real stream: ' + expected.length);
  const ok = await until(() => expected.every((id) => ids(b).includes(id)), 40000);
  const rows = (await db.pool.query("SELECT o.event_id, o.attempts, left(coalesce(o.locked_by,''),6) AS lock FROM voice_outbox o JOIN voice_reliable_events e ON e.id=o.event_id WHERE e.account_id='bob' AND e.id>$1 ORDER BY o.event_id", [start])).rows;
  console.log('ORDER-EVIDENCE R8-3 workers r1=' + r1.voice.worker.workerId.slice(0, 6) + ' r2=' + r2.voice.worker.workerId.slice(0, 6) + ' | bus deliveries seen by r2 (id,source,ts)=' + JSON.stringify(seen) + ' | consumer processed=' + JSON.stringify(ids(b)) + ' | claims=' + JSON.stringify(rows.map((r) => [Number(r.event_id), r.attempts, r.lock])));
  assert.ok(ok, 'every event reached bob: missing ' + JSON.stringify(expected.filter((id) => !ids(b).includes(id))));
  await wait(500);
  assert.deepEqual(ids(b), expected, 'bob sees each event once, in id order');
  assert.ok(await until(async () => (await metrics(r1)).outbox.pending === 0, 30000)); assert.equal((await metrics(r1)).outbox.dead, 0);
  await r1.stop(); await r2.stop();
});

test('R8-4 an event lost on the bus (never delivered to the consumer replica) is repaired from PostgreSQL when the next one arrives, never skipped', async (t) => {
  if (skip(t)) return; await endAll();
  const r1 = await h.replica({ redisUrl: redis.url, maintenance: false, outbox: false }), r2 = await h.replica({ redisUrl: redis.url, maintenance: false, outbox: false }); assert.ok(await busUp(r1, r2));
  const b = await r2.connect('bob', 'o4'), start = b.of('ready')[0].cursor;
  for (let i = 0; i < 2; i++) { const d = await r1.dial('alice', ext.bob, 'o4'); await r1.api('alice', 'POST', '/v1/voice/calls/' + d.body.call.id + '/end', {}); }
  const evs = await realEnvelopes('bob', start); assert.ok(evs.length >= 4);
  const rogue = createClient({ url: redis.url }); await rogue.connect();
  await rogue.publish(CHANNEL, envelope(evs[0])); await rogue.publish(CHANNEL, envelope(evs[2]));                                                          // evs[1] is "lost on the bus"
  assert.ok(await until(() => ids(b).includes(evs[2].id), 15000), 'the later event is delivered after the gap was repaired'); await wait(300);
  assert.deepEqual(ids(b), [evs[0].id, evs[1].id, evs[2].id], 'the lost event was filled in from PostgreSQL, before the event that revealed the gap');
  await rogue.quit(); await r1.stop(); await r2.stop();
});
