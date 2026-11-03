// A deterministic, in-process BillingProvider TEST DOUBLE. It is deliberately NOT shaped like Stripe: its wire events use their own names ("payment_succeeded"),
// its ids have their own format, and nothing here uses Stripe field names. If the billing service only works against Stripe-shaped data, the lifecycle tests that run
// on this provider fail - that is their purpose. Never use outside tests; it moves no money and is not a real payment service.
import crypto from 'node:crypto';
import { assertBillingProvider, WebhookSignatureError } from '../server/billing/provider.mjs';

const KIND = { payment_succeeded: 'invoice.paid', payment_failed: 'invoice.payment_failed', subscription_changed: 'subscription.updated', subscription_ended: 'subscription.deleted',
  checkout_done: 'checkout.completed', checkout_lapsed: 'checkout.expired', refund_issued: 'refund.recorded' };

export function createMockProvider({ secret = 'mock-whsec-' + 'k'.repeat(24) } = {}) {
  const st = { seq: 0, sessions: new Map(), subs: new Map(), customers: new Set(), invoices: [], portal: [], calls: [], failCheckout: false, down: false };
  const id = (p) => `${p}-${String(++st.seq).padStart(5, '0')}`;
  const hmac = (body) => crypto.createHmac('sha256', secret).update(body).digest('hex');
  const live = () => { if (st.down) throw Object.assign(new Error('mock provider down'), { status: 503 }); };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const DAY = 86400000;

  const provider = assertBillingProvider({
    name: 'mock', signatureHeader: 'x-billing-signature',
    async createCheckoutSession(input) { live(); st.calls.push(['checkout', input]); if (st.failCheckout) throw Object.assign(new Error('declined'), { status: 402 }); const sid = id('mchk'); st.sessions.set(sid, input); return { id: sid, url: `https://pay.mock.test/${sid}` }; },
    async createCustomerPortalSession({ customerId, returnUrl }) { live(); if (!st.customers.has(customerId)) throw Object.assign(new Error('unknown customer'), { status: 404 }); st.portal.push({ customerId, returnUrl }); return { url: `https://portal.mock.test/${id('mprt')}` }; },
    async getSubscription(sid) { live(); const s = st.subs.get(sid); if (!s) throw Object.assign(new Error('unknown subscription'), { status: 404 }); return clone(s); },
    async cancelSubscription(sid) { live(); const s = st.subs.get(sid); if (!s) throw Object.assign(new Error('unknown subscription'), { status: 404 }); s.cancelAtPeriodEnd = true; return clone(s); },
    async resumeSubscription(sid) { live(); const s = st.subs.get(sid); if (!s) throw Object.assign(new Error('unknown subscription'), { status: 404 }); s.cancelAtPeriodEnd = false; return clone(s); },
    async listInvoices(customerId) { live(); return st.invoices.filter((i) => i._customer === customerId).map(({ _customer, ...inv }) => clone(inv)); },
    async verifyWebhook(rawBody, signature) {
      if (!Buffer.isBuffer(rawBody) || String(signature || '') !== hmac(rawBody)) throw new WebhookSignatureError('bad signature');
      let w; try { w = JSON.parse(rawBody.toString('utf8')); } catch { throw new WebhookSignatureError('not json'); }
      const type = KIND[w.kind] || 'ignored';
      const ev = { id: w.eventId, type, providerType: w.kind, createdAt: w.at, raw: w };
      if (!w.eventId || !w.kind) return { ...ev, malformed: true };
      if (type === 'invoice.paid' || type === 'invoice.payment_failed') ev.invoice = w.invoice;
      else if (type === 'subscription.updated' || type === 'subscription.deleted') ev.subscription = w.subscription;
      else if (type === 'checkout.completed' || type === 'checkout.expired') ev.checkout = w.checkout;
      else if (type === 'refund.recorded') ev.refund = w.refund;
      return ev;
    }
    // no `extensions`: plan changes, refunds and usage invoice items are not supported by this provider
  });

  /** What the customer's payment would have created at the provider, bound to the checkout WE created. */
  function pay(sessionId, { status = 'active', now = Date.now() } = {}) {
    const input = st.sessions.get(sessionId); if (!input) throw new Error('unknown session');
    const customerId = input.customerId || id('mcus'); st.customers.add(customerId);
    const sub = { id: id('msub'), customerId, status, currentPeriodStart: new Date(now).toISOString(), currentPeriodEnd: new Date(now + 30 * DAY).toISOString(), cancelAtPeriodEnd: false, canceledAt: null,
      quantity: input.seats, unitAmountCents: input.unitAmountCents, currency: input.currency, interval: input.interval, metadata: { checkoutId: input.checkoutId, workspaceId: input.workspaceId } };
    st.subs.set(sub.id, sub);
    const invoice = invoiceFor(sub, input.unitAmountCents * input.seats, 'paid');
    return { sub: clone(sub), invoice };
  }
  function invoiceFor(sub, amount, status = 'paid') {
    const inv = { id: id('minv'), number: 'M-' + st.seq, status, currency: sub.currency, amountDueCents: amount, amountPaidCents: status === 'paid' ? amount : 0, hostedUrl: `https://invoices.mock.test/${st.seq}`, receiptUrl: null,
      periodStart: sub.currentPeriodStart, periodEnd: sub.currentPeriodEnd, attemptCount: 1, nextPaymentAttempt: null, subscriptionId: sub.id, paymentIntentId: null, chargeId: null, _customer: sub.customerId };
    st.invoices.push(inv); const { _customer, ...pub } = inv; return clone(pub);
  }
  /** A signed wire message exactly as the provider would POST it. */
  function wire(kind, payload, { eventId = id('mev'), at = Math.floor(Date.now() / 1000), secretOverride } = {}) {
    const body = JSON.stringify({ eventId, kind, at, ...payload }); const sig = secretOverride ? crypto.createHmac('sha256', secretOverride).update(body).digest('hex') : hmac(body);
    return { body, signature: sig, eventId };
  }
  async function deliver(base, message) {
    const r = await fetch(base + '/api/v1/billing/webhook', { method: 'POST', headers: { 'content-type': 'application/json', [provider.signatureHeader]: message.signature }, body: message.body });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }
  return { provider, st, secret, pay, invoiceFor, wire, deliver, extendPeriod: (sid, ms) => { const s = st.subs.get(sid); s.currentPeriodEnd = new Date(Date.parse(s.currentPeriodEnd) + ms).toISOString(); } };
}
