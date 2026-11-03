// Subscription lifecycle. Golden rule: a workspace is activated ONLY by a signature-verified provider webhook for a PAID invoice
// whose subscription we then re-read from the provider API and match - amount, currency, interval and seats - against the price
// snapshot we stored when WE created the checkout session. A redirect back from the provider proves nothing and changes nothing.
// This module is PROVIDER-NEUTRAL: it talks to a BillingProvider (see provider.mjs) and only ever sees the neutral shapes defined there.
import crypto from 'node:crypto';
import { UUID_RE } from '../auth.mjs';

export class BillingError extends Error {
  constructor(status, code, message, extra = {}) { super(message || code); this.status = status; this.code = code; this.extra = extra; }
}
const isoSec = (s) => (s == null ? null : new Date(Number(s) * 1000).toISOString());

export function createBillingService({ pool, provider, cfg, log, now = () => Date.now() }) {
  const available = () => cfg.billing.available && !!provider;
  const P = () => provider.name;

  // ---------- catalogue ----------
  async function catalog() {
    const [plans, prices, ents] = await Promise.all([
      pool.query('SELECT slug,name,description,contact_sales,sort_order FROM portal.plans WHERE listed ORDER BY sort_order,slug'),
      pool.query('SELECT plan_slug,billing_interval,currency,amount_cents FROM portal.plan_prices WHERE active ORDER BY plan_slug,billing_interval'),
      pool.query(`SELECT plan_slug,feature,quota,description FROM portal.entitlements WHERE enabled AND plan_slug IN (SELECT slug FROM portal.plans WHERE listed) AND feature ~ '^(notes|members|ai\\.queries|meet\\.max)' ORDER BY plan_slug,feature`)
    ]);
    return {
      currency: 'usd',
      billing: { checkout_available: available(), unavailable_reasons: available() ? [] : cfg.billing.unavailableReasons },
      plans: plans.rows.map((p) => {
        const price = {};
        for (const r of prices.rows.filter((x) => x.plan_slug === p.slug && x.currency === 'usd')) {
          price[r.billing_interval] = { amount_cents: r.amount_cents, per_seat_per_month_cents: r.billing_interval === 'year' ? Math.round(r.amount_cents / 12) : r.amount_cents };
        }
        return { slug: p.slug, name: p.name, description: p.description, contact_sales: p.contact_sales, free: !p.contact_sales && !Object.keys(price).length, prices: price,
          entitlements: Object.fromEntries(ents.rows.filter((e) => e.plan_slug === p.slug).map((e) => [e.feature, e.quota]).filter(Boolean)) };
      })
    };
  }

  // ---------- checkout ----------
  async function createCheckout({ workspaceId, userId, plan, interval, seats, publicOrigin }) {
    if (!available()) throw new BillingError(503, 'billing_unavailable', 'Online checkout is not enabled', { reasons: cfg.billing.unavailableReasons });
    if (!Number.isInteger(seats) || seats < 1 || seats > cfg.billing.maxSeats) throw new BillingError(400, 'bad_seats', `Seats must be 1-${cfg.billing.maxSeats}`);
    const price = (await pool.query(
      `SELECT p.slug, pr.amount_cents, pr.currency FROM portal.plans p JOIN portal.plan_prices pr ON pr.plan_slug=p.slug AND pr.billing_interval=$2 AND pr.active AND pr.currency='usd'
       WHERE p.slug=$1 AND NOT p.contact_sales`, [plan, interval])).rows[0];
    if (!price) throw new BillingError(400, 'plan_not_purchasable', 'That plan/interval cannot be purchased online');
    const current = (await pool.query(`SELECT plan_slug FROM portal.workspace_effective_plan WHERE workspace_id=$1`, [workspaceId])).rows[0];
    if (current && current.plan_slug !== 'basic') throw new BillingError(409, 'already_subscribed', 'This workspace already has a paid plan');
    const checkoutId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO portal.checkout_sessions(id,workspace_id,plan_slug,billing_interval,seats,currency,unit_amount_cents,provider,provider_session_id,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [checkoutId, workspaceId, plan, interval, seats, price.currency, price.amount_cents, P(), 'pending:' + checkoutId, userId]);
    const customerId = (await pool.query('SELECT provider_customer_id FROM portal.billing_customers WHERE workspace_id=$1 AND provider=$2', [workspaceId, P()])).rows[0]?.provider_customer_id || null;
    let session;
    try {
      session = await provider.createCheckoutSession({ checkoutId, workspaceId, customerId, plan, interval, seats, currency: price.currency, unitAmountCents: price.amount_cents,
        successUrl: publicOrigin + cfg.billing.successPath, cancelUrl: publicOrigin + cfg.billing.cancelPath });
      if (!session?.id || !session?.url) throw new Error('provider returned no session');
    } catch (e) {
      await pool.query(`UPDATE portal.checkout_sessions SET status='expired' WHERE id=$1`, [checkoutId]);
      log?.error('checkout session creation failed', { checkout_id: checkoutId, err: e.message, status: e.status });
      throw new BillingError(502, 'provider_error', 'Payment provider unavailable');
    }
    await pool.query('UPDATE portal.checkout_sessions SET provider_session_id=$2 WHERE id=$1', [checkoutId, session.id]);
    return { url: session.url, session_id: session.id, checkout_id: checkoutId, plan, interval, seats, currency: price.currency,
      unit_amount_cents: price.amount_cents, total_cents: price.amount_cents * seats };
  }

  // ---------- payment methods: the provider's HOSTED customer portal. We never see, store or proxy card details. ----------
  /** A short-lived provider session for THIS workspace's billing customer. The caller has already proven it may manage billing for `workspaceId`. */
  async function createPortalSession({ workspaceId, returnUrl }) {
    if (!available()) throw new BillingError(503, 'billing_unavailable', 'Payment management is not available');
    const customerId = (await pool.query('SELECT provider_customer_id FROM portal.billing_customers WHERE workspace_id=$1 AND provider=$2', [workspaceId, P()])).rows[0]?.provider_customer_id;
    if (!customerId) throw new BillingError(409, 'no_billing_customer', 'This workspace has no payment profile yet; it is created when a plan is purchased');
    let session;
    try { session = await provider.createCustomerPortalSession({ customerId, returnUrl }); } catch (e) { log?.error('portal session failed', { err: e.message, status: e.status }); throw new BillingError(502, 'provider_error', 'Payment provider unavailable'); }
    if (!/^https:\/\//.test(session?.url || '')) throw new BillingError(502, 'provider_error', 'Payment provider unavailable');
    return { url: session.url };
  }
  async function hasBillingCustomer(workspaceId) {
    return (await pool.query('SELECT 1 FROM portal.billing_customers WHERE workspace_id=$1 AND provider=$2', [workspaceId, P()])).rowCount > 0;
  }

  // ---------- applying provider state ----------
  async function lockWorkspace(client, workspaceId) { await client.query('SELECT id FROM portal.workspaces WHERE id=$1 FOR UPDATE', [workspaceId]); }

  async function writeSubscription(client, { workspaceId, plan, interval, seats, sub, eventAt, force = false }) {
    const r = await client.query(
      `INSERT INTO portal.subscriptions(workspace_id,plan_slug,status,billing_interval,provider,provider_customer_id,provider_subscription_id,seats,current_period_start,current_period_end,cancel_at_period_end,canceled_at,last_event_at,updated_at)
       VALUES($1,$2,$3,$4,$14,$5,$6,$7,$8,$9,$10,$11,$12,now())
       ON CONFLICT (workspace_id) DO UPDATE SET plan_slug=EXCLUDED.plan_slug,status=EXCLUDED.status,billing_interval=EXCLUDED.billing_interval,provider=EXCLUDED.provider,
         provider_customer_id=EXCLUDED.provider_customer_id,provider_subscription_id=EXCLUDED.provider_subscription_id,seats=EXCLUDED.seats,
         current_period_start=EXCLUDED.current_period_start,current_period_end=EXCLUDED.current_period_end,cancel_at_period_end=EXCLUDED.cancel_at_period_end,
         canceled_at=EXCLUDED.canceled_at,last_event_at=GREATEST(portal.subscriptions.last_event_at,EXCLUDED.last_event_at),updated_at=now()
       WHERE $13::boolean OR portal.subscriptions.last_event_at IS NULL OR portal.subscriptions.last_event_at <= EXCLUDED.last_event_at`,
      [workspaceId, plan, sub.status, interval, sub.customerId, sub.id, seats, sub.currentPeriodStart, sub.currentPeriodEnd, !!sub.cancelAtPeriodEnd, sub.canceledAt, isoSec(eventAt), force, P()]);
    if (sub.customerId) await client.query(`INSERT INTO portal.billing_customers(workspace_id,provider,provider_customer_id) VALUES($1,$2,$3) ON CONFLICT (workspace_id) DO NOTHING`, [workspaceId, P(), sub.customerId]);
    return r.rowCount > 0; // false = a newer event had already been applied (stale/out-of-order event ignored)
  }
  async function upsertInvoice(client, workspaceId, inv, status) {
    await client.query(
      `INSERT INTO portal.invoices(workspace_id,provider,provider_invoice_id,number,status,currency,amount_due_cents,amount_paid_cents,hosted_invoice_url,receipt_url,period_start,period_end,attempt_count,next_payment_attempt,paid_at,provider_payment_intent,provider_charge_id)
       VALUES($1,$17,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (provider,provider_invoice_id) DO UPDATE SET status=CASE WHEN portal.invoices.status IN ('refunded','partially_refunded') AND EXCLUDED.status='paid' THEN portal.invoices.status ELSE EXCLUDED.status END,
         number=COALESCE(EXCLUDED.number,portal.invoices.number),amount_due_cents=EXCLUDED.amount_due_cents,amount_paid_cents=EXCLUDED.amount_paid_cents,
         hosted_invoice_url=COALESCE(EXCLUDED.hosted_invoice_url,portal.invoices.hosted_invoice_url),receipt_url=COALESCE(EXCLUDED.receipt_url,portal.invoices.receipt_url),
         attempt_count=EXCLUDED.attempt_count,next_payment_attempt=EXCLUDED.next_payment_attempt,paid_at=COALESCE(EXCLUDED.paid_at,portal.invoices.paid_at),
         provider_payment_intent=COALESCE(EXCLUDED.provider_payment_intent,portal.invoices.provider_payment_intent),provider_charge_id=COALESCE(EXCLUDED.provider_charge_id,portal.invoices.provider_charge_id)`,
      [workspaceId, inv.id, inv.number || null, status, inv.currency, inv.amountDueCents, inv.amountPaidCents, inv.hostedUrl, inv.receiptUrl, inv.periodStart, inv.periodEnd,
        inv.attemptCount, inv.nextPaymentAttempt, status === 'paid' ? new Date(now()).toISOString() : null, inv.paymentIntentId, inv.chargeId, P()]);
  }

  // ---------- plan changes: local state follows the PROVIDER, never the request ----------
  const itemMatches = (pc, sub) => sub.unitAmountCents != null && ['active', 'trialing'].includes(sub.status) && sub.unitAmountCents === pc.unit_amount_cents &&
    sub.currency === pc.currency && sub.interval === pc.to_interval && sub.quantity === pc.to_seats;
  /** Apply a requested change iff the provider's subscription now shows exactly the price snapshot the customer was shown. `sub` is a NEUTRAL ProviderSubscription. */
  async function confirmChange(client, pc, sub, { eventAt, force }) {
    if (!itemMatches(pc, sub)) return false;
    await lockWorkspace(client, pc.workspace_id);
    await writeSubscription(client, { workspaceId: pc.workspace_id, plan: pc.to_plan, interval: pc.to_interval, seats: pc.to_seats, sub, eventAt, force });
    await client.query(`UPDATE portal.plan_changes SET status='applied', applied_at=now() WHERE id=$1 AND status IN ('requested','scheduled')`, [pc.id]);
    return true;
  }

  // ---------- event handlers (run inside the event transaction); keyed by NEUTRAL event type ----------
  const byProviderSub = async (client, subId) => (await client.query('SELECT * FROM portal.subscriptions WHERE provider=$1 AND provider_subscription_id=$2', [P(), subId])).rows[0];
  const handlers = {
    async 'checkout.completed'(client, ev) {
      const ck = ev.checkout;
      const row = (await client.query('SELECT * FROM portal.checkout_sessions WHERE provider=$1 AND provider_session_id=$2', [P(), ck.id])).rows[0];
      if (!row) return 'unmatched_checkout';
      if (ck.mode !== 'subscription' || ck.workspaceId !== row.workspace_id) return 'rejected_metadata_mismatch';
      await lockWorkspace(client, row.workspace_id);
      await client.query(`UPDATE portal.checkout_sessions SET status='completed',completed_at=now(),provider_subscription_id=COALESCE($2,provider_subscription_id) WHERE id=$1`, [row.id, ck.subscriptionId || null]);
      if (ck.customerId) await client.query(`INSERT INTO portal.billing_customers(workspace_id,provider,provider_customer_id) VALUES($1,$2,$3) ON CONFLICT (workspace_id) DO NOTHING`, [row.workspace_id, P(), ck.customerId]);
      return 'checkout_recorded_awaiting_paid_invoice'; // deliberately NOT an activation
    },
    async 'checkout.expired'(client, ev) {
      await client.query(`UPDATE portal.checkout_sessions SET status='expired' WHERE provider=$1 AND provider_session_id=$2 AND status='created'`, [P(), ev.checkout.id]);
      return 'checkout_expired';
    },
    async 'invoice.paid'(client, ev, ctx) {
      const inv = ev.invoice; const subId = inv.subscriptionId; const sub = ctx.providerSub;
      if (inv.status !== 'paid' || !(inv.amountPaidCents > 0) || !subId) return 'ignored_not_a_paid_subscription_invoice';
      if (!sub || sub.id !== subId) return 'rejected_no_provider_confirmation';
      if (!['active', 'trialing'].includes(sub.status)) return 'rejected_provider_status_' + sub.status;
      const local = await byProviderSub(client, subId);
      let binding;
      if (local) {
        binding = { workspaceId: local.workspace_id, plan: local.plan_slug, interval: local.billing_interval, seats: sub.quantity || local.seats };
      } else {
        const cid = sub.metadata?.checkoutId, wid = sub.metadata?.workspaceId;
        if (!cid || !UUID_RE.test(cid) || !wid) return 'unmatched_subscription';
        const row = (await client.query(`SELECT * FROM portal.checkout_sessions WHERE id=$1 AND workspace_id=$2 AND status IN ('created','completed')`, [cid, wid])).rows[0];
        if (!row) return 'unmatched_checkout';
        if (row.provider_subscription_id && row.provider_subscription_id !== subId) { log?.error('ALERT checkout already bound to another subscription', { checkout_id: cid }); return 'rejected_checkout_already_used'; }
        const same = sub.unitAmountCents === row.unit_amount_cents && sub.currency === row.currency && sub.interval === row.billing_interval && sub.quantity === row.seats && inv.currency === row.currency;
        if (!same) { log?.error('ALERT billing price mismatch - not activating', { checkout_id: cid, subscription: subId }); return 'rejected_price_mismatch'; }
        binding = { workspaceId: row.workspace_id, plan: row.plan_slug, interval: row.billing_interval, seats: row.seats };
        await client.query(`UPDATE portal.checkout_sessions SET status='completed',completed_at=COALESCE(completed_at,now()),provider_subscription_id=$2 WHERE id=$1`, [row.id, subId]);
      }
      await lockWorkspace(client, binding.workspaceId);
      const applied = await writeSubscription(client, { ...binding, sub, eventAt: ev.createdAt });
      await upsertInvoice(client, binding.workspaceId, inv, 'paid');
      return applied ? (local ? 'renewed' : 'activated') : 'stale_event_ignored';
    },
    async 'invoice.payment_failed'(client, ev) {
      const inv = ev.invoice; const subId = inv.subscriptionId;
      const local = subId && (await byProviderSub(client, subId));
      if (!local) return 'unmatched_subscription';
      await lockWorkspace(client, local.workspace_id);
      await upsertInvoice(client, local.workspace_id, inv, 'payment_failed');
      await client.query(`UPDATE portal.subscriptions SET status='past_due',last_event_at=to_timestamp($2),updated_at=now() WHERE workspace_id=$1 AND (last_event_at IS NULL OR last_event_at<=to_timestamp($2)) AND status IN ('active','trialing','past_due')`, [local.workspace_id, ev.createdAt]);
      return 'payment_failed_recorded';
    },
    async 'subscription.updated'(client, ev) { return handlers._subscriptionChanged(client, ev, false); },
    async 'subscription.deleted'(client, ev) { return handlers._subscriptionChanged(client, ev, true); },
    async _subscriptionChanged(client, ev, deleted) {
      const sub = ev.subscription;
      const local = await byProviderSub(client, sub.id);
      if (!local) return 'unmatched_subscription'; // never activates a workspace: activation needs a paid invoice
      await lockWorkspace(client, local.workspace_id);
      if (deleted) await client.query(`UPDATE portal.plan_changes SET status='cancelled', error_code='subscription_canceled' WHERE workspace_id=$1 AND status IN ('requested','scheduled')`, [local.workspace_id]);
      else {
        const pc = (await client.query(`SELECT * FROM portal.plan_changes WHERE workspace_id=$1 AND provider_subscription_id=$2 AND status='requested'`, [local.workspace_id, sub.id])).rows[0];
        if (pc && (await confirmChange(client, pc, sub, { eventAt: ev.createdAt, force: false }))) return 'plan_change_applied';
      }
      const r = await writeSubscription(client, { workspaceId: local.workspace_id, plan: local.plan_slug, interval: local.billing_interval, seats: sub.quantity || local.seats, sub: deleted ? { ...sub, status: 'canceled' } : sub, eventAt: ev.createdAt });
      return r ? (deleted ? 'canceled' : 'updated') : 'stale_event_ignored';
    },
    async 'refund.recorded'(client, ev) {
      const rf = ev.refund; const invId = rf.invoiceId;
      const inv = invId && (await client.query(`SELECT * FROM portal.invoices WHERE provider=$1 AND provider_invoice_id=$2`, [P(), invId])).rows[0];
      if (!inv) return 'unmatched_invoice';
      await lockWorkspace(client, inv.workspace_id);
      for (const r of rf.refunds) {
        await client.query(`INSERT INTO portal.refunds(workspace_id,provider,provider_refund_id,provider_invoice_id,amount_cents,currency,reason) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [inv.workspace_id, P(), r.id, invId, r.amountCents, (r.currency || inv.currency).toLowerCase(), r.reason]);
      }
      const refunded = Math.min(rf.amountRefundedCents ?? 0, inv.amount_paid_cents);
      await client.query(`UPDATE portal.invoices SET amount_refunded_cents=$2,status=CASE WHEN $2>=amount_paid_cents AND amount_paid_cents>0 THEN 'refunded' ELSE 'partially_refunded' END WHERE id=$1`, [inv.id, refunded]);
      return 'refund_recorded'; // policy: a refund never silently removes access; cancel the subscription separately
    }
  };

  /** Process one already-verified NEUTRAL event exactly once. Throws on infrastructure failure so the provider retries. */
  async function processEvent(event) {
    if (!event?.id || !event?.type || event.malformed) throw new BillingError(400, 'bad_event', 'Malformed event');
    // independent confirmation BEFORE taking locks: re-read the subscription from the provider
    const ctx = {};
    if (event.type === 'invoice.paid') {
      const inv = event.invoice;
      if (inv?.subscriptionId && inv.status === 'paid' && inv.amountPaidCents > 0) {
        try { ctx.providerSub = await provider.getSubscription(inv.subscriptionId); }
        catch (e) { throw new BillingError(503, 'provider_unreachable', 'Cannot confirm with provider yet'); } // 5xx => provider retries later
      }
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(`INSERT INTO portal.billing_events(provider,event_id,type,provider_created_at,payload) VALUES($5,$1,$2,to_timestamp($3),$4) ON CONFLICT DO NOTHING RETURNING event_id`,
        [event.id, event.providerType || event.type, event.createdAt || Math.floor(now() / 1000), JSON.stringify(event.raw ?? event), P()]);
      if (!ins.rowCount) { await client.query('COMMIT'); return { duplicate: true }; }
      const fn = Object.hasOwn(handlers, event.type) && !event.type.startsWith('_') ? handlers[event.type] : null;
      const outcome = fn ? await fn(client, event, ctx) : 'ignored_type';
      await client.query(`UPDATE portal.billing_events SET outcome=$3,processed_at=now() WHERE provider=$4 AND event_id=$1 AND type=$2`, [event.id, event.providerType || event.type, outcome, P()]);
      await client.query('COMMIT');
      log?.info('billing event', { event_id: event.id, type: event.providerType || event.type, outcome });
      return { duplicate: false, outcome };
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }

  /** HTTP entry: raw body + signature header. */
  async function handleWebhook(rawBody, signature) {
    if (!cfg.billing.enabled || !provider) throw new BillingError(503, 'billing_unavailable', 'Billing webhooks are not enabled');
    let event;
    try { event = await provider.verifyWebhook(rawBody, signature); }
    catch (e) { throw new BillingError(400, 'bad_signature', 'Invalid signature'); }
    return processEvent(event);
  }

  // ---------- user actions / maintenance ----------
  async function subscriptionFor(workspaceId) {
    return (await pool.query(`SELECT s.*, e.plan_slug AS effective_plan FROM portal.workspaces w LEFT JOIN portal.subscriptions s ON s.workspace_id=w.id
      JOIN portal.workspace_effective_plan e ON e.workspace_id=w.id WHERE w.id=$1`, [workspaceId])).rows[0];
  }
  async function applyProviderSubscription(workspaceId, sub) {
    const local = (await pool.query('SELECT * FROM portal.subscriptions WHERE workspace_id=$1 AND provider_subscription_id=$2', [workspaceId, sub.id])).rows[0];
    if (!local) throw new BillingError(409, 'not_bound', 'Subscription is not bound to this workspace');
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await lockWorkspace(client, workspaceId);
      await writeSubscription(client, { workspaceId, plan: local.plan_slug, interval: local.billing_interval, seats: sub.quantity || local.seats, sub, eventAt: Math.floor(now() / 1000), force: true }); // a direct read from the provider is the freshest truth
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }
  async function cancel(workspaceId) {
    if (!available()) throw new BillingError(503, 'billing_unavailable', 'Billing is not enabled');
    const s = await subscriptionFor(workspaceId);
    if (!s?.provider_subscription_id || !['active', 'trialing', 'past_due'].includes(s.status)) throw new BillingError(409, 'nothing_to_cancel', 'No active paid subscription');
    let sub;
    try { sub = await provider.cancelSubscription(s.provider_subscription_id); } catch (e) { throw new BillingError(502, 'provider_error', 'Payment provider unavailable'); }
    await applyProviderSubscription(workspaceId, sub);
    return { cancel_at_period_end: true, current_period_end: sub.currentPeriodEnd };
  }
  /** Undo "cancel at period end" while the paid period is still running. Local state changes only from the provider's answer. */
  async function resume(workspaceId) {
    if (!available()) throw new BillingError(503, 'billing_unavailable', 'Billing is not enabled');
    const s = await subscriptionFor(workspaceId);
    if (!s?.provider_subscription_id || !s.cancel_at_period_end || !['active', 'trialing', 'past_due'].includes(s.status) || !(new Date(s.current_period_end) > new Date(now()))) throw new BillingError(409, 'nothing_to_resume', 'There is no pending cancellation to undo');
    let sub;
    try { sub = await provider.resumeSubscription(s.provider_subscription_id); } catch (e) { throw new BillingError(502, 'provider_error', 'Payment provider unavailable'); }
    await applyProviderSubscription(workspaceId, sub);
    return { cancel_at_period_end: !!sub.cancelAtPeriodEnd, current_period_end: sub.currentPeriodEnd };
  }
  async function reconcile(workspaceId) {
    if (!available()) throw new BillingError(503, 'billing_unavailable', 'Billing is not enabled');
    const s = await subscriptionFor(workspaceId);
    if (!s?.provider_subscription_id) return { reconciled: false, reason: 'no_provider_subscription' };
    let sub;
    try { sub = await provider.getSubscription(s.provider_subscription_id); } catch (e) { throw new BillingError(502, 'provider_error', 'Payment provider unavailable'); }
    await applyProviderSubscription(workspaceId, sub);
    await syncInvoices(workspaceId, s.provider_customer_id, s.provider_subscription_id);
    const after = await subscriptionFor(workspaceId);
    return { reconciled: true, before: s.status, after: after.status, changed: s.status !== after.status };
  }
  /** Best effort: pull the provider's invoice list for this customer and keep only invoices of THIS workspace's subscription (a customer id alone is never trusted). */
  async function syncInvoices(workspaceId, customerId, subscriptionId) {
    if (!customerId) return 0;
    let list; try { list = await provider.listInvoices(customerId); } catch { return 0; }
    const mine = list.filter((i) => i.subscriptionId === subscriptionId);
    if (!mine.length) return 0;
    const client = await pool.connect();
    try { await client.query('BEGIN'); await lockWorkspace(client, workspaceId); for (const inv of mine) await upsertInvoice(client, workspaceId, inv, inv.status); await client.query('COMMIT'); }
    catch (e) { await client.query('ROLLBACK').catch(() => {}); log?.error('invoice sync failed', { err: e.message }); return 0; } finally { client.release(); }
    return mine.length;
  }
  /** Payment retries are exhausted after the grace period: make the lapse explicit in the data. */
  async function expireLapsed() {
    const r = await pool.query(`UPDATE portal.subscriptions SET status='expired',updated_at=now() WHERE status='past_due' AND current_period_end IS NOT NULL AND current_period_end < now() - interval '7 days' RETURNING workspace_id`);
    if (r.rowCount) log?.info('subscriptions expired', { count: r.rowCount });
    return r.rowCount;
  }
  async function invoices(workspaceId, limit = 100) {
    return (await pool.query(`SELECT id,provider_invoice_id,number,status,currency,amount_due_cents,amount_paid_cents,amount_refunded_cents,hosted_invoice_url,receipt_url,period_start,period_end,attempt_count,next_payment_attempt,created_at,paid_at
      FROM portal.invoices WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT $2`, [workspaceId, limit])).rows;
  }
  return { catalog, createCheckout, createPortalSession, hasBillingCustomer, handleWebhook, processEvent, subscriptionFor, cancel, resume, reconcile, expireLapsed, invoices, available, provider: () => provider, internals: { confirmChange } };
}
