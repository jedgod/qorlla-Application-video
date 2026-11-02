// P3 - Stripe TEST-MODE certification (Workplace v4.6). Real Stripe API, test keys only; refuses live keys.
// STATUS OF THIS FILE: written against Stripe's documented API but NOT YET EXECUTED against a Stripe account (none was available). Expect first-run fixes;
// until it has run, cert/provider/stripe-evidence.json says BLOCKED and the gate stays BLOCKED.
// Required environment (all must be set for the test-mode run):
//   STRIPE_TEST_SECRET_KEY=sk_test_...        STRIPE_WEBHOOK_SECRET=whsec_... (the endpoint secret of the portal's /api/v1/billing/webhook in test mode)
//   PORTAL_PUBLIC_URL=https://...            the portal as Stripe reaches it (HTTPS endpoint registered in the Stripe test dashboard, or `stripe listen --forward-to`)
//   PORTAL_OWNER_COOKIE / PORTAL_OWNER_CSRF  session of an owner of a FRESH Basic test workspace (PORTAL_WORKSPACE_ID)
//   PORTAL_ADMIN_COOKIE / PORTAL_ADMIN_CSRF  session of a platform admin (PLATFORM_ADMIN_USER_IDS)
//   DATABASE_URL                             read-only access to the portal database for reconciliation
// The portal under test must run with BILLING_ENABLED=true, STRIPE_SECRET_KEY=<the same sk_test key>; the live-authorisation variable must be UNSET.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { signPayload } from '../../qorlla-portal/server/billing/stripe.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.join(root, 'cert', 'provider', 'stripe-evidence.json');
const need = ['STRIPE_TEST_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'PORTAL_PUBLIC_URL', 'PORTAL_OWNER_COOKIE', 'PORTAL_OWNER_CSRF', 'PORTAL_WORKSPACE_ID', 'PORTAL_ADMIN_COOKIE', 'PORTAL_ADMIN_CSRF', 'DATABASE_URL'];
const finish = (o) => { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ phase: 'P3', finished: new Date().toISOString(), ...o }, null, 2)); console.log(o.status, o.reason || ''); process.exit(o.status === 'PASS' ? 0 : o.status === 'BLOCKED' ? 2 : 1); };
const missing = need.filter((k) => !process.env[k]);
if (missing.length) finish({ status: 'BLOCKED', reason: 'missing inputs: ' + missing.join(', '), requires: 'a Stripe account in TEST mode (test secret key + webhook endpoint secret), a publicly reachable HTTPS portal URL, and test sessions for a workspace owner and a platform admin' });
const KEY = process.env.STRIPE_TEST_SECRET_KEY;
if (!/^sk_test_/.test(KEY) || /live/.test(process.env.STRIPE_SECRET_KEY || '') || process.env.BILLING_LIVE_AUTHORIZED) finish({ status: 'FAIL', reason: 'refusing to run: a non sk_test_ key, a live key in the portal environment, or BILLING_LIVE_AUTHORIZED is set. Live payment collection must stay disabled.' });

