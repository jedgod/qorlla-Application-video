// Stripe and RevenueCat adapters: signature/authorization, event normalization, and the rules that stop one purchase being applied twice.
// Payload shapes follow the providers' documented webhook formats; they are NOT yet proven against a live sandbox (see PRODUCTION_READINESS).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createStripeAdapter, createStripeClient } from '../src/providers/stripe.js';
import { createRevenueCatAdapter } from '../src/providers/revenuecat.js';
import { validateEvent } from '../src/billingAdapters.js';

export const STRIPE_SECRET = 'whsec_' + 'a'.repeat(40);
export const RC_SECRET = 'rc_' + 'b'.repeat(40);
export const PRICES = { price_pro: 'pro', price_biz: 'business' };
export const PRODUCTS = { 'qorlla.pro.monthly': 'pro', 'qorlla.pro.yearly': 'pro' };
const T0 = 1_800_000_000;

export const stripeAdapter = () => createStripeAdapter({ secrets: [STRIPE_SECRET], prices: PRICES });
export const rcAdapter = (o = {}) => createRevenueCatAdapter({ secrets: [RC_SECRET], products: PRODUCTS, acceptSandbox: true, ...o });

export function stripeSub(over = {}) {
  return { id: 'sub_1', object: 'subscription', customer: 'cus_1', status: 'active', cancel_at_period_end: false, current_period_start: T0, current_period_end: T0 + 2_592_000,
    items: { data: [{ price: { id: 'price_pro' }, quantity: 1 }] }, metadata: {}, ...over };
}
export function stripeEvent(type, object, { id = 'evt_' + Math.random().toString(36).slice(2), created = T0 } = {}) {
  const rawBody = Buffer.from(JSON.stringify({ id, object: 'event', type, created, data: { object } }));
  return { rawBody, headers: { 'stripe-signature': stripeAdapter().sign(rawBody, created * 1000) }, id, created };
}
export function rcEvent(over = {}, { auth = 'Bearer ' + RC_SECRET } = {}) {
  const event = { id: 'rc_' + Math.random().toString(36).slice(2), type: 'INITIAL_PURCHASE', app_user_id: '11111111-1111-4111-8111-111111111111', product_id: 'qorlla.pro.monthly',
    store: 'APP_STORE', environment: 'SANDBOX', original_transaction_id: 'otx_1', transaction_id: 'tx_1', purchased_at_ms: T0 * 1000, expiration_at_ms: (T0 + 2_592_000) * 1000,
    event_timestamp_ms: T0 * 1000 + 5, period_type: 'NORMAL', ...over };
  return { rawBody: Buffer.from(JSON.stringify({ api_version: '1.0', event })), headers: { authorization: auth }, event };
}
const norm = (adapter, d) => validateEvent(adapter.provider, adapter.parse(d.rawBody));

describe('Stripe adapter', () => {
  test('a correctly signed body verifies; a tampered body, a wrong secret, an old timestamp and a missing header do not', () => {
    const a = stripeAdapter(), d = stripeEvent('customer.subscription.updated', stripeSub());
    assert.equal(a.verify(d.rawBody, d.headers, T0 * 1000).ok, true);
    assert.equal(a.verify(Buffer.concat([d.rawBody, Buffer.from(' ')]), d.headers, T0 * 1000).ok, false);
    const other = createStripeAdapter({ secrets: ['x'.repeat(40)], prices: PRICES });
    assert.equal(other.verify(d.rawBody, d.headers, T0 * 1000).ok, false);
    assert.equal(a.verify(d.rawBody, d.headers, (T0 + 1000) * 1000).reason, 'timestamp_out_of_tolerance');
    assert.equal(a.verify(d.rawBody, {}, T0 * 1000).ok, false);
  });
  test('key rotation: either secret verifies', () => {
    const a = createStripeAdapter({ secrets: [STRIPE_SECRET, 'n'.repeat(40)], prices: PRICES });
    const d = stripeEvent('customer.subscription.updated', stripeSub());
    assert.equal(a.verify(d.rawBody, { 'stripe-signature': a.sign(d.rawBody, T0 * 1000, 'n'.repeat(40)) }, T0 * 1000).ok, true);
  });
  test('subscription events become neutral snapshots with the price mapped to a plan, a ms revision and the purchase identity', () => {
    const e = norm(stripeAdapter(), stripeEvent('customer.subscription.created', stripeSub({ status: 'trialing', trial_end: T0 + 600, metadata: { qorlla_customer_id: 'abc' } })));
    assert.equal(e.type, 'subscription.created'); assert.equal(e.revision, T0 * 1000);
    assert.equal(e.subscription.planCode, 'pro'); assert.equal(e.subscription.status, 'trialing');
    assert.deepEqual(e.purchase, { source: 'stripe', id: 'sub_1' }); assert.equal(e.claimedCustomerId, 'abc');
  });
  test('past_due gets an explicit grace window; deleted becomes canceled; pause_collection becomes paused; unpaid ends access', () => {
    const a = stripeAdapter();
    const pd = norm(a, stripeEvent('customer.subscription.updated', stripeSub({ status: 'past_due' }))).subscription;
    assert.equal(new Date(pd.gracePeriodEndsAt).getTime() - T0 * 1000, 3 * 86_400_000);
    assert.equal(norm(a, stripeEvent('customer.subscription.deleted', stripeSub())).subscription.status, 'canceled');
    assert.equal(norm(a, stripeEvent('customer.subscription.updated', stripeSub({ pause_collection: { behavior: 'void' } }))).subscription.status, 'paused');
    assert.equal(norm(a, stripeEvent('customer.subscription.updated', stripeSub({ status: 'unpaid' }))).subscription.status, 'expired');
  });
  test('invoices and refunds are outbox-only (no snapshot); unknown events are ignored, not errors', () => {
    const a = stripeAdapter();
    const paid = norm(a, stripeEvent('invoice.paid', { id: 'in_1', customer: 'cus_1', amount_paid: 4900 }));
    assert.equal(paid.type, 'invoice.paid'); assert.equal(paid.subscription, undefined);
    assert.equal(norm(a, stripeEvent('charge.refunded', { id: 'ch_1', customer: 'cus_1', amount_refunded: 4900 })).type, 'invoice.refunded');
    assert.equal(norm(a, stripeEvent('customer.updated', { id: 'cus_1', customer: 'cus_1' })).unknownType, true);
  });
  test('an unmapped price, a multi-item subscription and an unknown status are rejected (never guessed)', () => {
    const a = stripeAdapter();
    assert.throws(() => a.parse(stripeEvent('customer.subscription.updated', stripeSub({ items: { data: [{ price: { id: 'price_x' } }] } })).rawBody), /not mapped/);
    assert.throws(() => a.parse(stripeEvent('customer.subscription.updated', stripeSub({ items: { data: [{ price: { id: 'price_pro' } }, { price: { id: 'price_biz' } }] } })).rawBody), /multi-item/);
    assert.throws(() => a.parse(stripeEvent('customer.subscription.updated', stripeSub({ status: 'weird' })).rawBody), /status/);
  });
  test('the REST client fails closed without a key and never sends the key anywhere but the Authorization header', async () => {
    await assert.rejects(createStripeClient({}).createCustomer({ qorllaCustomerId: 'x', name: 'n' }), /stripe_not_configured/);
    let seen;
    const c = createStripeClient({ secretKey: 'sk_test_x', fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ id: 'cus_9' }) }; } });
    assert.equal((await c.createCustomer({ qorllaCustomerId: 'q1', name: 'Acme' })).id, 'cus_9');
    assert.equal(seen.init.headers.authorization, 'Bearer sk_test_x'); assert.ok(!String(seen.init.body).includes('sk_test_x'));
    assert.match(seen.init.body, /metadata%5Bqorlla_customer_id%5D=q1/);
  });
});

