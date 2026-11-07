// Unified billing: Stripe + RevenueCat through ONE engine, on real PostgreSQL with the least-privilege billing role.
// Providers are simulated with documented payload shapes (no live sandbox yet). Access is always checked on the REQUEST path (AccessService).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb, skip } from './helpers/db.js';
import { BillingProcessor } from '../src/billing.js';
import { BillingGateway } from '../src/billingGateway.js';
import { AccessService } from '../src/accessService.js';
import { stripeReconciler } from '../src/providers/stripe.js';
import { stripeAdapter, rcAdapter, stripeSub, stripeEvent, rcEvent, PRICES } from './providers.test.js';

const T = Math.floor(Date.now() / 1000);          // "now", so periods are live for the database clock
const DAY = 86_400;
let seq = 0;

describe('unified billing: Stripe + RevenueCat (PostgreSQL)', { skip }, () => {
  let db, billing, access, gateway, stripe, changed;
  before(async () => {
    db = await createTestDb(); changed = [];
    billing = new BillingProcessor({ adapters: [stripeAdapter(), rcAdapter()], pool: db.poolFor('billing'), onSubscriptionChanged: (c) => changed.push(c) });
    access = new AccessService({ pool: db.poolFor('runtime') });
    stripe = { calls: [], fail: false,
      async createCustomer(a) { this.calls.push(['customer', a]); if (this.fail) throw new Error('down'); return { id: 'cus_' + ++seq }; },
      async createCheckoutSession(a) { this.calls.push(['checkout', a]); if (this.fail) throw new Error('down'); return { url: 'https://checkout.stripe.test/' + a.customer }; },
      async createPortalSession(a) { this.calls.push(['portal', a]); return { url: 'https://portal.stripe.test/' + a.customer }; },
      async retrieveSubscription() { return this.current; } };
    gateway = new BillingGateway({ pool: db.poolFor('billing'), stripe, prices: { pro: 'price_pro', business: 'price_biz' }, urls: { success: 'https://q/ok', cancel: 'https://q/no', returnUrl: 'https://q/billing' }, access });
  });
  after(async () => { await db.drop(); });

  async function world({ kind = 'organization', stripeLink = true, rcLink = true } = {}) {
    const id = randomUUID(), owner = 'owner-' + id.slice(0, 6), admin = 'admin-' + id.slice(0, 6), member = 'member-' + id.slice(0, 6);
    await db.owner.query(`INSERT INTO customers (id, name, created_by, kind) VALUES ($1,'Acme',$2,$3)`, [id, owner, kind]);
    const people = kind === 'personal' ? [[owner, 'owner']] : [[owner, 'owner'], [admin, 'admin'], [member, 'member']];
    for (const [u, r] of people) await db.owner.query(`INSERT INTO customer_members (customer_id, user_id, role, added_by) VALUES ($1,$2,$3,'t')`, [id, u, r]);
    const ext = 'cus_w' + ++seq;
    if (stripeLink) await db.owner.query(`INSERT INTO billing_customers (provider, external_customer_id, customer_id, linked_by) VALUES ('stripe',$1,$2,'t')`, [ext, id]);
    if (rcLink) await db.owner.query(`INSERT INTO billing_customers (provider, external_customer_id, customer_id, linked_by) VALUES ('revenuecat',$1::text,$1::uuid,'t')`, [id]);
    return { id, owner, admin, member, ext, sub: 'sub_' + id.slice(0, 8), otx: 'otx_' + id.slice(0, 8) };
  }
  const sevents = async (id) => (await db.owner.query(`SELECT event_type FROM security_events WHERE customer_id=$1`, [id])).rows.map((r) => r.event_type);
  const row = async (id) => (await db.owner.query('SELECT * FROM subscriptions WHERE customer_id=$1', [id])).rows[0];
  const can = async (id, f = 'meetings.cloud_recording') => (await access.canAccess(id, f)).allowed;
  const sDeliver = (w, type, over = {}, o = {}) => billing.ingest({ provider: 'stripe', ...stripeEvent(type, stripeSub({ id: w.sub, customer: w.ext, current_period_start: T - DAY, current_period_end: T + 30 * DAY, metadata: { qorlla_customer_id: w.id }, ...over }), { created: T, ...o }), nowMs: (o.created ?? T) * 1000 });
  const rDeliver = (w, over = {}, auth) => billing.ingest({ provider: 'revenuecat', ...rcEvent({ app_user_id: w.id, original_transaction_id: w.otx, purchased_at_ms: (T - DAY) * 1000, expiration_at_ms: (T + 30 * DAY) * 1000, event_timestamp_ms: Date.now(), ...over }, auth ? { auth } : undefined) });

  test('STRIPE lifecycle: purchase -> access; payment failure -> grace; recovery; cancel at period end keeps access; deletion ends it', async () => {
    const w = await world();
    assert.equal((await sDeliver(w, 'customer.subscription.created')).status, 'applied');
    assert.equal(await can(w.id), true); assert.equal((await row(w.id)).provider, 'stripe');
    assert.equal((await sDeliver(w, 'customer.subscription.updated', { status: 'past_due' }, { created: T + 1 })).status, 'applied');
    assert.equal((await row(w.id)).status, 'past_due'); assert.equal(await can(w.id), true, 'inside the grace window');
    await sDeliver(w, 'customer.subscription.updated', { status: 'active' }, { created: T + 2 });
    assert.equal((await row(w.id)).status, 'active');
    await sDeliver(w, 'customer.subscription.updated', { cancel_at_period_end: true }, { created: T + 3 });
    assert.equal((await row(w.id)).cancel_at_period_end, true); assert.equal(await can(w.id), true, 'cancelled but paid through the period');
    await sDeliver(w, 'customer.subscription.deleted', {}, { created: T + 4 });
    assert.equal(await can(w.id), false, 'ended: back to the free plan');
    assert.equal(await can(w.id, 'meetings.host'), true);
  });

  test('STRIPE webhook REPLAY and OUT-OF-ORDER delivery cannot move state backwards; a tampered replay is flagged', async () => {
    const w = await world();
    const created = stripeEvent('customer.subscription.created', stripeSub({ id: w.sub, customer: w.ext, current_period_start: T - DAY, current_period_end: T + 30 * DAY, metadata: { qorlla_customer_id: w.id } }), { id: 'evt_' + w.id, created: T });
    const del = stripeEvent('customer.subscription.deleted', stripeSub({ id: w.sub, customer: w.ext, current_period_start: T - DAY, current_period_end: T + 30 * DAY, metadata: { qorlla_customer_id: w.id } }), { created: T + 10 });
    await billing.ingest({ provider: 'stripe', ...del, nowMs: (T + 10) * 1000 });
    assert.equal((await billing.ingest({ provider: 'stripe', ...created, nowMs: T * 1000 })).status, 'stale', 'the older "created" arrives after "deleted"');
    assert.equal(await can(w.id), false);
    assert.equal((await billing.ingest({ provider: 'stripe', ...del, nowMs: (T + 10) * 1000 })).status, 'duplicate');
    const forged = { rawBody: Buffer.from(del.rawBody.toString().replace('"active"', '"past_due"')), headers: del.headers };
    await assert.rejects(billing.ingest({ provider: 'stripe', ...forged, nowMs: (T + 10) * 1000 }), /signature/i);
  });

  test('STRIPE same-second events tie (the second is stale) and RECONCILIATION heals the difference', async () => {
    const w = await world();
    await sDeliver(w, 'customer.subscription.created');
    const r = await sDeliver(w, 'customer.subscription.updated', { status: 'past_due' });          // same created second
    assert.equal(r.status, 'stale'); assert.equal((await row(w.id)).status, 'active', 'local state is behind');
    stripe.current = stripeSub({ id: w.sub, customer: w.ext, status: 'past_due', current_period_start: T - DAY, current_period_end: T + 30 * DAY });
    const fix = await billing.reconcile(w.id, 'stripe', stripeReconciler({ client: stripe, prices: PRICES }));
    assert.equal(fix.drift, true); assert.equal(fix.status, 'applied');
    assert.equal((await row(w.id)).status, 'past_due', 'reconciliation applied the provider state');
  });

  test('REVENUECAT lifecycle (App Store): purchase, renewal, unsubscribe keeps access to period end, expiry ends it', async () => {
    const w = await world({ kind: 'personal' });
    assert.equal((await rDeliver(w)).status, 'applied'); assert.equal(await can(w.id), true);
    assert.equal((await row(w.id)).provider, 'revenuecat');
    assert.equal((await rDeliver(w, { type: 'RENEWAL', event_timestamp_ms: Date.now() + 10 })).status, 'applied');
    await rDeliver(w, { type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', event_timestamp_ms: Date.now() + 20 });
    assert.equal((await row(w.id)).cancel_at_period_end, true); assert.equal(await can(w.id), true);
    await rDeliver(w, { type: 'EXPIRATION', event_timestamp_ms: Date.now() + 30, expiration_at_ms: (T - 5) * 1000 });
    assert.equal(await can(w.id), false, 'expired');
  });

  test('REVENUECAT refund ends access immediately; billing issue gives grace; wrong authorization is refused', async () => {
    const w = await world({ kind: 'personal' });
    await rDeliver(w); assert.equal(await can(w.id), true);
    await rDeliver(w, { type: 'BILLING_ISSUE', event_timestamp_ms: Date.now() + 5, grace_period_expiration_at_ms: (T + 3 * DAY) * 1000 });
    assert.equal((await row(w.id)).status, 'past_due'); assert.equal(await can(w.id), true);
    await rDeliver(w, { type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', event_timestamp_ms: Date.now() + 10 });
    assert.equal(await can(w.id), false, 'refunded purchase: revoked at once');
    await assert.rejects(rDeliver(w, { type: 'RENEWAL' }, 'Bearer nope'), { name: 'SubscriptionError', code: /signature|webhook/i });
  });

  test('NO DUPLICATE PROCESSING: RevenueCat\'s mirror of a Stripe purchase is ignored and Stripe stays authoritative', async () => {
    const w = await world({ kind: 'personal' });
    await sDeliver(w, 'customer.subscription.created');
    const r = await rDeliver(w, { store: 'STRIPE', original_transaction_id: w.sub });
    assert.equal(r.status, 'ignored');
    const s = await row(w.id); assert.equal(s.provider, 'stripe'); assert.equal(s.external_id, w.sub);
    assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM subscriptions WHERE customer_id=$1`, [w.id])).rows[0].n, 1);
  });

  test('NO DOUBLE BILLING: a store purchase while a Stripe subscription is live is parked and alerts (critical); access is unchanged', async () => {
    const w = await world({ kind: 'personal' });
    await sDeliver(w, 'customer.subscription.created');
    const r = await rDeliver(w);
    assert.equal(r.status, 'dead'); assert.equal(r.reason, 'subscription_conflict');
    assert.ok((await sevents(w.id)).includes('duplicate_subscription_detected'));
    assert.equal((await row(w.id)).provider, 'stripe', 'the existing subscription is untouched');
  });

  test('SWITCHING CHANNEL after the first subscription ended is allowed (Stripe -> App Store), and the old Stripe history cannot revive it', async () => {
    const w = await world({ kind: 'personal' });
    await sDeliver(w, 'customer.subscription.created', {}, { created: T });
    await sDeliver(w, 'customer.subscription.deleted', {}, { created: T + 1 });
    assert.equal(await can(w.id), false);
    assert.equal((await rDeliver(w)).status, 'applied'); assert.equal((await row(w.id)).provider, 'revenuecat'); assert.equal(await can(w.id), true);
    const late = await sDeliver(w, 'customer.subscription.updated', { status: 'active' }, { created: T + 2 });
    assert.equal(late.status, 'dead', 'a stale Stripe event is a duplicate subscription while the store one is live, not a revival');
    assert.equal((await row(w.id)).provider, 'revenuecat');
  });

  test('ONE PURCHASE, ONE ACCOUNT: the same Apple transaction reported for a different Qorlla customer is refused (no account hopping)', async () => {
    const a = await world({ kind: 'personal' }), b = await world({ kind: 'personal' });
    await rDeliver(a); assert.equal(await can(a.id), true);
    const r = await rDeliver(b, { original_transaction_id: a.otx });
    assert.equal(r.status, 'dead'); assert.ok((await sevents(b.id)).includes('purchase_claimed_by_other_customer'));
    assert.equal(await row(b.id), undefined); assert.equal(await can(b.id), false);
  });

  test('IDENTITY: an event whose own metadata names a different customer than the administrator-controlled link is parked; an unmapped customer never attaches itself', async () => {
    const w = await world(), other = await world();
    const r = await billing.ingest({ provider: 'stripe', ...stripeEvent('customer.subscription.created', stripeSub({ id: w.sub, customer: w.ext, metadata: { qorlla_customer_id: other.id } }), { created: T }), nowMs: T * 1000 });
    assert.equal(r.reason, 'identity_mismatch'); assert.equal(await row(w.id), undefined);
    const u = await billing.ingest({ provider: 'stripe', ...stripeEvent('customer.subscription.created', stripeSub({ id: 'sub_zz', customer: 'cus_unknown' }), { created: T }), nowMs: T * 1000 });
    assert.equal(u.reason, 'unmapped_customer');
  });

  test('PERSONAL vs ORGANIZATION: store purchases are for personal accounts only; an organization buys through Stripe', async () => {
    const org = await world({ kind: 'organization' }), me = await world({ kind: 'personal' });
    await assert.rejects(gateway.beginCheckout({ customerId: org.id, userId: org.owner, provider: 'revenuecat', planCode: 'pro' }), { code: 'channel_not_allowed' });
    const mobile = await gateway.beginCheckout({ customerId: me.id, userId: me.owner, provider: 'revenuecat', planCode: 'pro' });
    assert.equal(mobile.appUserId, me.id);
    assert.equal((await gateway.beginCheckout({ customerId: org.id, userId: org.owner, provider: 'stripe', planCode: 'pro' })).provider, 'stripe');
  });

  test('CHECKOUT authorization is read live: a plain member, a stranger and a suspended account cannot start a purchase', async () => {
    const w = await world();
    await assert.rejects(gateway.beginCheckout({ customerId: w.id, userId: w.member, provider: 'stripe', planCode: 'pro' }), { code: 'not_authorized' });
    await assert.rejects(gateway.beginCheckout({ customerId: w.id, userId: 'stranger', provider: 'stripe', planCode: 'pro' }), { code: 'not_a_member' });
    await assert.rejects(gateway.beginCheckout({ customerId: w.id, userId: w.owner, provider: 'stripe', planCode: 'enterprise' }), { code: 'plan_not_purchasable' });
    await db.owner.query(`UPDATE customers SET status='suspended' WHERE id=$1`, [w.id]);
    await assert.rejects(gateway.beginCheckout({ customerId: w.id, userId: w.owner, provider: 'stripe', planCode: 'pro' }), { code: 'customer_suspended' });
  });

  test('NO DOUBLE CHECKOUT: two simultaneous attempts (two devices) -> exactly one proceeds; a live subscription blocks a new one and names where to manage it', async () => {
    const w = await world({ stripeLink: false });
    const res = await Promise.allSettled([1, 2, 3, 4].map(() => gateway.beginCheckout({ customerId: w.id, userId: w.owner, provider: 'stripe', planCode: 'pro' })));
    assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(res.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'checkout_in_progress'));
    assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM billing_customers WHERE provider='stripe' AND customer_id=$1`, [w.id])).rows[0].n, 1, 'one Stripe customer, linked by the intent');
    // the purchase completes -> the intent closes, a second checkout is refused as already subscribed with the portal link
    await billing.ingest({ provider: 'stripe', ...stripeEvent('customer.subscription.created', stripeSub({ id: w.sub, customer: (await db.owner.query(`SELECT external_customer_id FROM billing_customers WHERE provider='stripe' AND customer_id=$1`, [w.id])).rows[0].external_customer_id, current_period_start: T - DAY, current_period_end: T + 30 * DAY, metadata: { qorlla_customer_id: w.id } }), { created: T }), nowMs: T * 1000 });
    assert.equal((await db.owner.query(`SELECT status FROM checkout_intents WHERE customer_id=$1`, [w.id])).rows[0].status, 'completed');
    const e = await gateway.beginCheckout({ customerId: w.id, userId: w.owner, provider: 'stripe', planCode: 'business' }).catch((x) => x);
    assert.equal(e.code, 'already_subscribed'); assert.equal(e.details.manage.kind, 'stripe_portal'); assert.match(e.details.manage.url, /portal\.stripe\.test/);
    const m = await gateway.beginCheckout({ customerId: w.id, userId: w.owner, provider: 'revenuecat', planCode: 'pro' }).catch((x) => x);
    assert.ok(['already_subscribed', 'channel_not_allowed'].includes(m.code), 'another channel cannot start a second subscription either');
  });

  test('A provider outage while starting checkout cancels the intent (no stuck lock) and a retry works', async () => {
    const w = await world({ stripeLink: false });
    stripe.fail = true;
    await assert.rejects(gateway.beginCheckout({ customerId: w.id, userId: w.owner, provider: 'stripe', planCode: 'pro' }), { code: 'provider_unavailable' });
    stripe.fail = false;
    assert.equal((await gateway.beginCheckout({ customerId: w.id, userId: w.owner, provider: 'stripe', planCode: 'pro' })).provider, 'stripe');
  });

  test('UNIFIED SUBSCRIPTION PAGE: plan, renewal, billing source, usage and the right management destination for each channel', async () => {
    const s = await world(), a = await world({ kind: 'personal' });
    await sDeliver(s, 'customer.subscription.created');
    const ps = await gateway.summary({ customerId: s.id, userId: s.owner, usageFeatures: ['meetings.cloud_recording'] });
    assert.equal(ps.plan, 'pro'); assert.equal(ps.billingSource.id, 'stripe'); assert.ok(ps.renewsOn); assert.equal(ps.manage.kind, 'stripe_portal'); assert.equal(ps.canPurchase, false);
    assert.equal(ps.usage['meetings.cloud_recording'].allowed, true);
    await rDeliver(a, { store: 'APP_STORE' });
    const pa = await gateway.summary({ customerId: a.id, userId: a.owner });
    assert.equal(pa.billingSource.id, 'app_store'); assert.match(pa.manage.url, /apps\.apple\.com/);
    const g = await world({ kind: 'personal' }); await rDeliver(g, { store: 'PLAY_STORE', original_transaction_id: 'GPA.' + g.otx });
    assert.match((await gateway.summary({ customerId: g.id, userId: g.owner })).manage.url, /play\.google\.com/);
    const free = await world();
    const pf = await gateway.summary({ customerId: free.id, userId: free.owner });
    assert.equal(pf.plan, 'basic'); assert.equal(pf.status, 'none'); assert.equal(pf.canPurchase, true); assert.equal(pf.manage, null);
    assert.equal((await gateway.summary({ customerId: s.id, userId: s.member })).manage, null, 'a plain member sees the plan but not the management link');
    await assert.rejects(gateway.summary({ customerId: s.id, userId: 'stranger' }), { code: 'not_a_member' });
  });

  test('CROSS-DEVICE entitlement: a purchase made on a phone is visible to a fresh service instance (another device / server) immediately after the event', async () => {
    const w = await world({ kind: 'personal' });
    await rDeliver(w);
    const other = new AccessService({ pool: db.poolFor('runtime') });
    assert.equal((await other.canAccess(w.id, 'meetings.cloud_recording')).allowed, true);
    assert.ok(changed.includes(w.id), 'the change notification fired so caches are invalidated');
  });

  test('LEAST PRIVILEGE: the billing role cannot write entitlement overrides, staff or other customers\' directory rows', async () => {
    const p = db.poolFor('billing');
    for (const sql of [`INSERT INTO entitlement_overrides (customer_id, feature_key, value, created_by) VALUES (gen_random_uuid(),'x','{}','x')`,
      `UPDATE customers SET status='active'`, `INSERT INTO customer_members (customer_id,user_id,role,added_by) VALUES (gen_random_uuid(),'u','owner','x')`,
      `INSERT INTO billing_customers (provider, external_customer_id, customer_id, linked_by) VALUES ('stripe','cus_evil',gen_random_uuid(),'x')`]) {
      await assert.rejects(p.query(sql), (e) => e.code === '42501' || e.code === '23503', sql);
    }
    await assert.rejects(p.query(`SELECT qorlla_link_checkout_customer(gen_random_uuid(), 'cus_evil')`), /not open/);
  });
  // ---- added: the rules that make "one customer, one subscription, one channel" hold in the database and the processor ----------------

  test('STORE PURCHASES NEVER REACH AN ORGANIZATION: even if an administrator links one by mistake, the event is parked and alerted and grants nothing', async () => {
    const org = await world({ kind: 'organization' });                                    // rcLink = true: the (mistaken or malicious) link exists
    const r = await rDeliver(org);
    assert.equal(r.status, 'dead'); assert.equal(await row(org.id), undefined); assert.equal(await can(org.id), false);
    assert.ok((await sevents(org.id)).includes('store_purchase_for_non_personal'));
    // ...while the same customer's Stripe subscription is entirely unaffected by that attempt
    assert.equal((await sDeliver(org, 'customer.subscription.created')).status, 'applied'); assert.equal(await can(org.id), true);
  });

  test('A PERSONAL ACCOUNT IS ONE PERSON, ENFORCED BY THE DATABASE: no second member (even from the table owner), one per user, and the kind never changes', async () => {
    const me = await world({ kind: 'personal' }), org = await world({ kind: 'organization' });
    await assert.rejects(db.owner.query(`INSERT INTO customer_members (customer_id, user_id, role, added_by) VALUES ($1,'intruder','member','dba')`, [me.id]), { code: '23514' });
    await assert.rejects(db.owner.query(`UPDATE customers SET kind = 'organization' WHERE id = $1`, [me.id]), { code: '23514' }, 'a personal subscription cannot become a shared licence');
    await assert.rejects(db.owner.query(`UPDATE customers SET kind = 'personal' WHERE id = $1`, [org.id]), { code: '23514' }, 'nor an organization a personal account');
    await assert.rejects(db.owner.query(`INSERT INTO customers (name, created_by, kind) VALUES ('second', $1, 'personal')`, [me.owner]), { code: '23505' }, 'one personal account per user');
    await db.owner.query(`INSERT INTO customers (name, created_by, kind) VALUES ('another org', $1, 'organization')`, [me.owner]);   // organizations are unaffected
  });

  test('THE CHECKOUT-LINK FUNCTION is the only way a webhook role links a provider customer: closed/expired intents and customers linked elsewhere are refused', async () => {
    const bl = db.poolFor('billing');
    await assert.rejects(bl.query(`SELECT qorlla_link_checkout_customer(gen_random_uuid(), 'cus_x')`), /not open/);
    const w = await world({ stripeLink: false });
    const short = new BillingGateway({ pool: bl, stripe, prices: { pro: 'price_pro' }, urls: {}, intentTtlMs: 2500 });
    await short.beginCheckout({ customerId: w.id, userId: w.owner, provider: 'stripe', planCode: 'pro' });
    await assert.rejects(short.beginCheckout({ customerId: w.id, userId: w.owner, provider: 'stripe', planCode: 'pro' }), { code: 'checkout_in_progress' });
    await new Promise((r) => setTimeout(r, 2800));
    const open = (await db.owner.query(`SELECT id FROM checkout_intents WHERE customer_id=$1 AND status='open'`, [w.id])).rows[0].id;
    await assert.rejects(bl.query(`SELECT qorlla_link_checkout_customer($1, 'cus_late')`, [open]), /not open/, 'an expired intent can no longer link anything');
    assert.ok((await short.beginCheckout({ customerId: w.id, userId: w.owner, provider: 'stripe', planCode: 'pro' })).url, 'and it stopped blocking a new checkout');
    const other = await world();                                                          // other.ext is already linked to `other`
    const fresh = (await db.owner.query(`SELECT id FROM checkout_intents WHERE customer_id=$1 AND status='open'`, [w.id])).rows[0].id;
    await assert.rejects(bl.query(`SELECT qorlla_link_checkout_customer($1, $2)`, [fresh, other.ext]), { code: '23505' }, 'a provider customer linked elsewhere is never re-pointed');
  });

  test('WEBHOOK SECURITY: tampered Stripe body, stale timestamp, wrong RevenueCat authorization and production-mode sandbox events change nothing', async () => {
    const w = await world({ kind: 'personal' });
    const good = stripeEvent('customer.subscription.created', stripeSub({ id: w.sub, customer: w.ext, current_period_start: T - DAY, current_period_end: T + 30 * DAY, metadata: { qorlla_customer_id: w.id } }), { created: T });
    const tampered = { rawBody: Buffer.from(good.rawBody.toString().replace('"active"', '"trialing"')), headers: good.headers };
    await assert.rejects(billing.ingest({ provider: 'stripe', ...tampered, nowMs: T * 1000 }), /signature/i);
    await assert.rejects(billing.ingest({ provider: 'stripe', ...good, nowMs: (T + 3600) * 1000 }), /signature|tolerance/i, 'a captured webhook replayed an hour later');
    await assert.rejects(rDeliver(w, {}, 'Bearer ' + 'x'.repeat(40)), { name: 'SubscriptionError' });
    const prod = new BillingProcessor({ adapters: [rcAdapter({ acceptSandbox: false })], pool: db.poolFor('billing') });
    const sandbox = rcEvent({ app_user_id: w.id, original_transaction_id: w.otx, purchased_at_ms: (T - DAY) * 1000, expiration_at_ms: (T + 30 * DAY) * 1000, event_timestamp_ms: Date.now() });
    assert.equal((await prod.ingest({ provider: 'revenuecat', ...sandbox })).status, 'ignored', 'a sandbox purchase never grants production access');
    assert.equal(await can(w.id), false); assert.equal(await row(w.id), undefined);
  });

  test('STRIPE REFUND: the refund is recorded for operations and does not itself end access; the cancellation that follows does', async () => {
    const w = await world();
    await sDeliver(w, 'customer.subscription.created');
    const refund = stripeEvent('charge.refunded', { id: 'ch_1', object: 'charge', customer: w.ext, invoice: 'in_1', amount_refunded: 4900 }, { created: T + 1 });
    assert.equal((await billing.ingest({ provider: 'stripe', ...refund, nowMs: (T + 1) * 1000 })).status, 'applied');
    assert.equal((await db.owner.query(`SELECT count(*)::int n FROM billing_outbox WHERE customer_id=$1 AND topic='billing.invoice.refunded'`, [w.id])).rows[0].n, 1);
    assert.equal(await can(w.id), true);
    await sDeliver(w, 'customer.subscription.deleted', {}, { created: T + 2 });
    assert.equal(await can(w.id), false);
  });

  test('RECONCILIATION heals a MISSED Stripe cancellation from the provider\'s authoritative state', async () => {
    const w = await world();
    await sDeliver(w, 'customer.subscription.created'); assert.equal(await can(w.id), true);
    stripe.current = stripeSub({ id: w.sub, customer: w.ext, status: 'canceled', canceled_at: T, current_period_start: T - DAY, current_period_end: T + 30 * DAY });   // the webhook never arrived
    const fix = await billing.reconcile(w.id, 'stripe', stripeReconciler({ client: stripe, prices: PRICES }));
    assert.equal(fix.drift, true); assert.equal(await can(w.id), false);
  });

  test('LEAST PRIVILEGE (new objects): billing cannot rewrite purchase identities or intents beyond its job; runtime cannot create intents or link customers', async () => {
    const bl = db.poolFor('billing'), rt = db.poolFor('runtime');
    for (const sql of ['DELETE FROM purchase_identities', `UPDATE purchase_identities SET customer_id = gen_random_uuid()`, 'DELETE FROM checkout_intents']) await assert.rejects(bl.query(sql), { code: '42501' }, 'billing: ' + sql);
    for (const sql of [`INSERT INTO checkout_intents (customer_id, provider, plan_code, requested_by, expires_at) VALUES (gen_random_uuid(),'stripe','pro','x',now())`,
      `INSERT INTO purchase_identities (source, source_id, customer_id) VALUES ('stripe','x',gen_random_uuid())`, `SELECT qorlla_link_checkout_customer(gen_random_uuid(), 'x')`]) await assert.rejects(rt.query(sql), { code: '42501' }, 'runtime: ' + sql);
  });

});
