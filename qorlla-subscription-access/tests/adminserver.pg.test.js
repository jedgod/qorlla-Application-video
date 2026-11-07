// The internal administration service over real HTTP and PostgreSQL: signed assertions, replay, route/customer binding, step-up gates,
// platform-staff scope, customer roles, last-owner rule, request log. The passkey ceremonies run through the API with a software passkey.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { createTestDb, newCustomer, seedSubscription, skip } from './helpers/db.js';
import { SoftAuthenticator } from './helpers/softauth.js';
import { StepUpService } from '../src/stepup.js';
import { createStaff } from '../src/staff.js';
import { DirectoryAdmin } from '../src/directory.js';
import { AdminService } from '../src/admin.js';
import { AccessService } from '../src/accessService.js';
import { createAdminServer } from '../src/adminServer.js';
import { createAdminClient } from '../src/adminClient.js';
import { signAssertion } from '../src/assertion.js';
import { ROUTES, fillPath } from '../src/adminRoutes.js';
import { totp, base32Decode } from '../src/totp.js';

const RP = 'localhost', ORIGIN = 'https://localhost:3443';
const K1 = 'k'.repeat(40), K2 = 'r'.repeat(40);
const sid = () => randomBytes(32).toString('hex');
let n = 0;
const uid = () => `u_${++n}_${randomBytes(3).toString('hex')}`;
const future = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

