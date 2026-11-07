/**
 * Stripe Billing adapter (web, desktop, enterprise). Webhook signature scheme: `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>]` =
 * HMAC-SHA256(`${t}.${rawBody}`) with the endpoint secret (several v1 values / several secrets = rotation) - the same scheme as the
 * reference adapter, so verification is shared. This module adds Stripe's event shapes, the price -> plan map, and a minimal REST client.
 *
 * Revision: Stripe events carry no version counter, so revision = event.created * 1000 (ms). Two events created in the same second tie and
 * the second is treated as stale; reconcile() (which uses the API's current state and a later revision) heals that. Documented, tested.
 *
 * Nothing here holds a live key: `createStripeClient({ secretKey, fetchImpl })` takes the key at runtime; with none configured every call fails closed.
 */

import { createSignedJsonAdapter } from '../billingAdapters.js';
import { BillingEventError } from '../errors.js';

const STATUS = { trialing: 'trialing', active: 'active', past_due: 'past_due', canceled: 'canceled', unpaid: 'expired', incomplete: 'incomplete', incomplete_expired: 'expired', paused: 'paused' };
const iso = (sec) => (sec == null ? undefined : new Date(Number(sec) * 1000).toISOString());

/** Stripe subscription object -> neutral snapshot. `prices` maps price id -> Qorlla plan code. */
export function snapshotFromStripeSubscription(sub, { prices, graceMs, nowMs }) {
  if (!sub || typeof sub.id !== 'string') throw new BillingEventError('stripe subscription object expected');
  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id;
  const planCode = prices[priceId];
  if (!planCode) throw new BillingEventError('stripe price is not mapped to a Qorlla plan');
  if ((sub.items?.data || []).length > 1) throw new BillingEventError('multi-item subscriptions are not supported');
  let status = STATUS[sub.status];
  if (!status) throw new BillingEventError('unknown stripe subscription status');
  if (sub.pause_collection && status === 'active') status = 'paused';
  const start = sub.current_period_start ?? item?.current_period_start, end = sub.current_period_end ?? item?.current_period_end;
  return {
    externalId: sub.id, planCode, status, quantity: item?.quantity ?? 1,
    trialEndsAt: iso(sub.trial_end), currentPeriodStart: iso(start), currentPeriodEnd: iso(end),
    gracePeriodEndsAt: status === 'past_due' ? new Date(nowMs + graceMs).toISOString() : undefined,
    cancelAtPeriodEnd: sub.cancel_at_period_end === true, canceledAt: iso(sub.canceled_at),
    pausedAt: status === 'paused' ? new Date(nowMs).toISOString() : undefined,
  };
}

export function createStripeAdapter({ secrets, prices, graceMs = 3 * 86_400_000 } = {}) {
  if (!prices || !Object.keys(prices).length) throw new Error('a price -> plan map is required');
  const base = createSignedJsonAdapter({ provider: 'stripe', secrets, header: 'stripe-signature' });
  return {
    ...base,
    parse(rawBody) {
      const e = JSON.parse(rawBody.toString('utf8'));
      const o = e?.data?.object;
      const out = { provider: 'stripe', eventId: e.id, occurredAt: iso(e.created), revision: Number.isSafeInteger(e.created) ? e.created * 1000 : undefined };
      if (typeof o?.customer !== 'string') return { ...out, type: 'stripe.unhandled' };
      out.externalCustomerId = o.customer;
      switch (e.type) {
        case 'customer.subscription.created': case 'customer.subscription.updated': case 'customer.subscription.deleted': {
          const type = e.type.endsWith('created') ? 'subscription.created' : e.type.endsWith('deleted') ? 'subscription.canceled' : 'subscription.updated';
          const subscription = snapshotFromStripeSubscription(e.type.endsWith('deleted') ? { ...o, status: 'canceled', canceled_at: o.canceled_at ?? e.created } : o,
            { prices, graceMs, nowMs: e.created * 1000 });
          return { ...out, type, subscription, purchase: { source: 'stripe', id: o.id }, claimedCustomerId: o.metadata?.qorlla_customer_id };
        }
        case 'customer.subscription.trial_will_end': return { ...out, type: 'subscription.trial_ending' };
        case 'invoice.paid': return { ...out, type: 'invoice.paid', invoice: { id: o.id, amount: o.amount_paid, subscription: o.subscription ?? null }, revision: undefined };
        case 'invoice.payment_failed': return { ...out, type: 'invoice.payment_failed', invoice: { id: o.id, amount: o.amount_due, subscription: o.subscription ?? null }, revision: undefined };
        case 'charge.refunded': return { ...out, type: 'invoice.refunded', invoice: { id: o.invoice ?? o.id, refunded: o.amount_refunded }, revision: undefined };
        default: return { ...out, type: 'stripe.unhandled' };
      }
    },
  };
}

/**
 * Minimal Stripe REST client over an injected `fetchImpl` (global fetch by default). Only what the gateway needs.
 * The secret key never leaves this closure and is never logged.
 */
export function createStripeClient({ secretKey, fetchImpl = globalThis.fetch, baseUrl = 'https://api.stripe.com' } = {}) {
  const call = async (method, path, params) => {
    if (!secretKey) throw new Error('stripe_not_configured');
    const body = params ? new URLSearchParams(params).toString() : undefined;
    const res = await fetchImpl(baseUrl + path, { method, headers: { authorization: `Bearer ${secretKey}`, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body });
    const json = await res.json();
    if (!res.ok) throw new Error('stripe_error_' + (json?.error?.code || res.status));
    return json;
  };
  return {
    createCustomer: ({ qorllaCustomerId, name }) => call('POST', '/v1/customers', { name, 'metadata[qorlla_customer_id]': qorllaCustomerId }),
    createCheckoutSession: ({ customer, price, successUrl, cancelUrl, qorllaCustomerId, quantity = 1 }) => call('POST', '/v1/checkout/sessions', {
      mode: 'subscription', customer, 'line_items[0][price]': price, 'line_items[0][quantity]': String(quantity), success_url: successUrl, cancel_url: cancelUrl,
      'subscription_data[metadata][qorlla_customer_id]': qorllaCustomerId }),
    createPortalSession: ({ customer, returnUrl }) => call('POST', '/v1/billing_portal/sessions', { customer, return_url: returnUrl }),
    retrieveSubscription: (id) => call('GET', `/v1/subscriptions/${encodeURIComponent(id)}`),
  };
}

/** `fetchSnapshot` for BillingProcessor.reconcile: the API's current state, revisioned at fetch time. */
export const stripeReconciler = ({ client, prices, graceMs = 3 * 86_400_000, now = Date.now }) => async ({ externalId }) => {
  if (!externalId) return null;
  const nowMs = now();
  return { revision: nowMs, subscription: snapshotFromStripeSubscription(await client.retrieveSubscription(externalId), { prices, graceMs, nowMs }) };
};
