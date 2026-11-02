// Outbox ordering and failure recovery on real PostgreSQL, at worker level (no sockets). The properties:
//   * for ONE account events are delivered in event-id order even with several workers racing (several replicas), and each is marked delivered only after it was published;
//   * a failed event holds back that account's later events (head of line) and nobody else's, and is retried;
//   * a poison event is set aside (dead-lettered) after the retry limit so it cannot block the account for ever, and stays replayable; a Redis outage is never mistaken for a poison event;
//   * a publish that hangs times out; a worker that dies holding a claim only delays its events; a database hiccup while marking does not duplicate or lose anything.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.mjs';
import { createReliability } from '../src/reliability.mjs';
import { OutboxWorker } from '../src/outbox.mjs';
import { isolatedDb, wait } from './helpers.mjs';

let db, rel;
const ACCOUNTS = Array.from({ length: 12 }, (_, i) => 'acct' + i);
before(async () => {
  db = await isolatedDb(); if (!db) return; rel = createReliability(db.pool);
  for (const a of ACCOUNTS) await db.pool.query('INSERT INTO voice_identities(account_id, extension) VALUES($1,$2)', [a, String(3000 + ACCOUNTS.indexOf(a))]);
});
after(async () => { if (db) await db.drop(); });
const skip = (t) => !db && t.skip('no PostgreSQL reachable');
const quiet = { error() {} };
const n = async (sql, p = []) => Number((await db.pool.query(sql, p)).rows[0].n);
const reset = () => db.pool.query('DELETE FROM voice_reliable_events');
/** Appends `count` events for an account in separate transactions; returns their ids. */
async function append(account, count) { const ids = []; for (let i = 0; i < count; i++) ids.push(Number((await db.pool.query("INSERT INTO voice_reliable_events(account_id, kind, payload) VALUES($1,'state','{\"type\":\"state\",\"call\":{}}'::jsonb) RETURNING id", [account])).rows[0].id)); for (const id of ids) await db.pool.query('INSERT INTO voice_outbox(event_id) VALUES($1)', [id]); return ids; }
const drainAll = async (workers, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { await Promise.all(workers.map((w) => w.drain())); if (!(await n('SELECT count(*) n FROM voice_outbox WHERE delivered_at IS NULL AND dead_at IS NULL'))) return true; await wait(60); } return false; };

test('several workers racing never deliver one account\'s events out of order, repeat one, or lose one', async (t) => {
  if (skip(t)) return; await reset();
  const expected = new Map(); for (const a of ACCOUNTS) expected.set(a, await append(a, 15));
  const delivered = new Map(ACCOUNTS.map((a) => [a, []])), publish = async (account, msg) => { await wait(Math.random() * 12); delivered.get(account).push(msg.eventId); await wait(Math.random() * 12); };
  const workers = Array.from({ length: 5 }, (_, i) => new OutboxWorker({ db: db.pool, publish, workerId: 'w' + i, batchSize: 7, concurrency: 8, logger: quiet }));
  assert.ok(await drainAll(workers), 'everything was delivered');
  for (const a of ACCOUNTS) assert.deepEqual(delivered.get(a), expected.get(a), a + ' in order, exactly once');
});

test('a failure holds back that account\'s later events, not anyone else\'s, and the event is retried', async (t) => {
  if (skip(t)) return; await reset();
  const a = await append('acct0', 5), b = await append('acct1', 5), got = { acct0: [], acct1: [] }; let failed = false;
  const publish = async (account, msg) => { if (account === 'acct0' && msg.eventId === a[1] && !failed) { failed = true; throw new Error('boom'); } got[account].push(msg.eventId); };
  const w = new OutboxWorker({ db: db.pool, publish, workerId: 'w', logger: quiet });
  await w.drain(); assert.deepEqual(got.acct1, b, 'the other account was not held back'); assert.deepEqual(got.acct0, [a[0]], 'acct0 stopped at the failed event: later events wait');
  assert.equal(await n('SELECT count(*) n FROM voice_outbox WHERE event_id = ANY($1) AND delivered_at IS NULL', [a.slice(1)]), 4);
  await db.pool.query('UPDATE voice_outbox SET available_at = now()'); await w.drain(); assert.deepEqual(got.acct0, a, 'after the retry the rest follow, in order');
  assert.equal((await db.pool.query('SELECT attempts FROM voice_outbox WHERE event_id=$1', [a[1]])).rows[0].attempts, 1);
});

test('a poison event is set aside after the retry limit (and stays replayable) so it cannot block the account; a Redis outage is never treated as poison', async (t) => {
  if (skip(t)) return; await reset();
  const a = await append('acct2', 4), got = [];
  const publish = async (account, msg) => { if (msg.eventId === a[1]) throw new Error('cannot serialise'); got.push(msg.eventId); };
  const w = new OutboxWorker({ db: db.pool, publish, workerId: 'w', maxAttempts: 4, logger: quiet });
  for (let i = 0; i < 6; i++) { await db.pool.query('UPDATE voice_outbox SET available_at = now()'); await w.drain(); }
  assert.deepEqual(got, [a[0], a[2], a[3]], 'the poison event was skipped and the account unblocked, order kept');
  const dead = (await db.pool.query('SELECT event_id, attempts, dead_at, last_error FROM voice_outbox WHERE dead_at IS NOT NULL')).rows; assert.equal(dead.length, 1); assert.equal(Number(dead[0].event_id), a[1]); assert.ok(dead[0].attempts >= 4); assert.match(dead[0].last_error, /cannot serialise/);
  const stats = await rel.queueStats(); assert.equal(stats.pending, 0, 'dead events are not "pending"'); assert.equal(stats.dead, 1, 'but they are counted, so an alert can fire');
  assert.ok((await rel.replay('acct2', a[0] - 1)).events.some((e) => e.id === a[1]), 'and a reconnecting device still receives it by replay');
  // the same number of failures because the bus is down never dead-letters anything
  await reset(); const b = await append('acct3', 3), many = new OutboxWorker({ db: db.pool, publish: async () => { throw new Error('distributed_bus_unavailable'); }, workerId: 'w2', maxAttempts: 3, logger: quiet });
  for (let i = 0; i < 8; i++) { await db.pool.query('UPDATE voice_outbox SET available_at = now()'); await many.drain(); }
  assert.equal(await n('SELECT count(*) n FROM voice_outbox WHERE dead_at IS NOT NULL'), 0, 'a Redis outage never sets events aside'); assert.equal(await n('SELECT count(*) n FROM voice_outbox WHERE delivered_at IS NULL'), 3);
  const ok = []; const back = new OutboxWorker({ db: db.pool, publish: async (acc, msg) => { ok.push(msg.eventId); }, workerId: 'w3', logger: quiet }); await db.pool.query('UPDATE voice_outbox SET available_at = now()'); await back.drain(); assert.deepEqual(ok, b, 'when Redis returns they are delivered, in order');
});

