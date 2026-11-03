// Stripe adapter behind the provider-neutral contract (provider.mjs). ALL Stripe vocabulary lives here and in stripe.mjs: status words, event names,
// period fields that moved between API versions, form encoding. The service only ever sees the neutral shapes.
import { assertBillingProvider, WebhookSignatureError as NeutralSignatureError } from './provider.mjs';
import { WebhookSignatureError } from './stripe.mjs';

const STATUS = { active: 'active', trialing: 'trialing', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', incomplete: 'incomplete', incomplete_expired: 'expired', paused: 'past_due' };
const EVENT = { 'checkout.session.completed': 'checkout.completed', 'checkout.session.expired': 'checkout.expired', 'invoice.paid': 'invoice.paid', 'invoice.payment_failed': 'invoice.payment_failed',
  'customer.subscription.updated': 'subscription.updated', 'customer.subscription.deleted': 'subscription.deleted', 'charge.refunded': 'refund.recorded' };
const iso = (s) => (s == null ? null : new Date(Number(s) * 1000).toISOString());
const subIdOfInvoice = (inv) => inv.subscription || inv.parent?.subscription_details?.subscription || null;
const periodOf = (sub) => ({ start: sub.current_period_start ?? sub.items?.data?.[0]?.current_period_start ?? null, end: sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null });

export function normalizeSubscription(sub) {
  const item = sub.items?.data?.[0], p = periodOf(sub);
  return { id: sub.id, customerId: sub.customer || null, status: STATUS[sub.status] || 'incomplete', currentPeriodStart: iso(p.start), currentPeriodEnd: iso(p.end),
    cancelAtPeriodEnd: !!sub.cancel_at_period_end, canceledAt: iso(sub.canceled_at), quantity: item?.quantity ?? null, unitAmountCents: item?.price?.unit_amount ?? null,
    currency: (item?.price?.currency || '').toLowerCase() || null, interval: item?.price?.recurring?.interval ?? null,
    metadata: { checkoutId: sub.metadata?.checkout_id ?? null, workspaceId: sub.metadata?.workspace_id ?? null } };
}
export function normalizeInvoice(inv) {
  return { id: inv.id, number: inv.number || null, status: inv.status === 'paid' ? 'paid' : (inv.status === 'void' || inv.status === 'uncollectible') ? 'void' : 'open', currency: (inv.currency || 'usd').toLowerCase(),
    amountDueCents: inv.amount_due ?? 0, amountPaidCents: inv.amount_paid ?? 0, hostedUrl: inv.hosted_invoice_url || null, receiptUrl: inv.invoice_pdf || null,
    periodStart: iso(inv.period_start), periodEnd: iso(inv.period_end), attemptCount: inv.attempt_count ?? 0, nextPaymentAttempt: iso(inv.next_payment_attempt),
    subscriptionId: subIdOfInvoice(inv), paymentIntentId: typeof inv.payment_intent === 'string' ? inv.payment_intent : null, chargeId: typeof inv.charge === 'string' ? inv.charge : null };
}
export function normalizeEvent(ev) {
  const obj = ev?.data?.object;
  const out = { id: ev?.id, type: EVENT[ev?.type] || 'ignored', providerType: ev?.type, createdAt: ev?.created, raw: ev };
  if (!ev?.id || !ev?.type || !obj) return { ...out, malformed: true };
  if (out.type === 'checkout.completed' || out.type === 'checkout.expired') out.checkout = { id: obj.id, mode: obj.mode, workspaceId: obj.metadata?.workspace_id ?? null, subscriptionId: obj.subscription || null, customerId: obj.customer || null };
  else if (out.type === 'invoice.paid' || out.type === 'invoice.payment_failed') out.invoice = normalizeInvoice(obj);
  else if (out.type === 'subscription.updated' || out.type === 'subscription.deleted') out.subscription = normalizeSubscription(obj);
  else if (out.type === 'refund.recorded') out.refund = { invoiceId: obj.invoice || null, amountRefundedCents: obj.amount_refunded ?? 0, refunds: (obj.refunds?.data || []).map((rf) => ({ id: rf.id, amountCents: rf.amount, currency: (rf.currency || 'usd').toLowerCase(), reason: rf.reason || null })) };
  return out;
}

/** `raw` is the low-level client from createStripe(); this wraps it into the neutral contract. */
export function createStripeProvider(raw) {
  return assertBillingProvider({
    name: 'stripe',
    signatureHeader: 'stripe-signature',
    createCheckoutSession: async (i) => { const s = await raw.createCheckoutSession({ ...i, customer: i.customerId || undefined }); return { id: s.id, url: s.url }; },
    createCustomerPortalSession: async ({ customerId, returnUrl }) => { const s = await raw.createPortalSession({ customer: customerId, returnUrl }); return { url: s.url }; },
    getSubscription: async (id) => normalizeSubscription(await raw.retrieveSubscription(id)),
    cancelSubscription: async (id) => normalizeSubscription(await raw.cancelAtPeriodEnd(id)),
    resumeSubscription: async (id) => normalizeSubscription(await raw.resumeSubscription(id)),
    listInvoices: async (customerId) => ((await raw.listInvoices(customerId)).data || []).map(normalizeInvoice),
    verifyWebhook: async (rawBody, signature) => {
      let ev; try { ev = raw.verifyWebhook(rawBody, signature); } catch (e) { throw e instanceof WebhookSignatureError ? new NeutralSignatureError(e.message) : e; }
      return normalizeEvent(ev);
    },
    // Stripe-shaped capabilities beyond the contract (plan changes, refunds, usage invoice items). The launch module consumes these; a provider without them gets 501.
    extensions: { ...raw, normalizeSubscription }
  });
}
