// A billing PROVIDER SIMULATOR: models the subscription state machine of a generic provider and emits correctly signed neutral events
// with monotonically increasing revisions. It is NOT a real provider: it certifies the provider-neutral contract (and is the template a
// real provider's sandbox run must satisfy), nothing more.
import { createSignedJsonAdapter } from '../../src/billingAdapters.js';

export const SIM_SECRET = 's'.repeat(40);
export const simAdapter = () => createSignedJsonAdapter({ provider: 'sim', secrets: [SIM_SECRET] });

export class ProviderSim {
  constructor({ externalCustomerId, externalId = 'sub_' + externalCustomerId }) {
    this.adapter = simAdapter();
    this.ext = externalCustomerId; this.subId = externalId; this.revision = 0; this.seq = 0;
    this.sub = null; this.sent = [];
  }

  snapshot() {
    const s = this.sub;
    return { externalId: this.subId, planCode: s.plan, status: s.status, currentPeriodStart: s.start.toISOString(), currentPeriodEnd: s.end.toISOString(),
      trialEndsAt: s.trialEnds?.toISOString(), gracePeriodEndsAt: s.grace?.toISOString(), cancelAtPeriodEnd: s.cancelAtPeriodEnd, canceledAt: s.canceledAt?.toISOString(), pausedAt: s.pausedAt?.toISOString() };
  }

  /** What a reconciliation fetch from the provider would return right now. */
  authoritative() { return { revision: this.revision, subscription: this.snapshot() }; }

  _emit(type, { withSnapshot = true, invoice } = {}) {
    this.revision++;
    const event = { provider: 'sim', eventId: `evt_${this.ext}_${++this.seq}`, type, revision: this.revision, occurredAt: new Date().toISOString(), externalCustomerId: this.ext,
      ...(withSnapshot ? { subscription: this.snapshot() } : {}), ...(invoice ? { invoice } : {}) };
    const rawBody = Buffer.from(JSON.stringify(event));
    const delivery = { event, rawBody, headers: { 'x-signature': this.adapter.sign(rawBody) } };
    this.sent.push(delivery);
    return delivery;
  }

  create({ plan = 'pro', periodMs = 60_000, trialMs = 0 } = {}) {
    const now = new Date();
    this.sub = { plan, status: trialMs ? 'trialing' : 'active', start: now, end: new Date(now.getTime() + periodMs), trialEnds: trialMs ? new Date(now.getTime() + trialMs) : undefined, cancelAtPeriodEnd: false };
    return this._emit('subscription.created');
  }
  renew(periodMs = 60_000) { const s = this.sub; s.status = 'active'; s.trialEnds = undefined; s.grace = undefined; s.start = new Date(); s.end = new Date(Date.now() + periodMs); return this._emit('invoice.paid'); }
  paymentFailed(graceMs) { this.sub.status = 'past_due'; this.sub.grace = new Date(Date.now() + graceMs); return this._emit('invoice.payment_failed', { invoice: { id: 'in_' + this.seq, amount: 4900 } }); }
  paymentRecovered(periodMs = 60_000) { return this.renew(periodMs); }
  changePlan(plan) { this.sub.plan = plan; return this._emit('subscription.updated'); }
  cancelAtPeriodEnd() { this.sub.cancelAtPeriodEnd = true; return this._emit('subscription.updated'); }
  cancelNow() { this.sub.status = 'canceled'; this.sub.canceledAt = new Date(); return this._emit('subscription.canceled'); }
  pause() { this.sub.status = 'paused'; this.sub.pausedAt = new Date(); return this._emit('subscription.paused'); }
  resume() { this.sub.status = 'active'; this.sub.pausedAt = undefined; return this._emit('subscription.resumed'); }
  refund(amount) { return this._emit('invoice.refunded', { withSnapshot: false, invoice: { id: 'in_' + this.seq, refunded: amount } }); }
  /** Advances the provider's state WITHOUT delivering the webhook (a missed event). */
  silently(fn) { const before = this.sent.length; fn(); this.sent.length = before; }
}
