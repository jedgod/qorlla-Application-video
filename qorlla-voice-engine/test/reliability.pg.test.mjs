// v1.4 gates DR-01, DR-03, DR-04, DR-05, DR-07 on REAL PostgreSQL (isolated schema): atomic state+outbox, replay, duplicate delivery, device fencing, fail-closed backpressure, lease expiry.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStore } from '../src/store.mjs';
import { createReliability } from '../src/reliability.mjs';
import { OutboxWorker } from '../src/outbox.mjs';
import { isolatedDb, identityProvider, wait } from './helpers.mjs';
import { harness, until, SDP } from './harness.mjs';

let db, idp, h, r, ext, store, rel;
before(async () => {
  db = await isolatedDb(); if (!db) return; idp = await identityProvider(); h = harness({ db, idp }); r = await h.replica({ maintenance: false }); store = createStore(db.pool); rel = createReliability(db.pool);
  ext = await h.people(r, ['alice', 'bob', 'carol', 'dave', 'erin']);
});
after(async () => { if (h) await h.closeAll(); if (idp) await idp.close(); if (db) await db.drop(); });
const skip = (t) => !db && t.skip('no PostgreSQL reachable');
/** The shared replica's own worker runs in the background; tests that stage the outbox by hand pause it so they are the only publisher. */
const pause = async () => { r.voice.worker.stop(); await wait(300); }, resume = () => r.voice.worker.start();
const count = async (sql, p = []) => Number((await db.pool.query(sql, p)).rows[0].n);

test('DR-01: a call-state change and its events commit atomically, or not at all', async (t) => {
  if (skip(t)) return;
  // a database whose outbox insert fails: the whole transaction must roll back, leaving no call, no idempotency key, no event
  const failing = { connect: async () => { const c = await db.pool.connect(), q = c.query, release = c.release; c.query = (sql, ...a) => (typeof sql === 'string' && sql.includes('INSERT INTO voice_outbox') ? Promise.reject(new Error('simulated crash before COMMIT')) : q.call(c, sql, ...a)); c.release = (...x) => { c.query = q; c.release = release; return release.apply(c, x); }; return c; }, query: (...a) => db.pool.query(...a) };
  const broken = createStore(failing), key = 'atomic-' + randomUUID(), before = { calls: await count('SELECT count(*) n FROM voice_calls'), events: await count('SELECT count(*) n FROM voice_reliable_events') };
  await assert.rejects(broken.createCall('alice', ext.bob, key, h.device('alice')), /simulated crash/);
  assert.equal(await count('SELECT count(*) n FROM voice_calls'), before.calls); assert.equal(await count('SELECT count(*) n FROM voice_reliable_events'), before.events); assert.equal(await count('SELECT count(*) n FROM voice_idempotency WHERE request_key=$1', [key]), 0);
  assert.equal(await store.liveCall('alice'), null);                                                                                // alice is not stuck busy
  // the retry after the failure creates exactly ONE logical call with ONE incoming event
  const ok = await store.createCall('alice', ext.bob, key, h.device('alice')); assert.equal(ok.reused, false);
  const again = await store.createCall('alice', ext.bob, key, h.device('alice')); assert.equal(again.reused, true); assert.equal(again.call.id, ok.call.id);
  assert.equal(await count("SELECT count(*) n FROM voice_calls WHERE caller_id='alice' AND status='ringing'"), 1);
  assert.equal(await count("SELECT count(*) n FROM voice_reliable_events WHERE call_id=$1 AND kind='incoming'", [ok.call.id]), 1);
  assert.equal(await count('SELECT count(*) n FROM voice_outbox o JOIN voice_reliable_events e ON e.id=o.event_id WHERE e.call_id=$1', [ok.call.id]), 1);          // every event has its outbox row
  // a transition that fails halfway rolls back too: the call is still ringing, with no state event
  const stateBefore = await count("SELECT count(*) n FROM voice_reliable_events WHERE call_id=$1 AND kind='state'", [ok.call.id]);
  await assert.rejects(createStore(failing).transition(ok.call.id, 'bob', 'active', undefined, { deviceId: h.device('bob') }), /simulated crash/);
  assert.equal((await store.getCall(ok.call.id)).status, 'ringing'); assert.equal(await count("SELECT count(*) n FROM voice_reliable_events WHERE call_id=$1 AND kind='state'", [ok.call.id]), stateBefore);
  assert.equal(await count('SELECT count(*) n FROM voice_media_leases WHERE call_id=$1 AND account_id=$2', [ok.call.id, 'bob']), 0);
  await store.transition(ok.call.id, 'bob', 'ended'); await store.transition(ok.call.id, 'alice', 'ended').catch(() => {});
});