describe('internal administration service (PostgreSQL + HTTP)', { skip }, () => {
  let db, server, base, api, stepUp, adminPool, keys, runtime;
  before(async () => {
    db = await createTestDb();
    adminPool = db.poolFor('admin');
    runtime = new AccessService({ pool: db.poolFor('runtime') });
    stepUp = new StepUpService({ pool: adminPool, rpID: RP, origins: [ORIGIN], totpKey: randomBytes(32) });
    const staff = createStaff({ pool: adminPool });
    keys = [K1];
    const app = createAdminServer({
      keys, pool: adminPool, stepUp, staff,
      directoryAdmin: new DirectoryAdmin({ pool: adminPool, authorizeStaff: staff.authorize }),
      adminService: new AdminService({ pool: adminPool, authorize: staff.authorize }),
      logger: { error() { /* expected in negative tests */ } },
    });
    server = createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    api = createAdminClient({ baseUrl: base, key: K1 });
  });
  after(async () => { server.close(); await db.drop(); });

  const call = (name, user, session, o = {}) => api.call(name, { userId: user, sessionHash: session, ...o });
  const count = async (sql, a) => Number((await db.owner.query(sql, a)).rows[0].n);
  const staffRow = (user, o = {}) => db.owner.query(`INSERT INTO platform_staff (user_id, roles, all_customers, granted_by) VALUES ($1,$2,$3,'dba')`, [user, o.roles ?? ['billing_admin', 'support_admin'], o.all ?? true]);

  /** Register a passkey through the API (first factor, token issued out of band) and return the authenticator. */
  async function enrollPasskey(user, session) {
    const a = new SoftAuthenticator({ rpID: RP, origin: ORIGIN });
    const token = await stepUp.createEnrollmentToken({ userId: user, createdBy: 'ops' });
    const begin = await call('registerBegin', user, session, { body: { userName: user, enrollmentToken: token } });
    assert.equal(begin.status, 200, JSON.stringify(begin.body));
    const fin = await call('registerFinish', user, session, { body: { response: a.create(begin.body), label: 'laptop', enrollmentToken: token } });
    assert.equal(fin.status, 200, JSON.stringify(fin.body));
    return a;
  }
  async function stepUpVia(user, session, action, a) {
    const begin = await call('assertBegin', user, session, { body: { action } });
    assert.equal(begin.status, 200);
    return call('assertFinish', user, session, { body: { action, response: a.get(begin.body) } });
  }
  async function setup() {                                  // an owner with a customer, a staff member with a passkey
    const owner = uid(), os = sid();
    const created = await call('orgCreate', owner, os, { body: { name: 'Acme' } });
    assert.equal(created.status, 201);
    return { owner, os, cid: created.body.customer_id };
  }

  // ---- 1. the signed assertion -------------------------------------------------------------------------------------------------
  test('every malformed, forged, expired or future-dated assertion is refused with the same 401 and logged; nothing executes', async () => {
    const route = ROUTES.orgCreate, url = base + route.path;
    const good = (o = {}) => signAssertion({ sub: uid(), sid: sid(), act: route.act, ...o }, K1);
    const post = (token) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { 'x-qorlla-assertion': token }) }, body: JSON.stringify({ name: 'X' }) });
    const forged = signAssertion({ sub: uid(), sid: sid(), act: route.act }, 'z'.repeat(40));
    const t = good(); const [p, s] = t.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), sub: 'u_admin' })).toString('base64url') + '.' + s;
    const expired = signAssertion({ sub: uid(), sid: sid(), act: route.act, now: Date.now() - 120_000, ttlMs: 30_000 }, K1);
    const future_ = signAssertion({ sub: uid(), sid: sid(), act: route.act, now: Date.now() + 120_000 }, K1);
    const longPayload = Buffer.from(JSON.stringify({ sub: uid(), sid: sid(), act: route.act, iat: Date.now(), exp: Date.now() + 3_600_000, jti: 'longlived-1234' })).toString('base64url');
    const longLived = longPayload + '.' + createHmac('sha256', K1).update(longPayload).digest('base64url');
    const before = await count('SELECT count(*) AS n FROM customers');
    for (const [name, token] of Object.entries({ none: undefined, empty: '', garbage: 'not-a-token', forged, 'tampered payload': tamperedPayload, expired, 'from the future': future_, 'one hour lifetime': longLived, 'oversized': 'a'.repeat(3000) })) {
      const r = await post(token);
      assert.equal(r.status, 401, name); assert.deepEqual(await r.json(), { error: 'invalid_assertion' }, name + ': one generic answer');
    }
    assert.equal(await count('SELECT count(*) AS n FROM customers'), before, 'nothing was created');
    assert.ok(await count(`SELECT count(*) AS n FROM admin_requests WHERE outcome='invalid'`) >= 9, 'each refusal is logged');
    assert.equal((await post(good())).status, 201, 'and a good one works');
  });

  test('replay: an assertion works exactly once, even raced from many connections at once', async () => {
    const route = ROUTES.orgCreate;
    const token = signAssertion({ sub: uid(), sid: sid(), act: route.act }, K1);
    const send = () => fetch(base + route.path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-qorlla-assertion': token }, body: JSON.stringify({ name: 'Once' }) });
    const rs = await Promise.all(Array.from({ length: 12 }, send));
    assert.equal(rs.filter((r) => r.status === 201).length, 1);
    assert.equal(rs.filter((r) => r.status === 401).length, 11);
    assert.equal((await send()).status, 401, 'and later too');
    assert.ok(await count(`SELECT count(*) AS n FROM admin_requests WHERE outcome='replay'`) >= 11);
  });

  test('route binding: an assertion minted for one action cannot be used for another', async () => {
    const owner = uid(), os = sid();
    const orgToken = signAssertion({ sub: owner, sid: os, act: ROUTES.orgCreate.act }, K1);
    const cid = newCustomer();
    for (const name of ['memberAdd', 'overrideSet', 'billingLink', 'orgStatus', 'sessionRevoke']) {
      const route = ROUTES[name];
      const r = await fetch(base + fillPath(route, { cid, uid: 'x', feature: 'meetings.cloud_recording' }), { method: route.method, headers: { 'content-type': 'application/json', 'x-qorlla-assertion': orgToken }, body: JSON.stringify({ customerId: cid }) });
      assert.equal(r.status, 403, name);
    }
  });

  test('customer binding: an assertion minted for customer A cannot act on customer B (path or body)', async () => {
    const a = await setup(), b = await setup();
    const token = signAssertion({ sub: a.owner, sid: a.os, act: ROUTES.memberAdd.act, cid: a.cid }, K1);
    const r = await fetch(base + fillPath(ROUTES.memberAdd, { cid: b.cid }), { method: 'POST', headers: { 'content-type': 'application/json', 'x-qorlla-assertion': token }, body: JSON.stringify({ userId: uid(), role: 'member' }) });
    assert.equal(r.status, 403);
    const noCid = signAssertion({ sub: a.owner, sid: a.os, act: ROUTES.memberAdd.act }, K1);
    const r2 = await fetch(base + fillPath(ROUTES.memberAdd, { cid: a.cid }), { method: 'POST', headers: { 'content-type': 'application/json', 'x-qorlla-assertion': noCid }, body: JSON.stringify({ userId: uid(), role: 'member' }) });
    assert.equal(r2.status, 403, 'a customer route needs an assertion that NAMES the customer');
    const l = signAssertion({ sub: a.owner, sid: a.os, act: ROUTES.billingLink.act, cid: a.cid }, K1);
    const r3 = await fetch(base + ROUTES.billingLink.path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-qorlla-assertion': l }, body: JSON.stringify({ provider: 'acme', externalCustomerId: 'c', customerId: b.cid }) });
    assert.equal(r3.status, 403, 'body customer must match too');
    assert.equal(await count(`SELECT count(*) AS n FROM customer_members WHERE customer_id=$1`, [b.cid]), 1, 'B untouched');
  });

  test('key rotation: a token signed with the previous key works while it is configured, and stops when it is retired', async () => {
    const old = createAdminClient({ baseUrl: base, key: K2 });
    const r1 = await old.call('orgCreate', { userId: uid(), sessionHash: sid(), body: { name: 'Rot' } });
    assert.equal(r1.status, 401);
    keys.push(K2);
    assert.equal((await old.call('orgCreate', { userId: uid(), sessionHash: sid(), body: { name: 'Rot' } })).status, 201);
    keys.pop();
    assert.equal((await old.call('orgCreate', { userId: uid(), sessionHash: sid(), body: { name: 'Rot' } })).status, 401);
  });

  // ---- 2. organizations: customer roles, last owner, escalation ----------------------------------------------------------------
  test('organizations through the API: create, add, and the roles are enforced from the database, not from the request', async () => {
    const { owner, os, cid } = await setup();
    const [adm, mem, stranger] = [uid(), uid(), uid()];
    assert.equal((await call('memberAdd', owner, os, { customerId: cid, body: { userId: adm, role: 'admin' } })).status, 200);
    assert.equal((await call('memberAdd', owner, os, { customerId: cid, body: { userId: mem, role: 'member' } })).status, 200);
    const asAdmin = (body) => call('memberAdd', adm, sid(), { customerId: cid, body });
    assert.equal((await asAdmin({ userId: uid(), role: 'member' })).status, 200, 'an admin may add plain members');
    assert.equal((await asAdmin({ userId: uid(), role: 'owner' })).status, 403, 'but not owners');
    assert.equal((await asAdmin({ userId: uid(), role: 'admin' })).status, 403);
    assert.equal((await call('memberAdd', mem, sid(), { customerId: cid, body: { userId: uid(), role: 'member' } })).status, 403, 'a member adds nobody');
    assert.equal((await call('memberAdd', stranger, sid(), { customerId: cid, body: { userId: uid(), role: 'member' } })).status, 403, 'a stranger neither');
    assert.equal((await call('memberAdd', owner, os, { customerId: cid, body: { userId: adm, role: 'member' } })).status, 409, 'already a member');
    assert.equal((await call('memberAdd', owner, os, { customerId: cid, body: { userId: uid(), role: 'root' } })).status, 400);
    assert.equal((await call('memberRemove', owner, os, { customerId: cid, params: { uid: mem } })).status, 200);
  });

  test('the actor is the ASSERTED user: a body field cannot name someone else as the actor', async () => {
    const { owner, cid } = await setup();
    const mem = uid(); await call('memberAdd', owner, sid(), { customerId: cid, body: { userId: mem, role: 'member' } });
    const r = await call('memberAdd', mem, sid(), { customerId: cid, body: { userId: uid(), role: 'member', actor: owner, actorUserId: owner, sub: owner, userIdActing: owner } });
    assert.equal(r.status, 403);
  });

  test('cross-customer isolation: the owner of A can do nothing to B', async () => {
    const [a, b] = [await setup(), await setup()];
    const victim = uid(); await call('memberAdd', b.owner, b.os, { customerId: b.cid, body: { userId: victim, role: 'member' } });
    for (const [name, o] of [['memberAdd', { body: { userId: uid(), role: 'member' } }], ['memberRemove', { params: { uid: victim } }]]) {
      assert.equal((await call(name, a.owner, sid(), { customerId: b.cid, ...o })).status, 403, name);
    }
    assert.equal((await call('memberSetRole', a.owner, sid(), { customerId: b.cid, params: { uid: victim }, body: { role: 'owner' } })).status, 403);
    assert.equal(await count(`SELECT count(*) AS n FROM customer_members WHERE customer_id=$1 AND user_id=$2 AND role='member'`, [b.cid, victim]), 1, 'unchanged');
  });

  test('the last-owner invariant holds through the API (demote, remove, leave), including two owners racing', async () => {
    const { owner, os, cid } = await setup();
    const o2 = uid(), o2s = sid(); await call('memberAdd', owner, os, { customerId: cid, body: { userId: o2, role: 'owner' } });
    const a1 = await enrollPasskey(owner, os), a2 = await enrollPasskey(o2, o2s);
    await stepUpVia(owner, os, 'member.set_role', a1); await stepUpVia(o2, o2s, 'member.set_role', a2);
    const rs = await Promise.all([
      call('memberSetRole', owner, os, { customerId: cid, params: { uid: o2 }, body: { role: 'member' } }),
      call('memberSetRole', o2, o2s, { customerId: cid, params: { uid: owner }, body: { role: 'member' } }),
    ]);
    assert.ok(await count(`SELECT count(*) AS n FROM customer_members WHERE customer_id=$1 AND role='owner'`, [cid]) >= 1, 'an owner always remains: ' + rs.map((r) => r.status));
    const lone = await setup();
    assert.equal((await call('memberRemove', lone.owner, lone.os, { customerId: lone.cid, params: { uid: lone.owner } })).status, 409, 'the last owner cannot leave');
  });

  // ---- 3. step-up gates ---------------------------------------------------------------------------------------------------------
  test('role changes need a fresh step-up bound to the session AND the action; the proof is spent by use', async () => {
    const { owner, os, cid } = await setup();
    const mem = uid(); await call('memberAdd', owner, os, { customerId: cid, body: { userId: mem, role: 'member' } });
    const a = await enrollPasskey(owner, os);
    const setRole = (session, role = 'admin') => call('memberSetRole', owner, session, { customerId: cid, params: { uid: mem }, body: { role } });
    let r = await setRole(os);
    assert.equal(r.status, 403); assert.equal(r.body.error, 'stepup_required', 'no proof, no change');
    assert.equal(await count(`SELECT count(*) AS n FROM customer_members WHERE customer_id=$1 AND user_id=$2 AND role='member'`, [cid, mem]), 1);
    await stepUpVia(owner, os, 'billing.link', a);                                          // a proof for a DIFFERENT action
    assert.equal((await setRole(os)).body.error, 'stepup_required', 'wrong-action proof is useless');
    await stepUpVia(owner, os, 'member.set_role', a);
    assert.equal((await setRole(sid())).body.error, 'stepup_required', 'another session cannot spend it');
    assert.equal((await setRole(os)).status, 200, 'the right session and action can');
    assert.equal((await setRole(os, 'member')).body.error, 'stepup_required', 'and it is spent: one proof, one change');
  });

  test('billing administration is staff-only and needs step-up: overrides and links change nothing without both', async () => {
    const { owner, cid } = await setup(); await seedSubscription(db.owner, cid, { plan: 'basic' });
    const staffUser = uid(), ss = sid(); await staffRow(staffUser);
    const a = await enrollPasskey(staffUser, ss);
    const body = { value: true, reason: 'pilot for ticket 77', expiresAt: future() };
    const put = (user, session) => call('overrideSet', user, session, { customerId: cid, params: { feature: 'meetings.cloud_recording' }, body });
    const overrides = () => count(`SELECT count(*) AS n FROM entitlement_overrides WHERE customer_id=$1`, [cid]);

    assert.equal((await put(staffUser, ss)).body.error, 'stepup_required', 'staff without a proof');
    const os2 = sid(); const oa = await enrollPasskey(owner, os2); await stepUpVia(owner, os2, 'override.set', oa);
    assert.equal((await put(owner, os2)).status, 403, 'a customer owner is not staff, even with a valid proof');
    assert.equal(await overrides(), 0);
    await stepUpVia(staffUser, ss, 'override.set', a);
    const ok = await put(staffUser, ss);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(await overrides(), 1);
    assert.equal((await runtime.canAccess(cid, 'meetings.cloud_recording')).allowed, true, 'and the request path sees it');
    assert.equal((await put(staffUser, ss)).body.error, 'stepup_required', 'one proof, one override');
    const h = (await db.owner.query(`SELECT actor, actor_roles FROM entitlement_override_history WHERE customer_id=$1`, [cid])).rows[0];
    assert.equal(h.actor, staffUser);
  });

  test('staff scope is checked BEFORE the proof is spent: a refused action does not burn it', async () => {
    const [a, b] = [await setup(), await setup()];
    const scoped = uid(), ss = sid(); await staffRow(scoped, { all: false });
    await db.owner.query(`INSERT INTO platform_staff_customers (user_id, customer_id) VALUES ($1,$2)`, [scoped, a.cid]);
    const pk = await enrollPasskey(scoped, ss);
    await stepUpVia(scoped, ss, 'override.set', pk);
    const body = { value: true, reason: 'scope test reason', expiresAt: future() };
    const put = (cid) => call('overrideSet', scoped, ss, { customerId: cid, params: { feature: 'meetings.cloud_recording' }, body });
    assert.equal((await put(b.cid)).status, 403, 'not their customer');
    assert.equal((await put(a.cid)).status, 200, 'the same proof still works for their own customer');
  });

  test('revoking staff takes effect at once even with a fresh proof; logging out kills the proofs', async () => {
    const { cid } = await setup();
    const st = uid(), ss = sid(); await staffRow(st);
    const pk = await enrollPasskey(st, ss);
    const body = { value: true, reason: 'revocation test', expiresAt: future() };
    const put = () => call('overrideSet', st, ss, { customerId: cid, params: { feature: 'meetings.cloud_recording' }, body });
    await stepUpVia(st, ss, 'override.set', pk);
    await db.owner.query(`UPDATE platform_staff SET active=false WHERE user_id=$1`, [st]);
    assert.equal((await put()).status, 403, 'revoked staff, fresh proof, still refused');
    await db.owner.query(`UPDATE platform_staff SET active=true WHERE user_id=$1`, [st]);
    assert.equal((await call('sessionRevoke', st, ss)).status, 200, 'logout');
    assert.equal((await put()).body.error, 'stepup_required', 'the proof died with the session');
  });

  test('customer suspension and billing links are staff + step-up actions; support and billing roles are separate', async () => {
    const { owner, cid } = await setup();
    const sup = uid(), ss = sid(); await staffRow(sup, { roles: ['support_admin'] });
    const pk = await enrollPasskey(sup, ss);
    await stepUpVia(sup, ss, 'billing.link', pk);
    const link = () => call('billingLink', sup, ss, { customerId: cid, body: { provider: 'acme', externalCustomerId: 'cus_9', customerId: cid } });
    assert.equal((await link()).status, 403, 'support staff cannot manage billing');
    await stepUpVia(sup, ss, 'customer.status', pk);
    const susp = await call('orgStatus', sup, ss, { customerId: cid, body: { status: 'suspended' } });
    assert.equal(susp.status, 200);
    assert.equal(await count(`SELECT count(*) AS n FROM customers WHERE id=$1 AND status='suspended'`, [cid]), 1);
    assert.equal((await call('orgStatus', owner, sid(), { customerId: cid, body: { status: 'active' } })).status, 403, 'the customer cannot un-suspend itself');
    const bill = uid(), bs = sid(); await staffRow(bill, { roles: ['billing_admin'] });
    const bp = await enrollPasskey(bill, bs); await stepUpVia(bill, bs, 'billing.link', bp);
    assert.equal((await call('billingLink', bill, bs, { customerId: cid, body: { provider: 'acme', externalCustomerId: 'cus_9', customerId: cid } })).status, 200);
    assert.equal(await count(`SELECT count(*) AS n FROM billing_customers WHERE customer_id=$1`, [cid]), 1);
  });

  test('TOTP works as the alternative factor through the API and spends the same kind of grant', async () => {
    const { cid } = await setup(); await seedSubscription(db.owner, cid, { plan: 'basic' });
    const st = uid(), ss = sid(); await staffRow(st);
    const token = await stepUp.createEnrollmentToken({ userId: st, createdBy: 'ops' });
    const begin = await call('totpBegin', st, ss, { body: { enrollmentToken: token } });
    const secret = base32Decode(begin.body.secret);
    assert.equal((await call('totpConfirm', st, ss, { body: { code: totp(secret, Date.now()) } })).status, 200);
    const bad = await call('totpVerify', st, ss, { body: { action: 'override.set', code: '000000' } });
    assert.equal(bad.status, 403);
    const replayed = await call('totpVerify', st, ss, { body: { action: 'override.set', code: totp(secret, Date.now()) } });
    assert.equal(replayed.status, 403, 'the code that just confirmed enrolment cannot be used again (its time step is spent)');
    const good = await call('totpVerify', st, ss, { body: { action: 'override.set', code: totp(secret, Date.now() + 30_000) } });   // the NEXT time step
    assert.equal(good.status, 200, JSON.stringify(good.body));
    const put = await call('overrideSet', st, ss, { customerId: cid, params: { feature: 'meetings.cloud_recording' }, body: { value: true, reason: 'totp path test', expiresAt: future() } });
    assert.equal(put.status, 200);
    assert.equal(await count(`SELECT count(*) AS n FROM stepup_grants WHERE user_id=$1 AND method='totp' AND consumed_at IS NOT NULL`, [st]), 1);
  });

  // ---- 4. separation of duties and hygiene -----------------------------------------------------------------------------------
  test('the web tier cannot do what the administration service does: its database roles are read-only on this data', async () => {
    const web = db.poolFor('runtime'), hooks = db.poolFor('billing');
    for (const [pool, sql] of [[web, `INSERT INTO customers (name, created_by) VALUES ('x','x')`], [web, `UPDATE customer_members SET role='owner'`], [web, `INSERT INTO entitlement_overrides (customer_id, feature_key, value, reason, created_by) VALUES (gen_random_uuid(),'meetings.participants','5','x','x')`],
      [web, 'SELECT 1 FROM stepup_grants'], [web, 'SELECT 1 FROM admin_requests'], [hooks, `INSERT INTO customer_members (customer_id, user_id, role, added_by) VALUES (gen_random_uuid(),'u','owner','x')`], [hooks, 'SELECT 1 FROM webauthn_credentials']]) {
      await assert.rejects(pool.query(sql), { code: '42501' }, sql);
    }
  });

  test('every request is logged append-only, with the session only ever hashed; errors leak nothing', async () => {
    const { owner, os, cid } = await setup();
    await call('memberAdd', owner, os, { customerId: cid, body: { userId: uid(), role: 'root' } });
    const rows = (await db.owner.query(`SELECT outcome, status, session_hash, action FROM admin_requests WHERE user_id=$1 ORDER BY occurred_at`, [owner])).rows;
    assert.ok(rows.some((r) => r.outcome === 'attempt') && rows.some((r) => r.status === 400 && r.outcome === 'error'), 'an intent row AND an outcome row');
    const sequence = rows.filter((r) => r.action === 'member.add').map((r) => r.outcome);
    assert.deepEqual(sequence, ['attempt', 'error'], 'the intent is recorded before the outcome');
    assert.ok(rows.every((r) => r.session_hash !== os), 'the raw session id is never stored');
    await assert.rejects(db.owner.query(`UPDATE admin_requests SET outcome='ok'`), /append-only/);
    const unknown = await fetch(base + '/v1/nope'); assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: 'not_found' });
    const bad = await call('memberAdd', owner, os, { customerId: cid, body: { userId: "u'; DROP TABLE customers;--", role: 'member' } });
    assert.equal(bad.status, 400); assert.doesNotMatch(JSON.stringify(bad.body), /DROP|SELECT|syntax|pg_|stack/i);
  });

  test('construction refuses missing collaborators and weak keys', () => {
    assert.throws(() => createAdminServer({ keys: ['short'], pool: adminPool, stepUp, staff: {}, directoryAdmin: {}, adminService: {} }), /32/);
    assert.throws(() => createAdminServer({ keys: [K1], pool: adminPool, stepUp }), /requires/);
    assert.throws(() => createAdminClient({ baseUrl: base, key: 'short' }), /32/);
    assert.throws(() => signAssertion({ sub: 'u', sid: sid(), act: 'x', ttlMs: 120_000 }, K1), /too long/);
  });
});
