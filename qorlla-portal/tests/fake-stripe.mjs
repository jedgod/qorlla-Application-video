// TEST DOUBLE ONLY. A minimal local stand-in for the three Stripe endpoints the adapter uses, so the lifecycle logic can be
// exercised without network access or credentials. Passing tests against this double is NOT evidence that the real provider
// integration works: that needs a Stripe test-mode account (certification gate "live provider" stays BLOCKED until then).
import http from 'node:http';
import crypto from 'node:crypto';
import { signPayload } from '../server/billing/stripe.mjs';

export const WEBHOOK_SECRET = 'whsec_' + 'test'.repeat(8);
const rid = (p) => p + crypto.randomBytes(8).toString('hex');

export async function startFakeStripe({ port = 0, host = '127.0.0.1' } = {}) {
  const st = { requests: [], subs: new Map(), down: false, failCreate: false, failChange: false, failRefund: false, failInvoiceItem: false, holdStatus: null, changes: [], refunds: [], invoiceItems: [], idem: new Map(), paymentIntents: new Set() };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString(); const form = Object.fromEntries(new URLSearchParams(raw));
    if (!req.url.startsWith('/__control/')) st.requests.push({ method: req.method, path: req.url, form, auth: req.headers.authorization, idem: req.headers['idempotency-key'] });
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url.startsWith('/__control/')) { // test-harness control plane (browser E2E runs the double as a separate process)
      const path = req.url.split('?')[0];
      if (path === '/__control/requests') return send(200, st.requests);
      if (path === '/__control/reset') { st.requests.length = 0; st.down = false; st.failCreate = false; st.failChange = false; st.failRefund = false; st.failInvoiceItem = false; st.changes.length = 0; st.refunds.length = 0; st.invoiceItems.length = 0; return send(200, { ok: true }); }
      if (path === '/__control/set') { const b = JSON.parse(raw || '{}'); if ('down' in b) st.down = !!b.down; if ('failCreate' in b) st.failCreate = !!b.failCreate; for (const k of ['failChange', 'failRefund', 'failInvoiceItem']) if (k in b) st[k] = !!b[k]; if ('holdStatus' in b) st.holdStatus = b.holdStatus; return send(200, { ok: true }); }
      if (path === '/__control/paid-event') { // what the provider would send after the customer pays: a subscription + a signed invoice.paid
        const b = JSON.parse(raw); const sub = api.subscription(b); const inv = api.invoice({ sub, amountPaid: b.unitAmount * (b.quantity || 1) });
        const body = JSON.stringify(api.event('invoice.paid', inv)); return send(200, { body, signature: signPayload(Buffer.from(body), WEBHOOK_SECRET), subscription: sub.id });
      }
      return send(404, { error: 'unknown control route' });
    }
    if (st.down) return send(503, { error: { message: 'provider down' } });
    if (req.headers.authorization !== 'Bearer sk_test_fake') return send(401, { error: { message: 'bad key' } });
    if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
      if (st.failCreate) return send(402, { error: { message: 'card_declined' } });
      const id = rid('cs_test_'); return send(200, { id, object: 'checkout.session', url: `https://checkout.stripe.test/pay/${id}` });
    }
    const m = /^\/v1\/subscriptions\/([^/?]+)/.exec(req.url);
    if (m && req.method === 'GET') { const s = st.subs.get(m[1]); return s ? send(200, s) : send(404, { error: { message: 'No such subscription' } }); }
    if (m && req.method === 'POST') {
      const s = st.subs.get(m[1]); if (!s) return send(404, { error: { message: 'No such subscription' } });
      if (form.cancel_at_period_end === 'true') s.cancel_at_period_end = true;
      if (form['items[0][price_data][unit_amount]'] !== undefined) {   // plan change
        if (st.failChange) return send(402, { error: { message: 'Your card was declined.' } });
        const it = s.items.data[0]; if (form['items[0][id]'] !== it.id) return send(400, { error: { message: 'No such subscription item' } });
        it.price = { unit_amount: Number(form['items[0][price_data][unit_amount]']), currency: form['items[0][price_data][currency]'], recurring: { interval: form['items[0][price_data][recurring][interval]'] }, product: form['items[0][price_data][product]'] };
        it.quantity = Number(form['items[0][quantity]']); if (st.holdStatus) s.status = st.holdStatus; st.changes.push({ ...form, idem: req.headers['idempotency-key'] });
      }
      return send(200, s);
    }
    if (req.method === 'POST' && req.url === '/v1/refunds') {
      const key = req.headers['idempotency-key']; if (key && st.idem.has(key)) return send(200, st.idem.get(key));
      if (st.failRefund) return send(402, { error: { message: 'charge_already_refunded' } });
      if (!st.paymentIntents.has(form.payment_intent)) return send(404, { error: { message: 'No such payment_intent' } });
      const rf = { id: rid('re_'), object: 'refund', amount: Number(form.amount), currency: 'usd', status: 'succeeded', payment_intent: form.payment_intent, metadata: { refund_request_id: form['metadata[refund_request_id]'] } };
      st.refunds.push({ ...rf, idem: key }); if (key) st.idem.set(key, rf); return send(200, rf);
    }
    if (req.method === 'POST' && req.url === '/v1/invoiceitems') {
      const key = req.headers['idempotency-key']; if (key && st.idem.has(key)) return send(200, st.idem.get(key));
      if (st.failInvoiceItem) return send(500, { error: { message: 'temporarily unavailable' } });
      const ii = { id: rid('ii_'), object: 'invoiceitem', customer: form.customer, amount: Number(form.amount), currency: form.currency, description: form.description };
      st.invoiceItems.push({ ...ii, idem: key, metadata: { workspace_id: form['metadata[workspace_id]'], usage_feature: form['metadata[usage_feature]'], period: form['metadata[period]'] } }); if (key) st.idem.set(key, ii); return send(200, ii);
    }
    send(404, { error: { message: 'unknown route' } });
  });
  await new Promise((r) => server.listen(port, host, r));
  const day = 86400;
  const api = {
    st, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)),
    /** The provider-side subscription that Checkout would have created. */
    subscription({ checkoutId, workspaceId, unitAmount, currency = 'usd', interval = 'month', quantity = 1, status = 'active', id = rid('sub_'), customer = rid('cus_'), start = Math.floor(Date.now() / 1000) }) {
      const sub = { id, object: 'subscription', customer, status, cancel_at_period_end: false, canceled_at: null, current_period_start: start, current_period_end: start + (interval === 'year' ? 365 : 30) * day,
        metadata: { checkout_id: checkoutId, workspace_id: workspaceId }, items: { data: [{ id: rid('si_'), quantity, price: { unit_amount: unitAmount, currency, recurring: { interval }, product: 'prod_test' } }] } };
      st.subs.set(id, sub); return sub;
    },
    invoice({ sub, id = rid('in_'), amountPaid, status = 'paid', currency = 'usd' }) {
      const pi = rid('pi_'); if (status === 'paid') st.paymentIntents.add(pi);
      return { id, object: 'invoice', number: 'QRL-' + id.slice(-6), customer: sub.customer, subscription: sub.id, payment_intent: pi, charge: rid('ch_'), status, currency, amount_due: amountPaid, amount_paid: status === 'paid' ? amountPaid : 0,
        hosted_invoice_url: `https://invoice.stripe.test/${id}`, invoice_pdf: `https://invoice.stripe.test/${id}.pdf`, period_start: sub.current_period_start, period_end: sub.current_period_end, attempt_count: 1, next_payment_attempt: null };
    },
    event(type, object, { id = rid('evt_'), created = Math.floor(Date.now() / 1000) } = {}) { return { id, object: 'event', type, created, data: { object } }; },
    /** POST a signed webhook (raw bytes exactly as signed). */
    async deliver(base, event, { secret = WEBHOOK_SECRET, timestamp, tamper, rawBody, signature } = {}) {
      const body = rawBody ?? JSON.stringify(event);
      const header = signature ?? signPayload(Buffer.from(body), secret, timestamp);
      const r = await fetch(base + '/api/v1/billing/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: tamper ? tamper(body) : body });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }
  };
  return api;
}

// CLI: `node tests/fake-stripe.mjs 19500` runs the double stand-alone (used by the browser E2E harness).
if (process.argv[1] && /[\\/]tests[\\/]fake-stripe\.mjs$/.test(String(process.argv[1]))) {
  const port = Number(process.argv[2] || 19500);
  await startFakeStripe({ port, host: '0.0.0.0' });
  console.log('fake stripe (TEST DOUBLE) listening on ' + port);
}