test('the ring timeout and account suspension also write their events in the same transaction', async (t) => {
  if (skip(t)) return;
  const c = (await store.createCall('carol', ext.dave, 'timeout-' + randomUUID(), h.device('carol'))).call;
  await db.pool.query("UPDATE voice_calls SET created_at = now() - interval '10 minutes' WHERE id=$1", [c.id]);
  assert.equal((await store.expireRinging(60)).length, 1);
  const ev = (await db.pool.query("SELECT account_id, payload FROM voice_reliable_events WHERE call_id=$1 AND kind='state' ORDER BY id", [c.id])).rows;
  assert.deepEqual(ev.map((e) => e.account_id).sort(), ['carol', 'dave']); assert.ok(ev.every((e) => e.payload.call.status === 'missed'));
  assert.equal((await store.expireRinging(60)).length, 0);                                                                              // idempotent: the same call is never processed twice
  const live = (await store.createCall('carol', ext.dave, 'susp-' + randomUUID(), h.device('carol'))).call; await store.transition(live.id, 'dave', 'active', undefined, { deviceId: h.device('dave') });
  const res = await store.setEnabled('dave', false); assert.equal(res.ended.length, 1);
  assert.equal(await count("SELECT count(*) n FROM voice_reliable_events WHERE call_id=$1 AND kind='state' AND payload->'call'->>'end_reason'='account_disabled'", [live.id]), 2);
  await store.setEnabled('dave', true);
});

