import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, addMember } from './helpers.mjs';
import { startFakeStripe, WEBHOOK_SECRET } from './fake-stripe.mjs';
import { startFakeLlm } from './fake-llm.mjs';
import { createOverage } from '../server/billing/overage.mjs';

// Provider = tests/fake-stripe.mjs and model = tests/fake-llm.mjs (TEST DOUBLES). These tests prove OUR plan-change, refund, usage-billing,
// admin and kill-switch logic. They do NOT prove that the real Stripe account accepts these calls (live verification is BLOCKED).
const key = () => 'idem-' + crypto.randomBytes(6).toString('hex');
const METRICS = 'm'.repeat(32);
const sql = (db, s, a = []) => db.pool.query(s, a).then((r) => r.rows);

describe('billing launch: plan changes, refunds, usage billing, admin console', () => {
  let db, main, stripe, llmd, app, P, c, owner, ws;
  const admin = () => app.client(P);
  const mk = async (role = 'owner') => { const u = await main.mint(); const w = await seedWorkspace(db.pool, u.sub, 'Co ' + crypto.randomBytes(3).toString('hex')); return { u, w, cl: app.client(u) }; };
  const deliver = async (ev) => { const r = await stripe.deliver(app.base, ev); const o = (await sql(db, 'SELECT outcome FROM portal.billing_events WHERE event_id=$1', [ev.id]))[0]; return { ...r, body: { ...r.body, outcome: o?.outcome } }; };

  /** checkout -> provider-side subscription + paid invoice -> signed webhook: a workspace that really is on a paid plan. */
  async function subscribe(who, plan = 'pro', interval = 'month', seats = 1) {
    const r = await who.cl.post('/api/v1/billing/checkout', { plan, interval, seats }); assert.equal(r.status, 201, JSON.stringify(r.body));
    const row = (await sql(db, 'SELECT * FROM portal.checkout_sessions WHERE id=$1', [r.body.checkout_id]))[0];
    const sub = stripe.subscription({ checkoutId: row.id, workspaceId: row.workspace_id, unitAmount: row.unit_amount_cents, interval, quantity: seats });
    const inv = stripe.invoice({ sub, amountPaid: row.unit_amount_cents * seats });
    const d = await deliver(stripe.event('invoice.paid', inv)); assert.equal(d.status, 200, JSON.stringify(d.body)); assert.equal(d.body.outcome, 'activated');
    return { sub, inv };
  }
  const planOf = async (w) => (await sql(db, 'SELECT plan_slug FROM portal.workspace_effective_plan WHERE workspace_id=$1', [w]))[0].plan_slug;
  const changeBody = (plan, interval = 'month', seats = 1, extra = {}) => ({ plan, interval, seats, ...extra });

  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn(); stripe = await startFakeStripe(); llmd = await startFakeLlm();
    P = await main.mint();
    const env = { BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_API_BASE: stripe.url, AI_LLM_API_KEY: 'test-llm-key', AI_LLM_API_BASE: llmd.url, AI_LLM_MODEL: 'claude-test',
      PLATFORM_ADMIN_USER_IDS: P.sub, METRICS_TOKEN: METRICS };
    app = await startApp({ pool: db.pool, cfg: testConfig({ env }, main), jwks: main.jwks });
  });
  after(async () => { await app.close(); await stripe.close(); await llmd.close(); await main.close(); await db.drop(); });
  beforeEach(async () => {
    await fetch(stripe.url + '/__control/reset', { method: 'POST' }); stripe.st.holdStatus = null; stripe.st.requests.length = 0;
    await fetch(llmd.url + '/__control/reset', { method: 'POST' });
    for (const k of ['checkout', 'plan_changes', 'ai', 'overage_billing']) await app.flags.set(k, true, null, P.sub);
    owner = await mk(); c = owner.cl; ws = owner.w;
  });

  describe('plan changes', () => {
    test('preview classifies the change: upgrade/seat increase now (with an estimate), downgrade/interval change at period end; nonsense is refused', async () => {
      await subscribe(owner, 'pro', 'month', 1);
      const up = (await c.post('/api/v1/billing/change-plan/preview', changeBody('business'))).body; assert.deepEqual([up.kind, up.immediate], ['upgrade', true]); assert.equal(up.to.unit_amount_cents, 2199); assert.ok(up.proration_estimate_cents > 0 && up.proration_estimate_cents <= 500); assert.match(up.notes.join(' '), /ESTIMATE/);
      const seats = (await c.post('/api/v1/billing/change-plan/preview', changeBody('pro', 'month', 5))).body; assert.deepEqual([seats.kind, seats.immediate], ['seats', true]);
      const yr = (await c.post('/api/v1/billing/change-plan/preview', changeBody('pro', 'year', 1))).body; assert.deepEqual([yr.kind, yr.immediate], ['interval', false]); assert.ok(yr.effective_at);
      assert.equal((await c.post('/api/v1/billing/change-plan/preview', changeBody('pro', 'month', 1))).body.code, 'no_change');
      assert.equal((await c.post('/api/v1/billing/change-plan/preview', { plan: 'enterprise', interval: 'month', seats: 1 })).status, 400);
      assert.equal((await c.post('/api/v1/billing/change-plan/preview', changeBody('pro', 'month', 0))).status, 400);
      const free = await mk(); const r = await free.cl.post('/api/v1/billing/change-plan/preview', changeBody('pro')); assert.equal(r.status, 409); assert.equal(r.body.code, 'no_subscription');
    });
    test('upgrade: the provider is asked (price from the database, never from the client), and the plan changes only after the provider is re-read', async () => {
      await subscribe(owner, 'pro', 'month', 1); assert.equal(await planOf(ws), 'pro');
      const r = await c.post('/api/v1/billing/change-plan', { ...changeBody('business', 'month', 2), unit_amount: 1, amount: 1, price: 1 }); assert.equal(r.status, 202, JSON.stringify(r.body)); assert.equal(r.body.status, 'applied');
      const sent = stripe.st.changes.at(-1); assert.equal(sent['items[0][price_data][unit_amount]'], '2199'); assert.equal(sent['items[0][quantity]'], '2'); assert.equal(sent.proration_behavior, 'always_invoice'); assert.equal(sent['items[0][price_data][recurring][interval]'], 'month');
      assert.equal(await planOf(ws), 'business'); const s = (await sql(db, 'SELECT plan_slug, seats, billing_interval FROM portal.subscriptions WHERE workspace_id=$1', [ws]))[0]; assert.deepEqual(s, { plan_slug: 'business', seats: 2, billing_interval: 'month' });
      assert.equal((await sql(db, `SELECT status FROM portal.plan_changes WHERE workspace_id=$1`, [ws]))[0].status, 'applied');
      assert.equal((await c.get('/api/v1/billing/pending-change')).body.change, null);
    });
    test('a provider that rejects the change leaves the plan untouched, records the failure, and allows a retry', async () => {
      await subscribe(owner, 'pro', 'month', 1); await fetch(stripe.url + '/__control/set', { method: 'POST', body: JSON.stringify({ failChange: true }) });
      const r = await c.post('/api/v1/billing/change-plan', changeBody('business')); assert.equal(r.status, 502); assert.equal(r.body.code, 'provider_error'); assert.equal(await planOf(ws), 'pro');
      assert.equal((await sql(db, `SELECT status, error_code FROM portal.plan_changes WHERE workspace_id=$1`, [ws]))[0].status, 'failed');
      await fetch(stripe.url + '/__control/set', { method: 'POST', body: JSON.stringify({ failChange: false }) }); assert.equal((await c.post('/api/v1/billing/change-plan', changeBody('business'))).body.status, 'applied');
    });
    test('if the provider has not confirmed payment the change stays pending; the matching provider event applies it; a mismatching event does not', async () => {
      const { sub } = await subscribe(owner, 'pro', 'month', 1); stripe.st.holdStatus = 'past_due';
      const r = await c.post('/api/v1/billing/change-plan', changeBody('business')); assert.equal(r.status, 202); assert.equal(r.body.status, 'pending_confirmation'); assert.equal(await planOf(ws), 'pro');
      assert.equal((await c.get('/api/v1/billing/pending-change')).body.change.status, 'requested');
      assert.equal((await c.post('/api/v1/billing/change-plan', changeBody('pro', 'month', 3))).body.code, 'change_pending', 'one change at a time');
      const wrong = JSON.parse(JSON.stringify(sub)); wrong.status = 'active'; wrong.items.data[0].price.unit_amount = 999; wrong.items.data[0].quantity = 1;      // not what was agreed
      assert.equal((await deliver(stripe.event('customer.subscription.updated', wrong))).body.outcome, 'updated'); assert.equal(await planOf(ws), 'pro', 'a different price never applies the business plan');
      const good = JSON.parse(JSON.stringify(sub)); good.status = 'active'; good.items.data[0].price.unit_amount = 2199; good.items.data[0].quantity = 1;
      const ok = await deliver(stripe.event('customer.subscription.updated', good, { created: Math.floor(Date.now() / 1000) + 5 })); assert.equal(ok.body.outcome, 'plan_change_applied'); assert.equal(await planOf(ws), 'business');
      assert.equal((await sql(db, `SELECT status FROM portal.plan_changes WHERE workspace_id=$1`, [ws]))[0].status, 'applied');
    });
    test('downgrade is scheduled for the period end, can be cancelled, and is sent to the provider (no proration) shortly before renewal', async () => {
      await subscribe(owner, 'business', 'month', 1);
      const r = await c.post('/api/v1/billing/change-plan', changeBody('pro')); assert.equal(r.status, 202); assert.equal(r.body.status, 'scheduled'); assert.equal(stripe.st.changes.length, 0, 'nothing sent to the provider yet'); assert.equal(await planOf(ws), 'business');
      assert.equal((await app.launch.applyScheduledChanges()), 0, 'not due yet');
      assert.equal((await c.del(`/api/v1/billing/change-plan/${r.body.change_id}`)).status, 200); assert.equal((await c.get('/api/v1/billing/pending-change')).body.change, null);
      const again = await c.post('/api/v1/billing/change-plan', changeBody('pro')); assert.equal(again.body.status, 'scheduled');
      await sql(db, `UPDATE portal.plan_changes SET effective_at = now() + interval '10 minutes' WHERE id=$1`, [again.body.change_id]);
      assert.equal(await app.launch.applyScheduledChanges(), 1); const sent = stripe.st.changes.at(-1); assert.equal(sent.proration_behavior, 'none'); assert.equal(sent['items[0][price_data][unit_amount]'], '1699');
      assert.equal(await planOf(ws), 'pro'); assert.equal((await sql(db, `SELECT status FROM portal.plan_changes WHERE id=$1`, [again.body.change_id]))[0].status, 'applied');
      assert.equal(await app.launch.applyScheduledChanges(), 0, 'applied once');
    });
    test('a scheduled change survives a provider outage (retried) and is dropped if the subscription is gone', async () => {
      await subscribe(owner, 'business', 'month', 1); const r = await c.post('/api/v1/billing/change-plan', changeBody('pro'));
      await sql(db, `UPDATE portal.plan_changes SET effective_at = now() WHERE id=$1`, [r.body.change_id]); await fetch(stripe.url + '/__control/set', { method: 'POST', body: JSON.stringify({ down: true }) });
      await app.launch.applyScheduledChanges(); assert.equal((await sql(db, `SELECT status FROM portal.plan_changes WHERE id=$1`, [r.body.change_id]))[0].status, 'scheduled'); assert.equal(await planOf(ws), 'business');
      await fetch(stripe.url + '/__control/set', { method: 'POST', body: JSON.stringify({ down: false }) }); assert.equal(await app.launch.applyScheduledChanges(), 1); assert.equal(await planOf(ws), 'pro');
    });
    test('guards: not while payment is failing or cancellation is pending; the target plan must fit the current members; roles and workspaces are respected', async () => {
      const { sub } = await subscribe(owner, 'business', 'month', 1);
      for (let i = 0; i < 26; i++) await addMember(db.pool, ws, (await main.mint()).sub, 'member');
      const tooMany = await c.post('/api/v1/billing/change-plan', changeBody('pro')); assert.equal(tooMany.status, 409); assert.equal(tooMany.body.code, 'too_many_members'); assert.equal(tooMany.body.limit, 25);
      const plain = await main.mint(); await addMember(db.pool, ws, plain.sub, 'member'); assert.equal((await app.client(plain).post('/api/v1/billing/change-plan', changeBody('pro'))).status, 403);
      await sql(db, `UPDATE portal.subscriptions SET status='past_due' WHERE workspace_id=$1`, [ws]); assert.equal((await c.post('/api/v1/billing/change-plan', changeBody('business', 'month', 2))).body.code, 'payment_required');
      await sql(db, `UPDATE portal.subscriptions SET status='active', cancel_at_period_end=true WHERE workspace_id=$1`, [ws]); assert.equal((await c.post('/api/v1/billing/change-plan', changeBody('business', 'month', 2))).body.code, 'cancellation_pending');
      await sql(db, `UPDATE portal.subscriptions SET cancel_at_period_end=false WHERE workspace_id=$1`, [ws]);
      const other = await mk(); await subscribe(other, 'pro', 'month', 1); const r = await other.cl.post('/api/v1/billing/change-plan', changeBody('pro', 'month', 4)); const stranger = await mk();
      assert.equal((await stranger.cl.del(`/api/v1/billing/change-plan/${r.body.change_id}`)).status, 409, 'cannot touch another workspace\'s change'); void sub;
    });
    test('idempotent requests and the platform kill switch', async () => {
      await subscribe(owner, 'pro', 'month', 1); const k = key();
      const a = await c.post('/api/v1/billing/change-plan', changeBody('pro', 'month', 3, { idempotency_key: k })); const b = await c.post('/api/v1/billing/change-plan', changeBody('pro', 'month', 3, { idempotency_key: k }));
      assert.equal(a.status, 202); assert.equal(b.status, 200); assert.equal(b.body.change_id, a.body.change_id); assert.equal(stripe.st.changes.length, 1);
      await app.flags.set('plan_changes', false, 'incident', P.sub); const off = await c.post('/api/v1/billing/change-plan', changeBody('pro', 'month', 4)); assert.equal(off.status, 503); assert.equal(off.body.code, 'feature_disabled');
      await app.flags.set('checkout', false, 'incident', P.sub); const fresh = await mk(); const co = await fresh.cl.post('/api/v1/billing/checkout', { plan: 'pro', interval: 'month', seats: 1 }); assert.equal(co.status, 503); assert.equal(co.body.code, 'feature_disabled');
    });
  });

  describe('refunds (platform admin)', () => {
    test('the console is invisible to everyone but platform admins', async () => {
      assert.equal((await admin().get('/api/v1/admin/me')).body.platform_admin, true);
      assert.equal((await c.get('/api/v1/admin/me')).status, 404, 'a workspace owner is not a platform admin');
      assert.equal((await app.client(null).get('/api/v1/admin/me')).status, 401);
      for (const p of ['/billing/overview', '/billing/subscriptions', '/billing/invoices', '/billing/events', '/billing/refunds', '/billing/usage-prices', '/flags', '/sales-inquiries', '/health']) assert.equal((await c.get('/api/v1/admin' + p)).status, 404, p);
      assert.equal((await c.post('/api/v1/admin/billing/refunds', { invoice_id: crypto.randomUUID(), reason: 'x y z', idempotency_key: key() })).status, 404);
    });
    test('partial then full refund: the provider is called once per request, invoice totals follow, the webhook replay does not double count', async () => {
      const { inv } = await subscribe(owner, 'pro', 'month', 2); const row = (await sql(db, `SELECT id, amount_paid_cents, provider_payment_intent FROM portal.invoices WHERE provider_invoice_id=$1`, [inv.id]))[0]; assert.ok(row.provider_payment_intent);
      assert.equal(row.amount_paid_cents, 3398);
      const k1 = key(); const r1 = await admin().post('/api/v1/admin/billing/refunds', { invoice_id: row.id, amount_cents: 1000, reason: 'goodwill credit', idempotency_key: k1 }); assert.equal(r1.status, 201, JSON.stringify(r1.body));
      assert.equal(stripe.st.refunds.length, 1); assert.equal(stripe.st.refunds[0].amount, 1000);
      const dup = await admin().post('/api/v1/admin/billing/refunds', { invoice_id: row.id, amount_cents: 1000, reason: 'goodwill credit', idempotency_key: k1 }); assert.equal(dup.status, 200); assert.equal(dup.body.duplicate, true); assert.equal(stripe.st.refunds.length, 1);
      let i = (await sql(db, `SELECT amount_refunded_cents, status FROM portal.invoices WHERE id=$1`, [row.id]))[0]; assert.deepEqual(i, { amount_refunded_cents: 1000, status: 'partially_refunded' });
      const over = await admin().post('/api/v1/admin/billing/refunds', { invoice_id: row.id, amount_cents: 5000, reason: 'too much', idempotency_key: key() }); assert.equal(over.status, 400); assert.equal(over.body.refundable, 2398);
      // the provider also tells us (charge.refunded) about the same refund: nothing changes
      const ch = { id: 'ch_x', invoice: inv.id, amount_refunded: 1000, refunds: { data: [{ id: r1.body.provider_refund_id, amount: 1000, currency: 'usd' }] } };
      await deliver(stripe.event('charge.refunded', ch)); i = (await sql(db, `SELECT amount_refunded_cents FROM portal.invoices WHERE id=$1`, [row.id]))[0]; assert.equal(i.amount_refunded_cents, 1000);
      assert.equal((await sql(db, `SELECT count(*)::int n FROM portal.refunds WHERE provider_refund_id=$1`, [r1.body.provider_refund_id]))[0].n, 1);
      const r2 = await admin().post('/api/v1/admin/billing/refunds', { invoice_id: row.id, reason: 'refund the rest', idempotency_key: key() }); assert.equal(r2.body.amount_cents, 2398);
      assert.deepEqual((await sql(db, `SELECT amount_refunded_cents, status FROM portal.invoices WHERE id=$1`, [row.id]))[0], { amount_refunded_cents: 3398, status: 'refunded' });
      assert.equal((await sql(db, `SELECT count(*)::int n FROM portal.platform_audit WHERE action='billing.refund'`))[0].n >= 2, true);
      assert.equal(await planOf(ws), 'pro', 'a refund never silently removes access');
    });
    test('provider failure leaves the invoice untouched and the request marked failed; unknown invoices and unrefundable invoices are refused', async () => {
      const { inv } = await subscribe(owner, 'pro', 'month', 1); const row = (await sql(db, `SELECT id FROM portal.invoices WHERE provider_invoice_id=$1`, [inv.id]))[0];
      await fetch(stripe.url + '/__control/set', { method: 'POST', body: JSON.stringify({ failRefund: true }) });
      const f = await admin().post('/api/v1/admin/billing/refunds', { invoice_id: row.id, amount_cents: 500, reason: 'will fail', idempotency_key: key() }); assert.equal(f.status, 502);
      assert.deepEqual((await sql(db, `SELECT amount_refunded_cents, status FROM portal.invoices WHERE id=$1`, [row.id]))[0], { amount_refunded_cents: 0, status: 'paid' }); assert.equal((await sql(db, `SELECT status FROM portal.refund_requests ORDER BY created_at DESC LIMIT 1`))[0].status, 'failed');
      assert.equal((await admin().post('/api/v1/admin/billing/refunds', { invoice_id: crypto.randomUUID(), reason: 'no such', idempotency_key: key() })).status, 404);
      await sql(db, `UPDATE portal.invoices SET provider_payment_intent=NULL WHERE id=$1`, [row.id]); assert.equal((await admin().post('/api/v1/admin/billing/refunds', { invoice_id: row.id, reason: 'no payment', idempotency_key: key() })).body.code, 'no_payment_to_refund');
      assert.equal((await admin().post('/api/v1/admin/billing/refunds', { invoice_id: row.id, reason: 'x', idempotency_key: key() })).status, 400);
    });
  });

  describe('usage-based AI billing', () => {
    let overage;
    beforeEach(async () => { overage = createOverage({ flags: app.flags }); await sql(db, `DELETE FROM portal.usage_prices`); });
    const lowerQuota = (feature, q) => sql(db, `UPDATE portal.entitlements SET quota=$2 WHERE plan_slug='pro' AND feature=$1`, [feature, q]);
    const restoreQuota = (feature, q) => sql(db, `UPDATE portal.entitlements SET quota=$2 WHERE plan_slug='pro' AND feature=$1`, [feature, q]);
    const chat = async (cl, text) => { const t = (await cl.post('/api/v1/assistant/threads', {})).body.id; return cl.post(`/api/v1/assistant/threads/${t}/messages`, { content: text, idempotency_key: key() }); };

    test('overage is opt-in and gated: paid plan, accepted terms, a published price - otherwise the hard plan limit stays', async () => {
      const basic = await mk(); assert.equal((await basic.cl.put('/api/v1/billing/overage', { enabled: true, accept_terms: true })).body.code, 'paid_plan_required');
      await subscribe(owner, 'pro', 'month', 1);
      assert.equal((await c.put('/api/v1/billing/overage', { enabled: true, accept_terms: true })).body.code, 'no_usage_prices');
      assert.equal((await admin().put('/api/v1/admin/billing/usage-prices/assistant_message', { unit_amount_cents: 5, active: true })).status, 200);
      assert.equal((await c.put('/api/v1/billing/overage', { enabled: true })).body.code, 'terms_required');
      assert.equal((await c.put('/api/v1/billing/overage', { enabled: true, accept_terms: true })).status, 200);
      const u = (await c.get('/api/v1/billing/usage')).body; assert.equal(u.overage_enabled, true); assert.equal(u.overage_possible, true); assert.equal(u.features.find((f) => f.feature === 'assistant_message').unit_amount_cents, 5);
      assert.equal((await c.put('/api/v1/billing/overage', { enabled: false })).status, 200); assert.equal((await c.get('/api/v1/billing/usage')).body.overage_enabled, false);
      assert.equal((await c.get('/api/v1/billing/usage')).status, 200); const m = await main.mint(); await addMember(db.pool, ws, m.sub, 'member'); assert.equal((await app.client(m).get('/api/v1/billing/usage')).status, 403);
      assert.equal((await c.put('/api/v1/admin/billing/usage-prices/assistant_message', { unit_amount_cents: 5, active: true })).status, 404, 'only platform admins set prices');
      assert.equal((await admin().put('/api/v1/admin/billing/usage-prices/telephony', { unit_amount_cents: 5, active: true })).status, 400);
    });
    test('beyond the quota: blocked without overage; with it, usage continues and every extra unit is recorded with the price in force at the time', async () => {
      await subscribe(owner, 'pro', 'month', 1); await lowerQuota('ai.assistant_messages_per_month', 2);
      try {
        assert.equal((await chat(c, 'one')).status, 201); assert.equal((await chat(c, 'two')).status, 201);
        const blocked = await chat(c, 'three'); assert.equal(blocked.status, 402); assert.equal(blocked.body.code, 'plan_limit'); assert.equal(blocked.body.overage_available, false);
        await admin().put('/api/v1/admin/billing/usage-prices/assistant_message', { unit_amount_cents: 5, active: true }); await c.put('/api/v1/billing/overage', { enabled: true, accept_terms: true });
        const third = await chat(c, 'three'); assert.equal(third.status, 201, JSON.stringify(third.body));
        await admin().put('/api/v1/admin/billing/usage-prices/assistant_message', { unit_amount_cents: 9, active: true }); assert.equal((await chat(c, 'four')).status, 201);
        const ev = await sql(db, `SELECT units, unit_amount_cents FROM portal.usage_overage_events WHERE workspace_id=$1 ORDER BY created_at`, [ws]); assert.deepEqual(ev.map((e) => e.unit_amount_cents), [5, 9], 'a later price change never rewrites earlier events');
        const u = (await c.get('/api/v1/billing/usage')).body.features.find((f) => f.feature === 'assistant_message'); assert.deepEqual([u.used, u.quota, u.overage_units, u.overage_cents], [4, 2, 2, 14]);
        // a failed model call is neither used nor billed
        await fetch(llmd.url + '/__control/set', { method: 'POST', body: JSON.stringify({ mode: 'overloaded' }) }); assert.equal((await chat(c, 'five')).status, 503);
        assert.equal((await sql(db, `SELECT count(*)::int n FROM portal.usage_overage_events WHERE workspace_id=$1`, [ws]))[0].n, 2);
        // the kill switch for overage billing restores the hard limit immediately
        await fetch(llmd.url + '/__control/reset', { method: 'POST' }); await app.flags.set('overage_billing', false, 'pricing review', P.sub); assert.equal((await chat(c, 'six')).status, 402);
      } finally { await restoreQuota('ai.assistant_messages_per_month', 500); }
    });
    test('a basic workspace can never accrue billable usage, and replays of one usage event are billed once', async () => {
      const basic = await mk(); await admin().put('/api/v1/admin/billing/usage-prices/doc_generation', { unit_amount_cents: 20, active: true });
      await sql(db, `INSERT INTO portal.workspace_billing_settings(workspace_id, overage_enabled) VALUES($1, true)`, [basic.w]);                // even if a stray setting exists
      assert.equal(await overage.quote(db.pool, basic.w, 'doc_generation'), null);
      await subscribe(owner, 'pro', 'month', 1); await lowerQuota('ai.doc_generations_per_month', 1);
      try {
        await c.put('/api/v1/billing/overage', { enabled: true, accept_terms: true });
        const client = await db.pool.connect();
        try { await client.query('BEGIN'); const a = await overage.meter(client, ws, 'doc_generation', 'k-1'); const b = await overage.meter(client, ws, 'doc_generation', 'k-2'); const dup = await overage.meter(client, ws, 'doc_generation', 'k-2'); await client.query('COMMIT');
          assert.equal(a.overage, false); assert.equal(b.overage, true); assert.equal(dup.recorded, false); } finally { client.release(); }
        assert.equal((await sql(db, `SELECT count(*)::int n FROM portal.usage_overage_events WHERE workspace_id=$1`, [ws]))[0].n, 1);
      } finally { await restoreQuota('ai.doc_generations_per_month', 200); }
    });
    test('month-end invoicing: one provider invoice item per workspace/feature/month, retried on failure, never duplicated, paused by the kill switch', async () => {
      await subscribe(owner, 'pro', 'month', 1);
      const last = "date_trunc('month', now() - interval '1 month')::date";
      await sql(db, `INSERT INTO portal.usage_overage_events(workspace_id,usage_feature,units,unit_amount_cents,currency,period_month,idempotency_key) VALUES ($1,'assistant_message',1,5,'usd',${last},'a'),($1,'assistant_message',1,5,'usd',${last},'b'),($1,'doc_generation',1,25,'usd',${last},'c'),($1,'doc_generation',1,25,'usd',date_trunc('month', now())::date,'current')`, [ws]);
      await app.flags.set('overage_billing', false, 'review', P.sub); assert.equal(await app.launch.reportOverage(), 0); await app.flags.set('overage_billing', true, null, P.sub);
      await fetch(stripe.url + '/__control/set', { method: 'POST', body: JSON.stringify({ failInvoiceItem: true }) }); assert.equal(await app.launch.reportOverage(), 0); assert.equal((await sql(db, `SELECT count(*)::int n FROM portal.usage_invoice_items`))[0].n, 0);
      await fetch(stripe.url + '/__control/set', { method: 'POST', body: JSON.stringify({ failInvoiceItem: false }) }); assert.equal(await app.launch.reportOverage(), 2);
      const items = stripe.st.invoiceItems; assert.equal(items.length, 2); const am = items.find((i) => i.metadata.usage_feature === 'assistant_message'); assert.equal(am.amount, 10); assert.equal(am.currency, 'usd'); assert.match(am.description, /2 x assistant message/);
      assert.equal(items.find((i) => i.metadata.usage_feature === 'doc_generation').amount, 25); assert.match(am.idem, /^overage-/);
      assert.equal(await app.launch.reportOverage(), 0, 'already invoiced'); assert.equal(stripe.st.invoiceItems.length, 2, 'the current month is not invoiced yet');
      assert.equal((await sql(db, `SELECT count(*)::int n FROM portal.usage_invoice_items WHERE workspace_id=$1`, [ws]))[0].n, 2);
    });
  });

  describe('admin console, workflow and monitoring', () => {
    test('overview, subscription/invoice/event listings and the MRR estimate come from the real tables', async () => {
      const a = await mk(); const b = await mk(); await subscribe(a, 'pro', 'month', 2); await subscribe(b, 'business', 'year', 1);
      const o = (await admin().get('/api/v1/admin/billing/overview')).body; assert.equal(o.billing_available, true);
      assert.ok(o.mrr_estimate_cents >= 1699 * 2 + 1833, String(o.mrr_estimate_cents)); assert.match(o.mrr_note, /estimate/i); assert.ok(o.subscriptions.some((s) => s.plan_slug === 'business' && s.status === 'active'));
      assert.ok(o.last_30_days.paid_cents >= 3398 + 21996); assert.ok(o.events_24h.some((e) => e.outcome === 'activated'));
      const subs = (await admin().get('/api/v1/admin/billing/subscriptions?status=active')).body; assert.ok(subs.some((s) => s.workspace_id === a.w));
      assert.equal((await admin().get('/api/v1/admin/billing/subscriptions?status=nonsense')).status, 400);
      assert.ok((await admin().get(`/api/v1/admin/billing/invoices?workspace_id=${a.w}`)).body.every((i) => i.workspace_id === a.w)); assert.ok((await admin().get('/api/v1/admin/billing/events?outcome=activated')).body.length >= 2);
    });
    test('health raises alerts for stuck events, rejected events, past-due subscriptions, stalled queues and overdue sales leads', async () => {
      assert.equal((await admin().get('/api/v1/admin/health')).body.alerts.filter((a) => a.severity !== 'info').length >= 0, true);
      await sql(db, `INSERT INTO portal.billing_events(provider,event_id,type,provider_created_at,payload,received_at,outcome) VALUES('stripe','evt_stuck_1','invoice.paid',now(),'{}', now() - interval '30 minutes','received')`);
      await sql(db, `INSERT INTO portal.billing_events(provider,event_id,type,provider_created_at,payload,outcome,processed_at) VALUES('stripe','evt_rej_1','invoice.paid',now(),'{}','rejected_price_mismatch',now())`);
      await sql(db, `INSERT INTO portal.sales_inquiries(name,email,message,created_at) VALUES('Old Lead','old@example.test','We need SSO', now() - interval '2 days')`);
      await app.flags.set('ai', false, 'model outage', P.sub);
      const h = (await admin().get('/api/v1/admin/health')).body; const codes = h.alerts.map((a) => a.code); assert.equal(h.status, 'critical');
      for (const k of ['billing_events_stuck', 'billing_events_rejected', 'sales_inquiries_overdue', 'flag_off_ai']) assert.ok(codes.includes(k), k);
      assert.equal(h.alerts.find((a) => a.code === 'billing_events_stuck').severity, 'critical');
      await sql(db, `DELETE FROM portal.billing_events WHERE event_id IN ('evt_stuck_1','evt_rej_1')`);
    });
    test('kill switch for AI: endpoints answer 503 and the queue pauses (jobs stay queued) until switched back on; switching off needs a reason and is audited', async () => {
      await subscribe(owner, 'pro', 'month', 1);
      const t = (await c.post('/api/v1/assistant/threads', {})).body.id;
      assert.equal((await admin().put('/api/v1/admin/flags/ai', { enabled: false })).status, 400, 'a reason is required');
      assert.equal((await c.put('/api/v1/admin/flags/ai', { enabled: false, reason: 'x' })).status, 404);
      assert.equal((await admin().put('/api/v1/admin/flags/ai', { enabled: false, reason: 'provider incident' })).status, 200);
      const off = await c.post(`/api/v1/assistant/threads/${t}/messages`, { content: 'hello', idempotency_key: key() }); assert.equal(off.status, 503); assert.equal(off.body.code, 'feature_disabled');
      assert.equal((await c.post('/api/v1/documents/ai-draft', { kind: 'doc', prompt: 'a brief', idempotency_key: key() })).body.code, 'feature_disabled');
      const vm = (await sql(db, `INSERT INTO portal.voicemails(workspace_id,provider_recording_sid,recording_url,transcript) VALUES($1,'RE'||md5(random()::text),'https://x.test/r','please call back') RETURNING id`, [ws]))[0].id;
      await sql(db, `INSERT INTO portal.phone_ai_jobs(workspace_id,voicemail_id) VALUES($1,$2)`, [ws, vm]);
      assert.equal(await app.ai.phoneWorker.runOne(), false, 'paused'); assert.equal((await sql(db, `SELECT status FROM portal.phone_ai_jobs WHERE voicemail_id=$1`, [vm]))[0].status, 'queued');
      await admin().put('/api/v1/admin/flags/ai', { enabled: true }); assert.equal(await app.ai.phoneWorker.runOne(), true); assert.equal((await sql(db, `SELECT summary_status FROM portal.voicemails WHERE id=$1`, [vm]))[0].summary_status, 'done');
      assert.equal((await c.post(`/api/v1/assistant/threads/${t}/messages`, { content: 'hello', idempotency_key: key() })).status, 201);
      assert.deepEqual((await sql(db, `SELECT action FROM portal.platform_audit WHERE object_id='ai' ORDER BY id`)).map((r) => r.action).slice(-2), ['flag.off', 'flag.on']);
      assert.equal((await admin().put('/api/v1/admin/flags/bogus', { enabled: false, reason: 'x' })).status, 400);
    });
    test('Enterprise sales workflow: public submissions land as new, admins triage through valid transitions with notes; workspace users cannot read leads', async () => {
      const pub = await app.client(null).post('/api/v1/sales-inquiries', { name: 'Ada Buyer', email: 'ada@example.test', company: 'Analytical Co', message: 'We need SSO and 400 seats', plan_interest: 'enterprise' }); assert.ok([200, 201, 202].includes(pub.status), JSON.stringify(pub.body));
      const list = (await admin().get('/api/v1/admin/sales-inquiries?status=new')).body; const lead = list.find((l) => l.email === 'ada@example.test'); assert.ok(lead); assert.equal(lead.overdue, false);
      assert.equal((await c.get('/api/v1/admin/sales-inquiries')).status, 404);
      const bad = await admin().patch(`/api/v1/admin/sales-inquiries/${lead.id}`, { status: 'won' }); assert.equal(bad.status, 409); assert.equal(bad.body.code, 'bad_transition');
      assert.equal((await admin().patch(`/api/v1/admin/sales-inquiries/${lead.id}`, { status: 'contacted', assignee_id: P.sub })).status, 200);
      assert.equal((await admin().post(`/api/v1/admin/sales-inquiries/${lead.id}/notes`, { note: 'Called, wants a demo Thursday' })).status, 201);
      assert.equal((await admin().patch(`/api/v1/admin/sales-inquiries/${lead.id}`, { status: 'qualified' })).status, 200); assert.equal((await admin().patch(`/api/v1/admin/sales-inquiries/${lead.id}`, { status: 'won' })).status, 200);
      const d = (await admin().get(`/api/v1/admin/sales-inquiries/${lead.id}`)).body; assert.equal(d.status, 'won'); assert.equal(d.assignee_id, P.sub); assert.equal(d.notes.length, 1); assert.deepEqual(d.allowed_next, ['closed']);
      assert.equal((await admin().patch(`/api/v1/admin/sales-inquiries/${crypto.randomUUID()}`, { status: 'contacted' })).status, 404); assert.equal((await admin().patch(`/api/v1/admin/sales-inquiries/${lead.id}`, { status: 'weird' })).status, 400);
      assert.ok((await sql(db, `SELECT count(*)::int n FROM portal.platform_audit WHERE action='sales.updated'`))[0].n >= 3);
    });
    test('metrics endpoint: off without a token, 404 for wrong tokens, Prometheus text for the right one; gauges reflect the data', async () => {
      assert.equal((await fetch(app.base + '/internal/metrics')).status, 404); assert.equal((await fetch(app.base + '/internal/metrics', { headers: { authorization: 'Bearer ' + 'x'.repeat(32) } })).status, 404);
      const r = await fetch(app.base + '/internal/metrics', { headers: { authorization: 'Bearer ' + METRICS } }); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/plain/); const t = await r.text();
      for (const g of ['qorlla_subscriptions', 'qorlla_billing_events_unprocessed', 'qorlla_ai_jobs', 'qorlla_flag_enabled{flag="ai"}', 'qorlla_billing_available 1', 'qorlla_telephony_available 0']) assert.ok(t.includes(g), g);
      assert.doesNotMatch(t, /@|sk_test|whsec/);
      const none = await startApp({ pool: db.pool, cfg: testConfig({ env: { METRICS_TOKEN: 'short' } }, main), jwks: main.jwks });
      try { assert.equal((await fetch(none.base + '/internal/metrics', { headers: { authorization: 'Bearer short' } })).status, 404, 'a weak token disables the endpoint'); } finally { await none.close(); }
    });
  });
});
