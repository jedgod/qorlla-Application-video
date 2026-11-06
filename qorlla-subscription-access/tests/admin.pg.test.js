// Privileged billing administration: authorization, MFA freshness, tenant scope, validation, history.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, newCustomer, seedSubscription, sleep, skip } from './helpers/db.js';
import { AdminService } from '../src/admin.js';
import { AccessService } from '../src/accessService.js';

const actor = (o = {}) => ({ id: 'admin-7', roles: ['billing_admin'], mfaVerifiedAt: Date.now() - 60_000, ...o });
const FUTURE = () => new Date(Date.now() + 7 * 86_400_000);

describe('AdminService (PostgreSQL)', { skip }, () => {
  let db, admin, runtime, changed;
  before(async () => {
    db = await createTestDb();
    changed = [];
    // The tenant-scope callback is the application's job; this one lets an actor act only on customers listed in actor.scope.
    admin = new AdminService({ pool: db.poolFor('admin'), authorize: async (a, _action, customerId) => !a.scope || a.scope.includes(customerId), onChange: (c) => changed.push(c) });
    runtime = new AccessService({ pool: db.poolFor('runtime') });
  });
  after(async () => { await db.drop(); });

  const customer = async (plan = 'basic') => { const c = newCustomer(); await seedSubscription(db.owner, c, { plan }); return c; };
  const count = async (sql, args) => Number((await db.owner.query(sql, args)).rows[0].n);
  const writes = (c) => count('SELECT count(*) AS n FROM entitlement_overrides WHERE customer_id=$1', [c]);

  test('the service refuses to exist without an authorization callback', () => {
    assert.throws(() => new AdminService({ pool: db.poolFor('admin') }), /authorize/);
    assert.throws(() => new AdminService({ pool: db.poolFor('admin'), authorize: 'yes' }), /authorize/);
  });

  test('every way of not being a current, MFA-verified billing administrator is refused, nothing is written, and each refusal is recorded', async () => {
    const c = await customer();
    const attempts = [
      ['no actor', undefined], ['no id', actor({ id: '' })], ['no roles', actor({ roles: undefined })], ['wrong role', actor({ roles: ['support'] })],
      ['no MFA', actor({ mfaVerifiedAt: undefined })], ['stale MFA', actor({ mfaVerifiedAt: Date.now() - 20 * 60_000 })],
      ['MFA from the future', actor({ mfaVerifiedAt: Date.now() + 10 * 60_000 })], ['MFA not a date', actor({ mfaVerifiedAt: 'yesterday' })],
    ];
    for (const [name, a] of attempts) {
      await assert.rejects(admin.setOverride(a, c, 'meetings.cloud_recording', true, { reason: 'customer escalation', expiresAt: FUTURE() }), { code: 'not_authorized', statusCode: 403 }, name);
    }
    assert.equal(await writes(c), 0);
    assert.equal(await count(`SELECT count(*) AS n FROM security_events WHERE event_type='admin_action_denied' AND customer_id=$1`, [c]), attempts.length);
    assert.equal(changed.includes(c), false, 'no cache invalidation for nothing');
  });

  test('tenant scope: an administrator authorised for customer A cannot change customer B', async () => {
    const [a, b] = [await customer(), await customer()];
    const scoped = actor({ scope: [a] });
    await assert.rejects(admin.setOverride(scoped, b, 'meetings.cloud_recording', true, { reason: 'wrong tenant', expiresAt: FUTURE() }), { code: 'not_authorized' });
    await assert.rejects(admin.removeOverride(scoped, b, 'meetings.cloud_recording', { reason: 'wrong tenant' }), { code: 'not_authorized' });
    await assert.rejects(admin.linkBillingCustomer(scoped, 'acme', 'cus_b', b), { code: 'not_authorized' });
    assert.equal(await writes(b), 0);
    assert.deepEqual(await admin.setOverride(scoped, a, 'meetings.cloud_recording', true, { reason: 'right tenant', expiresAt: FUTURE() }), { ok: true });
  });

  test('a malformed customer id is rejected before anything else', async () => {
    for (const bad of ['', 'x', null, "' OR 1=1 --", '../..']) {
      await assert.rejects(admin.setOverride(actor(), bad, 'meetings.cloud_recording', true, { reason: 'valid reason', expiresAt: FUTURE() }), { code: 'customer_context_invalid' });
    }
  });

  test('validation: reason, feature, value type and range, and expiry bounds', async () => {
    const c = await customer();
    const set = (feature, value, o = {}) => admin.setOverride(actor(), c, feature, value, { reason: 'support ticket 4411', expiresAt: FUTURE(), ...o });
    for (const reason of [undefined, '', '   ', 'abc', 'x'.repeat(501), 5]) await assert.rejects(set('meetings.cloud_recording', true, { reason }), { code: 'invalid_override' }, String(reason));
    await assert.rejects(set('made.up', true), { code: 'invalid_override' });
    await assert.rejects(set('meetings.cloud_recording', 1), { code: 'invalid_override' }, 'boolean feature, number');
    await assert.rejects(set('meetings.cloud_recording', 'true'), { code: 'invalid_override' });
    for (const v of ['lots', -1, 1.5, 1e10, 1_000_000_000, true, null, {}]) await assert.rejects(set('meetings.participants', v), { code: 'invalid_override' }, String(v));
    await assert.rejects(set('meetings.participants', 10, { expiresAt: undefined }), { code: 'invalid_override' }, 'permanent overrides are off by default');
    await assert.rejects(set('meetings.participants', 10, { expiresAt: new Date(Date.now() - 1000) }), { code: 'invalid_override' });
    await assert.rejects(set('meetings.participants', 10, { expiresAt: 'whenever' }), { code: 'invalid_override' });
    await assert.rejects(set('meetings.participants', 10, { expiresAt: new Date(Date.now() + 400 * 86_400_000) }), { code: 'invalid_override' }, 'beyond the 366 day cap');
    assert.equal(await writes(c), 0);
    assert.deepEqual(await set('meetings.participants', 'unlimited'), { ok: true });
    assert.deepEqual(await set('meetings.participants', 999_999_999), { ok: true });
    assert.deepEqual(await set('meetings.participants', 0), { ok: true });
  });

  test('a permanent override needs an explicit opt-in', async () => {
    const perm = new AdminService({ pool: db.poolFor('admin'), authorize: async () => true, allowPermanentOverrides: true });
    const c = await customer();
    assert.deepEqual(await perm.setOverride(actor(), c, 'meetings.cloud_recording', true, { reason: 'contractual entitlement' }), { ok: true });
    assert.equal((await db.owner.query('SELECT expires_at FROM entitlement_overrides WHERE customer_id=$1', [c])).rows[0].expires_at, null);
  });

  test('a successful override takes effect on the request path at once, is recorded in history (old and new value, actor, roles) and invalidates caches', async () => {
    const c = await customer('basic');
    assert.equal((await runtime.canAccess(c, 'meetings.cloud_recording')).allowed, false);
    await admin.setOverride(actor(), c, 'meetings.cloud_recording', true, { reason: 'pilot for ticket 9', expiresAt: FUTURE() });
    assert.equal((await runtime.canAccess(c, 'meetings.cloud_recording')).allowed, true);
    assert.ok(changed.includes(c));

    await admin.setOverride(actor({ id: 'admin-8' }), c, 'meetings.participants', 150, { reason: 'event capacity', expiresAt: FUTURE() });
    await admin.setOverride(actor({ id: 'admin-9' }), c, 'meetings.participants', 200, { reason: 'event capacity raised', expiresAt: FUTURE() });
    const h = (await db.owner.query(`SELECT action, old_value, new_value, actor, actor_roles, reason FROM entitlement_override_history
      WHERE customer_id=$1 AND feature_key='meetings.participants' ORDER BY occurred_at, id`, [c])).rows;
    assert.deepEqual(h.map((r) => [r.action, r.old_value, r.new_value, r.actor]), [['set', null, 150, 'admin-8'], ['set', 150, 200, 'admin-9']]);
    assert.deepEqual(h[0].actor_roles, ['billing_admin']);
    const live = (await db.owner.query(`SELECT created_by, value FROM entitlement_overrides WHERE customer_id=$1 AND feature_key='meetings.participants'`, [c])).rows[0];
    assert.equal(live.created_by, 'admin-9'); assert.equal(live.value, 200);
    assert.equal(await count(`SELECT count(*) AS n FROM security_events WHERE event_type='override_set' AND customer_id=$1`, [c]), 3);
  });

  test('an override expires on the database clock', async () => {
    const c = await customer('basic');
    await admin.setOverride(actor(), c, 'meetings.cloud_recording', true, { reason: 'short trial', expiresAt: new Date(Date.now() + 3000) });
    assert.equal((await runtime.canAccess(c, 'meetings.cloud_recording')).allowed, true);
    await sleep(3300);
    assert.equal((await runtime.canAccess(c, 'meetings.cloud_recording')).allowed, false);
  });

  test('removal is audited; removing nothing is a quiet no-op', async () => {
    const c = await customer();
    await admin.setOverride(actor(), c, 'meetings.cloud_recording', true, { reason: 'temporary', expiresAt: FUTURE() });
    const before = changed.length;
    assert.deepEqual(await admin.removeOverride(actor(), c, 'meetings.cloud_recording', { reason: 'trial ended' }), { ok: true, removed: true });
    assert.equal(changed.length, before + 1);
    assert.deepEqual(await admin.removeOverride(actor(), c, 'meetings.cloud_recording', { reason: 'trial ended again' }), { ok: true, removed: false });
    assert.equal(changed.length, before + 1, 'no invalidation for a no-op');
    const h = (await db.owner.query(`SELECT action, old_value, reason FROM entitlement_override_history WHERE customer_id=$1 ORDER BY occurred_at, id`, [c])).rows;
    assert.deepEqual(h.map((r) => r.action), ['set', 'remove']);
    assert.equal(h[1].old_value, true);
    await assert.rejects(admin.removeOverride(actor(), c, 'meetings.cloud_recording', { reason: '' }), { code: 'invalid_override' });
  });

  test('history cannot be rewritten: not by the admin role (no privilege) and not even by the table owner (trigger)', async () => {
    const c = await customer();
    await admin.setOverride(actor(), c, 'meetings.cloud_recording', true, { reason: 'history test', expiresAt: FUTURE() });
    const adminPool = db.poolFor('admin');
    await assert.rejects(adminPool.query(`UPDATE entitlement_override_history SET actor='nobody' WHERE customer_id=$1`, [c]), { code: '42501' });
    await assert.rejects(adminPool.query(`DELETE FROM entitlement_override_history WHERE customer_id=$1`, [c]), { code: '42501' });
    await assert.rejects(db.owner.query(`UPDATE entitlement_override_history SET actor='nobody' WHERE customer_id=$1`, [c]), /append-only/);
    await assert.rejects(db.owner.query(`DELETE FROM entitlement_override_history WHERE customer_id=$1`, [c]), /append-only/);
    await assert.rejects(db.owner.query('TRUNCATE entitlement_override_history'), /append-only/);
  });

  test('the admin role can write overrides and links but cannot change subscriptions, reservations or usage', async () => {
    const c = await customer();
    const p = db.poolFor('admin');
    await assert.rejects(p.query(`UPDATE subscriptions SET plan_code='enterprise' WHERE customer_id=$1`, [c]), { code: '42501' });
    await assert.rejects(p.query(`INSERT INTO usage_events (customer_id, feature_key, quantity, period_start, period_end) VALUES ($1,'ai.queries',1,now(),now()+interval '1 day')`, [c]), { code: '42501' });
    await assert.rejects(p.query('SELECT 1 FROM quota_reservations LIMIT 1'), { code: '42501' });
  });

  test('billing customer links: an administrator creates them, they are unique, and the provider side can never create one', async () => {
    const c = await customer();
    assert.deepEqual(await admin.linkBillingCustomer(actor(), 'acme', 'cus_100', c), { ok: true });
    await assert.rejects(admin.linkBillingCustomer(actor(), 'acme', 'cus_100', await customer()), { code: '23505' }, 'one provider customer maps to one tenant');
    await assert.rejects(admin.linkBillingCustomer(actor(), 'acme', 'cus_101', c), { code: '23505' }, 'one tenant maps to one provider customer');
    await assert.rejects(db.poolFor('billing').query(`INSERT INTO billing_customers (provider, external_customer_id, customer_id, linked_by) VALUES ('acme','cus_x',$1,'worker')`, [c]), { code: '42501' });
    await assert.rejects(admin.linkBillingCustomer(actor(), 'Bad Provider', 'cus_1', c), { code: '23514' });
  });
});