test('DR-03: replay returns exactly what the account missed, in order, only its own, and pages correctly', async (t) => {
  if (skip(t)) return;
  const start = await rel.latest('erin');
  for (let i = 0; i < 3; i++) { const c = (await store.createCall('alice', ext.erin, 'replay-' + randomUUID(), h.device('alice'))).call; await store.transition(c.id, 'erin', 'rejected'); }
  const page = await rel.replay('erin', start); assert.equal(page.events.length, 6); assert.equal(page.hasMore, false);                    // 3 incoming + 3 state
  assert.deepEqual(page.events.map((e) => e.kind), ['incoming', 'state', 'incoming', 'state', 'incoming', 'state']);
  const ids = page.events.map((e) => e.id); assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.ok(page.events.every((e) => JSON.stringify(e.payload).includes('erin') || e.payload.call.callee_id === 'erin'));
  assert.ok(!JSON.stringify(page).includes('"sdp"'));                                                                                    // SDP/ICE are never stored
  const next = await rel.replay('erin', ids[2]); assert.equal(next.events.length, 3); assert.equal(next.events[0].id, ids[3]);          // resume from a cursor
  assert.equal((await rel.replay('carol', ids[5])).events.filter((e) => ids.includes(e.id)).length, 0);                                  // another account's cursor never reveals erin's events
  for (const a of ['bob', 'carol', 'dave']) assert.ok((await rel.replay(a, 0)).events.every((e) => !ids.includes(e.id)));
  // pagination over the 200 limit
  const bulk = await db.pool.query("INSERT INTO voice_reliable_events(account_id, kind, payload) SELECT 'bob','state','{\"type\":\"state\",\"call\":{}}'::jsonb FROM generate_series(1,250) RETURNING id");
  const first = await rel.replay('bob', bulk.rows[0].id - 1); assert.equal(first.events.length, 200); assert.equal(first.hasMore, true);
  const rest = await rel.replay('bob', first.events.at(-1).id); assert.equal(rest.events.length, 50); assert.equal(rest.hasMore, false);
  // acknowledgements: own events only, never a future id, never backwards
  assert.equal(await rel.acknowledge('erin', h.device('erin'), ids[3]), ids[3]); assert.equal(await rel.acknowledge('erin', h.device('erin'), ids[1]), ids[3]);
  await assert.rejects(rel.acknowledge('erin', h.device('erin'), bulk.rows[0].id), /invalid_cursor/);                                    // bob's event
  await assert.rejects(rel.acknowledge('erin', h.device('erin'), 2 ** 40), /invalid_cursor/); await assert.rejects(rel.replay('erin', -1), /invalid_cursor/); await assert.rejects(rel.replay('erin', 1.5), /invalid_cursor/);
  // over HTTP and the WebSocket, with the same rules
  const http = await r.api('erin', 'GET', '/v1/voice/events?after=' + start); assert.equal(http.status, 200); assert.equal(http.body.events.length, 6); assert.equal((await r.api('erin', 'GET', '/v1/voice/events?after=abc')).status, 400);
  assert.equal((await r.api('erin', 'GET', '/v1/voice/events')).status, 200); assert.equal((await r.api(null, 'GET', '/v1/voice/events')).status, 401);
  const ack = await r.api('erin', 'POST', '/v1/voice/events/ack', { deviceId: h.device('erin'), cursor: ids[5] }); assert.equal(ack.body.cursor, ids[5]); assert.equal((await r.api('erin', 'POST', '/v1/voice/events/ack', { deviceId: 'nope', cursor: 1 })).status, 400);
  const ws = await r.connect('erin', 'd1', { resumeAfter: start }); const batch = await until(() => ws.of('resume_batch')[0]); assert.equal(batch.events.length, 6);
  ws.send({ type: 'ack', cursor: ids[5] }); assert.ok(await until(() => ws.of('ack_ok')[0])); ws.send({ type: 'ack', cursor: bulk.rows[0].id }); await wait(200); assert.equal(ws.of('ack_ok').length, 1);
  ws.send({ type: 'resume', after: 'x' }); await wait(150); assert.equal(ws.of('resume_batch').length, 1); ws.close();
});

