// The provider-neutral billing contract. The billing service (service.mjs) and everything above it depend ONLY on this shape; nothing provider-specific
// (field names, status words, event names, id formats) may cross it. Stripe is the first adapter (stripe-provider.mjs); tests/mock-provider.mjs is a second,
// deliberately differently-shaped deterministic one, which is how we prove the service is not coupled to Stripe.
//
//   interface BillingProvider {
//     name: string;                 // 'stripe', 'mock', ... stored with every row we write
//     signatureHeader: string;      // HTTP header that carries the webhook signature
//     createCheckoutSession(input: CheckoutInput): Promise<CheckoutSession>;
//     createCustomerPortalSession(input: PortalInput): Promise<PortalSession>;
//     getSubscription(id: string): Promise<ProviderSubscription>;
//     cancelSubscription(id: string): Promise<ProviderSubscription>;      // at period end: access continues until the paid period ends
//     resumeSubscription(id: string): Promise<ProviderSubscription>;      // undo a pending cancellation
//     listInvoices(customerId: string): Promise<Invoice[]>;
//     verifyWebhook(rawBody: Buffer, signature: string): Promise<BillingEvent>;   // throws WebhookSignatureError when the signature is not valid
//     extensions?: object;          // optional capabilities beyond the contract (plan changes, refunds, usage invoice items); absent = BillingError 501 provider_unsupported
//   }
//
// Neutral shapes (all money in integer minor units, all times ISO-8601 strings or null, all ids opaque strings):
//   CheckoutInput        { checkoutId, workspaceId, customerId|null, plan, interval:'month'|'year', seats, currency, unitAmountCents, successUrl, cancelUrl }
//   CheckoutSession      { id, url }
//   PortalInput          { customerId, returnUrl }
//   PortalSession        { url }                                     // short-lived, provider-hosted; the browser is redirected to it
//   ProviderSubscription { id, customerId|null, status:'active'|'trialing'|'past_due'|'canceled'|'incomplete'|'expired', currentPeriodStart, currentPeriodEnd,
//                          cancelAtPeriodEnd, canceledAt, quantity|null, unitAmountCents|null, currency|null, interval|null, metadata:{ checkoutId|null, workspaceId|null } }
//   Invoice              { id, number|null, status:'open'|'paid'|'void', currency, amountDueCents, amountPaidCents, hostedUrl|null, receiptUrl|null, periodStart, periodEnd,
//                          attemptCount, nextPaymentAttempt|null, subscriptionId|null, paymentIntentId|null, chargeId|null }
//   BillingEvent         { id, type, providerType, createdAt:<epoch seconds>, raw, malformed?:true, checkout?, invoice?, subscription?, refund? }
//       type is one of: 'checkout.completed' | 'checkout.expired' | 'invoice.paid' | 'invoice.payment_failed' | 'subscription.updated' | 'subscription.deleted'
//                     | 'refund.recorded' | 'ignored'; providerType is the provider's own name for it (kept for the evidence log only).
//       checkout { id, mode:'subscription'|string, workspaceId|null, subscriptionId|null, customerId|null }
//       refund   { invoiceId, amountRefundedCents, refunds:[{ id, amountCents, currency, reason|null }] }

export const CONTRACT_METHODS = ['createCheckoutSession', 'createCustomerPortalSession', 'getSubscription', 'cancelSubscription', 'resumeSubscription', 'listInvoices', 'verifyWebhook'];
export const EVENT_TYPES = ['checkout.completed', 'checkout.expired', 'invoice.paid', 'invoice.payment_failed', 'subscription.updated', 'subscription.deleted', 'refund.recorded', 'ignored'];
export const SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'canceled', 'incomplete', 'expired'];

export class WebhookSignatureError extends Error {}

/** Throws unless `p` implements the whole contract. Called once at start-up, so a half-written adapter can never run. */
export function assertBillingProvider(p) {
  if (!p || typeof p.name !== 'string' || !/^[a-z][a-z0-9_]{1,30}$/.test(p.name)) throw new Error('billing provider needs a short lowercase name');
  if (typeof p.signatureHeader !== 'string' || !p.signatureHeader) throw new Error('billing provider needs a signatureHeader');
  for (const m of CONTRACT_METHODS) if (typeof p[m] !== 'function') throw new Error(`billing provider "${p.name}" is missing ${m}()`);
  return p;
}
