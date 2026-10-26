import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace } from './helpers.mjs';

describe('backend entitlement enforcement, sales inquiries', () => {
  let db, main, app;
  before(async () => { db = await freshDatabase(); main = await startMainStandIn(); app = await startApp({ pool: db.pool, cfg: testConfig({ cfg: { salesLimit: 5 } }, main), jwks: main.jwks }); });
  after(async () => { await app.close(); await main.close(); await db.drop(); });
  const newWs = async (planSlug = 'basic', status = 'active') => {
    const u = await main.mint(); const ws = await seedWorkspace(db.pool, u.sub);
    if (planSlug !== 'basic') await db.pool.query(`UPDATE portal.subscriptions SET plan_slug=$2,status=$3,billing_interval='month',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [ws, planSlug, status]);
    return { u, ws, c: app.client(u) };
  };

  test('Basic notes limit (20) is enforced by the server, including under concurrency', async () => {
    const { c, ws } = await newWs();
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => c.post('/api/v1/notes', { title: 'n' + i })));
    assert.equal(results.filter((r) => r.status === 201).length, 20); assert.equal(results.filter((r) => r.status === 402).length, 10);
    const over = await c.post('/api/v1/notes', { title: 'one too many' }); assert.equal(over.status, 402);
    assert.deepEqual({ code: over.body.code, feature: over.body.feature, limit: over.body.limit, plan: over.body.plan }, { code: 'plan_limit', feature: 'notes.max', limit: 20, plan: 'basic' });
    assert.equal(Number((await db.pool.query('SELECT count(*) FROM portal.notes WHERE workspace_id=$1', [ws])).rows[0].count), 20);
  });
  test('paid plans raise the limits; an expired/cancelled/past-grace subscription falls back to Basic', async () => {
    const pro = await newWs('pro'); assert.equal((await pro.c.get('/api/v1/entitlements')).body.plan, 'pro');
    assert.equal((await pro.c.get('/api/v1/entitlements')).body.features['notes.max'].quota, 1000);
    const ent = await newWs('enterprise'); assert.equal((await ent.c.get('/api/v1/entitlements')).body.features['notes.max'].unlimited, true);
    for (const [status, expectPlan] of [['active', 'pro'], ['trialing', 'pro'], ['past_due', 'pro'], ['canceled', 'basic'], ['expired', 'basic'], ['incomplete', 'basic']]) {
      const w = await newWs('pro', status); assert.equal((await w.c.get('/api/v1/workspace')).body.plan, expectPlan, status);
    }
    const lapsed = await newWs('pro'); await db.pool.query(`UPDATE portal.subscriptions SET current_period_end=now()-interval '3 days' WHERE workspace_id=$1`, [lapsed.ws]);
    assert.equal((await lapsed.c.get('/api/v1/workspace')).body.plan, 'basic', 'active but 3 days past the period end (beyond webhook-lag allowance)');
    const grace = await newWs('pro', 'past_due'); await db.pool.query(`UPDATE portal.subscriptions SET current_period_end=now()-interval '3 days' WHERE workspace_id=$1`, [grace.ws]);
    assert.equal((await grace.c.get('/api/v1/workspace')).body.plan, 'pro', 'past_due inside the 7-day retry grace');
  });
  test('member limit follows the plan', async () => {
    const { c, ws } = await newWs();                         // Basic: 3 members, owner counts as one
    assert.equal((await c.post('/api/v1/members', { user_id: crypto.randomUUID(), role: 'member' })).status, 201);
    assert.equal((await c.post('/api/v1/members', { user_id: crypto.randomUUID(), role: 'member' })).status, 201);
    const third = await c.post('/api/v1/members', { user_id: crypto.randomUUID(), role: 'member' }); assert.equal(third.status, 402); assert.equal(third.body.feature, 'members.max');
    await db.pool.query(`UPDATE portal.subscriptions SET plan_slug='pro',status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [ws]);
    assert.equal((await c.post('/api/v1/members', { user_id: crypto.randomUUID(), role: 'member' })).status, 201);
  });
  test('metered usage: monthly AI-query quota is enforced, idempotent, and workspace-scoped', async () => {
    const { c } = await newWs(); const other = await newWs();
    const use = (cl, units, key) => cl.post('/api/v1/usage', { feature: 'ai.queries_per_month', units, idempotency_key: key });
    assert.equal((await use(c, 15, 'key-000001')).status, 201);
    assert.equal((await use(c, 15, 'key-000001')).body.duplicate, true, 'same key is not double counted');
    assert.equal((await use(c, 5, 'key-000002')).status, 201);
    const over = await use(c, 1, 'key-000003'); assert.equal(over.status, 402); assert.equal(over.body.limit, 20);
    assert.equal((await use(other.c, 20, 'key-000001')).status, 201, 'another workspace has its own meter');
    assert.equal((await c.post('/api/v1/usage', { feature: 'notes.max', units: 1, idempotency_key: 'key-000009' })).status, 400, 'only metered features accepted');
    assert.deepEqual((await c.get('/api/v1/usage')).body, [{ feature: 'ai.queries_per_month', units: 20 }]);
  });

  test('Enterprise "Contact sales" stores a real inquiry; validation, honeypot and rate limit protect the endpoint', async () => {
    const anon = app.client(null);
    const ok = await anon.post('/api/v1/sales-inquiries', { name: 'Dana Buyer', email: 'Dana@Example.COM', company: 'Acme', message: 'We need SSO for 500 seats.', plan_interest: 'enterprise' }, { origin: 'https://qorlla.test' });
    assert.equal(ok.status, 201);
    const row = (await db.pool.query('SELECT * FROM portal.sales_inquiries WHERE id=$1', [ok.body.id])).rows[0];
    assert.equal(row.email, 'dana@example.com'); assert.equal(row.status, 'new'); assert.equal(row.plan_interest, 'enterprise'); assert.match(row.source_ip_hash, /^[0-9a-f]{64}$/); assert.ok(!JSON.stringify(row).includes('127.0.0.1'));
    assert.equal((await anon.post('/api/v1/sales-inquiries', { name: '', email: 'x', message: 'hi' })).status, 400);
    assert.equal((await anon.post('/api/v1/sales-inquiries', { name: 'A', email: 'not-an-email', message: 'long enough message' })).status, 400);
    assert.equal((await anon.post('/api/v1/sales-inquiries', { name: 'A', email: 'a@b.co', message: 'long enough message' }, { origin: 'https://evil.example' })).status, 403);
    const before = Number((await db.pool.query('SELECT count(*) FROM portal.sales_inquiries')).rows[0].count);
    const bot = await anon.post('/api/v1/sales-inquiries', { name: 'Bot', email: 'b@b.co', message: 'buy pills now', website: 'http://spam' }); assert.equal(bot.status, 201);
    assert.equal(Number((await db.pool.query('SELECT count(*) FROM portal.sales_inquiries')).rows[0].count), before, 'honeypot submissions are not stored');
    let limited = 0; for (let i = 0; i < 8; i++) if ((await anon.post('/api/v1/sales-inquiries', { name: 'Spam' + i, email: 's@s.co', message: 'message ' + i + ' padding' })).status === 429) limited++;
    assert.ok(limited >= 1, 'rate limiter engaged');
  });
});
