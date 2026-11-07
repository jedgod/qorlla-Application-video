// Session -> verified tenant identity, against the REAL main-application auth (auth.js: real sign-up, cookies, logout, expiry)
// and a real PostgreSQL directory. Everything goes over HTTP with cookies, like a browser.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createTestDb, seedSubscription, skip } from './helpers/db.js';
import { Directory, DirectoryAdmin } from '../src/directory.js';
import { createIdentity } from '../src/identity.js';
import { AccessService } from '../src/accessService.js';
import { BillingProcessor } from '../src/billing.js';
import { createMiddleware } from '../src/middleware.js';
import { createExampleApp } from '../examples/express-integration.js';

const require = createRequire(import.meta.url);
const createAuth = require('../../auth.js');
let seq = 0;

describe('session -> tenant identity (real auth.js + PostgreSQL)', { skip }, () => {
  let db, dataDir, auth, dir, admin, identity, server, base, example, exampleBase;
  before(async () => {
    db = await createTestDb();
    dataDir = await mkdtemp(join(tmpdir(), 'subacc-auth-'));
    auth = createAuth({ dataDir, mailer: { enabled: false, configured: false, baseUrl: '' } });
    dir = new Directory({ pool: db.poolFor('runtime') });
    admin = new DirectoryAdmin({ pool: db.poolFor('admin') });
    identity = createIdentity({ getUser: auth.getUser, directory: dir });

    const app = express();
    app.use('/api/auth', auth.router);
    app.get('/whoami', identity.middleware(), (req, res) => res.json(req.auth));
    app.get('/owner-only', identity.middleware(), identity.requireRole('owner'), (req, res) => res.json({ ok: true }));
    server = createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;

    const access = new AccessService({ pool: db.poolFor('runtime') });
    example = createServer(createExampleApp({
      service: access, middleware: createMiddleware(access), internalToken: 'i'.repeat(40), authenticate: identity.authenticate,
      billing: new BillingProcessor({ adapters: [], pool: db.poolFor('billing') }),
    }));
    await new Promise((r) => example.listen(0, '127.0.0.1', r));
    exampleBase = `http://127.0.0.1:${example.address().port}`;
  });
  after(async () => { server.close(); example.close(); await db.drop(); await rm(dataDir, { recursive: true, force: true }); });

  const post = (path, body, cookie) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const get = (path, cookie, headers = {}, b = base) => fetch(b + path, { headers: { ...(cookie ? { cookie } : {}), ...headers } });
  const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

  /** A real user, signed up through the real auth router. */
  const signup = async (label = 'user') => {
    const username = `${label}${++seq}x${Math.random().toString(36).slice(2, 7)}`.slice(0, 24);
    const res = await post('/api/auth/register', { username, password: 'correct-horse-battery-9', displayName: username });
    assert.equal(res.status, 201);
    return { cookie: cookieOf(res), id: (await res.json()).user.id, username };
  };
  const login = async (u) => cookieOf(await post('/api/auth/login', { username: u.username, password: 'correct-horse-battery-9' }));

  test('a signed-in member resolves to their customer and role; every anonymous or forged session is refused', async () => {
    const u = await signup('alice');
    const { customer_id } = await admin.createCustomer(u.id, 'Alice Inc');
    const r = await get('/whoami', u.cookie);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { customer_id, user_id: u.id, role: 'owner' });
    assert.equal((await get('/whoami')).status, 401, 'no cookie');
    assert.equal((await get('/whoami', 'qs=' + 'a'.repeat(64))).status, 401, 'forged token');
    assert.equal((await get('/whoami', 'qs=')).status, 401);
    assert.equal((await get('/whoami', u.cookie.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')))).status, 401, 'one character off');
  });

  test('a signed-in user with no customer gets a specific 403, not someone else\'s data', async () => {
    const u = await signup('lonely');
    const r = await get('/whoami', u.cookie);
    assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'no_customer' });
  });

  test('REVOKED SESSION: logging out ends access on the very next request, and the old cookie never works again', async () => {
    const u = await signup('revoke');
    await admin.createCustomer(u.id, 'Revoke Co');
    assert.equal((await get('/whoami', u.cookie)).status, 200);
    assert.equal((await post('/api/auth/logout', {}, u.cookie)).status, 200);
    assert.equal((await get('/whoami', u.cookie)).status, 401, 'the old cookie is dead');
    const fresh = await login(u);
    assert.notEqual(fresh, u.cookie);
    assert.equal((await get('/whoami', fresh)).status, 200, 'a new sign-in works');
    assert.equal((await get('/whoami', u.cookie)).status, 401, 'and the old one still does not');
  });

  test('EXPIRED SESSION: a session past its expiry is refused', async () => {
    const u = await signup('expire');
    await admin.createCustomer(u.id, 'Expire Co');
    assert.equal((await get('/whoami', u.cookie)).status, 200);
    const file = join(dataDir, 'auth', 'sessions.json');
    const sessions = JSON.parse(await readFile(file, 'utf8'));
    for (const k of Object.keys(sessions)) sessions[k].exp = Date.now() - 1000;          // every session just expired
    await writeFile(file, JSON.stringify(sessions));
    assert.equal((await get('/whoami', u.cookie)).status, 401);
  });

  test('ROLE CHANGE: demotion takes effect on the next request, mid-session, with no re-login; promotion too', async () => {
    const owner = await signup('boss'), member = await signup('staffer');
    const { customer_id } = await admin.createCustomer(owner.id, 'Role Co');
    await admin.addMember(owner.id, customer_id, member.id, 'admin');
    assert.equal((await get('/owner-only', member.cookie)).status, 403, 'an admin is not an owner');
    assert.equal((await (await get('/whoami', member.cookie)).json()).role, 'admin');
    await admin.setRole(owner.id, customer_id, member.id, 'owner');
    assert.equal((await get('/owner-only', member.cookie)).status, 200, 'promoted: allowed at once');
    await admin.setRole(owner.id, customer_id, member.id, 'member');
    assert.equal((await get('/owner-only', member.cookie)).status, 403, 'demoted: refused at once');
    assert.equal((await (await get('/whoami', member.cookie)).json()).role, 'member');
  });

  test('REMOVED MEMBER: loses access at once even though their session is still valid', async () => {
    const owner = await signup('o'), m = await signup('m');
    const { customer_id } = await admin.createCustomer(owner.id, 'Removal Co');
    await admin.addMember(owner.id, customer_id, m.id, 'member');
    assert.equal((await get('/whoami', m.cookie)).status, 200);
    await admin.removeMember(owner.id, customer_id, m.id);
    const r = await get('/whoami', m.cookie);
    assert.equal(r.status, 403); assert.equal((await r.json()).error, 'no_customer');
  });

  test('SUSPENDED customer: every member is refused until reactivated', async () => {
    const owner = await signup('susp');
    const { customer_id } = await admin.createCustomer(owner.id, 'Susp Co');
    const staffAdmin = new DirectoryAdmin({ pool: db.poolFor('admin'), authorizeStaff: async () => true });
    await staffAdmin.setStatus({ id: 'staff-1' }, customer_id, 'suspended');
    const r = await get('/whoami', owner.cookie);
    assert.equal(r.status, 403); assert.equal((await r.json()).error, 'customer_suspended');
    assert.equal((await get('/whoami', owner.cookie, { 'x-qorlla-customer': customer_id })).status, 403);
    await staffAdmin.setStatus({ id: 'staff-1' }, customer_id, 'active');
    assert.equal((await get('/whoami', owner.cookie)).status, 200);
  });

  test('CROSS-TENANT: naming another tenant\'s id (header, case-mangled, garbage) never works for a non-member', async () => {
    const [a, b] = [await signup('tenantA'), await signup('tenantB')];
    const ca = (await admin.createCustomer(a.id, 'A Co')).customer_id, cb = (await admin.createCustomer(b.id, 'B Co')).customer_id;
    const asB = (h) => get('/whoami', b.cookie, { 'x-qorlla-customer': h });
    for (const attempt of [ca, ca.toUpperCase(), ' ' + ca + ' ']) {
      const r = await asB(attempt);
      assert.equal(r.status, 403, attempt); assert.equal((await r.json()).error, 'not_a_member');
    }
    for (const junk of ['nope', "' OR 1=1 --", '../a', '0'.repeat(36)]) assert.equal((await asB(junk)).status, 403, junk);
    assert.equal((await (await asB(cb)).json()).customer_id, cb, 'naming your own tenant is fine');
    assert.equal((await (await get('/whoami', b.cookie)).json()).customer_id, cb, 'and without a header you only ever get your own');
    assert.equal((await get('/whoami', b.cookie, { 'X-Qorlla-Customer': ca })).status, 403);
  });

  test('MULTIPLE customers: the user must choose one; the choice is verified against membership', async () => {
    const [u, other] = [await signup('multi'), await signup('other')];
    const c1 = (await admin.createCustomer(u.id, 'First')).customer_id, c2 = (await admin.createCustomer(u.id, 'Second')).customer_id;
    const unrelated = (await admin.createCustomer(other.id, 'Unrelated')).customer_id;
    const ambiguous = await get('/whoami', u.cookie);
    assert.equal(ambiguous.status, 409);
    const body = await ambiguous.json();
    assert.equal(body.error, 'customer_selection_required'); assert.deepEqual(body.choices.map((c) => c.customer_id).sort(), [c1, c2].sort());
    assert.equal((await (await get('/whoami', u.cookie, { 'x-qorlla-customer': c2 })).json()).customer_id, c2);
    assert.equal((await get('/whoami', u.cookie, { 'x-qorlla-customer': unrelated })).status, 403);
  });

  test('a directory failure is a 503, never a pass-through', async () => {
    const u = await signup('dbdown');
    const broken = createIdentity({ getUser: auth.getUser, directory: new Directory({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none' }) });
    const app = express(); app.get('/x', broken.middleware(), (_req, res) => res.json({ leaked: true }));
    const s = createServer(app); await new Promise((r) => s.listen(0, '127.0.0.1', r));
    try {
      const r = await get('/x', u.cookie, {}, `http://127.0.0.1:${s.address().port}`);
      assert.equal(r.status, 503); assert.doesNotMatch(await r.text(), /leaked|ECONNREFUSED|postgres/);
    } finally { s.close(); }
    const throwing = createIdentity({ getUser: () => { throw new Error('session store unreadable'); }, directory: dir });
    assert.deepEqual((await throwing.resolve({ headers: {} })), { ok: false, status: 503, code: 'access_unavailable' });
  });

  test('requireVerifiedEmail is available for sensitive deployments', async () => {
    const u = await signup('unverified');
    await admin.createCustomer(u.id, 'Unverified Co');
    const strict = createIdentity({ getUser: auth.getUser, directory: dir, requireVerifiedEmail: true });
    const app = express(); app.get('/x', strict.middleware(), (_req, res) => res.json({ ok: 1 }));
    const s = createServer(app); await new Promise((r) => s.listen(0, '127.0.0.1', r));
    try {
      const r = await get('/x', u.cookie, {}, `http://127.0.0.1:${s.address().port}`);
      assert.equal(r.status, 403); assert.equal((await r.json()).error, 'email_unverified');
    } finally { s.close(); }
  });

  test('construction refuses missing collaborators', () => {
    assert.throws(() => createIdentity({ directory: dir }), /getUser/);
    assert.throws(() => createIdentity({ getUser: auth.getUser }), /Directory/);
  });

  test('END TO END with the example API: real cookie -> verified tenant -> that tenant\'s plan; a stolen tenant id buys nothing', async () => {
    const [rich, poor] = [await signup('rich'), await signup('poor')];
    const cr = (await admin.createCustomer(rich.id, 'Rich Co')).customer_id, cp = (await admin.createCustomer(poor.id, 'Poor Co')).customer_id;
    await seedSubscription(db.owner, cr, { plan: 'business' }); await seedSubscription(db.owner, cp, { plan: 'basic' });
    const create = (cookie, body, headers = {}) => fetch(exampleBase + '/api/meetings', { method: 'POST', headers: { 'content-type': 'application/json', cookie, ...headers }, body: JSON.stringify(body) });
    assert.equal((await create(rich.cookie, { max_participants: 300, duration_minutes: 60 })).status, 201, 'business: 300');
    assert.equal((await create(poor.cookie, { max_participants: 300, duration_minutes: 30 })).status, 403, 'basic: capped at 100');
    assert.equal((await create(poor.cookie, { max_participants: 300, duration_minutes: 30 }, { 'x-qorlla-customer': cr })).status, 401, 'claiming the rich tenant is refused outright');
    const entitlements = await (await fetch(exampleBase + '/api/me/entitlements', { headers: { cookie: poor.cookie, 'x-qorlla-customer': cp } })).json();
    assert.equal(entitlements.plan, 'basic');
    await post('/api/auth/logout', {}, rich.cookie);
    assert.equal((await create(rich.cookie, { max_participants: 5 })).status, 401, 'signed out: nothing');
  });
});
