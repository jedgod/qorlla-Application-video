// TEST DOUBLE ONLY. A minimal local stand-in for the three Stripe endpoints the adapter uses, so the lifecycle logic can be
// exercised without network access or credentials. Passing tests against this double is NOT evidence that the real provider
// integration works: that needs a Stripe test-mode account (certification gate "live provider" stays BLOCKED until then).
import http from 'node:http';
import crypto from 'node:crypto';
import { signPayload } from '../server/billing/stripe.mjs';

export const WEBHOOK_SECRET = 'whsec_' + 'test'.repeat(8);
const rid = (p) => p + crypto.randomBytes(8).toString('hex');

export async function startFakeStripe({ port = 0, host = '127.0.0.1' } = {}) {
  const st = { requests: [], subs: new Map(), down: false, failCreate: false };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString(); const form = Object.fromEntries(new URLSearchParams(raw));
    if (!req.url.startsWith('/__control/')) st.requests.push({ method: req.method, path: req.url, form, auth: req.headers.authorization, idem: req.headers['idempotency-key'] });
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url.startsWith('/__control/')) { // test-harness control plane (browser E2E runs the double as a separate process)
      const path = req.url.split('?')[0];
      if (path === '/__control/requests') return send(200, st.requests);
      if (path === '/__control/reset') { st.requests.length = 0; st.down = false; st.failCreate = false; return send(200, { ok: true }); }
      if (path === '/__control/set') { const b = JSON.parse(raw || '{}'); if ('down' in b) st.down = !!b.down; if ('failCreate' in b) st.failCreate = !!b.failCreate; return send(200, { ok: true }); }
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
    if (m && req.method === 'POST') { const s = st.subs.get(m[1]); if (!s) return send(404, { error: { message: 'No such subscription' } }); if (form.cancel_at_period_end === 'true') s.cancel_at_period_end = true; return send(200, s); }
    send(404, { error: { message: 'unknown route' } });
  });
  await new Promise((r) => server.listen(port, host, r));
  const day = 86400;
  const api = {
    st, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)),
    /** The provider-side subscription that Checkout would have created. */
    subscription({ checkoutId, workspaceId, unitAmount, currency = 'usd', interval = 'month', quantity = 1, status = 'active', id = rid('sub_'), customer = rid('cus_'), start = Math.floor(Date.now() / 1000) }) {
      const sub = { id, object: 'subscription', customer, status, cancel_at_period_end: false, canceled_at: null, current_period_start: start, current_period_end: start + (interval === 'year' ? 365 : 30) * day,
        metadata: { checkout_id: checkoutId, workspace_id: workspaceId }, items: { data: [{ quantity, price: { unit_amount: unitAmount, currency, recurring: { interval } } }] } };
      st.subs.set(id, sub); return sub;
    },
    invoice({ sub, id = rid('in_'), amountPaid, status = 'paid', currency = 'usd' }) {
      return { id, object: 'invoice', number: 'QRL-' + id.slice(-6), customer: sub.customer, subscription: sub.id, status, currency, amount_due: amountPaid, amount_paid: status === 'paid' ? amountPaid : 0,
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
