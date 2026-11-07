/**
 * BillingGateway - what the web tier calls on behalf of a signed-in member. Runs with the `qorlla_sub_billing` role; holds no payment
 * credential beyond the Stripe key handed to its client at runtime. It never grants access: access is decided only by the
 * subscription engine from verified webhook events. The gateway's job is to start a purchase safely and to say where to manage one.
 *
 *  - Authorization is read LIVE from the directory: only an owner/admin (organization) or the owner (personal) may start a purchase.
 *  - Personal vs organization: App Store / Google Play (RevenueCat) purchases belong to PERSONAL customers only; organization licences
 *    are bought through Stripe (invoices, seats). The two never share a subscription.
 *  - No double billing: a LIVE subscription from any provider blocks a new checkout (409 with the right management destination);
 *    one open checkout per customer is enforced by a unique index, so two clicks or two devices cannot start two.
 *  - Provider-specific management: Stripe -> billing portal; Apple -> App Store subscriptions; Google -> Play subscriptions.
 */

import { randomUUID } from 'node:crypto';
import { withTx } from './db.js';
import { ensureSearchPath } from './schema.js';
import { SubscriptionError } from './errors.js';

const MANAGE_URL = { app_store: 'https://apps.apple.com/account/subscriptions', play_store: 'https://play.google.com/store/account/subscriptions' };
const SOURCE_LABEL = { stripe: 'Stripe (web / desktop / invoice)', app_store: 'Apple App Store', play_store: 'Google Play' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BillingGateway {
  constructor({ pool, stripe, prices, urls = {}, access, intentTtlMs = 30 * 60_000 } = {}) {
    if (!pool) throw new Error('BillingGateway requires a pool (qorlla_sub_billing)');
    this.pool = pool; this.stripe = stripe; this.prices = prices || {}; this.urls = urls; this.access = access; this.ttl = intentTtlMs;
  }

  async _actor(c, customerId, userId) {
    const r = (await c.query(
      `SELECT c.kind, c.status, c.name, m.role FROM customers c LEFT JOIN customer_members m ON m.customer_id = c.id AND m.user_id = $2 WHERE c.id = $1`,
      [customerId, userId])).rows[0];
    if (!r || !r.role) throw new SubscriptionError('Not a member of this customer', 'not_a_member', {}, 403);
    if (r.status !== 'active') throw new SubscriptionError('This account is suspended', 'customer_suspended', {}, 403);
    return r;
  }

  async _live(c, customerId) {
    return (await c.query(
      `SELECT s.provider, s.plan_code, s.status, s.current_period_end,
              (SELECT source FROM purchase_identities p WHERE p.customer_id = s.customer_id ORDER BY recorded_at DESC LIMIT 1) AS source
         FROM subscriptions s WHERE s.customer_id = $1
          AND s.status IN ('active','trialing','past_due','paused')
          AND greatest(s.current_period_end, coalesce(s.grace_period_ends_at, s.current_period_end)) > now()`, [customerId])).rows[0] || null;
  }

  /** Where this customer manages the subscription they already have (the provider that bills it). */
  async manageDestination(customerId, userId, live) {
    if (live.provider === 'stripe') {
      const link = (await this.pool.query(`SELECT external_customer_id FROM billing_customers WHERE provider = 'stripe' AND customer_id = $1`, [customerId])).rows[0];
      if (!link || !this.stripe) return { kind: 'stripe_portal', url: null, unavailable: true };
      const s = await this.stripe.createPortalSession({ customer: link.external_customer_id, returnUrl: this.urls.returnUrl });
      return { kind: 'stripe_portal', url: s.url };
    }
    return { kind: live.source || 'store', url: MANAGE_URL[live.source] || null };
  }

  /**
   * @param {{customerId:string, userId:string, provider:'stripe'|'revenuecat', planCode:string}} req
   * @returns stripe: { provider, intentId, url }   revenuecat: { provider, intentId, appUserId } (the store does the checkout)
   */
  async beginCheckout({ customerId, userId, provider, planCode }) {
    await ensureSearchPath(this.pool);
    if (!UUID_RE.test(customerId || '')) throw new SubscriptionError('invalid customer', 'invalid_customer', {}, 400);
    if (!['stripe', 'revenuecat'].includes(provider)) throw new SubscriptionError('unknown payment channel', 'unknown_provider', {}, 400);
    if (provider === 'stripe' && !this.prices[planCode]) throw new SubscriptionError('plan is not purchasable', 'plan_not_purchasable', {}, 400);

    const intentId = randomUUID();
    const cid = customerId.toLowerCase();
    await withTx(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`sub:${cid}`]);
      const a = await this._actor(c, cid, userId);
      const allowed = a.kind === 'personal' ? a.role === 'owner' : ['owner', 'admin'].includes(a.role);
      if (!allowed) throw new SubscriptionError('Only an owner or administrator can purchase', 'not_authorized', {}, 403);
      if (provider === 'revenuecat' && a.kind !== 'personal') throw new SubscriptionError('Store purchases are for personal accounts; organizations subscribe through Stripe', 'channel_not_allowed', {}, 409);
      const live = await this._live(c, cid);
      if (live) throw Object.assign(new SubscriptionError('This account already has an active subscription', 'already_subscribed', { provider: live.provider, plan: live.plan_code, source: live.source }, 409), { live });
      await c.query(`UPDATE checkout_intents SET status = 'expired' WHERE customer_id = $1 AND status = 'open' AND expires_at <= now()`, [cid]);
      try {
        await c.query(`INSERT INTO checkout_intents (id, customer_id, provider, plan_code, requested_by, expires_at) VALUES ($1,$2,$3,$4,$5, now() + $6 * interval '1 millisecond')`,
          [intentId, cid, provider, planCode, userId, this.ttl]);
      } catch (e) {
        if (e.code === '23505') throw new SubscriptionError('A checkout is already in progress for this account', 'checkout_in_progress', {}, 409);
        throw e;
      }
    }).catch(async (e) => {
      if (e.code === 'already_subscribed') e.details.manage = await this.manageDestination(cid, userId, e.live).catch(() => null);
      throw e;
    });

    try {
      if (provider === 'revenuecat') {
        // The RevenueCat app user id IS the Qorlla customer id; the link is written by the intent, never by a webhook.
        await this.pool.query('SELECT qorlla_link_checkout_customer($1, $2)', [intentId, cid]);
        return { provider, intentId, appUserId: cid };
      }
      if (!this.stripe) throw new SubscriptionError('Stripe is not configured', 'provider_unavailable', {}, 503);
      let link = (await this.pool.query(`SELECT external_customer_id FROM billing_customers WHERE provider = 'stripe' AND customer_id = $1`, [cid])).rows[0];
      let ext = link?.external_customer_id;
      if (!ext) {
        const name = (await this.pool.query('SELECT name FROM customers WHERE id = $1', [cid])).rows[0]?.name;
        ext = (await this.stripe.createCustomer({ qorllaCustomerId: cid, name })).id;
      }
      await this.pool.query('SELECT qorlla_link_checkout_customer($1, $2)', [intentId, ext]);
      const session = await this.stripe.createCheckoutSession({ customer: ext, price: this.prices[planCode], qorllaCustomerId: cid, successUrl: this.urls.success, cancelUrl: this.urls.cancel });
      return { provider, intentId, url: session.url };
    } catch (e) {
      await this.pool.query(`UPDATE checkout_intents SET status = 'canceled' WHERE id = $1 AND status = 'open'`, [intentId]).catch(() => {});
      throw e instanceof SubscriptionError ? e : new SubscriptionError('The payment provider is unavailable', 'provider_unavailable', {}, 503);
    }
  }

  /** The unified subscription page: plan, renewal, billing source, usage, and where to manage it. */
  async summary({ customerId, userId, usageFeatures = [] }) {
    await ensureSearchPath(this.pool);
    if (!UUID_RE.test(customerId || '')) throw new SubscriptionError('invalid customer', 'invalid_customer', {}, 400);
    const cid = customerId.toLowerCase();
    const a = await this._actor(this.pool, cid, userId);
    const s = (await this.pool.query(
      `SELECT s.provider, s.plan_code, s.status, s.current_period_end, s.cancel_at_period_end, s.grace_period_ends_at, s.trial_ends_at,
              (SELECT source FROM purchase_identities p WHERE p.customer_id = s.customer_id ORDER BY recorded_at DESC LIMIT 1) AS source
         FROM subscriptions s WHERE s.customer_id = $1`, [cid])).rows[0];
    const live = s ? await this._live(this.pool, cid) : null;
    const usage = {};
    if (this.access) for (const f of usageFeatures) {
      const d = await this.access.canAccess(cid, f).catch(() => null);
      usage[f] = d ? { allowed: d.allowed, reason: d.reason, limit: d.limit ?? null, used: d.used ?? null } : { error: 'unavailable' };
    }
    const key = live ? (live.provider === 'stripe' ? 'stripe' : live.source) : null;
    const canManage = ['owner', 'admin'].includes(a.role);
    return {
      account: { kind: a.kind, name: a.name, role: a.role },
      plan: live ? s.plan_code : 'basic', status: live ? s.status : (s ? 'ended' : 'none'),
      renewsOn: live && !s.cancel_at_period_end ? s.current_period_end : null,
      endsOn: live && s.cancel_at_period_end ? s.current_period_end : null,
      billingSource: key ? { id: key, label: SOURCE_LABEL[key] || key } : null,
      manage: live && canManage ? await this.manageDestination(cid, userId, live).catch(() => ({ unavailable: true })) : null,
      canPurchase: !live && (a.kind === 'personal' ? a.role === 'owner' : canManage),
      usage,
    };
  }
}