test('DR-04: the outbox delivers at least once; a crash after publishing causes a duplicate with the SAME id and never a second state transition', async (t) => {
  if (skip(t)) return; await pause(); t.after(resume);
  const c = (await store.createCall('alice', ext.bob, 'dup-' + randomUUID(), h.device('alice'))).call; await store.transition(c.id, 'bob', 'rejected');
  await db.pool.query("UPDATE voice_outbox SET delivered_at = now() WHERE delivered_at IS NULL");                                       // clear the backlog from other tests
  const e = await store.createCall('carol', ext.erin, 'dup2-' + randomUUID(), h.device('carol')); const eventId = Number((await db.pool.query("SELECT id FROM voice_reliable_events WHERE call_id=$1 AND kind='incoming'", [e.call.id])).rows[0].id);
  const published = []; let crashed = false;
  const w = new OutboxWorker({ db: db.pool, workerId: 'w1', logger: { error() {} }, publish: async (account, msg) => { published.push({ account, id: msg.eventId }); if (!crashed) { crashed = true; throw new Error('killed after publish, before marking delivered'); } } });
  await w.runOnce(); assert.deepEqual(published.map((p) => p.id), [eventId]);                                                         // published once, but the mark failed
  assert.equal((await db.pool.query('SELECT delivered_at, attempts, last_error FROM voice_outbox WHERE event_id=$1', [eventId])).rows[0].delivered_at, null);
  await db.pool.query('UPDATE voice_outbox SET available_at = now() WHERE event_id=$1', [eventId]);                                      // the retry delay has passed
  await w.runOnce(); assert.deepEqual(published.map((p) => p.id), [eventId, eventId]);                                                // duplicate delivery, identical id
  assert.notEqual((await db.pool.query('SELECT delivered_at FROM voice_outbox WHERE event_id=$1', [eventId])).rows[0].delivered_at, null);
  assert.equal(await count("SELECT count(*) n FROM voice_calls WHERE id=$1 AND status='ringing'", [e.call.id]), 1);                      // the call itself was transitioned zero extra times
  assert.equal(await count("SELECT count(*) n FROM voice_call_events WHERE call_id=$1", [e.call.id]), 1);
  // applying the same terminal transition twice is refused: duplicate REST delivery cannot duplicate a transition
  assert.equal((await r.api('erin', 'POST', `/v1/voice/calls/${e.call.id}/reject`, {})).status, 200); assert.equal((await r.api('erin', 'POST', `/v1/voice/calls/${e.call.id}/reject`, {})).status, 409);
  assert.equal(await count("SELECT count(*) n FROM voice_reliable_events WHERE call_id=$1 AND kind='state'", [e.call.id]), 2);          // exactly one transition: two parties, one event each
  // two workers racing never publish the same row at the same time
  for (let i = 0; i < 6; i++) { const x = (await store.createCall('dave', ext.erin, 'race-' + i + randomUUID(), h.device('dave'))).call; await store.transition(x.id, 'erin', 'rejected'); }
  const seen = new Map(); const mk = (id) => new OutboxWorker({ db: db.pool, workerId: id, batchSize: 5, logger: { error() {} }, publish: async (a, m) => { seen.set(m.eventId, (seen.get(m.eventId) || 0) + 1); await wait(15); } });
  await Promise.all([mk('wa').runOnce(), mk('wb').runOnce(), mk('wc').runOnce()]); assert.ok([...seen.values()].every((n) => n === 1), JSON.stringify([...seen]));
  await mk('wd').drain();
});

test('a worker that died holding a claim only delays the event: the lock expires and another worker takes it', async (t) => {
  if (skip(t)) return; await pause(); t.after(resume);
  await db.pool.query('UPDATE voice_outbox SET delivered_at = now() WHERE delivered_at IS NULL');
  const c = (await store.createCall('alice', ext.carol, 'dead-' + randomUUID(), h.device('alice'))).call; const id = Number((await db.pool.query("SELECT id FROM voice_reliable_events WHERE call_id=$1", [c.id])).rows[0].id);
  const dead = new OutboxWorker({ db: db.pool, workerId: 'dead', publish: async () => {} }); assert.deepEqual((await dead.claim()).map(Number), [id]);          // claimed, then the process dies
  const got = []; const live = new OutboxWorker({ db: db.pool, workerId: 'live', publish: async (a, m) => got.push(m.eventId) });
  assert.equal(await live.runOnce(), 0);                                                                                                        // still locked
  await db.pool.query("UPDATE voice_outbox SET locked_until = now() - interval '1 second' WHERE event_id=$1", [id]);                         // 30 s later
  assert.equal(await live.runOnce(), 1); assert.deepEqual(got, [id]); await store.transition(c.id, 'carol', 'rejected');
});

