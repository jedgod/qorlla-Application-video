import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, addMember, here } from './helpers.mjs';
import { startFakeStripe, WEBHOOK_SECRET } from './fake-stripe.mjs';
import { createSbacs } from '../server/sbacs.mjs';

// SBACS Phase 3A: billing foundation. The provider is tests/fake-stripe.mjs (a deterministic TEST DOUBLE, never a live provider). These tests prove OUR
// state machine: only verified, authoritative events change entitlements; replays, stale and cross-workspace events cannot; payment never beats suspension.
describe('billing foundation (flag-gated, provider-neutral lifecycle)', () => {
  let db, main, stripe, app, sbacs, owner, ws, c;
  const env = () => ({ BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_API_BASE: stripe.url });
  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn(); stripe = await startFakeStripe(); sbacs = createSbacs({ pool: db.pool });
    app = await startApp({ pool: db.pool, cfg: testConfig({ env: env() }, main), jwks: main.jwks });
  });
  after(async () => { await app.close(); await stripe.close(); await main.close(); await db.drop(); });
  beforeEach(async () => { owner = await main.mint(); ws = await seedWorkspace(db.pool, owner.sub); c = app.client(owner); stripe.st.requests.length = 0; stripe.st.down = false; stripe.st.failCreate = false; await app.flags.set('billing_live', true, 'test', owner.sub); });

  const sql = (q, a) => db.pool.query(q, a);
  const plan = async (client = c) => (await client.get('/api/v1/workspace')).body.plan;
  async function checkout(client = c, planSlug = 'pro') {
    const r = await client.post('/api/v1/subscriptions/checkout', { plan: planSlug, interval: 'month', seats: 1 }); assert.equal(r.status, 201, JSON.stringify(r.body));
    return (await sql('SELECT * FROM portal.checkout_sessions WHERE id=$1', [r.body.checkout_id])).rows[0];
  }
  const paid = (row, extra = {}) => { const sub = stripe.subscription({ checkoutId: row.id, workspaceId: row.workspace_id, unitAmount: row.unit_amount_cents, interval: row.billing_interval, quantity: row.seats, ...extra }); return { sub, inv: stripe.invoice({ sub, amountPaid: row.unit_amount_cents * row.seats }) }; };
  async function activate(client = c) { const row = await checkout(client); const { sub, inv } = paid(row); const t0 = Math.floor(Date.now() / 1000); assert.equal((await stripe.deliver(app.base, stripe.event('invoice.paid', inv, { created: t0 }))).status, 200); return { row, sub, inv, t0 }; }
  const events = async (w, like = 'subscription.%') => (await sql(`SELECT kind, detail FROM portal.entitlement_events WHERE workspace_id=$1 AND kind LIKE $2 ORDER BY id`, [w, like])).rows;

  test('payment processing is OFF by default: no provider configured = checkout, resume and webhooks refuse; a configured provider still needs the billing_live flag', async () => {
    const bare = await startApp({ pool: db.pool, cfg: testConfig({}, main), jwks: main.jwks });                       // production-default configuration: no BILLING_ENABLED, no keys
    try {
      assert.equal(bare.billing.available(), false);
      const r = await bare.client(owner).post('/api/v1/subscriptions/checkout', { plan: 'pro', interval: 'month' }); assert.ok([503, 502].includes(r.status), 'checkout refused: ' + r.status);
      assert.equal((await stripe.deliver(bare.base, stripe.event('invoice.paid', { id: 'in_x', subscription: 'sub_x', status: 'paid', amount_paid: 1 }))).status, 503, 'webhooks are not even read');
      assert.equal((await bare.client(owner).get('/api/v1/billing')).body.checkout_available, false);
    } finally { await bare.close(); }
    await app.flags.set('billing_live', false, 'default', owner.sub);
    for (const [m, p, b] of [['post', '/api/v1/subscriptions/checkout', { plan: 'pro', interval: 'month' }], ['post', '/api/v1/billing/checkout', { plan: 'pro', interval: 'month' }], ['post', '/api/v1/subscriptions/resume', {}], ['post', '/api/v1/subscriptions/change', { plan: 'business', interval: 'month', seats: 1 }]]) {
      const r = await c[m](p, b); assert.equal(r.status, 503, p); assert.equal(r.body.flag, 'billing_live');
    }
    assert.equal(stripe.st.requests.length, 0, 'the provider was never contacted');
    assert.equal((await sql(`SELECT enabled FROM portal.platform_flags WHERE key='billing_live'`)).rows[0].enabled, false);
  });

  test('a checkout (or its success redirect) never activates anything; only a verified authoritative event does, and the spec endpoints exist', async () => {
    const row = await checkout(); assert.equal(await plan(), 'basic');
    assert.equal((await c.get('/api/v1/subscriptions/current')).body.plan, 'basic');
    const { inv } = paid(row);
    assert.equal((await stripe.deliver(app.base, stripe.event('invoice.paid', inv), { secret: 'whsec_wrong' })).status, 400); assert.equal(await plan(), 'basic', 'unsigned or forged: nothing changes');
    assert.equal((await stripe.deliver(app.base, stripe.event('invoice.paid', inv))).status, 200); assert.equal(await plan(), 'pro');
    assert.equal((await c.get('/api/v1/subscriptions/invoices')).status, 200); assert.equal((await c.get('/api/v1/subscriptions/invoices')).body.length, 1);
    assert.equal((await c.get('/api/v1/subscriptions/current')).body.subscription.status, 'active');
  });

  test('a billing event for workspace A cannot modify workspace B, even when the event claims B\'s identifiers', async () => {
    const other = await main.mint(); const wsB = await seedWorkspace(db.pool, other.sub); const cB = app.client(other);
    const rowA = await checkout(c), rowB = await checkout(cB);
    // a subscription created through A's checkout whose metadata CLAIMS workspace B
    const sub = stripe.subscription({ checkoutId: rowA.id, workspaceId: wsB, unitAmount: rowA.unit_amount_cents, interval: 'month', quantity: 1 }); const inv = stripe.invoice({ sub, amountPaid: rowA.unit_amount_cents });
    await stripe.deliver(app.base, stripe.event('invoice.paid', inv));
    assert.equal(await plan(cB), 'basic', 'B was not upgraded by an event that merely names B');
    assert.equal((await sql(`SELECT count(*)::int n FROM portal.subscriptions WHERE provider_subscription_id=$1`, [sub.id])).rows[0].n <= 1, true);
    // a legitimate event for B changes B only
    const { inv: invB } = paid(rowB); await stripe.deliver(app.base, stripe.event('invoice.paid', invB));
    assert.equal(await plan(cB), 'pro'); assert.notEqual((await sql(`SELECT provider_subscription_id FROM portal.subscriptions WHERE workspace_id=$1`, [wsB])).rows[0].provider_subscription_id, sub.id);
    assert.deepEqual((await events(wsB, 'subscription.%')).every((e) => e.detail.to.plan !== undefined), true);
  });

  test('replayed, stale and conflicting events cannot duplicate or reverse a subscription', async () => {
    const { sub, inv, t0 } = await activate();
    const same = stripe.event('invoice.paid', inv, { created: t0 });                                                  // re-delivery of the same event id
    const first = await stripe.deliver(app.base, same), again = await stripe.deliver(app.base, same); assert.equal(again.body.duplicate, true); assert.equal(first.status, 200);
    assert.equal((await sql(`SELECT count(*)::int n FROM portal.subscriptions WHERE workspace_id=$1`, [ws])).rows[0].n, 1);
    assert.equal((await sql(`SELECT count(*)::int n FROM portal.billing_events WHERE event_id=$1`, [same.id])).rows[0].n, 1);
    await stripe.deliver(app.base, stripe.event('customer.subscription.deleted', { ...sub, status: 'canceled' }, { created: t0 + 100 })); assert.equal(await plan(), 'basic');
    await stripe.deliver(app.base, stripe.event('customer.subscription.updated', { ...sub, status: 'active' }, { created: t0 + 50 })); assert.equal(await plan(), 'basic', 'a stale event cannot undo a newer cancellation');
    await stripe.deliver(app.base, stripe.event('invoice.paid', inv, { created: t0 + 10 }));                           // a different event id carrying an OLD paid invoice
    assert.equal(await plan(), 'basic', 'an old payment event cannot resurrect a cancelled subscription');
    const sub2 = stripe.subscription({ checkoutId: crypto.randomUUID(), workspaceId: ws, unitAmount: 1699, interval: 'month', quantity: 1 });
    await stripe.deliver(app.base, stripe.event('invoice.paid', stripe.invoice({ sub: sub2, amountPaid: 1699 })));
    assert.equal((await sql(`SELECT count(*)::int n FROM portal.subscriptions WHERE workspace_id=$1`, [ws])).rows[0].n, 1, 'an event with no matching server-side checkout creates nothing');
    assert.equal(await plan(), 'basic');
  });

  test('cancellation keeps the plan until the paid period ends; resume undoes it; only billing roles may act; every transition is audited', async () => {
    const { sub } = await activate(); const memberU = await main.mint(); await addMember(db.pool, ws, memberU.sub, 'member'); const billingU = await main.mint(); await addMember(db.pool, ws, billingU.sub, 'billing');
    const cm = app.client(memberU, { workspace: ws }), cb = app.client(billingU, { workspace: ws });
    for (const p of ['/api/v1/subscriptions/cancel', '/api/v1/subscriptions/resume', '/api/v1/subscriptions/checkout']) assert.equal((await cm.post(p, { plan: 'pro', interval: 'month' })).status, 403, 'plain member: ' + p);
    assert.equal((await c.post('/api/v1/subscriptions/resume', {})).status, 409, 'nothing to resume yet');
    const cancelled = await cb.post('/api/v1/subscriptions/cancel', {}); assert.equal(cancelled.status, 202); assert.equal(cancelled.body.cancel_at_period_end, true);
    assert.equal(await plan(), 'pro', 'still entitled until the period ends'); assert.equal((await sbacs.check({ workspaceId: ws, featureKey: 'meet.recording' })).allowed, true);
    assert.equal((await c.get('/api/v1/subscriptions/current')).body.subscription.cancelAtPeriodEnd, true);
    const resumed = await cb.post('/api/v1/subscriptions/resume', {}); assert.equal(resumed.status, 202); assert.equal(resumed.body.cancel_at_period_end, false);
    assert.equal((await c.get('/api/v1/subscriptions/current')).body.subscription.cancelAtPeriodEnd, false);
    await cb.post('/api/v1/subscriptions/cancel', {});
    await stripe.deliver(app.base, stripe.event('customer.subscription.deleted', { ...stripe.st.subs.get(sub.id), status: 'canceled' }, { created: Math.floor(Date.now() / 1000) + 5 }));
    assert.equal(await plan(), 'basic', 'after the period ends it falls back to Free');
    const log = await events(ws); assert.ok(log.length >= 4, 'insert + cancel + resume + cancel + end'); assert.equal(log.some((e) => e.detail.to.cancel_at_period_end === true), true); assert.equal(log.at(-1).detail.to.status, 'canceled');
  });

  test('a downgrade preserves existing documents; billing_events and the event log are immutable', async () => {
    const { sub, t0 } = await activate(); const d = (await c.post('/api/v1/documents', { kind: 'doc', title: 'Keep me' })).body;
    await stripe.deliver(app.base, stripe.event('customer.subscription.deleted', { ...sub, status: 'canceled' }, { created: t0 + 60 })); assert.equal(await plan(), 'basic');
    assert.equal((await c.get(`/api/v1/documents/${d.id}`)).status, 200); assert.equal((await c.get(`/api/v1/documents/${d.id}/versions`)).status, 200, 'basic history survives the downgrade');
    await assert.rejects(sql(`UPDATE portal.billing_events SET payload='{}'::jsonb`), /append-only/); await assert.rejects(sql(`UPDATE portal.billing_events SET type='x'`), /append-only/);
    await assert.rejects(sql(`DELETE FROM portal.billing_events`), /append-only/); await assert.rejects(sql(`TRUNCATE portal.billing_events`), /append-only/);
    await sql(`UPDATE portal.billing_events SET outcome='checked'`);                                                  // processing results may still be recorded
    await assert.rejects(sql(`DELETE FROM portal.entitlement_events WHERE workspace_id=$1`, [ws]), /append-only/);
  });

  test('a suspended workspace cannot regain access through payment, an override or a cached entitlement', async () => {
    const admin = crypto.randomUUID(); const row = await checkout(); const { inv } = paid(row);        // a checkout was started before the suspension
    await sbacs.setSuspended({ workspaceId: ws, suspended: true, reason: 'fraud review', actorId: admin });
    assert.equal((await c.post('/api/v1/subscriptions/checkout', { plan: 'pro', interval: 'month' })).status, 403, 'a suspended workspace cannot even start a checkout');
    assert.equal((await stripe.deliver(app.base, stripe.event('invoice.paid', inv))).status, 200, 'the payment event is recorded');
    assert.equal((await sql(`SELECT plan_slug FROM portal.subscriptions WHERE workspace_id=$1`, [ws])).rows[0].plan_slug, 'pro');
    await sbacs.setOverride({ workspaceId: ws, feature: 'meet.recording', enabled: true, reason: 'pilot', actorId: admin });
    assert.equal((await sbacs.check({ workspaceId: ws, featureKey: 'meet.recording' })).reason, 'account_suspended');
    assert.equal((await c.get('/api/v1/notes')).status, 403); assert.equal((await c.post('/api/v1/documents', { kind: 'doc', title: 'x' })).status, 403);
    const cur = (await c.get('/api/v1/subscriptions/current')).body; assert.equal(cur.suspended, true);
    assert.equal((await c.get('/api/v1/subscriptions/entitlements')).body.features['meet.recording'].state, 'suspended');
    await sbacs.setSuspended({ workspaceId: ws, suspended: false, actorId: admin }); assert.equal((await sbacs.check({ workspaceId: ws, featureKey: 'meet.recording' })).allowed, true, 'lifting the suspension is the only way back');
  });

  test('paid plans never touch AI consent, Private AI or telephony: hard-disabled features stay disabled on every plan and show no upgrade path', async () => {
    await activate(); const e = (await c.get('/api/v1/subscriptions/entitlements')).body;
    assert.equal(e.plan, 'pro'); for (const k of ['phone.pstn']) { assert.deepEqual([e.features[k].enabled, e.features[k].state, e.features[k].upgrade], [false, 'unavailable', false]); }
    assert.equal(e.features['org.admin'].state, 'restricted'); assert.equal(e.features['org.admin'].upgrade, true); assert.equal(e.features['meet.recording'].state, 'enabled');
    assert.equal((await sbacs.check({ workspaceId: ws, featureKey: 'ai.private.external' })).allowed, false);
    assert.equal((await sql(`SELECT count(*)::int n FROM portal.entitlements WHERE feature IN ('phone.pstn','ai.private.external') AND enabled`)).rows[0].n, 0);
  });

  test('provisional quotas are shown but not enforced until approved; migration 014 rolls back without losing events', async () => {
    const free = await main.mint(); const w = await seedWorkspace(db.pool, free.sub); const cf = app.client(free);
    assert.equal((await sbacs.reserve({ workspaceId: w, featureKey: 'docs.create', units: 30, idempotencyKey: 'prov-0001' })).ok, true, 'Free is not capped at the illustrative 25/month until Qorlla approves the number');
    const f = (await cf.get('/api/v1/subscriptions/entitlements')).body.features['docs.create']; assert.deepEqual([f.quota, f.provisionalQuota, f.unlimited], [null, 25, false]);
    const g = (n) => fs.readFileSync(path.join(here, '..', 'sql', ...n.split('/')), 'utf8'); const d = await freshDatabase(); const p = d.pool;
    try {
      const wsx = (await p.query(`INSERT INTO portal.workspaces(name) VALUES('H') RETURNING id`)).rows[0].id; await p.query(`INSERT INTO portal.subscriptions(workspace_id,plan_slug,status,current_period_end) VALUES($1,'pro','active',now()+interval '1 day')`, [wsx]);
      await p.query(`UPDATE portal.subscriptions SET cancel_at_period_end=true WHERE workspace_id=$1`, [wsx]);
      const before = (await p.query(`SELECT count(*)::int n FROM portal.entitlement_events WHERE workspace_id=$1`, [wsx])).rows[0].n; assert.ok(before >= 2);
      await p.query(g('rollback/014_sbacs_billing.down.sql')); await p.query(`UPDATE portal.subscriptions SET cancel_at_period_end=false WHERE workspace_id=$1`, [wsx]);
      assert.equal((await p.query(`SELECT count(*)::int n FROM portal.entitlement_events WHERE workspace_id=$1`, [wsx])).rows[0].n, before, 'history kept; the audit trigger is gone');
      assert.equal((await p.query(`SELECT count(*)::int n FROM portal.platform_flags WHERE key='billing_live'`)).rows[0].n, 0);
      await p.query(g('014_sbacs_billing.sql')); await p.query(g('014_sbacs_billing.sql'));
      assert.equal((await p.query(`SELECT enabled FROM portal.platform_flags WHERE key='billing_live'`)).rows[0].enabled, false, 're-applied: live billing starts OFF again');
      await p.query(g('rollback/014_sbacs_billing.down.sql')); await p.query(g('rollback/013_sbacs_enforcement.down.sql')); await p.query(g('rollback/012_sbacs.down.sql'));
      assert.equal((await p.query(`SELECT count(*)::int n FROM portal.entitlements WHERE feature='phone.pstn' OR NOT (plan_slug IS NOT NULL)`)).rows[0].n, 0, 'no "not granted" rows survive as grants');
    } finally { await d.drop(); }
    assert.ok(w);
  });
});
