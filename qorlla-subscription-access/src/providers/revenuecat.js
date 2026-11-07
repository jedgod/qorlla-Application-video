/**
 * RevenueCat adapter (Apple App Store + Google Play). RevenueCat webhooks are NOT body-signed: they carry the Authorization header
 * value you configure in the RevenueCat dashboard. Verification is therefore a constant-time compare of that shared secret (several
 * secrets = rotation); replay protection is the inbox (provider, event id) uniqueness plus revision ordering.
 *
 * Rules enforced here (each one is tested):
 *  - Events whose store is STRIPE are mirrors of purchases Stripe already reports: ignored, so one purchase is never applied twice.
 *  - SANDBOX events are refused unless acceptSandbox is set (never in production configuration).
 *  - PROMOTIONAL and anything unrecognised is ignored: complimentary access is granted through audited overrides, not store events.
 *  - app_user_id must be the Qorlla customer id; anonymous ids ($RCAnonymousID:...) never map to a customer.
 *  - Revision = event_timestamp_ms; subscription identity = original_transaction_id (stable across renewals).
 */

import { timingSafeEqual, createHash } from 'node:crypto';
import { BillingEventError } from '../errors.js';

const STORE_SOURCE = { APP_STORE: 'app_store', MAC_APP_STORE: 'app_store', PLAY_STORE: 'play_store' };
const ms = (v) => (Number.isFinite(Number(v)) && v != null ? new Date(Number(v)).toISOString() : undefined);

export function createRevenueCatAdapter({ secrets, products, acceptSandbox = false } = {}) {
  const keys = (Array.isArray(secrets) ? secrets : [secrets]).filter((s) => typeof s === 'string' && s.length >= 32);
  if (!keys.length) throw new Error('at least one webhook authorization secret of 32+ characters is required');
  if (!products || !Object.keys(products).length) throw new Error('a product -> plan map is required');
  const digest = (s) => createHash('sha256').update(s).digest();

  return {
    provider: 'revenuecat',
    verify(rawBody, headers = {}) {
      if (!Buffer.isBuffer(rawBody)) return { ok: false, reason: 'raw_body_required' };
      const h = headers.authorization ?? headers.Authorization;
      if (typeof h !== 'string' || h.length > 512) return { ok: false, reason: 'missing_authorization' };
      const given = digest(h.replace(/^Bearer\s+/i, ''));
      let match = false;
      for (const k of keys) if (timingSafeEqual(given, digest(k))) match = true;       // fixed-size digests, no early exit
      return match ? { ok: true } : { ok: false, reason: 'authorization_mismatch' };
    },
    parse(rawBody) {
      const e = JSON.parse(rawBody.toString('utf8'))?.event;
      if (!e || typeof e.id !== 'string') throw new BillingEventError('revenuecat event expected');
      const base = { provider: 'revenuecat', eventId: e.id };
      const ignore = (why) => ({ ...base, type: 'revenuecat.ignored.' + why });
      if (e.environment === 'SANDBOX' && !acceptSandbox) return ignore('sandbox');
      if (e.store === 'STRIPE') return ignore('stripe_mirror');
      const source = STORE_SOURCE[e.store];
      if (!source) return ignore('store');
      if (typeof e.app_user_id !== 'string' || e.app_user_id.startsWith('$RCAnonymousID:')) return ignore('anonymous');

      const planCode = products[e.product_id];
      const common = { ...base, externalCustomerId: e.app_user_id, occurredAt: ms(e.event_timestamp_ms), revision: Number.isSafeInteger(e.event_timestamp_ms) ? e.event_timestamp_ms : undefined,
        purchase: { source, id: e.original_transaction_id } };
      const snap = (status, extra = {}) => {
        if (!planCode) throw new BillingEventError('revenuecat product is not mapped to a Qorlla plan');
        if (typeof e.original_transaction_id !== 'string') throw new BillingEventError('original_transaction_id required');
        return { externalId: e.original_transaction_id, planCode, status, currentPeriodStart: ms(e.purchased_at_ms), currentPeriodEnd: ms(e.expiration_at_ms), ...extra };
      };
      switch (e.type) {
        case 'INITIAL_PURCHASE': return { ...common, type: 'subscription.created', subscription: snap(e.period_type === 'TRIAL' ? 'trialing' : 'active', e.period_type === 'TRIAL' ? { trialEndsAt: ms(e.expiration_at_ms) } : {}) };
        case 'RENEWAL': return { ...common, type: 'invoice.paid', subscription: snap('active') };
        case 'UNCANCELLATION': case 'PRODUCT_CHANGE': return { ...common, type: 'subscription.updated', subscription: snap('active') };
        case 'CANCELLATION':
          // UNSUBSCRIBE / BILLING_ERROR: access continues to the end of the paid period. A refund or developer cancellation ends it now.
          if (e.cancel_reason === 'CUSTOMER_SUPPORT' || e.cancel_reason === 'DEVELOPER_INITIATED') return { ...common, type: 'subscription.canceled', subscription: snap('canceled', { canceledAt: ms(e.event_timestamp_ms) }) };
          return { ...common, type: 'subscription.updated', subscription: snap('active', { cancelAtPeriodEnd: true, canceledAt: ms(e.event_timestamp_ms) }) };
        case 'EXPIRATION': return { ...common, type: 'subscription.canceled', subscription: snap('expired') };
        case 'BILLING_ISSUE': return { ...common, type: 'invoice.payment_failed', subscription: snap('past_due', { gracePeriodEndsAt: ms(e.grace_period_expiration_at_ms ?? e.expiration_at_ms) }), invoice: { id: e.transaction_id ?? e.id } };
        case 'SUBSCRIPTION_PAUSED': return { ...common, type: 'subscription.paused', subscription: snap('paused', { pausedAt: ms(e.event_timestamp_ms) }) };
        default: return ignore('type');                                                  // TRANSFER, TEST, NON_RENEWING_PURCHASE, ...
      }
    },
  };
}

/** Receives the webhook and answers RevenueCat's expectation (any 2xx = delivered). */
export const revenuecatReconciler = ({ fetchSubscriber, products, now = Date.now }) => async ({ externalCustomerId }) => {
  const s = await fetchSubscriber(externalCustomerId);                                  // injected: RevenueCat REST v1 GET /subscribers/{id} with a server key
  if (!s) return null;
  return { revision: now(), subscription: { ...s, planCode: products[s.productId] ?? s.planCode } };
};