test('DR-05: a replaced device loses signaling authority at once, on every operation; the new generation wins', async (t) => {
  if (skip(t)) return;
  await db.pool.query('UPDATE voice_outbox SET delivered_at = now() WHERE delivered_at IS NULL');
  const a1 = await r.connect('alice', 'd1'), a2 = await r.connect('alice', 'd2'), b = await r.connect('bob', 'd1');
  const d = await r.dial('alice', ext.bob, 'd1'); const id = d.body.call.id, g1 = d.body.generation; assert.equal(g1, 1);
  const ans = await r.answer(id, 'bob'); assert.equal(ans.body.generation, 1);
  a1.send({ type: 'offer', callId: id, generation: 1, sdp: SDP }); assert.ok(await until(() => b.of('offer')[0]));                       // the original device signals fine
  // device d2 of the same account takes over mid-call
  const claim = await r.api('alice', 'POST', `/v1/voice/calls/${id}/device`, { deviceId: r.device('alice', 'd2') }); assert.equal(claim.status, 200); assert.equal(claim.body.generation, 2);
  const revoked = await until(() => a1.of('device_revoked')[0]); assert.equal(revoked.revokedDevice, r.device('alice', 'd1')); assert.equal(revoked.newDevice, r.device('alice', 'd2')); assert.equal(revoked.generation, 2); assert.ok(revoked.eventId);
  assert.ok(await until(() => a2.of('device_revoked')[0]));                                                                            // the account's sockets all learn of it (the old device acts on its own id)
  assert.ok(await until(() => b.of('device_claimed')[0]));                                                                             // the peer learns it must renegotiate with the new device
  const n = b.inbox.length;
  a1.send({ type: 'offer', callId: id, generation: 1, sdp: SDP }); a1.send({ type: 'ice', callId: id, generation: 1, candidate: null }); a1.send({ type: 'offer', callId: id, generation: 2, sdp: SDP });   // stale generation, and the right generation from the WRONG device
  await wait(300); assert.equal(b.inbox.length, n);
  a2.send({ type: 'offer', callId: id, generation: 2, sdp: SDP }); const off = await until(() => b.of('offer').find((m) => m.gen === 2)); assert.ok(off);                  // the new device's higher generation wins
  b.send({ type: 'answer', callId: id, generation: 1, sdp: SDP }); const ans2 = await until(() => a2.of('answer')[0]); assert.ok(ans2); assert.equal(a1.of('answer').length, 0);   // the answer goes to the NEW device only
  // the old device can neither renew its lease nor fail the call
  assert.equal((await r.api('alice', 'POST', `/v1/voice/calls/${id}/device/refresh`, { deviceId: r.device('alice', 'd1'), generation: 1 })).status, 409);
  assert.equal((await r.api('alice', 'POST', `/v1/voice/calls/${id}/fail`, { deviceId: r.device('alice', 'd1'), generation: 1 })).status, 409); assert.equal((await store.getCall(id)).status, 'active');
  assert.equal((await r.api('alice', 'POST', `/v1/voice/calls/${id}/device/refresh`, { deviceId: r.device('alice', 'd2'), generation: 2 })).status, 200);
  assert.equal((await r.api('alice', 'POST', `/v1/voice/calls/${id}/fail`, { deviceId: r.device('alice', 'd2'), generation: 2 })).status, 200);
  assert.equal((await r.api('alice', 'POST', `/v1/voice/calls/${id}/fail`, {})).status, 400);                                          // a fence is required to fail a call
  for (const x of [a1, a2, b]) x.close();
});

test('DR-05/06: concurrent claims are serialised: unique generations, one final owner, consistent for every reader', async (t) => {
  if (skip(t)) return;
  const c = (await store.createCall('carol', ext.dave, 'claims-' + randomUUID(), h.device('carol', 'c0'))).call; await store.transition(c.id, 'dave', 'active', undefined, { deviceId: h.device('dave') });
  const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => store.claimDevice(c.id, 'carol', h.device('carol', 'c' + (i + 1)))));
  const gens = claims.map((x) => x.lease.generation).sort((a, b) => a - b); assert.deepEqual(gens, Array.from({ length: 12 }, (_, i) => i + 2));
  const ctx = await store.signalContext(c.id); const owner = claims.find((x) => x.lease.generation === 13); assert.equal(ctx.leases.carol.device_id, owner.lease.device_id); assert.equal(ctx.leases.carol.generation, 13);
  assert.equal(await count("SELECT count(*) n FROM voice_media_leases WHERE call_id=$1 AND account_id='carol'", [c.id]), 1);
  await assert.rejects(store.claimDevice(c.id, 'erin', h.device('erin')), /not_found/); await assert.rejects(store.claimDevice(c.id, 'carol', 'not-a-uuid'), /invalid_input/);   // strangers and bad ids
  await store.transition(c.id, 'carol', 'ended'); await assert.rejects(store.claimDevice(c.id, 'carol', h.device('carol', 'late')), /call_not_active/);
});

