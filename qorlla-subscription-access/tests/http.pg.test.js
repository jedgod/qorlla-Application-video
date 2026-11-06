// End to end over real HTTP: Express + the example routes + the real services + PostgreSQL (least-privilege roles).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createTestDb, newCustomer, seedSubscription, skip } from './helpers/db.js';
import { AccessService } from '../src/accessService.js';
import { AdminService } from '../src/admin.js';
import { BillingProcessor } from '../src/billing.js';
import { createMiddleware } from '../src/middleware.js';
import { createSignedJsonAdapter } from '../src/billingAdapters.js';
import { createExampleApp } from '../examples/express-integration.js';

const INTERNAL = 'i'.repeat(40);
const adapter = createSignedJsonAdapter({ provider: 'acme', secrets: ['w'.repeat(40)] });
const D = 86_400_000;

describe('HTTP end to end (PostgreSQL)', { skip }, () => {
  let db, server, base, service, tokens, down;
  before(async () => {
    db = await createTestDb();
    service = new AccessService({ pool: db.poolFor('runtime') });
    const billing = new BillingProcessor({ adapters: [adapter], pool: db.poolFor('billing'), onSubscriptionChanged: (c) => service.invalidate(c) });
    tokens = new Map();                                                    // stands in for a real verified-session lookup
    const app = createExampleApp({
      service, billing, middleware: createMiddleware(service), internalToken: INTERNAL,
      authenticate: async (req) => tokens.get((req.get('authorization') || '').replace(/^Bearer /, '')) || null,
    });
    server = createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    down = createServer(createExampleApp({
      service: new AccessService({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none', connectionTimeoutMs: 300 }), billing,
      middleware: createMiddleware(new AccessService({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none', connectionTimeoutMs: 300 })),
      internalToken: INTERNAL, authenticate: async () => ({ customer_id: newCustomer(), user_id: 'u' }),
    }));
    await new Promise((r) => down.listen(0, '127.0.0.1', r));
  });
  after(async () => { server.close(); down.close(); await db.drop(); });

  const login = async (plan, o = {}) => {
    const customer_id = newCustomer(); await seedSubscription(db.owner, customer_id, { plan, ...o });
    const token = 't-' + customer_id; tokens.set(token, { customer_id, user_id: 'user-' + customer_id.slice(0, 6) });
    return { customer_id, token };
  };
  const call = (token, path, { method = 'GET', body, headers = {} } = {}, b = base) => fetch(b + path, {
    method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });

  test('no session -> 401; a forged x-customer-id header, query or body is never used as identity', async () => {
    const victim = await login('enterprise');
    assert.equal((await call(null, '/api/me/entitlements')).status, 401);
    assert.equal((await call(null, `/api/me/entitlements?customer_id=${victim.customer_id}`, { headers: { 'x-customer-id': victim.customer_id } })).status, 401);
    const attacker = await login('basic');
    const r = await call(attacker.token, `/api/me/entitlements?customer_id=${victim.customer_id}`, { headers: { 'x-customer-id': victim.customer_id } });
    assert.equal((await r.json()).plan, 'basic', 'the attacker still sees their own plan');
    const m = await call(attacker.token, '/api/meetings', { method: 'POST', body: { max_participants: 300, customer_id: victim.customer_id } });
    assert.equal(m.status, 403, 'basic cannot create a 300 participant meeting by claiming an enterprise id');
  });

  test('capacity limits over HTTP: allowed, refused with the plan that unlocks it, and lapsed -> 402', async () => {
    const biz = await login('business');
    assert.equal((await call(biz.token, '/api/meetings', { method: 'POST', body: { max_participants: 300, duration_minutes: 90 } })).status, 201);
    const over = await call(biz.token, '/api/meetings', { method: 'POST', body: { max_participants: 301 } });
    assert.equal(over.status, 403); assert.equal((await over.json()).code, 'limit_exceeded');
    const paused = await login('pro', { status: 'paused' });
    const r = await call(paused.token, '/api/phone/pstn/enable', { method: 'POST' });
    assert.equal(r.status, 402);
    assert.equal((await call(biz.token, '/api/meetings', { method: 'POST', body: { max_participants: 'many' } })).status, 201, 'a non-numeric value falls back to the minimum of 1');
    assert.equal((await call(biz.token, '/api/meetings', { method: 'POST', body: { max_participants: -5 } })).status, 400, 'a negative quantity is rejected, not clamped');
  });

  test('PSTN: a business plan owns it but the operational gate keeps it closed (403 operational_gate_off)', async () => {
    const biz = await login('business');
    const r = await call(biz.token, '/api/phone/pstn/enable', { method: 'POST' });
    assert.equal(r.status, 403); assert.equal((await r.json()).code, 'operational_gate_off');
  });

  test('metered work: reserve -> commit once; a retry with the same Idempotency-Key replays without consuming; the 4th distinct request is refused', async () => {
    const u = await login('basic');                                       // 3 summaries per window
    assert.equal((await call(u.token, '/api/ai/summaries', { method: 'POST', body: {} })).status, 400, 'Idempotency-Key is mandatory');
    const post = (key) => call(u.token, '/api/ai/summaries', { method: 'POST', body: { meeting_id: 'm' }, headers: { 'idempotency-key': key } });
    assert.equal((await post('a')).status, 201);
    const replay = await post('a');
    assert.equal(replay.status, 200); assert.equal((await replay.json()).replay, true);
    assert.equal((await post('b')).status, 201); assert.equal((await post('c')).status, 201);
    const refused = await post('d');
    assert.equal(refused.status, 403); assert.equal((await refused.json()).code, 'limit_exceeded');
    const used = await db.owner.query(`SELECT COALESCE(sum(quantity),0)::int n FROM usage_events WHERE customer_id=$1`, [u.customer_id]);
    assert.equal(used.rows[0].n, 3, 'exactly the three distinct requests were metered');
    const held = await db.owner.query(`SELECT count(*)::int n FROM quota_reservations WHERE customer_id=$1 AND status='reserved'`, [u.customer_id]);
    assert.equal(held.rows[0].n, 0, 'nothing left holding quota');
  });

  test('30 simultaneous HTTP requests, limit 3: exactly 3 succeed', async () => {
    const u = await login('basic');
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => call(u.token, '/api/ai/summaries', { method: 'POST', body: {}, headers: { 'idempotency-key': 'k' + i } })));
    const codes = rs.map((r) => r.status);
    assert.equal(codes.filter((c) => c === 201).length, 3);
    assert.equal(codes.filter((c) => c === 403).length, 27);
  });

  test('database down -> 503 access_unavailable with no internal detail; never a pass-through', async () => {
    const dbase = `http://127.0.0.1:${down.address().port}`;
    for (const [path, opts] of [['/api/meetings', { method: 'POST', body: { max_participants: 5 } }], ['/api/ai/summaries', { method: 'POST', body: {}, headers: { 'idempotency-key': 'z' } }], ['/api/me/entitlements', {}]]) {
      const r = await call('anything', path, opts, dbase);
      assert.equal(r.status, 503, path);
      const text = await r.text();
      assert.match(text, /access_unavailable/); assert.doesNotMatch(text, /ECONNREFUSED|127\.0\.0\.1|postgres|stack/i);
    }
  });

  test('webhooks over HTTP: a signed event is applied and the customer sees it at once; forged, tampered and replayed ones are handled safely', async () => {
    const u = await login('basic');
    const ext = 'cus_http_' + u.customer_id.slice(0, 8);
    const admin = new AdminService({ pool: db.poolFor('admin'), authorize: async () => true });
    await admin.linkBillingCustomer({ id: 'a', roles: ['billing_admin'], mfaVerifiedAt: Date.now() }, 'acme', ext, u.customer_id);
    await db.owner.query('DELETE FROM subscriptions WHERE customer_id=$1', [u.customer_id]);        // start from "no subscription"
    const event = { provider: 'acme', eventId: 'evt_http_1', type: 'subscription.created', revision: 1, occurredAt: new Date().toISOString(), externalCustomerId: ext,
      subscription: { externalId: 'sub_http_1', planCode: 'business', status: 'active', currentPeriodStart: new Date(Date.now() - D).toISOString(), currentPeriodEnd: new Date(Date.now() + 29 * D).toISOString() } };
    const body = Buffer.from(JSON.stringify(event));
    const hook = (b, sig) => fetch(base + '/webhooks/acme', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sig }, body: b });

    assert.equal((await (await call(u.token, '/api/me/entitlements')).json()).plan, 'basic');
    const ok = await hook(body, adapter.sign(body));
    assert.equal(ok.status, 200); assert.equal((await ok.json()).status, 'applied');
    assert.equal((await (await call(u.token, '/api/me/entitlements')).json()).plan, 'business', 'entitlements follow the webhook immediately');

    const dup = await hook(body, adapter.sign(body));
    assert.equal(dup.status, 200); assert.equal((await dup.json()).status, 'duplicate');
    assert.equal((await hook(body, adapter.sign(body, Date.now(), 'x'.repeat(40)))).status, 401, 'forged');
    assert.equal((await hook(Buffer.from(JSON.stringify({ ...event, revision: 50 })), adapter.sign(body))).status, 401, 'tampered');
    assert.equal((await hook(Buffer.from(JSON.stringify(event, null, 2)), adapter.sign(body))).status, 401, 're-serialised');
    assert.equal((await hook(body, 'garbage')).status, 401);
    assert.equal((await fetch(base + '/webhooks/unknown', { method: 'POST', body })).status, 400);
    const bad = Buffer.from(JSON.stringify({ ...event, eventId: 'evt_http_bad', subscription: { ...event.subscription, planCode: 'platinum' } }));
    assert.equal((await hook(bad, adapter.sign(bad))).status, 400, 'signed but malformed');
  });

  test('the internal refresh route needs the service token (a user session is not enough)', async () => {
    const u = await login('pro');
    const url = `/internal/subscriptions/${u.customer_id}/refresh`;
    assert.equal((await call(u.token, url, { method: 'POST' })).status, 401);
    assert.equal((await call(u.token, url, { method: 'POST', headers: { 'x-internal-token': 'wrong' } })).status, 401);
    assert.equal((await call(u.token, url, { method: 'POST', headers: { 'x-internal-token': INTERNAL } })).status, 200);
  });

  test('the example refuses to be built without authentication or an internal token', () => {
    assert.throws(() => createExampleApp({ service, middleware: createMiddleware(service), internalToken: INTERNAL }), /authenticate/);
    assert.throws(() => createExampleApp({ service, middleware: createMiddleware(service), authenticate: async () => null }), /internalToken/);
  });
});
