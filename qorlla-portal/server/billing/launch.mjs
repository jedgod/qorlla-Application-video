// v4.5 billing operations: plan changes (proration), refunds, usage-overage invoicing, workspace usage summary.
// Every provider-facing step follows the same rule as checkout: local plan state changes only after the PROVIDER confirms it.
import { effectivePlan, quotaFor } from '../entitlements.mjs';
import { BillingError } from './service.mjs';
import { OVERAGE_QUOTA, OVERAGE_FEATURES } from './overage.mjs';

const PERIODS = { month: 1, year: 12 };
const normalised = (unit, seats, interval) => (unit * seats) / PERIODS[interval];
const iso = (s) => (s == null ? null : new Date(Number(s) * 1000).toISOString());

export function createBillingLaunch({ pool, stripe, cfg, log, billing, flags, now = () => Date.now() }) {
  const { confirmChange } = billing.internals;
  const needProvider = () => { if (!billing.available()) throw new BillingError(503, 'billing_unavailable', 'Billing is not enabled', { reasons: cfg.billing.unavailableReasons }); };
  const platformAudit = (db, actor, action, obj, detail) => db.query('INSERT INTO portal.platform_audit(actor_id,action,object_id,detail) VALUES($1,$2,$3,$4)', [actor, action, String(obj ?? ''), detail ? JSON.stringify(detail) : null]);

  // ------------------------------------------------------------------ plan changes
  async function prepare(workspaceId, { plan, interval, seats }) {
    const s = await billing.subscriptionFor(workspaceId);
    if (!s?.provider_subscription_id) throw new BillingError(409, 'no_subscription', 'This workspace has no paid subscription to change - choose a plan from the pricing page');
    if (s.status === 'past_due') throw new BillingError(409, 'payment_required', 'Fix the failed payment before changing plans');
    if (!['active', 'trialing'].includes(s.status)) throw new BillingError(409, 'subscription_inactive', 'The subscription is not active');
    if (s.cancel_at_period_end) throw new BillingError(409, 'cancellation_pending', 'The subscription is set to cancel at the end of the period');
    if (!Number.isInteger(seats) || seats < 1 || seats > cfg.billing.maxSeats) throw new BillingError(400, 'bad_seats', `Seats must be 1-${cfg.billing.maxSeats}`);
    const price = (await pool.query(`SELECT p.slug, pr.amount_cents, pr.currency FROM portal.plans p JOIN portal.plan_prices pr ON pr.plan_slug=p.slug AND pr.billing_interval=$2 AND pr.active AND pr.currency='usd' WHERE p.slug=$1 AND NOT p.contact_sales`, [plan, interval])).rows[0];
    if (!price) throw new BillingError(400, 'plan_not_purchasable', 'That plan/interval cannot be purchased online');
    if (plan === s.plan_slug && interval === s.billing_interval && seats === s.seats) throw new BillingError(400, 'no_change', 'That is already your plan');
    // never strand people: the target plan must still fit the people already in the workspace
    const cap = (await pool.query(`SELECT quota FROM portal.entitlements WHERE plan_slug=$1 AND feature='members.max'`, [plan])).rows[0];
    const members = Number((await pool.query('SELECT count(*) FROM portal.members WHERE workspace_id=$1', [workspaceId])).rows[0].count);
    if (cap && cap.quota !== null && members > cap.quota) throw new BillingError(409, 'too_many_members', `The ${plan} plan allows ${cap.quota} members; this workspace has ${members}. Remove members first.`, { limit: cap.quota, members });
    let providerSub;
    try { providerSub = await stripe.retrieveSubscription(s.provider_subscription_id); } catch (e) { throw new BillingError(502, 'provider_error', 'Payment provider unavailable'); }
    const item = providerSub.items?.data?.[0];
    if (!item || providerSub.id !== s.provider_subscription_id) throw new BillingError(502, 'provider_mismatch', 'The provider subscription could not be read');
    const cur = normalised(item.price.unit_amount, item.quantity, item.price.recurring.interval);
    const next = normalised(price.amount_cents, seats, interval);
    const intervalChange = interval !== item.price.recurring.interval;
    const planChange = plan !== s.plan_slug;
    const kind = intervalChange ? 'interval' : planChange ? (next >= cur ? 'upgrade' : 'downgrade') : 'seats';
    const immediate = !intervalChange && next >= cur;                       // more value (or equal) now; less value or a different billing cycle at the period end
    const periodEnd = providerSub.current_period_end ?? item.current_period_end;
    const periodStart = providerSub.current_period_start ?? item.current_period_start;
    let estimate = null;
    if (immediate && !intervalChange && periodEnd && periodStart) {
      const remaining = Math.max(0, Math.min(1, (periodEnd * 1000 - now()) / ((periodEnd - periodStart) * 1000)));
      estimate = Math.round((price.amount_cents * seats - item.price.unit_amount * item.quantity) * remaining);
    }
    return { s, providerSub, item, price, kind, immediate, effectiveAt: immediate ? new Date(now()).toISOString() : iso(periodEnd), estimate,
      from: { plan: s.plan_slug, interval: s.billing_interval, seats: s.seats, unit_amount_cents: item.price.unit_amount }, to: { plan, interval, seats, unit_amount_cents: price.amount_cents } };
  }
  const view = (p) => ({ kind: p.kind, immediate: p.immediate, effective_at: p.effectiveAt, from: p.from, to: p.to, currency: p.price.currency,
    new_total_per_period_cents: p.price.amount_cents * p.to.seats, proration_estimate_cents: p.estimate,
    notes: p.immediate ? ['The change takes effect immediately; the provider charges the prorated difference now.', 'The amount above is an ESTIMATE; the provider calculates the final proration.']
      : ['The change takes effect at the end of the current billing period; you keep your current plan until then.', 'No charge or credit is made today.'] });

  async function previewChange({ workspaceId, plan, interval, seats }) { needProvider(); return view(await prepare(workspaceId, { plan, interval, seats })); }

  async function changePlan({ workspaceId, userId, plan, interval, seats, idempotencyKey }) {
    needProvider();
    if (!(await flags.enabled('plan_changes'))) throw new BillingError(503, 'feature_disabled', 'Plan changes are temporarily switched off');
    if (idempotencyKey) { const dup = (await pool.query('SELECT * FROM portal.plan_changes WHERE workspace_id=$1 AND idempotency_key=$2', [workspaceId, idempotencyKey])).rows[0]; if (dup) return { change_id: dup.id, status: dup.status, effective_at: dup.effective_at, duplicate: true }; }
    const p = await prepare(workspaceId, { plan, interval, seats });
    let pc;
    try {
      pc = (await pool.query(`INSERT INTO portal.plan_changes(workspace_id,provider_subscription_id,kind,from_plan,from_interval,from_seats,to_plan,to_interval,to_seats,unit_amount_cents,currency,status,effective_at,requested_by,idempotency_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, [workspaceId, p.s.provider_subscription_id, p.kind, p.from.plan, p.from.interval, p.from.seats, plan, interval, seats, p.price.amount_cents, p.price.currency, p.immediate ? 'requested' : 'scheduled', p.effectiveAt, userId, idempotencyKey || null])).rows[0];
    } catch (e) { if (e.code === '23505') throw new BillingError(409, 'change_pending', 'A plan change is already pending for this workspace'); throw e; }
    await pool.query(`INSERT INTO portal.audit_events(workspace_id,actor_id,action,object_id) VALUES($1,$2,'billing.plan_change_requested',$3)`, [workspaceId, userId, pc.id]);
    if (!p.immediate) return { change_id: pc.id, status: 'scheduled', effective_at: pc.effective_at, kind: p.kind };
    const out = await applyToProvider(pc, p.item, p.providerSub, 'always_invoice');
    return { change_id: pc.id, kind: p.kind, ...out };
  }

  /** Send the change to the provider, then re-read and apply only if the provider shows exactly what was agreed. */
  async function applyToProvider(pc, item, providerSub, proration) {
    try {
      await stripe.changeSubscription({ id: pc.provider_subscription_id, itemId: item.id, product: item.price.product, currency: pc.currency, unitAmountCents: pc.unit_amount_cents, interval: pc.to_interval, quantity: pc.to_seats, prorationBehavior: proration, changeId: pc.id });
    } catch (e) {
      const permanent = e.status >= 400 && e.status < 500;
      await pool.query(`UPDATE portal.plan_changes SET status=$2, error_code=$3 WHERE id=$1`, [pc.id, permanent ? 'failed' : (proration === 'none' ? 'scheduled' : 'failed'), 'provider_' + (e.status || 'unreachable')]);
      log?.error('plan change rejected by provider', { change_id: pc.id, status: e.status });
      throw new BillingError(502, 'provider_error', 'The payment provider did not accept the change; nothing was changed');
    }
    let fresh;
    try { fresh = await stripe.retrieveSubscription(pc.provider_subscription_id); } catch { return { status: 'pending_confirmation', note: 'The provider accepted the change; confirmation is pending.' }; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const applied = await confirmChange(client, pc, fresh, { eventAt: Math.floor(now() / 1000), force: true });
      await client.query('COMMIT');
      return applied ? { status: 'applied' } : { status: 'pending_confirmation', note: 'The provider accepted the change; it will apply once payment is confirmed.' };
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }

  async function cancelChange(workspaceId, id) {
    const r = await pool.query(`UPDATE portal.plan_changes SET status='cancelled' WHERE id=$1 AND workspace_id=$2 AND status='scheduled' RETURNING id`, [id, workspaceId]);
    if (!r.rowCount) throw new BillingError(409, 'not_cancellable', 'Only a scheduled change can be cancelled');
    return { cancelled: true };
  }
  async function pendingChange(workspaceId) {
    return (await pool.query(`SELECT id, kind, status, from_plan, from_interval, from_seats, to_plan, to_interval, to_seats, unit_amount_cents, currency, effective_at FROM portal.plan_changes WHERE workspace_id=$1 AND status IN ('requested','scheduled')`, [workspaceId])).rows[0] || null;
  }

  /** Scheduled downgrades are sent to the provider shortly BEFORE the renewal so the next invoice already uses the new price (no proration, nothing refunded). */
  async function applyScheduledChanges() {
    if (!billing.available() || !(await flags.enabled('plan_changes'))) return 0;
    const due = (await pool.query(`UPDATE portal.plan_changes SET status='requested' WHERE id IN (SELECT id FROM portal.plan_changes WHERE status='scheduled' AND effective_at <= now() + interval '30 minutes' ORDER BY effective_at FOR UPDATE SKIP LOCKED LIMIT 20) RETURNING *`)).rows;
    for (const pc of due) {
      try {
        const sub = await stripe.retrieveSubscription(pc.provider_subscription_id); const item = sub.items?.data?.[0];
        if (!item || ['canceled', 'incomplete_expired'].includes(sub.status)) { await pool.query(`UPDATE portal.plan_changes SET status='cancelled', error_code='subscription_gone' WHERE id=$1`, [pc.id]); continue; }
        await applyToProvider(pc, item, sub, 'none');
      } catch (e) {
        if (!(e instanceof BillingError)) { await pool.query(`UPDATE portal.plan_changes SET status='scheduled', error_code='retry' WHERE id=$1 AND status='requested'`, [pc.id]); log?.warn('scheduled plan change will retry', { change_id: pc.id, err: e.message }); }
      }
    }
    return due.length;
  }
  async function expireStaleChanges() {
    return (await pool.query(`UPDATE portal.plan_changes SET status='failed', error_code='not_confirmed' WHERE status='requested' AND created_at < now() - interval '1 day'`)).rowCount;
  }

  // ------------------------------------------------------------------ usage and overage (workspace view)
  async function usageSummary(workspaceId) {
    const plan = await effectivePlan(pool, workspaceId);
    const settings = (await pool.query('SELECT overage_enabled, overage_accepted_at FROM portal.workspace_billing_settings WHERE workspace_id=$1', [workspaceId])).rows[0] || { overage_enabled: false };
    const prices = Object.fromEntries((await pool.query('SELECT usage_feature, unit_amount_cents, currency, active FROM portal.usage_prices')).rows.map((r) => [r.usage_feature, r]));
    const features = [];
    for (const f of OVERAGE_FEATURES) {
      const q = await quotaFor(pool, workspaceId, OVERAGE_QUOTA[f]);
      const used = Number((await pool.query(`SELECT COALESCE(sum(units),0) s FROM portal.ai_usage_events WHERE workspace_id=$1 AND feature=$2 AND created_at >= date_trunc('month', now())`, [workspaceId, f])).rows[0].s);
      const o = (await pool.query(`SELECT COALESCE(sum(units),0)::int units, COALESCE(sum(units*unit_amount_cents),0)::int cents FROM portal.usage_overage_events WHERE workspace_id=$1 AND usage_feature=$2 AND period_month = date_trunc('month', now())::date`, [workspaceId, f])).rows[0];
      features.push({ feature: f, used, quota: q.quota, overage_units: o.units, overage_cents: o.cents, unit_amount_cents: prices[f]?.active ? prices[f].unit_amount_cents : null, currency: prices[f]?.currency || 'usd' });
    }
    return { plan, overage_enabled: !!settings.overage_enabled, overage_accepted_at: settings.overage_accepted_at || null,
      overage_possible: plan !== 'basic' && billing.available() && features.some((x) => x.unit_amount_cents), features };
  }
  async function setOverage({ workspaceId, userId, enabled, acceptTerms }) {
    if (enabled) {
      if ((await effectivePlan(pool, workspaceId)) === 'basic') throw new BillingError(409, 'paid_plan_required', 'Pay-as-you-go usage needs a paid plan');
      needProvider();
      if (!acceptTerms) throw new BillingError(400, 'terms_required', 'You must confirm that you accept being charged for usage beyond your plan');
      if (!(await pool.query('SELECT 1 FROM portal.usage_prices WHERE active')).rowCount) throw new BillingError(409, 'no_usage_prices', 'Usage-based pricing has not been published yet');
    }
    await pool.query(`INSERT INTO portal.workspace_billing_settings(workspace_id,overage_enabled,overage_accepted_by,overage_accepted_at) VALUES($1,$2::boolean,$3,CASE WHEN $2::boolean THEN now() END)
      ON CONFLICT (workspace_id) DO UPDATE SET overage_enabled=EXCLUDED.overage_enabled, overage_accepted_by=CASE WHEN EXCLUDED.overage_enabled THEN EXCLUDED.overage_accepted_by ELSE portal.workspace_billing_settings.overage_accepted_by END,
      overage_accepted_at=CASE WHEN EXCLUDED.overage_enabled THEN EXCLUDED.overage_accepted_at ELSE portal.workspace_billing_settings.overage_accepted_at END, updated_at=now()`, [workspaceId, !!enabled, userId]);
    await pool.query(`INSERT INTO portal.audit_events(workspace_id,actor_id,action,object_id) VALUES($1,$2,$3,$4)`, [workspaceId, userId, enabled ? 'billing.overage_enabled' : 'billing.overage_disabled', String(workspaceId)]);
    return { overage_enabled: !!enabled };
  }

  /** Close out finished months: one provider invoice item per workspace/feature/month, keyed so a retry can never double-bill. */
  async function reportOverage() {
    if (!billing.available() || !(await flags.enabled('overage_billing'))) return 0;
    const rows = (await pool.query(`SELECT e.workspace_id, e.usage_feature, e.period_month, sum(e.units)::int units, sum(e.units*e.unit_amount_cents)::int amount, min(e.currency) currency
        FROM portal.usage_overage_events e WHERE e.period_month < date_trunc('month', now())::date
          AND NOT EXISTS (SELECT 1 FROM portal.usage_invoice_items i WHERE i.workspace_id=e.workspace_id AND i.usage_feature=e.usage_feature AND i.period_month=e.period_month)
        GROUP BY 1,2,3 ORDER BY 3,1,2 LIMIT 200`)).rows;
    let done = 0;
    for (const r of rows) {
      const customer = (await pool.query('SELECT provider_customer_id FROM portal.billing_customers WHERE workspace_id=$1', [r.workspace_id])).rows[0]?.provider_customer_id;
      if (!customer) { log?.warn('overage not invoiced: no provider customer', { workspace_id: r.workspace_id }); continue; }
      const month = new Date(r.period_month).toISOString().slice(0, 7);
      try {
        const item = await stripe.createInvoiceItem({ customer, amountCents: r.amount, currency: r.currency, description: `Qorlla AI usage beyond plan: ${r.units} x ${r.usage_feature.replace('_', ' ')} (${month})`,
          metadata: { workspace_id: r.workspace_id, usage_feature: r.usage_feature, period: month }, idempotencyKey: `overage-${r.workspace_id}-${r.usage_feature}-${month}` });
        await pool.query(`INSERT INTO portal.usage_invoice_items(workspace_id,usage_feature,period_month,units,amount_cents,currency,provider_invoice_item_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [r.workspace_id, r.usage_feature, r.period_month, r.units, r.amount, r.currency, item.id]);
        done++;
      } catch (e) { log?.error('overage invoice item failed (will retry)', { workspace_id: r.workspace_id, err: e.message, status: e.status }); }
    }
    return done;
  }

  // ------------------------------------------------------------------ refunds (platform admin)
  async function refund({ actor, invoiceId, amountCents, reason, idempotencyKey }) {
    needProvider();
    const prior = (await pool.query('SELECT * FROM portal.refund_requests WHERE idempotency_key=$1', [idempotencyKey])).rows[0];
    if (prior) return { request_id: prior.id, status: prior.status, duplicate: true };
    const inv = (await pool.query('SELECT * FROM portal.invoices WHERE id=$1', [invoiceId])).rows[0];
    if (!inv) throw new BillingError(404, 'invoice_not_found', 'Invoice not found');
    if (!inv.provider_payment_intent) throw new BillingError(409, 'no_payment_to_refund', 'This invoice has no recorded payment to refund');
    const refundable = inv.amount_paid_cents - inv.amount_refunded_cents;
    const amount = amountCents ?? refundable;
    if (!(amount > 0) || amount > refundable) throw new BillingError(400, 'exceeds_refundable', `At most ${refundable} can be refunded on this invoice`, { refundable });
    let req;
    try { req = (await pool.query(`INSERT INTO portal.refund_requests(workspace_id,provider_invoice_id,amount_cents,reason,requested_by,idempotency_key) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [inv.workspace_id, inv.provider_invoice_id, amount, reason, actor, idempotencyKey])).rows[0]; }
    catch (e) { if (e.code === '23505') { const again = (await pool.query('SELECT * FROM portal.refund_requests WHERE idempotency_key=$1', [idempotencyKey])).rows[0]; return { request_id: again.id, status: again.status, duplicate: true }; } throw e; }
    let rf;
    try { rf = await stripe.createRefund({ paymentIntent: inv.provider_payment_intent, amountCents: amount, requestId: req.id, workspaceId: inv.workspace_id, idempotencyKey: 'refund-' + req.id }); }
    catch (e) { await pool.query(`UPDATE portal.refund_requests SET status='failed', error_code=$2 WHERE id=$1`, [req.id, 'provider_' + (e.status || 'unreachable')]); throw new BillingError(502, 'provider_error', 'The payment provider rejected the refund'); }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM portal.invoices WHERE id=$1 FOR UPDATE', [inv.id]);
      const ins = await client.query(`INSERT INTO portal.refunds(workspace_id,provider,provider_refund_id,provider_invoice_id,amount_cents,currency,reason) VALUES($1,'stripe',$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`, [inv.workspace_id, rf.id, inv.provider_invoice_id, amount, inv.currency, 'admin: ' + reason.slice(0, 200)]);
      if (ins.rowCount) await client.query(`UPDATE portal.invoices SET amount_refunded_cents=LEAST(amount_paid_cents, amount_refunded_cents+$2), status=CASE WHEN amount_refunded_cents+$2>=amount_paid_cents THEN 'refunded' ELSE 'partially_refunded' END WHERE id=$1`, [inv.id, amount]);
      await client.query(`UPDATE portal.refund_requests SET status='succeeded', provider_refund_id=$2 WHERE id=$1`, [req.id, rf.id]);
      await platformAudit(client, actor, 'billing.refund', inv.id, { amount, reason, provider_refund_id: rf.id });
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    return { request_id: req.id, status: 'succeeded', provider_refund_id: rf.id, amount_cents: amount };
  }

  return { previewChange, changePlan, cancelChange, pendingChange, applyScheduledChanges, expireStaleChanges, usageSummary, setOverage, reportOverage, refund, platformAudit };
}
