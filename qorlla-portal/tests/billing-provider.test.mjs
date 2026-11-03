import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, addMember } from './helpers.mjs';
import { startFakeStripe, WEBHOOK_SECRET } from './fake-stripe.mjs';
import { createMockProvider } from './mock-provider.mjs';
import { createStripe, signPayload } from '../server/billing/stripe.mjs';
import { createStripeProvider } from '../server/billing/stripe-provider.mjs';
import { assertBillingProvider, CONTRACT_METHODS, EVENT_TYPES, SUBSCRIPTION_STATUSES, WebhookSignatureError } from '../server/billing/provider.mjs';
import { createSbacs } from '../server/sbacs.mjs';

const SUB_KEYS = ['canceledAt', 'cancelAtPeriodEnd', 'currency', 'currentPeriodEnd', 'currentPeriodStart', 'customerId', 'id', 'interval', 'metadata', 'quantity', 'status', 'unitAmountCents'].sort();
const INV_KEYS = ['amountDueCents', 'amountPaidCents', 'attemptCount', 'chargeId', 'currency', 'hostedUrl', 'id', 'nextPaymentAttempt', 'number', 'paymentIntentId', 'periodEnd', 'periodStart', 'receiptUrl', 'status', 'subscriptionId'].sort();
const CHECKOUT = (o = {}) => ({ checkoutId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), customerId: null, plan: 'pro', interval: 'month', seats: 2, currency: 'usd', unitAmountCents: 1699, successUrl: 'https://app.test/ok', cancelUrl: 'https://app.test/no', ...o });

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// 1. ADAPTER CONTRACT: both providers (Stripe adapter over the Stripe test double, and the differently-shaped mock) must satisfy the identical neutral contract.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
describe('BillingProvider contract (provider-neutral)', () => {
  let stripe, rawStripe, mock;
  before(async () => { stripe = await startFakeStripe(); rawStripe = createStripe({ secretKey: 'sk_test_fake', webhookSecret: WEBHOOK_SECRET, apiBase: stripe.url }); mock = createMockProvider(); });
  after(async () => { await stripe.close(); });

  const adapters = {
    stripe: () => ({ provider: createStripeProvider(rawStripe),
      paid: async (input) => { const sub = stripe.subscription({ checkoutId: input.checkoutId, workspaceId: input.workspaceId, unitAmount: input.unitAmountCents, interval: input.interval, quantity: input.seats }); const inv = stripe.invoice({ sub, amountPaid: input.unitAmountCents * input.seats });
        const body = Buffer.from(JSON.stringify(stripe.event('invoice.paid', inv))); return { subscriptionId: sub.id, customerId: sub.customer, signed: { raw: body, signature: signPayload(body, WEBHOOK_SECRET) }, forged: { raw: body, signature: signPayload(body, 'whsec_other') } }; } }),
    mock: () => ({ provider: mock.provider,
      paid: async (input) => { const { sessionId } = input.__session; const { sub, invoice } = mock.pay(sessionId); const m = mock.wire('payment_succeeded', { invoice }); const f = mock.wire('payment_succeeded', { invoice }, { secretOverride: 'other' });
        return { subscriptionId: sub.id, customerId: sub.customerId, signed: { raw: Buffer.from(m.body), signature: m.signature }, forged: { raw: Buffer.from(f.body), signature: f.signature } }; } })
  };

  for (const [label, make] of Object.entries(adapters)) {
    describe(label, () => {
      test('implements the whole contract', () => {
        const { provider } = make(); assertBillingProvider(provider); for (const m of CONTRACT_METHODS) assert.equal(typeof provider[m], 'function', m);
        assert.throws(() => assertBillingProvider({ name: 'half', signatureHeader: 'x', createCheckoutSession() {} }), /missing/);
      });
      test('checkout -> subscription -> cancel -> resume -> invoices -> portal -> webhook, all in neutral shapes', async () => {
        const { provider, paid } = make(); const input = CHECKOUT();
        const session = await provider.createCheckoutSession(input); assert.deepEqual(Object.keys(session).sort(), ['id', 'url']); assert.match(session.url, /^https:\/\//);
        const p = await paid({ ...input, __session: { sessionId: session.id } });
        const sub = await provider.getSubscription(p.subscriptionId);
        assert.deepEqual(Object.keys(sub).sort(), SUB_KEYS, 'exactly the neutral subscription fields: no provider-specific field leaks'); assert.ok(SUBSCRIPTION_STATUSES.includes(sub.status));
        assert.deepEqual([sub.quantity, sub.unitAmountCents, sub.currency, sub.interval, sub.customerId], [2, 1699, 'usd', 'month', p.customerId]); assert.deepEqual(sub.metadata, { checkoutId: input.checkoutId, workspaceId: input.workspaceId });
        assert.ok(!Number.isNaN(Date.parse(sub.currentPeriodEnd)) && Date.parse(sub.currentPeriodEnd) > Date.parse(sub.currentPeriodStart));
        assert.equal((await provider.cancelSubscription(sub.id)).cancelAtPeriodEnd, true); assert.equal((await provider.resumeSubscription(sub.id)).cancelAtPeriodEnd, false);
        const invs = await provider.listInvoices(p.customerId); assert.ok(invs.length >= 1); for (const i of invs) { assert.deepEqual(Object.keys(i).sort(), INV_KEYS); assert.ok(['open', 'paid', 'void'].includes(i.status)); }
        const portal = await provider.createCustomerPortalSession({ customerId: p.customerId, returnUrl: 'https://app.test/back' }); assert.deepEqual(Object.keys(portal), ['url']); assert.match(portal.url, /^https:\/\//);
        await assert.rejects(provider.createCustomerPortalSession({ customerId: 'cus_unknown_' + label, returnUrl: 'https://app.test/back' }), 'a customer the provider does not know gets no portal');
        await assert.rejects(provider.getSubscription('sub_unknown_' + label));
        const ev = await provider.verifyWebhook(p.signed.raw, p.signed.signature);
        assert.ok(EVENT_TYPES.includes(ev.type)); assert.equal(ev.type, 'invoice.paid'); assert.ok(ev.id && Number.isInteger(ev.createdAt) && ev.raw && ev.invoice); assert.deepEqual(Object.keys(ev.invoice).sort(), INV_KEYS); assert.equal(ev.invoice.subscriptionId, sub.id);
        await assert.rejects(provider.verifyWebhook(p.forged.raw, p.forged.signature), WebhookSignatureError, 'a forged signature is refused with the NEUTRAL error type');
        await assert.rejects(provider.verifyWebhook(p.signed.raw, ''), WebhookSignatureError); await assert.rejects(provider.verifyWebhook(Buffer.from(p.signed.raw.toString() + ' '), p.signed.signature), WebhookSignatureError, 'a re-serialised body does not verify');
      });
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// 2. THE BILLING SERVICE ON THE MOCK PROVIDER: the same lifecycle rules hold with a provider that shares nothing with Stripe's data shapes.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
describe('billing service on a non-Stripe provider', () => {
  let db, main, mock, app, owner, ws, c;
  const env = { BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_unused', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET };
  before(async () => { db = await freshDatabase(); main = await startMainStandIn(); mock = createMockProvider(); app = await startApp({ pool: db.pool, cfg: testConfig({ env }, main), jwks: main.jwks, billingProvider: mock.provider }); });
  after(async () => { await app.close(); await main.close(); await db.drop(); });
  beforeEach(async () => { owner = await main.mint(); ws = await seedWorkspace(db.pool, owner.sub); c = app.client(owner); mock.st.down = false; mock.st.failCheckout = false; await app.flags.set('billing_live', true, 'test', owner.sub); });
  const sql = (q, a) => db.pool.query(q, a);
  async function buy(client = c) { const r = await client.post('/api/v1/subscriptions/checkout', { plan: 'pro', interval: 'month', seats: 2 }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; }
  async function activate(client = c) { const b = await buy(client); const { sub, invoice } = mock.pay(b.session_id); const m = mock.wire('payment_succeeded', { invoice }); const d = await mock.deliver(app.base, m); assert.equal(d.status, 200); return { b, sub, invoice, m }; }
  const plan = async (cl = c) => (await cl.get('/api/v1/workspace')).body.plan;

  test('checkout, verified activation, replay, forged and stale events behave exactly as with Stripe', async () => {
    const b = await buy(); assert.match(b.url, /^https:\/\/pay\.mock\.test\//); assert.equal(await plan(), 'basic', 'a created checkout activates nothing');
    assert.equal((await sql(`SELECT provider FROM portal.checkout_sessions WHERE id=$1`, [b.checkout_id])).rows[0].provider, 'mock');
    const { sub, invoice } = mock.pay(b.session_id); const m = mock.wire('payment_succeeded', { invoice }, { at: 1_800_000_000 });
    assert.equal((await mock.deliver(app.base, mock.wire('payment_succeeded', { invoice }, { secretOverride: 'wrong' }))).status, 400); assert.equal(await plan(), 'basic', 'forged signature');
    assert.equal((await mock.deliver(app.base, { body: m.body, signature: '' })).status, 400);
    assert.equal((await mock.deliver(app.base, m)).status, 200); assert.equal(await plan(), 'pro');
    const s = (await sql(`SELECT provider, provider_subscription_id, provider_customer_id, seats FROM portal.subscriptions WHERE workspace_id=$1`, [ws])).rows[0]; assert.deepEqual([s.provider, s.provider_subscription_id, s.seats], ['mock', sub.id, 2]);
    assert.equal((await sql(`SELECT provider FROM portal.billing_customers WHERE workspace_id=$1`, [ws])).rows[0].provider, 'mock');
    assert.equal((await mock.deliver(app.base, m)).body.duplicate, true, 'replay is recognised'); assert.equal((await sql(`SELECT count(*)::int n FROM portal.billing_events WHERE provider='mock'`)).rows[0].n >= 1, true);
    await mock.deliver(app.base, mock.wire('subscription_ended', { subscription: { ...sub, status: 'canceled' } }, { at: 1_800_000_100 })); assert.equal(await plan(), 'basic');
    await mock.deliver(app.base, mock.wire('subscription_changed', { subscription: { ...sub, status: 'active' } }, { at: 1_800_000_050 })); assert.equal(await plan(), 'basic', 'a stale event cannot undo a newer cancellation');
    assert.equal((await mock.deliver(app.base, mock.wire('checkout_done', { checkout: { id: 'x' } }, {}))).status, 200, 'an unmatched event is recorded and ignored');
    assert.equal((await mock.deliver(app.base, mock.wire('something_new', { x: 1 }))).body.duplicate, false, 'unknown event kinds are ignored, not errors');
  });

  test('an event naming another workspace, or carrying the wrong price, activates nothing', async () => {
    const other = await main.mint(); const wsB = await seedWorkspace(db.pool, other.sub); const cB = app.client(other);
    const a = await buy(c), bb = await buy(cB); const pa = mock.pay(a.session_id);
    const forged = { ...pa.sub, metadata: { checkoutId: a.checkout_id, workspaceId: wsB } }; mock.st.subs.set(forged.id, forged);
    await mock.deliver(app.base, mock.wire('payment_succeeded', { invoice: pa.invoice })); assert.equal(await plan(cB), 'basic', 'B untouched by an event that names B'); assert.equal(await plan(c), 'basic', 'and the mismatched binding did not activate A either');
    const cheap = mock.pay(bb.session_id); cheap.sub.unitAmountCents = 1; mock.st.subs.get(cheap.sub.id).unitAmountCents = 1;
    await mock.deliver(app.base, mock.wire('payment_succeeded', { invoice: cheap.invoice })); assert.equal(await plan(cB), 'basic', 'price mismatch against the stored checkout snapshot is refused');
    assert.ok(wsB);
  });

  test('cancel, resume, payment-method portal and invoice sync work through the neutral contract; provider outages fail closed', async () => {
    const { sub } = await activate();
    assert.equal((await c.post('/api/v1/subscriptions/cancel', {})).body.cancel_at_period_end, true); assert.equal(await plan(), 'pro');
    assert.equal((await c.post('/api/v1/subscriptions/resume', {})).body.cancel_at_period_end, false);
    const pm = await c.post('/api/v1/subscriptions/payment-methods', {}); assert.equal(pm.status, 201); assert.match(pm.body.url, /^https:\/\/portal\.mock\.test\//); assert.deepEqual(Object.keys(pm.body), ['url']);
    assert.deepEqual(mock.st.portal.at(-1), { customerId: sub.customerId, returnUrl: app.cfg?.origin ? `${app.cfg.origin}/app/billing?portal=return` : mock.st.portal.at(-1).returnUrl });
    mock.invoiceFor(sub, 500, 'open'); mock.invoiceFor({ ...sub, id: 'msub-someone-else' }, 999, 'paid');             // one more of ours; one that belongs to a different subscription of the same customer
    assert.equal((await c.post('/api/v1/billing/reconcile', {})).body.reconciled, true);
    const rows = (await sql(`SELECT amount_due_cents, status FROM portal.invoices WHERE workspace_id=$1 ORDER BY amount_due_cents`, [ws])).rows; assert.deepEqual(rows.map((r) => r.amount_due_cents), [500, 3398], 'only this subscription\'s invoices were imported');
    mock.st.down = true;
    for (const [p, b] of [['/api/v1/subscriptions/cancel', {}], ['/api/v1/subscriptions/payment-methods', {}], ['/api/v1/subscriptions/checkout', { plan: 'pro', interval: 'month', seats: 1 }]]) { const r = await c.post(p, b); assert.ok([409, 502].includes(r.status), p + ' ' + r.status); }
    assert.equal(await plan(), 'pro', 'an outage never changes entitlements');
  });

  test('provider extensions are optional: plan changes and refunds answer 501 on a provider without them, and nothing else is affected', async () => {
    await activate();
    const r = await c.post('/api/v1/billing/change-plan', { plan: 'business', interval: 'month', seats: 1 }); assert.equal(r.status, 501); assert.equal(r.body.code, 'provider_unsupported');
    assert.equal((await c.post('/api/v1/billing/change-plan/preview', { plan: 'business', interval: 'month', seats: 1 })).status, 501);
    assert.equal(await plan(), 'pro');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// 3. PAYMENT METHODS: the provider-hosted customer portal (Stripe adapter, against the Stripe test double).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
describe('Manage payment methods (hosted customer portal)', () => {
  let db, main, stripe, app, bare, sbacs, owner, ws, c;
  const env = () => ({ BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_API_BASE: stripe.url });
  before(async () => { db = await freshDatabase(); main = await startMainStandIn(); stripe = await startFakeStripe(); sbacs = createSbacs({ pool: db.pool });
    app = await startApp({ pool: db.pool, cfg: testConfig({ env: env() }, main), jwks: main.jwks }); bare = await startApp({ pool: db.pool, cfg: testConfig({}, main), jwks: main.jwks }); });
  after(async () => { await app.close(); await bare.close(); await stripe.close(); await main.close(); await db.drop(); });
  beforeEach(async () => { owner = await main.mint(); ws = await seedWorkspace(db.pool, owner.sub); c = app.client(owner); stripe.st.requests.length = 0; stripe.st.down = false; stripe.st.portalSessions.length = 0; await app.flags.set('billing_live', true, 'test', owner.sub); });
  const sql = (q, a) => db.pool.query(q, a);
  async function activate(client = c) {
    const r = await client.post('/api/v1/subscriptions/checkout', { plan: 'pro', interval: 'month', seats: 1 }); assert.equal(r.status, 201);
    const row = (await sql('SELECT * FROM portal.checkout_sessions WHERE id=$1', [r.body.checkout_id])).rows[0];
    const sub = stripe.subscription({ checkoutId: row.id, workspaceId: row.workspace_id, unitAmount: row.unit_amount_cents, interval: row.billing_interval, quantity: row.seats }); const inv = stripe.invoice({ sub, amountPaid: row.unit_amount_cents });
    assert.equal((await stripe.deliver(app.base, stripe.event('invoice.paid', inv))).status, 200); return { sub, row };
  }

  test('a billing admin gets a short-lived hosted-portal URL for THIS workspace\'s own customer; only the URL reaches the browser', async () => {
    const { sub } = await activate();
    const r = await c.post('/api/v1/subscriptions/payment-methods', {}); assert.equal(r.status, 201); assert.deepEqual(Object.keys(r.body), ['url']); assert.match(r.body.url, /^https:\/\/billing\.stripe\.test\/session\//);
    const sent = stripe.st.portalSessions.at(-1); assert.equal(sent.customer, sub.customer, 'the workspace\'s own billing customer, resolved server-side (the client never names one)'); assert.equal(sent.return_url, app.cfg?.origin ? `${app.cfg.origin}/app/billing?portal=return` : sent.return_url);
    assert.match(sent.return_url, /\/app\/billing\?portal=return$/);
    const req = stripe.st.requests.find((x) => x.path === '/v1/billing_portal/sessions'); assert.equal(req.auth, 'Bearer sk_test_fake'); assert.ok(!JSON.stringify(r.body).includes('sk_test'), 'the provider secret never reaches the browser');
    assert.equal((await c.post('/api/v1/billing/portal', { customer: 'cus_someone_else', customerId: 'cus_someone_else' })).status, 201, 'the old alias works and ignores any customer the client names'); assert.equal(stripe.st.portalSessions.at(-1).customer, sub.customer);
    assert.equal((await sql(`SELECT count(*)::int n FROM portal.audit_events WHERE workspace_id=$1 AND action='billing.portal_opened'`, [ws])).rows[0].n, 2, 'opening the portal is audited');
  });

  test('permissions: owner, admin and billing contacts may; plain members, outsiders and unauthenticated callers may not', async () => {
    await activate(); const mk = async (role) => { const u = await main.mint(); await addMember(db.pool, ws, u.sub, role); return app.client(u, { workspace: ws }); };
    for (const role of ['admin', 'billing']) assert.equal((await (await mk(role)).post('/api/v1/subscriptions/payment-methods', {})).status, 201, role);
    assert.equal((await (await mk('member')).post('/api/v1/subscriptions/payment-methods', {})).status, 403, 'plain member');
    const outsider = await main.mint(); assert.equal((await app.client(outsider, { workspace: ws }).post('/api/v1/subscriptions/payment-methods', {})).status, 403, 'not a member of the workspace');
    assert.equal((await app.client(null).post('/api/v1/subscriptions/payment-methods', {})).status, 401);
    const before = stripe.st.portalSessions.length; assert.equal((await (await mk('member')).post('/api/v1/subscriptions/payment-methods', {})).status, 403); assert.equal(stripe.st.portalSessions.length, before, 'a refused request never reaches the provider');
  });

  test('workspace isolation: another workspace\'s admin gets only THEIR customer, or nothing if they have none', async () => {
    const a = await activate(); const u2 = await main.mint(); const ws2 = await seedWorkspace(db.pool, u2.sub); const c2 = app.client(u2);
    const none = await c2.post('/api/v1/subscriptions/payment-methods', {}); assert.equal(none.status, 409); assert.equal(none.body.code, 'no_billing_customer'); assert.equal(stripe.st.portalSessions.length, 0);
    const b = await activate(c2); const r = await c2.post('/api/v1/subscriptions/payment-methods', {}); assert.equal(r.status, 201); assert.equal(stripe.st.portalSessions.at(-1).customer, b.sub.customer); assert.notEqual(b.sub.customer, a.sub.customer);
    assert.ok(ws2);
  });

  test('unavailable cleanly: billing off, no provider, provider down, suspended workspace - never a half-working action', async () => {
    await activate();
    await app.flags.set('billing_live', false, 'off', owner.sub); const off = await c.post('/api/v1/subscriptions/payment-methods', {}); assert.equal(off.status, 503); assert.equal(off.body.flag, 'billing_live'); await app.flags.set('billing_live', true, 'on', owner.sub);
    const nob = await bare.client(owner).post('/api/v1/subscriptions/payment-methods', {}); assert.ok([503, 409].includes(nob.status)); assert.equal(stripe.st.portalSessions.length, 0);
    stripe.st.down = true; const down = await c.post('/api/v1/subscriptions/payment-methods', {}); assert.equal(down.status, 502); assert.equal(down.body.code, 'provider_error'); stripe.st.down = false;
    await sbacs.setSuspended({ workspaceId: ws, suspended: true, reason: 'review', actorId: crypto.randomUUID() }); const sus = await c.post('/api/v1/subscriptions/payment-methods', {}); assert.equal(sus.status, 403); assert.equal(sus.body.code, 'account_suspended');
    await sbacs.setSuspended({ workspaceId: ws, suspended: false, actorId: crypto.randomUUID() });
    const cur = (await c.get('/api/v1/subscriptions/current')).body.billing; assert.deepEqual([cur.live, cur.hasBillingCustomer, cur.canManage], [true, true, true]);
    const none = await main.mint(); await seedWorkspace(db.pool, none.sub); assert.equal((await app.client(none).get('/api/v1/subscriptions/current')).body.billing.hasBillingCustomer, false);
  });
});
