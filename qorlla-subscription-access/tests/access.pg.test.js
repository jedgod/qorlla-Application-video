// AccessService against a real PostgreSQL, connecting as the least-privilege runtime role.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, newCustomer, seedSubscription, sleep, skip } from './helpers/db.js';
import { AccessService, validOverrideValue } from '../src/accessService.js';
import { requireFeature, loadSubscription } from '../src/middleware.js';
import { getFeatureMeta } from '../src/plans.js';

const D = 86_400_000;

describe('AccessService (PostgreSQL)', { skip }, () => {
  let db, rt, svc;
  before(async () => { db = await createTestDb(); rt = db.poolFor('runtime'); svc = new AccessService({ pool: rt }); });
  after(async () => { await db.drop(); });

  const customerWith = async (o) => { const c = newCustomer(); await seedSubscription(db.owner, c, o); return c; };
  const override = (c, key, value, expires = null) => db.owner.query(
    `INSERT INTO entitlement_overrides (customer_id, feature_key, value, reason, expires_at, created_by) VALUES ($1,$2,$3,'test grant',$4,'test')`,
    [c, key, JSON.stringify(value), expires]);

  test('no subscription row -> free Basic by default (decided and documented), never paid features', async () => {
    const c = newCustomer();
    const sub = await svc.getSubscription(c);
    assert.equal(sub.source, 'default');
    assert.equal((await svc.canAccess(c, 'meetings.host')).allowed, true);
    const d = await svc.canAccess(c, 'meetings.cloud_recording');
    assert.equal(d.allowed, false);
    assert.equal(d.required_plan, 'pro');
  });

  test("missingSubscription:'deny' -> no subscription row, no access at all", async () => {
    const strict = new AccessService({ pool: rt, missingSubscription: 'deny' });
    const c = newCustomer();
    const d = await strict.canAccess(c, 'chat.instant');
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'subscription_inactive');
    assert.equal(d.lifecycle_reason, 'no_subscription');
    assert.throws(() => new AccessService({ pool: rt, missingSubscription: 'maybe' }));
  });

  test('an active paid subscription gets its plan; features above it name the plan that unlocks them', async () => {
    const c = await customerWith({ plan: 'pro' });
    assert.equal((await svc.canAccess(c, 'meetings.cloud_recording')).allowed, true);
    const d = await svc.canAccess(c, 'phone.pstn');
    assert.equal(d.allowed, false);
    assert.equal(d.required_plan, 'business');
    assert.equal((await svc.getResolvedEntitlements(c)).__plan, 'pro');
  });

  test('the DATABASE clock decides expiry: access ends when current_period_end passes, with no cache and no restart', async () => {
    const c = newCustomer();
    await db.owner.query(`INSERT INTO subscriptions (customer_id, plan_code, status, current_period_start, current_period_end)
      VALUES ($1, 'pro', 'active', now() - interval '1 day', now() + interval '3 seconds')`, [c]);
    assert.equal((await svc.canAccess(c, 'meetings.cloud_recording')).allowed, true);
    await sleep(3300);
    const d = await svc.canAccess(c, 'meetings.cloud_recording');
    assert.equal(d.allowed, false);
    assert.equal(d.lifecycle_reason, 'period_expired');
  });

  for (const [name, row, entitled, reason] of [
    ['paused', { status: 'paused' }, false, 'paused'],
    ['canceled', { status: 'canceled' }, false, 'canceled'],
    ['incomplete', { status: 'incomplete' }, false, 'incomplete'],
    ['trial over', { status: 'trialing', trialEnds: new Date(Date.now() - 1000) }, false, 'trial_expired'],
    ['trial running', { status: 'trialing', trialEnds: new Date(Date.now() + D) }, true, undefined],
    ['past_due inside explicit grace', { status: 'past_due', graceEnds: new Date(Date.now() + D) }, true, 'grace_period'],
    ['past_due after explicit grace', { status: 'past_due', graceEnds: new Date(Date.now() - 1000) }, false, 'grace_expired'],
    ['active but period over', { start: new Date(Date.now() - 40 * D), end: new Date(Date.now() - D) }, false, 'period_expired'],
  ]) {
    test(`lifecycle from stored rows: ${name}`, async () => {
      const c = await customerWith(row);
      const d = await svc.canAccess(c, 'meetings.cloud_recording');
      assert.equal(d.allowed, entitled);
      if (!entitled) {
        assert.equal(d.reason, 'subscription_inactive');
        assert.equal(d.lifecycle_reason, reason);
        assert.equal((await svc.canAccess(c, 'chat.instant')).allowed, true, 'the free tier still works');
      }
    });
  }

  test('overrides apply while active, expire on the database clock, and are ignored for a lapsed subscription', async () => {
    const c = await customerWith({ plan: 'basic' });
    await override(c, 'meetings.cloud_recording', true, new Date(Date.now() + 3000));
    assert.equal((await svc.canAccess(c, 'meetings.cloud_recording')).allowed, true);
    await sleep(3300);
    assert.equal((await svc.canAccess(c, 'meetings.cloud_recording')).allowed, false, 'expired override');

    const paused = await customerWith({ plan: 'pro', status: 'paused' });
    await override(paused, 'meetings.participants', 5000);
    assert.equal((await svc.canAccess(paused, 'meetings.participants', { quantity: 200 })).allowed, false, 'paused keeps no paid override');
  });

  test('consumption is counted inside the window only, by when the operation started', async () => {
    const c = await customerWith({ plan: 'basic' });                                     // 3 summaries per window
    const insert = (at) => db.owner.query(
      `INSERT INTO usage_events (customer_id, feature_key, quantity, occurred_at, period_start, period_end)
       VALUES ($1, 'ai.meeting_summaries', 1, $2, $3, $4)`, [c, at, new Date(Date.now() - 10 * D), new Date(Date.now() + 20 * D)]);
    await insert(new Date(Date.now() - 11 * D));                                          // before the window: not counted
    await insert(new Date(Date.now() - D)); await insert(new Date(Date.now() - 2 * D));  // inside: 2 used
    const first = await svc.reserve(c, 'ai.meeting_summaries', 1, { idempotencyKey: 'w1' });
    assert.equal(first.allowed, true);
    assert.equal(first.used, 2);
    const second = await svc.reserve(c, 'ai.meeting_summaries', 1, { idempotencyKey: 'w2' });
    assert.equal(second.allowed, false);
    assert.equal(second.reason, 'limit_exceeded');
  });

  test('entitlement is not capability: PSTN stays closed until operations open the gate, and the gate is per customer', async () => {
    const biz = await customerWith({ plan: 'business' });
    const closed = await svc.canAccess(biz, 'phone.pstn');
    assert.equal(closed.allowed, false);
    assert.equal(closed.reason, 'operational_gate_off');
    assert.equal(closed.entitled, true, 'the UI can tell "you own it" from "it is not switched on"');
    const seen = [];
    const open = new AccessService({ pool: rt, operationalGates: { 'phone.pstn': async (id) => { seen.push(id); return id === biz; } } });
    assert.equal((await open.canAccess(biz, 'phone.pstn')).allowed, true);
    assert.deepEqual(seen, [biz]);
    const other = await customerWith({ plan: 'business' });
    assert.equal((await open.canAccess(other, 'phone.pstn')).allowed, false);
    const pro = await customerWith({ plan: 'pro' });
    assert.equal((await open.canAccess(pro, 'phone.pstn')).reason, 'feature_not_available', 'no gate probe for an unentitled customer');
    const broken = new AccessService({ pool: rt, operationalGates: { 'phone.pstn': () => { throw new Error('probe down'); } } });
    await assert.rejects(broken.canAccess(biz, 'phone.pstn'), { code: 'access_unavailable' }, 'a failing gate denies');
    assert.equal((await svc.canAccess(biz, 'phone.voip')).allowed, true, 'VoIP is unaffected');
  });

  test('only a UUID from authenticated context is accepted as a customer; nothing reaches the database otherwise', async () => {
    const before = (await db.owner.query('SELECT count(*)::int AS n FROM access_audit')).rows[0].n;
    for (const bad of [undefined, null, '', 'x', '1', "'; DROP TABLE subscriptions;--", '../etc/passwd', {}, [], 7, 'ZZZZZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZZZZZZZZZ']) {
      await assert.rejects(svc.canAccess(bad, 'chat.instant'), { code: 'customer_context_invalid', statusCode: 401 });
    }
    assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM access_audit')).rows[0].n, before);
    assert.equal((await db.owner.query(`SELECT to_regclass('subscriptions') IS NOT NULL AS ok`)).rows[0].ok, true);
  });

  test('quantity must be a positive safe integer', async () => {
    const c = await customerWith({});
    for (const q of [0, -1, 1.5, '1', NaN, Infinity, -Infinity, {}, [], true, -0, 0.1 + 0.2, new Number(5)]) {
      await assert.rejects(svc.canAccess(c, 'meetings.participants', { quantity: q }), { code: 'invalid_quantity', statusCode: 400 }, String(q));
    }
    await assert.rejects(svc.canAccess(c, 'meetings.participants', { quantity: null }), { code: 'quantity_required' }, 'null is not "1"');
    for (const q of [2 ** 60, 1_000_001, Number.MAX_SAFE_INTEGER]) await assert.rejects(svc.canAccess(c, 'meetings.participants', { quantity: q }), { code: 'quantity_too_large' });
    assert.equal((await svc.canAccess(c, 'meetings.participants', {})).allowed, true, 'omitting the option means a plain check for 1');
    const small = new AccessService({ pool: rt, maxQuantity: 500 });
    assert.equal((await small.canAccess(c, 'meetings.participants', { quantity: 500 })).requested, 500);
    await assert.rejects(small.canAccess(c, 'meetings.participants', { quantity: 501 }), { code: 'quantity_too_large' }, 'the ceiling is configurable');
  });

  test('assertAccess raises the typed error for each denial', async () => {
    const c = await customerWith({ plan: 'basic' });
    await assert.rejects(svc.assertAccess(c, 'meetings.cloud_recording'), { code: 'feature_not_available' });
    await assert.rejects(svc.assertAccess(c, 'meetings.participants', { quantity: 101 }), { code: 'limit_exceeded' });
    await assert.rejects(svc.assertAccess(c, 'nonsense'), { code: 'feature_not_available' });
    const paused = await customerWith({ status: 'paused' });
    await assert.rejects(svc.assertAccess(paused, 'meetings.cloud_recording'), { code: 'subscription_inactive', statusCode: 402 });
    const biz = await customerWith({ plan: 'business' });
    await assert.rejects(svc.assertAccess(biz, 'phone.pstn'), { code: 'operational_gate_off' });
  });

  test('every decision is audited with who asked and why; auditing only denials is a choice, not an accident', async () => {
    const c = await customerWith({ plan: 'basic' });
    await svc.canAccess(c, 'meetings.host', { requestId: 'req-1', actor: 'user-9' });
    await svc.canAccess(c, 'meetings.cloud_recording');
    const rows = (await db.owner.query('SELECT feature_key, allowed, reason, request_id, actor, plan_code FROM access_audit WHERE customer_id=$1 ORDER BY occurred_at', [c])).rows;
    assert.deepEqual(rows.map((r) => [r.feature_key, r.allowed, r.reason]), [['meetings.host', true, null], ['meetings.cloud_recording', false, 'feature_not_available']]);
    assert.equal(rows[0].request_id, 'req-1'); assert.equal(rows[0].actor, 'user-9');
    const denialsOnly = new AccessService({ pool: rt, audit: 'denied' });
    const c2 = await customerWith({ plan: 'basic' });
    await denialsOnly.canAccess(c2, 'meetings.host');
    await denialsOnly.canAccess(c2, 'meetings.cloud_recording');
    assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM access_audit WHERE customer_id=$1', [c2])).rows[0].n, 1);
  });

  test('audit failure fails CLOSED by default (and leaves a critical security event); the opt-out is explicit', async () => {
    const c = await customerWith({ plan: 'basic' });
    await db.owner.query('REVOKE INSERT ON access_audit FROM qorlla_sub_runtime');
    try {
      await assert.rejects(svc.canAccess(c, 'meetings.host'), { code: 'access_unavailable', statusCode: 503 });
      const ev = (await db.owner.query(`SELECT severity FROM security_events WHERE event_type='audit_write_failed' AND customer_id=$1`, [c])).rows;
      assert.equal(ev.length > 0 && ev[0].severity, 'critical');
      const lenient = new AccessService({ pool: rt, failClosedOnAuditError: false });
      assert.equal((await lenient.canAccess(c, 'meetings.host')).allowed, true);
      // a reservation and its audit row are ONE transaction: no audit, no reservation
      const metered = await customerWith({ plan: 'basic' });
      await assert.rejects(svc.reserve(metered, 'ai.queries', 1, { idempotencyKey: 'a1' }), { code: 'access_unavailable' });
      assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM quota_reservations WHERE customer_id=$1', [metered])).rows[0].n, 0);
      assert.equal((await lenient.reserve(metered, 'ai.queries', 1, { idempotencyKey: 'a2' })).allowed, true);
    } finally {
      await db.owner.query('GRANT INSERT ON access_audit TO qorlla_sub_runtime');
    }
  });

  test('database unreachable -> denied (503), never allowed', async () => {
    const down = new AccessService({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none', connectionTimeoutMs: 400 });
    await assert.rejects(down.canAccess(newCustomer(), 'chat.instant'), { code: 'access_unavailable', statusCode: 503 });
    await assert.rejects(down.reserve(newCustomer(), 'ai.queries', 1, { idempotencyKey: 'k' }), { code: 'access_unavailable' });
    await down.close();
  });

  test('cache: refused in production without singleInstance; never extends entitlement past the period end', async () => {
    const old = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(() => new AccessService({ pool: rt, cacheEnabled: true }), /singleInstance/);
      assert.doesNotThrow(() => new AccessService({ pool: rt, cacheEnabled: true, singleInstance: true }));
    } finally { process.env.NODE_ENV = old; }

    const cached = new AccessService({ pool: rt, cacheEnabled: true, cacheTtlMs: 60_000 });
    const c = newCustomer();
    await db.owner.query(`INSERT INTO subscriptions (customer_id, plan_code, status, current_period_start, current_period_end)
      VALUES ($1, 'pro', 'active', now() - interval '1 day', now() + interval '30 seconds')`, [c]);
    assert.equal((await cached.canAccess(c, 'meetings.cloud_recording')).allowed, true);
    await db.owner.query(`UPDATE subscriptions SET status='paused' WHERE customer_id=$1`, [c]);
    assert.equal((await cached.canAccess(c, 'meetings.cloud_recording')).allowed, true, 'documented: stale until invalidated');
    cached.invalidate(c);
    assert.equal((await cached.canAccess(c, 'meetings.cloud_recording')).allowed, false, 'invalidate() takes effect at once');

    const c2 = newCustomer();
    await db.owner.query(`INSERT INTO subscriptions (customer_id, plan_code, status, current_period_start, current_period_end)
      VALUES ($1, 'pro', 'active', now() - interval '1 day', now() + interval '3 seconds')`, [c2]);
    assert.equal((await cached.canAccess(c2, 'meetings.cloud_recording')).allowed, true);
    await sleep(3300);
    assert.equal((await cached.canAccess(c2, 'meetings.cloud_recording')).allowed, false, 'a cached row is re-evaluated against the clock');
  });

  test('override values are re-validated on read: a malformed value grants nothing', () => {
    const bool = getFeatureMeta('meetings.cloud_recording'), num = getFeatureMeta('meetings.participants');
    assert.equal(validOverrideValue(bool, true), true);
    assert.equal(validOverrideValue(bool, 'true'), false);
    assert.equal(validOverrideValue(num, 'unlimited'), true);
    assert.equal(validOverrideValue(num, 100), true);
    for (const v of [-1, 1.5, 1e12, '5', null, {}, true]) assert.equal(validOverrideValue(num, v), false);
  });

  describe('middleware with the real service', () => {
    const run = async (mw, req) => {
      let status = 200, body, nexted = false;
      const res = { status(n) { status = n; return this; }, json(b) { body = b; return this; } };
      await mw(req, res, () => { nexted = true; });
      return { status, body, nexted };
    };
    const gate = (feature, opts) => requireFeature(feature, { service: svc, ...opts });

    test('allowed -> next(); inactive -> 402; unavailable feature -> 403; gate off -> 403', async () => {
      const pro = await customerWith({ plan: 'pro' });
      assert.equal((await run(gate('meetings.cloud_recording'), { auth: { customer_id: pro } })).nexted, true);
      const paused = await customerWith({ status: 'paused' });
      const r = await run(gate('meetings.cloud_recording'), { auth: { customer_id: paused } });
      assert.equal(r.status, 402); assert.equal(r.nexted, false); assert.equal(r.body.lifecycle_reason, 'paused');
      assert.equal((await run(gate('phone.pstn'), { auth: { customer_id: pro } })).status, 403);
      const biz = await customerWith({ plan: 'business' });
      assert.equal((await run(gate('phone.pstn'), { auth: { customer_id: biz } })).body.code, 'operational_gate_off');
    });

    test('the customer is never taken from the request body, query, params or headers', async () => {
      const pro = await customerWith({ plan: 'pro' });
      const spoof = { body: { customer_id: pro }, query: { customer_id: pro }, params: { customerId: pro }, headers: { 'x-customer-id': pro }, customerId: pro };
      const r = await run(gate('meetings.cloud_recording'), spoof);
      assert.equal(r.status, 401); assert.equal(r.nexted, false);
    });

    test('bad quantity -> 400; database failure -> 503 and next() is never called', async () => {
      const pro = await customerWith({ plan: 'pro' });
      assert.equal((await run(gate('meetings.participants', { quantity: () => NaN }), { auth: { customer_id: pro } })).status, 400);
      assert.equal((await run(gate('meetings.participants', { quantity: () => 'many' }), { auth: { customer_id: pro } })).status, 400);
      const down = new AccessService({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none', connectionTimeoutMs: 300 });
      const r = await run(requireFeature('meetings.host', { service: down }), { auth: { customer_id: pro } });
      assert.equal(r.status, 503); assert.equal(r.nexted, false); assert.equal(r.body.error, 'access_unavailable');
      assert.doesNotMatch(JSON.stringify(r.body), /ECONNREFUSED|127\.0\.0\.1|postgres/);
      await down.close();
    });

    test('loadSubscription attaches the snapshot and a failure is 503', async () => {
      const pro = await customerWith({ plan: 'pro' });
      const req = { auth: { customer_id: pro } };
      assert.equal((await run(loadSubscription({ service: svc }), req)).nexted, true);
      assert.equal(req.subscription.plan, 'pro');
      assert.equal((await run(loadSubscription({ service: svc }), { auth: { customer_id: 'nope' } })).status, 401);
    });
  });
});