test('a publish that hangs times out and is retried; it does not stall the other accounts', async (t) => {
  if (skip(t)) return; await reset();
  const a = await append('acct4', 2), b = await append('acct5', 3), got = []; let hung = true;
  const publish = (account, msg) => (account === 'acct4' && hung ? new Promise(() => {}) : Promise.resolve().then(() => { got.push(msg.eventId); }));
  const w = new OutboxWorker({ db: db.pool, publish, workerId: 'w', publishTimeoutMs: 300, logger: quiet });
  const t0 = Date.now(); await w.drain(); assert.ok(Date.now() - t0 < 3000, 'the batch finished despite the hung publish'); assert.deepEqual(got, b, 'the other account was delivered');
  assert.match((await db.pool.query('SELECT last_error FROM voice_outbox WHERE event_id=$1', [a[0]])).rows[0].last_error, /publish_timeout/);
  hung = false; await db.pool.query('UPDATE voice_outbox SET available_at = now()'); await w.drain(); assert.deepEqual(got, [...b, ...a]);
});

test('a worker that dies holding a claim blocks only its accounts, only until the lock expires; then another worker continues in order', async (t) => {
  if (skip(t)) return; await reset();
  const a = await append('acct6', 4), b = await append('acct7', 2), got = []; const publish = async (account, msg) => { got.push([account, msg.eventId]); };
  const dead = new OutboxWorker({ db: db.pool, publish, workerId: 'dead', logger: quiet }); const claimed = await dead.claim(); assert.deepEqual(claimed.map((x) => x.event_id).sort((x, y) => x - y), [a[0], b[0]], 'it holds the head of each account');
  const live = new OutboxWorker({ db: db.pool, publish, workerId: 'live', logger: quiet }); await live.drain(); assert.deepEqual(got, [], 'nothing else may overtake the held heads');
  await db.pool.query("UPDATE voice_outbox SET locked_until = now() - interval '1 second'"); await live.drain();
  assert.deepEqual(got.filter(([x]) => x === 'acct6').map(([, id]) => id), a); assert.deepEqual(got.filter(([x]) => x === 'acct7').map(([, id]) => id), b);
});

test('a database hiccup while marking delivered is retried; nothing is duplicated, nothing is lost', async (t) => {
  if (skip(t)) return; await reset();
  const a = await append('acct8', 3), got = []; let failMark = 2;
  const flaky = { query: (sql, ...args) => (typeof sql === 'string' && sql.includes('SET delivered_at') && failMark-- > 0 ? Promise.reject(new Error('connection reset')) : db.pool.query(sql, ...args)) };
  const w = new OutboxWorker({ db: flaky, publish: async (acc, msg) => { got.push(msg.eventId); }, workerId: 'w', logger: quiet });
  await w.drain(); assert.deepEqual(got, a, 'each event published once'); assert.equal(await n('SELECT count(*) n FROM voice_outbox WHERE delivered_at IS NULL'), 0, 'and marked after the retries');
  // if the marking keeps failing, the lock expires and the events are delivered again (at least once): same ids, same order
  await reset(); const b = await append('acct9', 2), again = []; failMark = 99;
  const w2 = new OutboxWorker({ db: flaky, publish: async (acc, msg) => { again.push(msg.eventId); }, workerId: 'w2', logger: quiet }); await w2.drain(); failMark = 0;
  await db.pool.query("UPDATE voice_outbox SET locked_until = now() - interval '1 second'"); await w2.drain(); assert.deepEqual(again.filter((x, i, arr) => arr.indexOf(x) === i), b, 'redelivery keeps the order');
});

test('the optimised claim still scales: a large backlog drains in order across workers', async (t) => {
  if (skip(t)) return; await reset();
  for (let i = 0; i < ACCOUNTS.length; i++) await append(ACCOUNTS[i], 40);
  const order = new Map(); const publish = async (account, msg) => { const l = order.get(account) || []; l.push(msg.eventId); order.set(account, l); };
  const workers = [0, 1, 2].map((i) => new OutboxWorker({ db: db.pool, publish, workerId: 'k' + i, logger: quiet })), t0 = Date.now(); assert.ok(await drainAll(workers, 30000)); const ms = Date.now() - t0;
  for (const [a, ids] of order) assert.deepEqual(ids, [...ids].sort((x, y) => x - y), a); assert.equal([...order.values()].flat().length, 480);
  console.log(`  drained 480 events for 12 accounts in ${ms} ms with 3 workers`);
});