test('a ringing callee cannot hold a lease before answering, and a lease is not needed to hang up from any device', async (t) => {
  if (skip(t)) return;
  const c = (await store.createCall('erin', ext.alice, 'ring-' + randomUUID(), h.device('erin'))).call;
  await assert.rejects(store.claimDevice(c.id, 'alice', h.device('alice', 'x')), /call_not_active/);
  assert.equal((await r.api('alice', 'POST', `/v1/voice/calls/${c.id}/reject`, {})).status, 200);
});

test('DR-07: when the outbox backlog is over its limit, NEW calls and rooms are refused (fail closed) while existing calls continue; recovery is automatic', async (t) => {
  if (skip(t)) return;
  await pause(); t.after(resume);                                                                                                          // the shared replica's worker must not drain what this test stages
  const quiet = await h.replica({ maintenance: false, outbox: false, env: { VOICE_OUTBOX_MAX_PENDING: '5' } });                          // no worker: nothing drains
  await db.pool.query('UPDATE voice_outbox SET delivered_at = now() WHERE delivered_at IS NULL');
  const live = (await store.createCall('alice', ext.bob, 'sat-' + randomUUID(), h.device('alice'))).call;
  await db.pool.query("INSERT INTO voice_reliable_events(account_id, kind, payload) SELECT 'dave','state','{\"type\":\"state\",\"call\":{}}'::jsonb FROM generate_series(1,12)");
  await db.pool.query("INSERT INTO voice_outbox(event_id) SELECT id FROM voice_reliable_events WHERE id NOT IN (SELECT event_id FROM voice_outbox)");
  const m = (await fetch(quiet.base + '/v1/voice/admin/metrics', { headers: { 'x-voice-admin-secret': 'a'.repeat(40) } }).then((x) => x.json())); assert.ok(m.outbox.pending >= 12); assert.equal(m.outbox.failClosed, true);
  const refused = await quiet.dial('carol', ext.dave); assert.equal(refused.status, 503); assert.equal(refused.body.error, 'overloaded'); assert.equal(refused.headers.get('retry-after'), '10');
  assert.equal((await quiet.api('carol', 'POST', '/v1/voice/rooms', { extensions: [ext.dave], deviceId: h.device('carol') })).status, 503);
  assert.equal((await quiet.api('bob', 'POST', `/v1/voice/calls/${live.id}/answer`, { deviceId: h.device('bob') })).status, 200);       // the existing call is still served
  assert.equal((await quiet.api('alice', 'POST', `/v1/voice/calls/${live.id}/end`, {})).status, 200);
  assert.equal(await count("SELECT count(*) n FROM voice_calls WHERE caller_id='carol' AND status IN ('ringing','active')"), 0);          // nothing was half-created
  await new OutboxWorker({ db: db.pool, publish: async () => {}, batchSize: 500, logger: { error() {} } }).drain();                      // drain: the system recovers by itself
  await wait(1100); assert.equal((await quiet.dial('carol', ext.dave)).status, 201); await quiet.stop();
  // an old undelivered event also trips the age limit
  const old = await h.replica({ maintenance: false, outbox: false, env: { VOICE_OUTBOX_MAX_AGE_SECONDS: '60' } });
  await db.pool.query("UPDATE voice_reliable_events SET created_at = now() - interval '5 minutes' WHERE id = (SELECT max(id) FROM voice_reliable_events)"); await db.pool.query("UPDATE voice_outbox SET delivered_at = NULL WHERE event_id = (SELECT max(id) FROM voice_reliable_events)");
  assert.equal((await old.dial('erin', ext.bob)).status, 503); await db.pool.query('UPDATE voice_outbox SET delivered_at = now() WHERE delivered_at IS NULL'); await old.stop();
});

