import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, addMember, ORIGIN } from './helpers.mjs';
import { startFakeStripe, WEBHOOK_SECRET } from './fake-stripe.mjs';
import { signPayload } from '../server/billing/stripe.mjs';

// Provider = tests/fake-stripe.mjs (a TEST DOUBLE). These tests prove OUR lifecycle logic (signature, idempotency, verification,
// entitlements); they do not prove the real Stripe integration.
describe('subscription lifecycle', () => {
  let db, main, stripe, app, owner, ws, c;
  const env = () => ({ BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_API_BASE: stripe.url });
  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn(); stripe = await startFakeStripe();
    app = await startApp({ pool: db.pool, cfg: testConfig({ env: env() }, main), jwks: main.jwks });
  });
  after(async () => { await app.close(); await stripe.close(); await main.close(); await db.drop(); });
  beforeEach(async () => { owner = await main.mint(); ws = await seedWorkspace(db.pool, owner.sub); c = app.client(owner); stripe.st.requests.length = 0; stripe.st.down = false; stripe.st.failCreate = false; });

  const plan = async () => (await c.get('/api/v1/workspace')).body.plan;
  async function checkout(planSlug = 'pro', interval = 'month', seats = 1) {
    const r = await c.post('/api/v1/billing/checkout', { plan: planSlug, interval, seats }); assert.equal(r.status, 201, JSON.stringify(r.body));
    const row = (await db.pool.query('SELECT * FROM portal.checkout_sessions WHERE id=$1', [r.body.checkout_id])).rows[0];
    return { res: r.body, row };
  }
  /** What really happens at the provider after the customer pays: a subscription exists and an invoice is paid. */
  function paid({ row, amount, qty = row.seats, status = 'active', invoiceAmount }) {
    const sub = stripe.subscription({ checkoutId: row.id, workspaceId: row.workspace_id, unitAmount: amount ?? row.unit_amount_cents, interval: row.billing_interval, quantity: qty, status });
    const inv = stripe.invoice({ sub, amountPaid: invoiceAmount ?? (amount ?? row.unit_amount_cents) * qty });
    return { sub, inv };
  }

  test('catalogue is database-backed with annual as a first-class price, and says whether checkout is available', async () => {
    const r = await app.client(null).get('/api/v1/plans'); assert.equal(r.status, 200);
    const pro = r.body.plans.find((p) => p.slug === 'pro');
    assert.equal(pro.prices.month.amount_cents, 1699); assert.equal(pro.prices.year.amount_cents, 17988); assert.equal(pro.prices.year.per_seat_per_month_cents, 1499);
    assert.equal(r.body.plans.find((p) => p.slug === 'business').prices.year.per_seat_per_month_cents, 1833);
    assert.equal(r.body.plans.find((p) => p.slug === 'enterprise').contact_sales, true);
    assert.deepEqual(r.body.plans.find((p) => p.slug === 'enterprise').prices, {});
    assert.equal(r.body.billing.checkout_available, true);
    await db.pool.query(`UPDATE portal.plan_prices SET amount_cents=1799 WHERE plan_slug='pro' AND billing_interval='month'`);
    assert.equal((await app.client(null).get('/api/v1/plans')).body.plans.find((p) => p.slug === 'pro').prices.month.amount_cents, 1799, 'catalogue follows the database, nothing is cached or hard-coded');
    await db.pool.query(`UPDATE portal.plan_prices SET amount_cents=1699 WHERE plan_slug='pro' AND billing_interval='month'`);
  });
  test('checkout is created server-side from the database price; the client cannot choose the amount', async () => {
    const r = await c.post('/api/v1/billing/checkout', { plan: 'pro', interval: 'year', seats: 3, unit_amount: 1, amount: 1, price: 1 });
    assert.equal(r.status, 201); assert.equal(r.body.unit_amount_cents, 17988); assert.equal(r.body.total_cents, 17988 * 3);
    const req = stripe.st.requests.find((x) => x.path === '/v1/checkout/sessions');
    assert.equal(req.form['line_items[0][price_data][unit_amount]'], '17988'); assert.equal(req.form['line_items[0][quantity]'], '3');
    assert.equal(req.form['line_items[0][price_data][recurring][interval]'], 'year'); assert.equal(req.form.mode, 'subscription');
    assert.equal(req.form['subscription_data[metadata][workspace_id]'], ws); assert.equal(req.auth, 'Bearer sk_test_fake'); assert.ok(req.idem.startsWith('checkout-'));
    assert.equal(await plan(), 'basic', 'creating a checkout session never activates anything');
  });
  test('only purchasable plans/intervals/seat counts are accepted', async () => {
    assert.equal((await c.post('/api/v1/billing/checkout', { plan: 'enterprise', interval: 'month' })).status, 400);
    assert.equal((await c.post('/api/v1/billing/checkout', { plan: 'basic', interval: 'month' })).status, 400);
    assert.equal((await c.post('/api/v1/billing/checkout', { plan: 'pro', interval: 'week' })).status, 400);
    assert.equal((await c.post('/api/v1/billing/checkout', { plan: 'pro', interval: 'month', seats: 0 })).status, 400);
    assert.equal((await c.post('/api/v1/billing/checkout', { plan: 'pro', interval: 'month', seats: 100000 })).status, 400);
    await db.pool.query(`UPDATE portal.plan_prices SET active=false WHERE plan_slug='business' AND billing_interval='year'`);
    assert.equal((await c.post('/api/v1/billing/checkout', { plan: 'business', interval: 'year' })).status, 400, 'inactive price');
    await db.pool.query(`UPDATE portal.plan_prices SET active=true WHERE plan_slug='business' AND billing_interval='year'`);
  });
  test('a provider failure during checkout is reported safely and nothing is activated', async () => {
    stripe.st.failCreate = true;
    const r = await c.post('/api/v1/billing/checkout', { plan: 'pro', interval: 'month' }); assert.equal(r.status, 502); assert.equal(r.body.code, 'provider_error');
    assert.ok(!JSON.stringify(r.body).includes('card_declined'), 'provider detail is not leaked');
    assert.equal(await plan(), 'basic');
  });
  test('webhooks: missing, malformed, wrong-secret, stale and re-serialised bodies are all rejected (raw-body signature)', async () => {
    const { row } = await checkout(); const { sub, inv } = paid({ row }); const ev = stripe.event('invoice.paid', inv);
    assert.equal((await stripe.deliver(app.base, ev, { signature: '' })).status, 400);
    assert.equal((await stripe.deliver(app.base, ev, { signature: 't=1,v1=zz' })).status, 400);
    assert.equal((await stripe.deliver(app.base, ev, { secret: 'whsec_wrong' })).status, 400);
    assert.equal((await stripe.deliver(app.base, ev, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status, 400);
    const raw = JSON.stringify(ev); const sig = signPayload(Buffer.from(raw), WEBHOOK_SECRET);
    assert.equal((await stripe.deliver(app.base, ev, { rawBody: JSON.stringify(ev, null, 2), signature: sig })).status, 400, 'a pretty-printed copy of the same JSON must not verify');
    assert.equal((await stripe.deliver(app.base, ev, { tamper: (b) => b.replace('"paid"', '"open"') })).status, 400);
    assert.equal(await plan(), 'basic'); assert.equal(Number((await db.pool.query('SELECT count(*) FROM portal.billing_events')).rows[0].count), 0, 'rejected events leave no trace');
    assert.equal((await stripe.deliver(app.base, ev)).status, 200, 'the correctly signed original is accepted'); assert.ok(sub);
  });
  test('checkout.session.completed and the browser redirect are NOT proof of payment', async () => {
    const { row, res } = await checkout();
    const { sub } = paid({ row });
    const completed = stripe.event('checkout.session.completed', { id: res.session_id, object: 'checkout.session', mode: 'subscription', customer: sub.customer, subscription: sub.id, payment_status: 'paid', metadata: { workspace_id: ws, checkout_id: row.id } });
    const r = await stripe.deliver(app.base, completed); assert.equal(r.status, 200);
    assert.equal(await plan(), 'basic', 'completed session alone must not activate');
    const outcome = (await db.pool.query(`SELECT outcome FROM portal.billing_events WHERE event_id=$1`, [completed.id])).rows[0].outcome; assert.match(outcome, /awaiting_paid_invoice/);
    const redirect = await fetch(app.base + '/app/billing?checkout=success&session_id=' + res.session_id); assert.equal(redirect.status, 200);
    assert.equal(await plan(), 'basic', 'visiting the success URL changes nothing');
  });
  test('activation: a signed PAID invoice whose subscription the provider confirms and whose price matches our snapshot', async () => {
    const { row } = await checkout('pro', 'year', 2); const { sub, inv } = paid({ row });
    const ev = stripe.event('invoice.paid', inv); const r = await stripe.deliver(app.base, ev);
    assert.deepEqual(r.body, { received: true, duplicate: false });
    assert.equal(await plan(), 'pro');
    const s = (await db.pool.query('SELECT * FROM portal.subscriptions WHERE workspace_id=$1', [ws])).rows[0];
    assert.equal(s.status, 'active'); assert.equal(s.billing_interval, 'year'); assert.equal(s.seats, 2); assert.equal(s.provider_subscription_id, sub.id);
    assert.ok(new Date(s.current_period_end) > new Date(Date.now() + 300 * 86400000));
    const invs = await c.get('/api/v1/billing/invoices'); assert.equal(invs.body.length, 1); assert.equal(invs.body[0].status, 'paid'); assert.equal(invs.body[0].amount_paid_cents, 17988 * 2);
    assert.ok(invs.body[0].hosted_invoice_url.startsWith('https://invoice.stripe.test/'));
    assert.equal((await db.pool.query(`SELECT status FROM portal.checkout_sessions WHERE id=$1`, [row.id])).rows[0].status, 'completed');
    assert.equal((await c.get('/api/v1/entitlements')).body.features['notes.max'].quota, 1000, 'entitlements follow the verified plan');
    const b = (await c.get('/api/v1/billing')).body; assert.equal(b.plan, 'pro'); assert.equal(b.subscription.interval, 'year');
  });
  test('replayed events are idempotent (same event id, any number of deliveries, even concurrently)', async () => {
    const { row } = await checkout(); const { inv } = paid({ row }); const ev = stripe.event('invoice.paid', inv);
    const results = await Promise.all(Array.from({ length: 6 }, () => stripe.deliver(app.base, ev)));
    assert.ok(results.every((r) => r.status === 200)); assert.equal(results.filter((r) => !r.body.duplicate).length, 1, 'exactly one delivery processed');
    const again = await stripe.deliver(app.base, ev); assert.equal(again.body.duplicate, true);
    assert.equal(Number((await db.pool.query(`SELECT count(*) FROM portal.invoices WHERE workspace_id=$1`, [ws])).rows[0].count), 1);
    assert.equal(Number((await db.pool.query(`SELECT count(*) FROM portal.billing_events WHERE event_id=$1`, [ev.id])).rows[0].count), 1);
  });
  test('a forged-but-signed-looking event for something we never created, or a price that differs from our snapshot, never activates', async () => {
    const { row } = await checkout('pro', 'month');
    // (1) provider subscription whose metadata points to no checkout of ours
    const stranger = stripe.subscription({ checkoutId: crypto.randomUUID(), workspaceId: ws, unitAmount: 1699 }); const inv1 = stripe.invoice({ sub: stranger, amountPaid: 1699 });
    await stripe.deliver(app.base, stripe.event('invoice.paid', inv1)); assert.equal(await plan(), 'basic');
    // (2) the customer somehow paid a different amount than we showed (mismatch)
    const cheap = stripe.subscription({ checkoutId: row.id, workspaceId: row.workspace_id, unitAmount: 100, interval: 'month' }); const inv2 = stripe.invoice({ sub: cheap, amountPaid: 100 });
    await stripe.deliver(app.base, stripe.event('invoice.paid', inv2)); assert.equal(await plan(), 'basic');
    assert.match((await db.pool.query(`SELECT outcome FROM portal.billing_events ORDER BY received_at DESC LIMIT 1`)).rows[0].outcome, /price_mismatch/);
    // (3) wrong interval / wrong seats
    const wrongInterval = stripe.subscription({ checkoutId: row.id, workspaceId: row.workspace_id, unitAmount: row.unit_amount_cents, interval: 'year' }); await stripe.deliver(app.base, stripe.event('invoice.paid', stripe.invoice({ sub: wrongInterval, amountPaid: 1699 })));
    const wrongSeats = stripe.subscription({ checkoutId: row.id, workspaceId: row.workspace_id, unitAmount: row.unit_amount_cents, quantity: 9 }); await stripe.deliver(app.base, stripe.event('invoice.paid', stripe.invoice({ sub: wrongSeats, amountPaid: 1699 * 9 })));
    assert.equal(await plan(), 'basic');
    // (4) checkout row belongs to ANOTHER workspace than the metadata claims
    const other = await main.mint(); const ws2 = await seedWorkspace(db.pool, other.sub);
    const crossed = stripe.subscription({ checkoutId: row.id, workspaceId: ws2, unitAmount: row.unit_amount_cents }); await stripe.deliver(app.base, stripe.event('invoice.paid', stripe.invoice({ sub: crossed, amountPaid: 1699 })));
    assert.equal((await app.client(other).get('/api/v1/workspace')).body.plan, 'basic'); assert.equal(await plan(), 'basic');
  });
  test('zero-amount, unpaid, or provider-not-active invoices do not activate', async () => {
    const { row } = await checkout();
    const { sub } = paid({ row, status: 'incomplete' });
    await stripe.deliver(app.base, stripe.event('invoice.paid', stripe.invoice({ sub, amountPaid: row.unit_amount_cents }))); assert.equal(await plan(), 'basic');
    const s2 = stripe.subscription({ checkoutId: row.id, workspaceId: ws, unitAmount: row.unit_amount_cents }); await stripe.deliver(app.base, stripe.event('invoice.paid', stripe.invoice({ sub: s2, amountPaid: 0 }))); assert.equal(await plan(), 'basic');
    await stripe.deliver(app.base, stripe.event('invoice.paid', stripe.invoice({ sub: s2, amountPaid: 1699, status: 'open' }))); assert.equal(await plan(), 'basic');
  });
  test('provider unreachable during confirmation => 5xx so the provider retries, nothing recorded; retry then succeeds', async () => {
    const { row } = await checkout(); const { inv } = paid({ row }); const ev = stripe.event('invoice.paid', inv);
    stripe.st.down = true; const first = await stripe.deliver(app.base, ev); assert.ok(first.status >= 500, 'status ' + first.status);
    assert.equal(Number((await db.pool.query(`SELECT count(*) FROM portal.billing_events WHERE event_id=$1`, [ev.id])).rows[0].count), 0); assert.equal(await plan(), 'basic');
    stripe.st.down = false; const second = await stripe.deliver(app.base, ev); assert.equal(second.status, 200); assert.equal(await plan(), 'pro');
  });
  test('out-of-order delivery: a stale subscription.updated cannot undo a newer state', async () => {
    const { row } = await checkout(); const { sub, inv } = paid({ row });
    const t0 = Math.floor(Date.now() / 1000);
    await stripe.deliver(app.base, stripe.event('invoice.paid', inv, { created: t0 })); assert.equal(await plan(), 'pro');
    await stripe.deliver(app.base, stripe.event('customer.subscription.deleted', { ...sub, status: 'canceled' }, { created: t0 + 100 })); assert.equal(await plan(), 'basic');
    const stale = await stripe.deliver(app.base, stripe.event('customer.subscription.updated', { ...sub, status: 'active' }, { created: t0 + 50 }));
    assert.equal(stale.status, 200); assert.equal(await plan(), 'basic', 'older event ignored');
    assert.equal((await db.pool.query('SELECT status FROM portal.subscriptions WHERE workspace_id=$1', [ws])).rows[0].status, 'canceled');
  });
  test('payment failure: past_due keeps access during the grace period, then access ends and the lapse is made explicit', async () => {
    const { row } = await checkout(); const { sub, inv } = paid({ row }); const t0 = Math.floor(Date.now() / 1000);
    await stripe.deliver(app.base, stripe.event('invoice.paid', inv, { created: t0 }));
    const failed = stripe.invoice({ sub, amountPaid: 1699, status: 'open' }); failed.amount_paid = 0; failed.attempt_count = 2; failed.next_payment_attempt = t0 + 86400;
    await stripe.deliver(app.base, stripe.event('invoice.payment_failed', failed, { created: t0 + 10 }));
    assert.equal((await db.pool.query('SELECT status FROM portal.subscriptions WHERE workspace_id=$1', [ws])).rows[0].status, 'past_due');
    const fi = (await c.get('/api/v1/billing/invoices')).body.find((i) => i.status === 'payment_failed'); assert.equal(fi.attempt_count, 2);
    assert.equal(await plan(), 'pro', 'grace: still entitled while retries run');
    await db.pool.query(`UPDATE portal.subscriptions SET current_period_end = now() - interval '8 days' WHERE workspace_id=$1`, [ws]);
    assert.equal(await plan(), 'basic', 'grace over: entitlements fall back to Basic');
    assert.equal(await app.billing.expireLapsed(), 1);
    assert.equal((await db.pool.query('SELECT status FROM portal.subscriptions WHERE workspace_id=$1', [ws])).rows[0].status, 'expired');
    // paying later restores access (new paid invoice, newer event)
    const late = stripe.invoice({ sub, amountPaid: 1699 }); sub.current_period_end = Math.floor(Date.now() / 1000) + 30 * 86400;
    await stripe.deliver(app.base, stripe.event('invoice.paid', late, { created: t0 + 20 * 86400 })); assert.equal(await plan(), 'pro');
  });
  test('renewals keep the plan; cancel_at_period_end is reflected; deletion ends access; cancel API asks the provider', async () => {
    const { row } = await checkout('business', 'month'); const { sub, inv } = paid({ row }); const t0 = Math.floor(Date.now() / 1000);
    await stripe.deliver(app.base, stripe.event('invoice.paid', inv, { created: t0 }));
    const renewal = stripe.invoice({ sub, amountPaid: row.unit_amount_cents }); sub.current_period_end += 30 * 86400;
    assert.equal((await stripe.deliver(app.base, stripe.event('invoice.paid', renewal, { created: t0 + 30 * 86400 }))).status, 200);
    assert.equal((await db.pool.query(`SELECT outcome FROM portal.billing_events WHERE type='invoice.paid' ORDER BY received_at DESC LIMIT 1`)).rows[0].outcome, 'renewed');
    const r = await c.post('/api/v1/billing/cancel', {}); assert.equal(r.status, 202); assert.equal(r.body.cancel_at_period_end, true);
    assert.equal(stripe.st.requests.find((x) => x.path.startsWith('/v1/subscriptions/') && x.method === 'POST').form.cancel_at_period_end, 'true');
    const b = (await c.get('/api/v1/billing')).body; assert.equal(b.subscription.cancel_at_period_end, true); assert.equal(b.plan, 'business', 'still entitled until the period ends');
    await stripe.deliver(app.base, stripe.event('customer.subscription.deleted', { ...sub, status: 'canceled' }, { created: t0 + 60 * 86400 }));
    assert.equal(await plan(), 'basic');
    assert.equal((await c.post('/api/v1/billing/cancel', {})).status, 409);
  });
  test('refunds are recorded idempotently against the invoice; access is not silently removed', async () => {
    const { row } = await checkout(); const { inv } = paid({ row });
    await stripe.deliver(app.base, stripe.event('invoice.paid', inv));
    const charge = { id: 'ch_1', object: 'charge', invoice: inv.id, amount: 1699, amount_refunded: 1699, refunds: { data: [{ id: 're_1', amount: 1699, currency: 'usd', reason: 'requested_by_customer' }] } };
    const ev = stripe.event('charge.refunded', charge); assert.equal((await stripe.deliver(app.base, ev)).status, 200); assert.equal((await stripe.deliver(app.base, ev)).body.duplicate, true);
    const i = (await c.get('/api/v1/billing/invoices')).body[0]; assert.equal(i.status, 'refunded'); assert.equal(i.amount_refunded_cents, 1699);
    assert.equal(Number((await db.pool.query('SELECT count(*) FROM portal.refunds WHERE workspace_id=$1', [ws])).rows[0].count), 1);
    assert.equal(await plan(), 'pro');
    const partial = stripe.event('charge.refunded', { ...charge, id: 'ch_2', amount_refunded: 500, refunds: { data: [{ id: 're_2', amount: 500, currency: 'usd' }] } });
    await stripe.deliver(app.base, partial); assert.equal((await c.get('/api/v1/billing/invoices')).body[0].status, 'partially_refunded');
  });
  test('reconciliation repairs drift from the provider without webhooks', async () => {
    const { row } = await checkout(); const { sub, inv } = paid({ row }); await stripe.deliver(app.base, stripe.event('invoice.paid', inv)); assert.equal(await plan(), 'pro');
    sub.status = 'canceled';                                 // provider cancelled; our webhook was lost
    const r = await c.post('/api/v1/billing/reconcile', {}); assert.equal(r.status, 200); assert.equal(r.body.changed, true); assert.equal(await plan(), 'basic');
  });
  test('one checkout can only ever be bound to ONE provider subscription', async () => {
    const { row } = await checkout(); const first = paid({ row });
    await stripe.deliver(app.base, stripe.event('invoice.paid', first.inv)); assert.equal(await plan(), 'pro');
    const second = paid({ row });                                   // a different provider subscription claiming the same checkout
    await stripe.deliver(app.base, stripe.event('invoice.paid', second.inv));
    assert.match((await db.pool.query(`SELECT outcome FROM portal.billing_events ORDER BY received_at DESC LIMIT 1`)).rows[0].outcome, /rejected_checkout_already_used/);
    assert.equal((await db.pool.query('SELECT provider_subscription_id FROM portal.subscriptions WHERE workspace_id=$1', [ws])).rows[0].provider_subscription_id, first.sub.id);
  });
  test('an already-subscribed workspace cannot start a second checkout; members cannot start one at all', async () => {
    const { row } = await checkout(); const { inv } = paid({ row }); await stripe.deliver(app.base, stripe.event('invoice.paid', inv));
    assert.equal((await c.post('/api/v1/billing/checkout', { plan: 'business', interval: 'month' })).status, 409);
    const m = await main.mint(); await addMember(db.pool, ws, m.sub, 'member'); assert.equal((await app.client(m, { workspace: ws }).post('/api/v1/billing/checkout', { plan: 'pro', interval: 'month' })).status, 403);
  });
  test('billing is unavailable (503) unless explicitly enabled and fully configured; live keys need separate authorization', async () => {
    const off = await startApp({ pool: db.pool, cfg: testConfig({ env: { BILLING_ENABLED: 'false' } }, main), jwks: main.jwks });
    const o = off.client(owner); const r = await o.post('/api/v1/billing/checkout', { plan: 'pro', interval: 'month' });
    assert.equal(r.status, 503); assert.equal(r.body.code, 'billing_unavailable'); assert.deepEqual((await off.client(null).get('/api/v1/plans')).body.billing.unavailable_reasons, ['billing_disabled']);
    assert.equal((await fetch(off.base + '/api/v1/billing/webhook', { method: 'POST', body: '{}' })).status, 503); await off.close();
    const missing = testConfig({ env: { BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_x' } }, main); assert.deepEqual(missing.billing.unavailableReasons, ['missing_webhook_secret']);
    const live = testConfig({ env: { BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_WEBHOOK_SECRET: 'whsec_x' } }, main); assert.equal(live.billing.available, false); assert.deepEqual(live.billing.unavailableReasons, ['live_key_not_authorized']);
    const authorised = testConfig({ env: { BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_WEBHOOK_SECRET: 'whsec_x', BILLING_LIVE_AUTHORIZED: 'yes-i-authorize-real-payments' } }, main); assert.equal(authorised.billing.available, true);
    const prod = testConfig({ env: { NODE_ENV: 'production', STRIPE_API_BASE: 'http://evil.example' } }, main); assert.equal(prod.billing.apiBase, 'https://api.stripe.com', 'API base override is ignored in production');
  });
});
