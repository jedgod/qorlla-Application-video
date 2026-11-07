// Idempotent replay of a metered operation, over real HTTP, across independent application instances sharing one PostgreSQL.
// The protected work counts its own executions: the contract is that it runs AT MOST ONCE per Idempotency-Key, and that a retry
// is never answered with success while the original is unfinished or has failed.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createTestDb, newCustomer, seedSubscription, sleep, skip } from './helpers/db.js';
import { AccessService } from '../src/accessService.js';
import { BillingProcessor } from '../src/billing.js';
import { createMiddleware } from '../src/middleware.js';
import { createExampleApp } from '../examples/express-integration.js';

const INTERNAL = 'i'.repeat(40);

describe('idempotent replay (PostgreSQL, multi-instance HTTP)', { skip }, () => {
  let db, tokens, executions, latches, servers;
  before(async () => { db = await createTestDb(); tokens = new Map(); executions = new Map(); latches = new Map(); servers = []; });
  after(async () => { for (const s of servers) s.close(); await db.drop(); });

  /** One application instance: its own connection pools, its own HTTP port. */
  async function instance({ wrapMiddleware } = {}) {
    const service = new AccessService({ pool: db.poolFor('runtime', { max: 8 }) });
    let middleware = createMiddleware(service);
    if (wrapMiddleware) middleware = wrapMiddleware(middleware);
    const app = createExampleApp({
      service, middleware, internalToken: INTERNAL, billing: new BillingProcessor({ adapters: [], pool: db.poolFor('billing', { max: 2 }) }),
      authenticate: async (req) => tokens.get((req.get('authorization') || '').replace(/^Bearer /, '')) || null,
      work: async (req) => {
        const key = req.get('idempotency-key'); const mode = req.get('x-test-mode') || 'quick';
        executions.set(key, (executions.get(key) || 0) + 1);
        if (mode === 'slow') await sleep(500);
        if (mode === 'fail') throw new Error('upstream model unavailable');
        if (mode === 'latch') await latches.get(key).promise;
        return { summary: 'summary-for-' + key, n: executions.get(key) };
      },
    });
    const server = createServer(app); servers.push(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { base: `http://127.0.0.1:${server.address().port}`, service, close: () => new Promise((r) => server.close(r)) };
  }
  const user = async (plan = 'basic', o = {}) => {
    const customer_id = newCustomer(); await seedSubscription(db.owner, customer_id, { plan, ...o });
    const user_id = 'user-' + customer_id.slice(0, 8), token = 't-' + customer_id; tokens.set(token, { customer_id, user_id });
    return { customer_id, user_id, token };
  };
  const call = (inst, u, key, mode) => fetch(inst.base + '/api/ai/summaries', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + u.token, 'idempotency-key': key, ...(mode ? { 'x-test-mode': mode } : {}) }, body: JSON.stringify({ meeting_id: 'm1' }) });
  const read = async (r) => ({ status: r.status, replay: r.headers.get('idempotent-replay'), retryAfter: r.headers.get('retry-after'), body: await r.json() });
  const usage = async (c) => Number((await db.owner.query(`SELECT COALESCE(sum(quantity),0) AS n FROM usage_events WHERE customer_id=$1`, [c])).rows[0].n);
  const resv = async (c, k) => (await db.owner.query(`SELECT status FROM quota_reservations WHERE customer_id=$1 AND idempotency_key LIKE $2 ORDER BY reserved_at`, [c, '%:' + k])).rows.map((r) => r.status);

  test('24 simultaneous requests with ONE key across 3 instances: the work runs exactly once; nobody gets a second success', async () => {
    const insts = await Promise.all([instance(), instance(), instance()]);
    const u = await user('basic');
    const rs = await Promise.all(Array.from({ length: 24 }, (_, i) => call(insts[i % 3], u, 'sim-1', 'slow').then(read)));
    assert.equal(executions.get('sim-1'), 1, 'the protected work executed ONCE');
    const original = rs.filter((r) => r.status === 201 && !r.replay);
    assert.equal(original.length, 1, 'exactly one original success');
    for (const r of rs) {
      if (r === original[0]) continue;
      const pending = r.status === 409 && r.body.error === 'request_in_progress' && r.retryAfter;
      const replayed = r.status === 201 && r.replay === 'true' && r.body.summary === 'summary-for-sim-1';
      assert.ok(pending || replayed, `every other answer is "in progress" or the stored result, got ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.equal(await usage(u.customer_id), 1, 'one unit consumed');
    assert.deepEqual(await resv(u.customer_id, 'sim-1'), ['committed']);
    const after = await Promise.all(insts.map((i) => call(i, u, 'sim-1').then(read)));
    assert.ok(after.every((r) => r.status === 201 && r.replay === 'true' && r.body.n === 1), 'once finished, every instance replays the stored response');
    assert.equal(executions.get('sim-1'), 1);
  });

  test('a retry while the original is STILL RUNNING is a 409 (never a success) and does not run the work again; afterwards the stored result is replayed', async () => {
    const [a, b] = await Promise.all([instance(), instance()]);
    const u = await user('basic');
    let release; latches.set('pend-1', { promise: new Promise((r) => { release = r; }) });
    const first = call(a, u, 'pend-1', 'latch').then(read);
    for (let i = 0; i < 100 && !executions.get('pend-1'); i++) await sleep(20);
    assert.equal(executions.get('pend-1'), 1, 'the original is running');
    for (const inst of [a, b, a, b]) {
      const r = await call(inst, u, 'pend-1').then(read);
      assert.equal(r.status, 409); assert.equal(r.body.error, 'request_in_progress'); assert.ok(r.retryAfter, 'tells the client when to retry');
      assert.equal(r.replay, null);
    }
    assert.equal(executions.get('pend-1'), 1, 'four retries ran the work zero extra times');
    assert.equal(await usage(u.customer_id), 0, 'nothing is billed until the original commits');
    assert.deepEqual(await resv(u.customer_id, 'pend-1'), ['reserved']);
    release();
    const done = await first;
    assert.equal(done.status, 201); assert.equal(done.replay, null);
    const replay = await call(b, u, 'pend-1').then(read);
    assert.equal(replay.status, 201); assert.equal(replay.replay, 'true'); assert.deepEqual(replay.body, done.body, 'the very same response');
    assert.equal(executions.get('pend-1'), 1); assert.equal(await usage(u.customer_id), 1);
  });

  test('a FAILED original is never turned into success: the retry is 409 previous_attempt_failed, the work is not run again, and the quota was given back', async () => {
    const [a, b] = await Promise.all([instance(), instance()]);
    const u = await user('basic');
    const failed = await call(a, u, 'fail-1', 'fail').then(read);
    assert.equal(failed.status, 500); assert.equal(failed.body.error, 'operation_failed', 'a failure of the work is not reported as an access error');
    assert.deepEqual(await resv(u.customer_id, 'fail-1'), ['released']);
    assert.equal(await usage(u.customer_id), 0);
    for (const inst of [a, b]) {
      const r = await call(inst, u, 'fail-1').then(read);
      assert.equal(r.status, 409); assert.equal(r.body.error, 'previous_attempt_failed'); assert.equal(r.replay, null);
    }
    assert.equal(executions.get('fail-1'), 1, 'a failed key is not silently re-run either');
    const fresh = await call(b, u, 'fail-2').then(read);                                // a NEW key is the way forward, and the quota is intact
    assert.equal(fresh.status, 201);
    assert.equal(await usage(u.customer_id), 1);
  });

  test('idempotency survives a restart: a brand-new instance (new pools) replays what an earlier, now-closed instance stored', async () => {
    const old = await instance();
    const u = await user('basic');
    const original = await call(old, u, 'restart-1').then(read);
    assert.equal(original.status, 201);
    await old.close();                                                                  // the process "goes away"
    const reborn = await instance();
    const replay = await call(reborn, u, 'restart-1').then(read);
    assert.equal(replay.status, 201); assert.equal(replay.replay, 'true'); assert.deepEqual(replay.body, original.body);
    assert.equal(executions.get('restart-1'), 1, 'the new process never ran the work');
    assert.equal(await usage(u.customer_id), 1);
  });

  test('a process that died after reserving (no commit): retries see "in progress", then "failed" once the hold expires - never success, never a second run', async () => {
    const inst = await instance();
    const u = await user('basic');
    const r0 = await inst.service.reserve(u.customer_id, 'ai.meeting_summaries', 1, { idempotencyKey: `${u.user_id}:crash-1` });   // the dead process got this far
    assert.equal(r0.allowed, true);
    const during = await call(inst, u, 'crash-1').then(read);
    assert.equal(during.status, 409); assert.equal(during.body.error, 'request_in_progress');
    await db.owner.query(`UPDATE quota_reservations SET expires_at = now() + interval '700 milliseconds' WHERE id = $1`, [r0.reservationId]);
    await sleep(1000);
    const after = await call(inst, u, 'crash-1').then(read);
    assert.equal(after.status, 409); assert.equal(after.body.error, 'previous_attempt_failed');
    assert.equal(executions.get('crash-1'), undefined, 'the work never ran in the new process');
    assert.equal((await call(inst, u, 'crash-2').then(read)).status, 201, 'a new key proceeds, quota free again');
  });

  test('unlimited plans are protected the same way (they used to leave no record, so a retry ran the work twice)', async () => {
    const [a, b, c] = await Promise.all([instance(), instance(), instance()]);
    const pro = await user('pro');
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => call([a, b, c][i % 3], pro, 'unl-1', 'slow').then(read)));
    assert.equal(executions.get('unl-1'), 1);
    assert.equal(rs.filter((r) => r.status === 201 && !r.replay).length, 1);
    assert.ok(rs.every((r) => r.status === 409 || (r.status === 201)));
    assert.equal(await usage(pro.customer_id), 1, 'and the unlimited usage is metered');
    const again = await call(b, pro, 'unl-1').then(read);
    assert.equal(again.replay, 'true');
  });

  test('replays never consume quota: the same key five times uses one of three; distinct keys fill the rest; the fourth is refused', async () => {
    const inst = await instance();
    const u = await user('basic');                                                      // 3 per window
    for (let i = 0; i < 5; i++) assert.equal((await call(inst, u, 'rq-1').then(read)).status, 201);
    assert.equal(await usage(u.customer_id), 1);
    assert.equal((await call(inst, u, 'rq-2').then(read)).status, 201); assert.equal((await call(inst, u, 'rq-3').then(read)).status, 201);
    const fourth = await call(inst, u, 'rq-4').then(read);
    assert.equal(fourth.status, 403); assert.equal(fourth.body.code, 'limit_exceeded');
    assert.equal((await call(inst, u, 'rq-1').then(read)).replay, 'true', 'and an old key still replays even when the window is full');
    assert.equal(executions.get('rq-4'), undefined);
  });

  test('keys are per user: the same Idempotency-Key from two users is two independent operations', async () => {
    const inst = await instance();
    const [u1, u2] = [await user('basic'), await user('basic')];
    const [r1, r2] = await Promise.all([call(inst, u1, 'shared-key').then(read), call(inst, u2, 'shared-key').then(read)]);
    assert.equal(r1.status, 201); assert.equal(r2.status, 201); assert.equal(r1.replay, null); assert.equal(r2.replay, null);
    assert.equal(executions.get('shared-key'), 2, 'one run per user');
    assert.equal(await usage(u1.customer_id), 1); assert.equal(await usage(u2.customer_id), 1);
  });

  test('if the work finished but the commit cannot be recorded, the hold is KEPT (no free ride), the answer is an error, and a retry is "in progress"', async () => {
    const inst = await instance({ wrapMiddleware: (m) => ({ ...m, commitReservation: async () => { throw new Error('database connection lost'); } }) });
    const u = await user('basic');
    const r = await call(inst, u, 'commit-lost').then(read);
    assert.equal(r.status, 503); assert.equal(r.body.error, 'access_unavailable');
    assert.equal(executions.get('commit-lost'), 1);
    assert.deepEqual(await resv(u.customer_id, 'commit-lost'), ['reserved'], 'NOT released: the quota stays held until it expires');
    const healthy = await instance();
    const retry = await call(healthy, u, 'commit-lost').then(read);
    assert.equal(retry.status, 409); assert.equal(retry.body.error, 'request_in_progress', 'not success, and the work does not run again');
    assert.equal(executions.get('commit-lost'), 1);
  });

  test('a transient commit error is retried and the usage is not lost', async () => {
    let failures = 2;
    const inst = await instance({ wrapMiddleware: (m) => ({ ...m, commitReservation: (...a) => { if (failures-- > 0) throw new Error('blip'); return m.commitReservation(...a); } }) });
    const u = await user('basic');
    const r = await call(inst, u, 'blip-1').then(read);
    assert.equal(r.status, 201);
    assert.equal(await usage(u.customer_id), 1);
    assert.deepEqual(await resv(u.customer_id, 'blip-1'), ['committed']);
  });

  test('the Idempotency-Key is mandatory and bounded', async () => {
    const inst = await instance();
    const u = await user('basic');
    const bad = await fetch(inst.base + '/api/ai/summaries', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + u.token }, body: '{}' });
    assert.equal(bad.status, 400);
    assert.equal((await call(inst, u, 'k'.repeat(151)).then(read)).status, 400);
    assert.equal(await usage(u.customer_id), 0);
  });
});