describe('RevenueCat adapter', () => {
  test('only the configured authorization value verifies (Bearer prefix optional, rotation supported)', () => {
    const a = rcAdapter({ secrets: [RC_SECRET, 'r'.repeat(40)] });
    assert.equal(a.verify(rcEvent().rawBody, { authorization: 'Bearer ' + RC_SECRET }).ok, true);
    assert.equal(a.verify(rcEvent().rawBody, { authorization: RC_SECRET }).ok, true);
    assert.equal(a.verify(rcEvent().rawBody, { authorization: 'r'.repeat(40) }).ok, true);
    assert.equal(a.verify(rcEvent().rawBody, { authorization: 'Bearer wrong' }).ok, false);
    assert.equal(a.verify(rcEvent().rawBody, {}).ok, false);
    assert.throws(() => createRevenueCatAdapter({ secrets: ['short'], products: PRODUCTS }));
  });
  test('purchase lifecycle maps to neutral events: purchase, trial, renewal, unsubscribe (access continues), refund (ends now), expiry, billing issue, pause', () => {
    const a = rcAdapter();
    const n = (o) => norm(a, rcEvent(o));
    const buy = n({}); assert.equal(buy.type, 'subscription.created'); assert.equal(buy.subscription.status, 'active');
    assert.equal(buy.subscription.externalId, 'otx_1'); assert.equal(buy.revision, T0 * 1000 + 5); assert.deepEqual(buy.purchase, { source: 'app_store', id: 'otx_1' });
    assert.equal(n({ period_type: 'TRIAL' }).subscription.status, 'trialing');
    assert.equal(n({ type: 'RENEWAL' }).type, 'invoice.paid');
    const unsub = n({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE' }).subscription; assert.equal(unsub.status, 'active'); assert.equal(unsub.cancelAtPeriodEnd, true);
    assert.equal(n({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' }).subscription.status, 'canceled');
    assert.equal(n({ type: 'EXPIRATION' }).subscription.status, 'expired');
    assert.equal(n({ type: 'BILLING_ISSUE', grace_period_expiration_at_ms: (T0 + 3 * 86400) * 1000 }).subscription.status, 'past_due');
    assert.equal(n({ type: 'SUBSCRIPTION_PAUSED' }).subscription.status, 'paused');
    assert.equal(n({ store: 'PLAY_STORE' }).purchase.source, 'play_store');
  });
  test('Stripe-sourced mirrors, promotional grants, anonymous users, TRANSFER and production-mode sandbox events are ignored', () => {
    const ignored = (o, a = rcAdapter()) => assert.equal(norm(a, rcEvent(o)).unknownType, true, JSON.stringify(o));
    ignored({ store: 'STRIPE' }); ignored({ store: 'PROMOTIONAL' }); ignored({ app_user_id: '$RCAnonymousID:abc' }); ignored({ type: 'TRANSFER' });
    ignored({ environment: 'SANDBOX' }, rcAdapter({ acceptSandbox: false }));
    assert.equal(norm(rcAdapter({ acceptSandbox: false }), rcEvent({ environment: 'PRODUCTION' })).type, 'subscription.created');
  });
  test('an unmapped product is rejected, not guessed', () => {
    assert.throws(() => rcAdapter().parse(rcEvent({ product_id: 'unknown' }).rawBody), /not mapped/);
  });
});