test('queue statistics and retention: undelivered events are never pruned, delivered ones are after the window', async (t) => {
  if (skip(t)) return; await pause(); t.after(resume);
  await db.pool.query('UPDATE voice_outbox SET delivered_at = now() WHERE delivered_at IS NULL');
  const ids = (await db.pool.query("INSERT INTO voice_reliable_events(account_id, kind, payload, created_at) SELECT 'erin','state','{\"type\":\"state\",\"call\":{}}'::jsonb, now() - interval '30 days' FROM generate_series(1,3) RETURNING id")).rows.map((x) => x.id);
  await db.pool.query('INSERT INTO voice_outbox(event_id, delivered_at) VALUES($1, now()), ($2, now()), ($3, NULL)', ids);
  const s = await rel.queueStats(); assert.equal(s.pending, 1); assert.ok(s.oldestSeconds >= 29 * 86400);
  assert.equal(await rel.prune(168), 2 + (await count("SELECT count(*) n FROM voice_reliable_events WHERE false")));                       // the two delivered ones (older delivered rows from other tests may be recent)
  assert.equal(await count('SELECT count(*) n FROM voice_reliable_events WHERE id=$1', [ids[2]]), 1);                                         // the undelivered one stays
  await db.pool.query('UPDATE voice_outbox SET delivered_at = now() WHERE delivered_at IS NULL');
});

test('leases expire: a call whose participant stopped renewing ends after the grace period instead of holding both accounts busy', async (t) => {
  if (skip(t)) return;
  await db.pool.query("UPDATE voice_calls SET status='ended', ended_at=now() WHERE status IN ('ringing','active')");                       // earlier tests may have left calls ringing
  const c = (await store.createCall('dave', ext.erin, 'stale-' + randomUUID(), h.device('dave'))).call; await store.transition(c.id, 'erin', 'active', undefined, { deviceId: h.device('erin') });
  assert.equal((await store.expireStaleCalls(120)).length, 0);                                                                              // leases are fresh
  await db.pool.query("UPDATE voice_media_leases SET expires_at = now() - interval '3 minutes' WHERE call_id=$1 AND account_id='erin'", [c.id]);
  await db.pool.query("UPDATE voice_calls SET answered_at = now() - interval '10 minutes' WHERE id=$1", [c.id]);
  const ended = await store.expireStaleCalls(120); assert.equal(ended.length, 1); assert.equal(ended[0].end_reason, 'lease_expired'); assert.equal(await store.liveCall('dave'), null);
  assert.equal(await count("SELECT count(*) n FROM voice_reliable_events WHERE call_id=$1 AND payload->'call'->>'end_reason'='lease_expired'", [c.id]), 2);
  assert.equal((await store.expireStaleCalls(120)).length, 0);
});

