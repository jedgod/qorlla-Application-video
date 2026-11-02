// Stripe adapter (Checkout Sessions + Billing). Talks to the REAL API only when configured with a secret key; the base URL
// can be overridden solely outside production (tests use a local test double - see tests/fake-stripe.mjs).
// Webhook authenticity is established by verifying Stripe's HMAC-SHA256 signature over the RAW request body.
import crypto from 'node:crypto';

export class ProviderError extends Error {
  constructor(status, message, code) { super(message || 'Provider error'); this.status = status; this.code = code; }
}
export class WebhookSignatureError extends Error {}

/** Flatten nested objects/arrays to Stripe's form encoding: a[b][0][c]=v */
export function encodeForm(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? encodeForm(item, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === 'object') encodeForm(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

/** Verify a Stripe-Signature header against the raw body. Throws WebhookSignatureError; returns the parsed event on success. */
export function verifyWebhook(rawBody, header, secret, { toleranceSeconds = 300, now = () => Date.now() } = {}) {
  if (!secret) throw new WebhookSignatureError('webhook secret not configured');
  if (!Buffer.isBuffer(rawBody)) throw new WebhookSignatureError('raw body required'); // parsed JSON can never verify
  const parts = String(header || '').split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !/^\d+$/.test(t) || !sigs.length) throw new WebhookSignatureError('malformed signature header');
  if (Math.abs(now() / 1000 - Number(t)) > toleranceSeconds) throw new WebhookSignatureError('timestamp outside tolerance');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  const ok = sigs.some((s) => { const b = Buffer.from(s, 'hex'); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
  if (!ok) throw new WebhookSignatureError('signature mismatch');
  try { return JSON.parse(rawBody.toString('utf8')); } catch { throw new WebhookSignatureError('body is not JSON'); }
}

/** Test helper / documentation of the scheme: produce a valid header for a payload. */
export function signPayload(rawBody, secret, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${timestampSeconds}.`).update(rawBody).digest('hex');
  return `t=${timestampSeconds},v1=${sig}`;
}

export function createStripe({ secretKey, webhookSecret, apiBase = 'https://api.stripe.com', fetchImpl = fetch, now = () => Date.now() }) {
  async function api(method, path, body, headers = {}) {
    const res = await fetchImpl(apiBase + path, {
      method,
      headers: { authorization: `Bearer ${secretKey}`, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
      body: body ? encodeForm(body).toString() : undefined,
      signal: AbortSignal.timeout(10000)
    });
    let json = {}; try { json = await res.json(); } catch { /* non-JSON error */ }
    if (!res.ok) throw new ProviderError(res.status, json.error?.message || `provider HTTP ${res.status}`, json.error?.code);
    return json;
  }
  return {
    name: 'stripe',
    verifyWebhook: (raw, header) => verifyWebhook(raw, header, webhookSecret, { now }),
    createCheckoutSession: ({ checkoutId, workspaceId, customer, plan, interval, seats, currency, unitAmountCents, successUrl, cancelUrl }) =>
      api('POST', '/v1/checkout/sessions', {
        mode: 'subscription',
        success_url: successUrl, cancel_url: cancelUrl,
        client_reference_id: checkoutId,
        customer: customer || undefined,
        line_items: [{ quantity: seats, price_data: { currency, unit_amount: unitAmountCents, recurring: { interval }, product_data: { name: `Qorlla Workplace ${plan} (${interval === 'year' ? 'annual' : 'monthly'})` } } }],
        metadata: { checkout_id: checkoutId, workspace_id: workspaceId },
        subscription_data: { metadata: { checkout_id: checkoutId, workspace_id: workspaceId } }
      }, { 'idempotency-key': `checkout-${checkoutId}` }),
    retrieveSubscription: (id) => api('GET', `/v1/subscriptions/${encodeURIComponent(id)}`),
    cancelAtPeriodEnd: (id) => api('POST', `/v1/subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: 'true' }),
    /** Change the price/quantity of the subscription's single item. prorationBehavior: 'always_invoice' (upgrade, charged now) or 'none' (downgrade at renewal). */
    changeSubscription: ({ id, itemId, product, currency, unitAmountCents, interval, quantity, prorationBehavior, changeId }) =>
      api('POST', `/v1/subscriptions/${encodeURIComponent(id)}`, {
        items: [{ id: itemId, quantity, price_data: { currency, product, unit_amount: unitAmountCents, recurring: { interval } } }],
        proration_behavior: prorationBehavior, metadata: { plan_change_id: changeId }
      }, { 'idempotency-key': `planchange-${changeId}-${prorationBehavior}` }),
    /** Refund part or all of a payment. The reason text stays in OUR records; the provider only accepts its own enumeration. */
    createRefund: ({ paymentIntent, amountCents, requestId, workspaceId, idempotencyKey }) =>
      api('POST', '/v1/refunds', { payment_intent: paymentIntent, amount: amountCents, reason: 'requested_by_customer', metadata: { refund_request_id: requestId, workspace_id: workspaceId } }, { 'idempotency-key': idempotencyKey }),
    /** A one-off line that the provider adds to the customer's next invoice (used for AI overage). */
    createInvoiceItem: ({ customer, amountCents, currency, description, metadata, idempotencyKey }) =>
      api('POST', '/v1/invoiceitems', { customer, amount: amountCents, currency, description, metadata }, { 'idempotency-key': idempotencyKey })
  };
}
