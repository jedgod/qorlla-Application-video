// HTTP surface of unified billing over a real socket and a real PostgreSQL: signed webhooks arrive as RAW bytes, status codes follow what
// providers retry on, and the member-facing routes enforce identity, CSRF and live authorization.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createTestDb, skip } from './helpers/db.js';
import { DirectoryAdmin } from '../src/directory.js';
import { BillingProcessor } from '../src/billing.js';
import { BillingGateway } from '../src/billingGateway.js';
import { AccessService } from '../src/accessService.js';
import { webhookRouter, customerRouter } from '../src/billingRoutes.js';
import { SubscriptionError } from '../src/errors.js';
import { stripeAdapter, rcAdapter, stripeSub, stripeEvent, rcEvent } from './providers.test.js';

const T = Math.floor(Date.now() / 1000);
let n = 0;
const uid = (t) => `u_${t}${++n}-${Math.random().toString(16).slice(2, 8)}`;
const listen = (app) => new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res({ s, base: `http://127.0.0.1:${s.address().port}` })); });

describe('billing HTTP routes (PostgreSQL, real sockets)', { skip }, () => {
  let db, directory, access, gateway, billing, hooks, web, jsonFirst, stub, calls;
  before(async () => {
    db = await createTestDb();
    directory = new DirectoryAdmin({ pool: db.poolFor('admin'), authorizeStaff: async () => true });
    access = new AccessService({ pool: db.poolFor('runtime') });
    billing = new BillingProcessor({ adapters: [stripeAdapter(), rcAdapter()], pool: db.poolFor('billing') });
    calls = [];
    const stripe = { createCustomer: async () => ({ id: 'cus_' + ++n }), createCheckoutSession: async (a) => ({ url: 'https://checkout.stripe.test/' + a.customer }), createPortalSession: async (a) => ({ url: 'https://portal.stripe.test/' + a.customer }) };
    gateway = new BillingGateway({ pool: db.poolFor('billing'), stripe, prices: { pro: 'price_pro' }, urls: {}, access });

    const quiet = { error: (...a) => calls.push(a) };
    const app = express();
    app.use('/webhooks', webhookRouter({ billing, logger: quiet, limit: '64kb' }));
    const csrf = (req, res, next) => (req.headers['x-csrf'] === 'ok' ? next() : res.status(403).json({ error: 'csrf' }));
    app.use('/billing', customerRouter({ gateway, getUserId: (req) => req.headers['x-test-user'] || null, csrf }));
    web = await listen(app);

    // the classic mistake: a global JSON parser mounted BEFORE the webhook router
    const bad = express(); bad.use(express.json()); bad.use('/webhooks', webhookRouter({ billing, logger: quiet }));
    jsonFirst = await listen(bad);

    stub = await listen((() => {
      const a = express(); const mode = { v: 'retry' };
      a.post('/mode/:m', (req, res) => { mode.v = req.params.m; res.end(); });
      const failing = { async ingest() { if (mode.v === 'retry') throw new SubscriptionError('x', 'webhook_processing_failed', {}, 503); throw new Error('database password is hunter2'); } };
      a.use('/webhooks', webhookRouter({ billing: failing, logger: quiet }));
      return a;
    })());
  });
  after(async () => { for (const x of [web, jsonFirst, stub]) await new Promise((r) => x.s.close(r)); await db.drop(); });

  const post = (base, path, body, headers = {}) => fetch(base + path, { method: 'POST', body, headers });
  const world = async ({ kind = 'organization' } = {}) => {
    const owner = uid('own'); const id = (await directory.createCustomer(owner, 'Acme', { kind })).customer_id;
    const ext = 'cus_h' + ++n;
    await db.owner.query(`INSERT INTO billing_customers (provider, external_customer_id, customer_id, linked_by) VALUES ('stripe',$1,$2,'t')`, [ext, id]);
    if (kind === 'personal') await db.owner.query(`INSERT INTO billing_customers (provider, external_customer_id, customer_id, linked_by) VALUES ('revenuecat',$1::text,$1::uuid,'t')`, [id]);
    return { owner, id, ext, sub: 'sub_' + id.slice(0, 8), otx: 'otx_' + id.slice(0, 8) };
  };
  const can = async (id) => (await access.canAccess(id, 'meetings.cloud_recording')).allowed;
  const stripeReq = (w, type = 'customer.subscription.created', created = T) => stripeEvent(type, stripeSub({ id: w.sub, customer: w.ext, current_period_start: T - 86400, current_period_end: T + 30 * 86400, metadata: { qorlla_customer_id: w.id } }), { created });

  test('STRIPE over HTTP: a correctly signed RAW body is applied (200) and grants access; replay is a 200 no-op', async () => {
    const w = await world(); const e = stripeReq(w);
    // Stripe's tolerance window is checked against the real clock, so sign "now"
    const rawBody = e.rawBody, headers = { 'stripe-signature': stripeAdapter().sign(rawBody, Date.now()), 'content-type': 'application/json' };
    const r = await post(web.base, '/webhooks/stripe', rawBody, headers);
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { status: 'applied' });
    assert.equal(await can(w.id), true);
    assert.deepEqual(await (await post(web.base, '/webhooks/stripe', rawBody, headers)).json(), { status: 'duplicate' });
  });

  test('REVENUECAT over HTTP: the configured Authorization value is required', async () => {
    const w = await world({ kind: 'personal' });
    const e = rcEvent({ app_user_id: w.id, original_transaction_id: w.otx, purchased_at_ms: Date.now() - 1000, expiration_at_ms: Date.now() + 3_600_000, event_timestamp_ms: Date.now() });
    assert.equal((await post(web.base, '/webhooks/revenuecat', e.rawBody, { authorization: 'Bearer nope' })).status, 401);
    assert.equal(await can(w.id), false);
    const ok = await post(web.base, '/webhooks/revenuecat', e.rawBody, { authorization: e.headers.authorization, 'content-type': 'application/json' });
    assert.equal(ok.status, 200); assert.equal(await can(w.id), true);
  });

  test('FAILURES ARE CLASSIFIED: bad/missing signature 401, tampered body 401, malformed signed payload 400, oversize 413; nothing changes access', async () => {
    const w = await world(); const e = stripeReq(w);
    const sig = stripeAdapter().sign(e.rawBody, Date.now());
    assert.equal((await post(web.base, '/webhooks/stripe', e.rawBody, {})).status, 401, 'no signature');
    assert.equal((await post(web.base, '/webhooks/stripe', e.rawBody, { 'stripe-signature': 't=1,v1=00' })).status, 401, 'bad signature');
    assert.equal((await post(web.base, '/webhooks/stripe', Buffer.from(e.rawBody.toString().replace('"active"', '"trialing"')), { 'stripe-signature': sig })).status, 401, 'tampered body');
    const junk = Buffer.from('{not json');
    assert.equal((await post(web.base, '/webhooks/stripe', junk, { 'stripe-signature': stripeAdapter().sign(junk, Date.now()) })).status, 400, 'signed but malformed');
    const huge = Buffer.alloc(80 * 1024, 120);
    assert.equal((await post(web.base, '/webhooks/stripe', huge, { 'stripe-signature': stripeAdapter().sign(huge, Date.now()) })).status, 413, 'oversize');
    assert.equal((await post(web.base, '/webhooks/paypal', e.rawBody, {})).status, 404, 'unknown provider has no route');
    assert.equal(await can(w.id), false);
  });

  test('PARKED EVENTS ARE 200: an unmapped provider customer is acknowledged (retrying cannot help) and recorded for an operator', async () => {
    const w = await world(); const e = stripeReq({ ...w, ext: 'cus_unknown_zz' });
    const r = await post(web.base, '/webhooks/stripe', e.rawBody, { 'stripe-signature': stripeAdapter().sign(e.rawBody, Date.now()) });
    assert.equal(r.status, 200); assert.equal((await r.json()).status, 'dead');
    assert.ok(Number((await db.owner.query(`SELECT count(*) n FROM security_events WHERE event_type='webhook_unmapped_customer'`)).rows[0].n) >= 1);
  });

  test('A GLOBAL JSON PARSER MOUNTED FIRST is refused loudly (400) instead of verifying a re-serialised body', async () => {
    const w = await world(); const e = stripeReq(w);
    const r = await post(jsonFirst.base, '/webhooks/stripe', e.rawBody, { 'stripe-signature': stripeAdapter().sign(e.rawBody, Date.now()), 'content-type': 'application/json' });
    assert.equal(r.status, 400); assert.equal((await r.json()).error, 'raw_body_required');
    assert.equal(await can(w.id), false);
  });

  test('RETRY SEMANTICS AND NO LEAKS: a transient failure is 503 (provider retries); an unexpected error is a generic 500 that never echoes internals', async () => {
    await fetch(stub.base + '/mode/retry', { method: 'POST' });
    const a = await post(stub.base, '/webhooks/stripe', Buffer.from('{}'), {}); assert.equal(a.status, 503); assert.deepEqual(await a.json(), { error: 'retry_later' });
    await fetch(stub.base + '/mode/boom', { method: 'POST' });
    const b = await post(stub.base, '/webhooks/stripe', Buffer.from('{}'), {}); assert.equal(b.status, 500);
    assert.doesNotMatch(await b.text(), /hunter2/);
  });

  test('MEMBER ROUTES: identity and CSRF are required; checkout/summary enforce live authorization; bad input is a 4xx, never a 500', async () => {
    const w = await world(); const h = { 'content-type': 'application/json', 'x-test-user': w.owner, 'x-csrf': 'ok' };
    const body = (o) => JSON.stringify({ customerId: w.id, provider: 'stripe', planCode: 'pro', ...o });
    assert.equal((await post(web.base, '/billing/checkout', body(), { 'content-type': 'application/json', 'x-csrf': 'ok' })).status, 401, 'no session');
    assert.equal((await post(web.base, '/billing/checkout', body(), { 'content-type': 'application/json', 'x-test-user': w.owner })).status, 403, 'no CSRF token');
    assert.equal((await post(web.base, '/billing/checkout', body({ customerId: 5 }), h)).status, 400);
    assert.equal((await post(web.base, '/billing/checkout', body({ customerId: 'nope' }), h)).status, 400);
    assert.equal((await post(web.base, '/billing/checkout', body({ planCode: ['pro'] }), h)).status, 400);
    assert.equal((await post(web.base, '/billing/checkout', body(), { ...h, 'x-test-user': uid('stranger') })).status, 403, 'not a member');
    const ok = await post(web.base, '/billing/checkout', body(), h);
    assert.equal(ok.status, 201); assert.match((await ok.json()).url, /^https:\/\/checkout\.stripe\.test\//);
    const again = await post(web.base, '/billing/checkout', body(), h);
    assert.equal(again.status, 409); assert.equal((await again.json()).error, 'checkout_in_progress');
  });

  test('SUMMARY over HTTP: reflects the verified subscription, hides billing management from plain members, rejects bad ids', async () => {
    const w = await world(); const member = uid('mem'); await directory.addMember(w.owner, w.id, member, 'member');
    const e = stripeReq(w); await post(web.base, '/webhooks/stripe', e.rawBody, { 'stripe-signature': stripeAdapter().sign(e.rawBody, Date.now()) });
    const get = (u, q) => fetch(`${web.base}/billing/summary?customerId=${q ?? w.id}&usage=meetings.cloud_recording`, { headers: u ? { 'x-test-user': u } : {} });
    assert.equal((await get(null)).status, 401);
    const s = await (await get(w.owner)).json();
    assert.equal(s.plan, 'pro'); assert.equal(s.billingSource.id, 'stripe'); assert.equal(s.manage.kind, 'stripe_portal'); assert.equal(s.usage['meetings.cloud_recording'].allowed, true);
    assert.equal((await (await get(member)).json()).manage, null);
    assert.equal((await get(uid('stranger'))).status, 403);
    assert.equal((await get(w.owner, 'not-a-uuid')).status, 400);
  });

  test('CONSTRUCTION FAILS CLOSED: no CSRF middleware, no identity function, or no processor means no router', () => {
    assert.throws(() => customerRouter({ gateway, getUserId: () => 'u' }), /csrf/);
    assert.throws(() => customerRouter({ gateway, csrf: (q, s, nx) => nx() }), /getUserId/);
    assert.throws(() => webhookRouter({}), /BillingProcessor/);
  });
});