test('ordering (v1.9 audit blocker): for one account a later-committing writer can never hold a lower event id, so a cursor never skips an event', async (t) => {
  if (skip(t)) return; await pause(); t.after(resume);
  const { appendEvent, lockEvents } = await import('../src/reliability.mjs'); const payload = { type: 'state', call: {} };
  // deterministic: writer A appends and has not committed; writer B must WAIT for A, so it cannot commit first with a higher id
  const start = await rel.latest('erin'), a = await db.pool.connect(), b = await db.pool.connect();
  await a.query('BEGIN'); const idA = await appendEvent(a, { account: 'erin', kind: 'state', payload });
  await b.query('BEGIN'); let bDone = false; const pB = appendEvent(b, { account: 'erin', kind: 'state', payload }).then((id) => { bDone = true; return id; });
  await wait(400); assert.equal(bDone, false, 'B waits for A');
  assert.equal((await rel.replay('erin', start)).events.length, 0, 'an uncommitted event is invisible to readers');
  await a.query('COMMIT'); const idB = await pB; await b.query('COMMIT'); a.release(); b.release();
  assert.ok(idB > idA); assert.deepEqual((await rel.replay('erin', start)).events.map((e) => e.id), [idA, idB]);
  // stress: many concurrent multi-account writers (locks taken in sorted order) while a reader polls with a moving cursor: the reader sees every event exactly once, in order
  const written = [], seen = []; let cursor = await rel.latest('erin'), done = false;
  const reader = (async () => { while (!done || (await rel.replay('erin', cursor)).events.length) { const { events } = await rel.replay('erin', cursor); for (const e of events) { seen.push(e.id); cursor = e.id; } await wait(3); } })();
  await Promise.all(Array.from({ length: 40 }, (_, i) => store.tx(async (c) => {
    await lockEvents(c, ['erin', 'dave']); await wait(Math.random() * 25);
    for (const acct of (i % 2 ? ['erin', 'dave'] : ['dave', 'erin'])) { const id = await appendEvent(c, { account: acct, kind: 'state', payload }); if (acct === 'erin') written.push(id); await wait(Math.random() * 10); }
  })));
  done = true; await reader;
  assert.equal(written.length, 40); assert.deepEqual(seen, [...written].sort((x, y) => x - y), 'no event skipped, none repeated, ids ascending');
  await db.pool.query('UPDATE voice_outbox SET delivered_at = now() WHERE delivered_at IS NULL');
});

test('v1.9 operations: a server-side consumer applies each event once; strict readiness tells a load balancer where new calls may go', async (t) => {
  if (skip(t)) return; await pause(); t.after(resume);
  const c = (await store.createCall('alice', ext.bob, 'ops-' + randomUUID(), h.device('alice'))).call; const id = Number((await db.pool.query("SELECT id FROM voice_reliable_events WHERE call_id=$1", [c.id])).rows[0].id);
  assert.equal(await rel.markProcessed('meet-bridge', id), true); assert.equal(await rel.markProcessed('meet-bridge', id), false, 'a redelivery is recognised'); assert.equal(await rel.markProcessed('other-consumer', id), true);
  await assert.rejects(rel.markProcessed('bad consumer!', id), /invalid_input/); await assert.rejects(rel.markProcessed('x', -1), /invalid_input/); await assert.rejects(rel.markProcessed('x', 99999999), /violates foreign key/);
  await store.transition(c.id, 'bob', 'rejected'); await db.pool.query('UPDATE voice_outbox SET delivered_at = now() WHERE delivered_at IS NULL');
  const ok = await fetch(r.base + '/v1/voice/operational/readiness').then(async (x) => ({ s: x.status, b: await x.json() })); assert.equal(ok.s, 200); assert.equal(ok.b.ready, true); assert.equal(ok.b.redis, 'off'); assert.equal(ok.b.outbox.pending, 0);
  await db.pool.query("INSERT INTO voice_reliable_events(account_id, kind, payload, created_at) VALUES('erin','state','{\"type\":\"state\",\"call\":{}}'::jsonb, now() - interval '10 minutes')");
  await db.pool.query('INSERT INTO voice_outbox(event_id) SELECT max(id) FROM voice_reliable_events');
  const late = await fetch(r.base + '/v1/voice/operational/readiness').then(async (x) => ({ s: x.status, b: await x.json() })); assert.equal(late.s, 503); assert.equal(late.b.ready, false, 'a backlog older than 60 s takes the node out of rotation for NEW calls');
  assert.equal((await fetch(r.base + '/readyz')).status, 200, 'but the lenient /readyz keeps serving the calls it already holds');
  await db.pool.query('UPDATE voice_outbox SET delivered_at = now() WHERE delivered_at IS NULL');
});