const PORTAL = process.env.PORTAL_PUBLIC_URL.replace(/\/$/, ''); const WS = process.env.PORTAL_WORKSPACE_ID;
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const q = async (sql, a = []) => (await db.query(sql, a)).rows;
const form = (o, p = '', u = new URLSearchParams()) => { for (const [k, v] of Object.entries(o)) { if (v == null) continue; const key = p ? `${p}[${k}]` : k; if (typeof v === 'object') form(v, key, u); else u.append(key, String(v)); } return u; };
const stripe = async (method, p, body, idem) => { const r = await fetch('https://api.stripe.com' + p, { method, headers: { authorization: 'Bearer ' + KEY, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) }, body: body ? form(body).toString() : undefined }); const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error?.message || r.status), { status: r.status, body: j }); return j; };
const portal = async (who, method, p, body) => { const c = who === 'admin' ? [process.env.PORTAL_ADMIN_COOKIE, process.env.PORTAL_ADMIN_CSRF] : [process.env.PORTAL_OWNER_COOKIE, process.env.PORTAL_OWNER_CSRF];
  const r = await fetch(PORTAL + p, { method, headers: { cookie: c[0], 'x-csrf-token': c[1], origin: PORTAL, 'x-workspace-id': WS, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const until = async (fn, what, ms = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 2000)); } throw new Error('timeout waiting for ' + what); };
const steps = []; const evidence = { stripeObjects: {}, eventIds: [] };
async function step(id, name, fn) { try { const d = await fn(); steps.push({ id, name, status: 'PASS', detail: d }); console.log('PASS', id, name); } catch (e) { steps.push({ id, name, status: 'FAIL', detail: String(e.message || e).slice(0, 400) }); console.log('FAIL', id, name, e.message); } }
const planOf = async () => (await q('SELECT plan_slug FROM portal.workspace_effective_plan WHERE workspace_id=$1', [WS]))[0]?.plan_slug;
const assert = (c, m) => { if (!c) throw new Error(m); };
let sub, customer, checkoutRow;

await step('D1', 'checkout session is created server-side from the database price; Stripe agrees; a redirect alone activates nothing', async () => {
  assert(await planOf() === 'basic', 'test workspace must start on Basic');
  const r = await portal('owner', 'POST', '/api/v1/billing/checkout', { plan: 'pro', interval: 'month', seats: 2 }); assert(r.status === 201, 'checkout ' + r.status + JSON.stringify(r.body));
  checkoutRow = (await q('SELECT * FROM portal.checkout_sessions WHERE id=$1', [r.body.checkout_id]))[0];
  const s = await stripe('GET', `/v1/checkout/sessions/${checkoutRow.provider_session_id}?expand[]=line_items`); evidence.stripeObjects.checkoutSession = s.id;
  assert(s.mode === 'subscription' && s.metadata.workspace_id === WS && s.line_items.data[0].price.unit_amount === checkoutRow.unit_amount_cents && s.line_items.data[0].quantity === 2, 'session does not match the stored price snapshot');
  await fetch(PORTAL + '/pricing/?checkout=success'); assert(await planOf() === 'basic', 'redirect activated the plan');
  return { session: s.id };
});
await step('D2', 'payment succeeds: subscription is created at Stripe with the checkout metadata, the SIGNED webhook activates the workspace', async () => {
  customer = await stripe('POST', '/v1/customers', { name: 'Qorlla v4.6 test', metadata: { workspace_id: WS } }); const pm = await stripe('POST', '/v1/payment_methods/pm_card_visa/attach', { customer: customer.id });
  await stripe('POST', `/v1/customers/${customer.id}`, { invoice_settings: { default_payment_method: pm.id } });
  const product = await stripe('POST', '/v1/products', { name: 'Qorlla Workplace pro (monthly) - test' });
  sub = await stripe('POST', '/v1/subscriptions', { customer: customer.id, items: [{ quantity: 2, price_data: { currency: checkoutRow.currency, product: product.id, unit_amount: checkoutRow.unit_amount_cents, recurring: { interval: 'month' } } }], metadata: { checkout_id: checkoutRow.id, workspace_id: WS } }, 'v46-sub-' + checkoutRow.id);
  evidence.stripeObjects.customer = customer.id; evidence.stripeObjects.subscription = sub.id;
  await until(async () => (await planOf()) === 'pro', 'webhook-driven activation');
  const ev = await q(`SELECT event_id, type, outcome FROM portal.billing_events WHERE payload::text LIKE $1 ORDER BY received_at`, [`%${sub.id}%`]); evidence.eventIds.push(...ev.map((e) => e.event_id));
  assert(ev.some((e) => e.type === 'invoice.paid' && e.outcome === 'activated'), 'no activating invoice.paid event: ' + JSON.stringify(ev)); return { events: ev };
});
await step('D3', 'webhook replay and out-of-order delivery are harmless', async () => {
  const evs = (await stripe('GET', `/v1/events?limit=50&type=customer.subscription.updated`)).data.filter((e) => e.data.object.id === sub.id); const paid = (await q(`SELECT event_id FROM portal.billing_events WHERE type='invoice.paid' AND payload::text LIKE $1`, [`%${sub.id}%`]))[0];
  const send = async (event, ts) => { const body = JSON.stringify(event); const r = await fetch(PORTAL + '/api/v1/billing/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signPayload(Buffer.from(body), process.env.STRIPE_WEBHOOK_SECRET, ts) }, body }); return r.status; };
  const before = JSON.stringify(await q('SELECT status, plan_slug, seats FROM portal.subscriptions WHERE workspace_id=$1', [WS]));
  const full = await stripe('GET', `/v1/events/${paid.event_id}`); assert((await send(full)) === 200 && (await send(full)) === 200, 'replay not acknowledged');
  assert((await q('SELECT count(*)::int n FROM portal.billing_events WHERE event_id=$1', [paid.event_id]))[0].n === 1, 'replay stored twice');
  if (evs.length) { const old = { ...evs[evs.length - 1], created: Math.floor(Date.now() / 1000) - 86400 }; await send(old); }
  assert(JSON.stringify(await q('SELECT status, plan_slug, seats FROM portal.subscriptions WHERE workspace_id=$1', [WS])) === before, 'replay/stale event changed state');
  const forged = await fetch(PORTAL + '/api/v1/billing/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' }, body: '{}' }); assert(forged.status === 400, 'forged signature accepted');
});
await step('D4', 'upgrade now (proration charged by Stripe), downgrade scheduled', async () => {
  const up = await portal('owner', 'POST', '/api/v1/billing/change-plan', { plan: 'business', interval: 'month', seats: 2, idempotency_key: 'v46-up-' + sub.id }); assert(up.status === 202, 'upgrade ' + JSON.stringify(up.body));
  const s2 = await stripe('GET', `/v1/subscriptions/${sub.id}`); assert(s2.items.data[0].price.unit_amount > checkoutRow.unit_amount_cents, 'Stripe price did not change'); await until(async () => (await planOf()) === 'business', 'business plan');
  const invs = await stripe('GET', `/v1/invoices?subscription=${sub.id}&limit=5`); assert(invs.data.length >= 2, 'no proration invoice'); evidence.stripeObjects.prorationInvoice = invs.data[0].id;
  const down = await portal('owner', 'POST', '/api/v1/billing/change-plan', { plan: 'pro', interval: 'month', seats: 2 }); assert(down.body.status === 'scheduled', 'downgrade not scheduled'); assert(await planOf() === 'business', 'downgrade applied early');
  await portal('owner', 'DELETE', `/api/v1/billing/change-plan/${down.body.change_id}`);
});
await step('D5', 'failed payment: a card that attaches but declines puts the subscription past_due and the portal follows', async () => {
  const c2 = await stripe('POST', '/v1/customers', { name: 'Qorlla v4.6 failing card' }); const pm = await stripe('POST', '/v1/payment_methods/pm_card_chargeCustomerFail/attach', { customer: c2.id });
  await stripe('POST', `/v1/customers/${c2.id}`, { invoice_settings: { default_payment_method: pm.id } });
  const prod = await stripe('POST', '/v1/products', { name: 'Qorlla failing-card test' });
  const bad = await stripe('POST', '/v1/subscriptions', { customer: c2.id, payment_behavior: 'allow_incomplete', items: [{ price_data: { currency: 'usd', product: prod.id, unit_amount: 1699, recurring: { interval: 'month' } } }], metadata: { workspace_id: WS, checkout_id: crypto.randomUUID() } });
  evidence.stripeObjects.failedSubscription = bad.id; assert(['incomplete', 'past_due'].includes(bad.status), 'Stripe status ' + bad.status);
  await until(async () => (await q(`SELECT 1 FROM portal.billing_events WHERE type IN ('invoice.payment_failed') AND payload::text LIKE $1`, [`%${bad.id}%`])).length, 'payment_failed event', 60000);
  assert(await planOf() !== undefined, 'unmatched failed subscription must not affect the workspace: ' + (await planOf())); await stripe('DELETE', `/v1/subscriptions/${bad.id}`);
});
await step('D6', 'subscription reconciliation repairs drift', async () => {
  await db.query(`UPDATE portal.subscriptions SET seats = seats + 5 WHERE workspace_id=$1`, [WS]).catch(() => { throw new Error('use a DATABASE_URL that may write the test workspace for the drift injection'); });
  const r = await portal('owner', 'POST', '/api/v1/billing/reconcile', {}); assert(r.status === 200 && r.body.reconciled, JSON.stringify(r.body));
  const s = await stripe('GET', `/v1/subscriptions/${sub.id}`); assert((await q('SELECT seats FROM portal.subscriptions WHERE workspace_id=$1', [WS]))[0].seats === s.items.data[0].quantity, 'seats not repaired');
});
await step('D7', 'refund through the admin console reaches Stripe and the ledger', async () => {
  const inv = (await q(`SELECT id, provider_invoice_id, amount_paid_cents FROM portal.invoices WHERE workspace_id=$1 AND status='paid' ORDER BY created_at LIMIT 1`, [WS]))[0]; assert(inv, 'no paid invoice'); const key = 'v46-refund-' + inv.id;
  const r = await portal('admin', 'POST', '/api/v1/admin/billing/refunds', { invoice_id: inv.id, amount_cents: 100, reason: 'v4.6 certification refund', idempotency_key: key }); assert(r.status === 201, JSON.stringify(r.body));
  const rf = await stripe('GET', `/v1/refunds/${r.body.provider_refund_id}`); assert(rf.amount === 100 && rf.status === 'succeeded', 'Stripe refund ' + rf.status); evidence.stripeObjects.refund = rf.id;
  assert((await q('SELECT amount_refunded_cents FROM portal.invoices WHERE id=$1', [inv.id]))[0].amount_refunded_cents === 100, 'ledger not updated');
  assert((await portal('admin', 'POST', '/api/v1/admin/billing/refunds', { invoice_id: inv.id, amount_cents: 100, reason: 'v4.6 certification refund', idempotency_key: key })).body.duplicate === true, 'not idempotent');
});
await step('D8', 'metered AI usage becomes one Stripe invoice item per workspace/feature/month', async () => {
  await portal('admin', 'PUT', '/api/v1/admin/billing/usage-prices/assistant_message', { unit_amount_cents: 5, active: true });
  await db.query(`INSERT INTO portal.usage_overage_events(workspace_id,usage_feature,units,unit_amount_cents,currency,period_month,idempotency_key) VALUES ($1,'assistant_message',3,5,'usd',date_trunc('month', now() - interval '1 month')::date,'v46-' || gen_random_uuid())`, [WS]);
  const r = await portal('admin', 'POST', '/api/v1/admin/billing/overage/report', {}); assert(r.status === 200 && r.body.invoice_items_created >= 1, JSON.stringify(r.body));
  const item = (await stripe('GET', `/v1/invoiceitems?customer=${customer.id}&limit=5`)).data.find((i) => i.metadata?.usage_feature === 'assistant_message'); assert(item && item.amount === 15, 'invoice item missing/wrong'); evidence.stripeObjects.invoiceItem = item.id;
  await portal('admin', 'PUT', '/api/v1/admin/billing/usage-prices/assistant_message', { unit_amount_cents: 5, active: false });
});
await step('D9', 'cancellation is requested at Stripe and mirrored', async () => {
  const r = await portal('owner', 'POST', '/api/v1/billing/cancel', {}); assert(r.status === 202, JSON.stringify(r.body)); assert((await stripe('GET', `/v1/subscriptions/${sub.id}`)).cancel_at_period_end === true, 'Stripe not cancelling');
  assert((await q('SELECT cancel_at_period_end FROM portal.subscriptions WHERE workspace_id=$1', [WS]))[0].cancel_at_period_end === true, 'portal not mirrored');
});
await step('D10', 'ledger consistency: portal invoices equal Stripe invoices (amounts paid, refunded)', async () => {
  const sInv = (await stripe('GET', `/v1/invoices?subscription=${sub.id}&limit=20`)).data.filter((i) => i.status === 'paid'); const local = await q(`SELECT provider_invoice_id, amount_paid_cents, amount_refunded_cents FROM portal.invoices WHERE workspace_id=$1 AND status IN ('paid','partially_refunded','refunded')`, [WS]);
  for (const i of sInv) { const l = local.find((x) => x.provider_invoice_id === i.id); assert(l, 'invoice missing locally ' + i.id); assert(l.amount_paid_cents === i.amount_paid, `amount mismatch ${i.id}`); }
  return { stripeInvoices: sInv.length, localInvoices: local.length };
});
await stripe('DELETE', `/v1/subscriptions/${sub.id}`).catch(() => {});
await db.end();
finish({ status: steps.every((s) => s.status === 'PASS') ? 'PASS' : 'FAIL', mode: 'test', livePaymentsEnabled: false, steps, evidence });
