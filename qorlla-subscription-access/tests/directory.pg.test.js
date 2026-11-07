// Customer directory, membership roles and platform-staff authorization, on a real PostgreSQL with least-privilege roles.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, newCustomer, seedSubscription, skip } from './helpers/db.js';
import { Directory, DirectoryAdmin } from '../src/directory.js';
import { createStaff } from '../src/staff.js';
import { AdminService } from '../src/admin.js';
import { AccessService } from '../src/accessService.js';

let n = 0;
const uid = (tag = 'u') => `u_${tag}${++n}-${Math.random().toString(16).slice(2, 10)}`;

describe('directory, roles and staff (PostgreSQL)', { skip }, () => {
  let db, dir, admin, staff, changed;
  before(async () => {
    db = await createTestDb();
    changed = [];
    staff = createStaff({ pool: db.poolFor('admin'), stepUp: async (req) => req?.stepUpAt ?? null });
    dir = new Directory({ pool: db.poolFor('runtime') });
    admin = new DirectoryAdmin({ pool: db.poolFor('admin'), authorizeStaff: staff.authorize, onChange: (c) => changed.push(c) });
  });
  after(async () => { await db.drop(); });

  const mk = async (owner = uid('own')) => ({ owner, ...(await admin.createCustomer(owner, 'Acme ' + owner)) });
  const roleOf = async (user, cid) => (await dir.membershipsOf(user)).find((m) => m.customer_id === cid)?.role;
  const hist = async (cid) => (await db.owner.query('SELECT action, user_id, old_role, new_role, actor FROM customer_member_history WHERE customer_id=$1 ORDER BY occurred_at, id', [cid])).rows;

  test('creating a customer makes the creator its owner, with history; names and ids are validated; the per-user cap holds', async () => {
    const owner = uid('own');
    const { customer_id } = await admin.createCustomer(owner, '  Acme  ');
    assert.deepEqual(await dir.membershipsOf(owner), [{ customer_id, role: 'owner', active: true, name: 'Acme' }]);
    assert.deepEqual((await hist(customer_id)).map((h) => h.action), ['customer_created']);
    for (const bad of ['', '   ', 'x'.repeat(121), null, 5]) await assert.rejects(admin.createCustomer(owner, bad), { code: 'invalid_name' });
    for (const bad of ['', null, "u'; DROP TABLE customers;--", 'a b', 'x'.repeat(101)]) await assert.rejects(admin.createCustomer(bad, 'ok'), { code: 'invalid_user' });
    const small = new DirectoryAdmin({ pool: db.poolFor('admin'), maxOwnedCustomers: 2 });
    const greedy = uid('greedy');
    await small.createCustomer(greedy, 'a'); await small.createCustomer(greedy, 'b');
    await assert.rejects(small.createCustomer(greedy, 'c'), { code: 'customer_limit', statusCode: 409 });
    const racers = uid('racer');
    const rs = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => small.createCustomer(racers, 'r' + i)));
    assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 2, 'the cap holds under concurrency');
  });

  test('who may add whom: owners add any role, admins add plain members only, members and strangers add nobody', async () => {
    const { owner, customer_id: c } = await mk();
    const [adm, mem, stranger, t] = [uid('adm'), uid('mem'), uid('str'), uid('new')];
    await admin.addMember(owner, c, adm, 'admin'); await admin.addMember(owner, c, mem, 'member');
    await assert.rejects(admin.addMember(adm, c, t, 'admin'), { code: 'not_authorized' });
    await assert.rejects(admin.addMember(adm, c, t, 'owner'), { code: 'not_authorized' });
    await assert.rejects(admin.addMember(mem, c, t, 'member'), { code: 'not_authorized' });
    await assert.rejects(admin.addMember(stranger, c, t, 'member'), { code: 'not_authorized' });
    assert.deepEqual(await admin.addMember(adm, c, t, 'member'), { ok: true });
    await assert.rejects(admin.addMember(owner, c, t, 'member'), { code: 'already_member', statusCode: 409 });
    await assert.rejects(admin.addMember(owner, c, uid(), 'superuser'), { code: 'invalid_role' });
    assert.ok(changed.includes(c));
  });

  test('role changes: owners only, effective on the very next read, and recorded with old and new role', async () => {
    const { owner, customer_id: c } = await mk();
    const [m, adm] = [uid('m'), uid('a')];
    await admin.addMember(owner, c, m, 'member'); await admin.addMember(owner, c, adm, 'admin');
    await assert.rejects(admin.setRole(adm, c, m, 'admin'), { code: 'not_authorized' }, 'an admin cannot promote');
    await assert.rejects(admin.setRole(m, c, m, 'owner'), { code: 'not_authorized' }, 'nobody promotes themselves');
    assert.equal(await roleOf(m, c), 'member');
    await admin.setRole(owner, c, m, 'admin');
    assert.equal(await roleOf(m, c), 'admin', 'visible at once');
    await assert.rejects(admin.setRole(owner, c, uid('ghost'), 'admin'), { code: 'not_a_member' });
    assert.deepEqual((await hist(c)).filter((h) => h.action === 'role_change').map((h) => [h.user_id, h.old_role, h.new_role, h.actor]), [[m, 'member', 'admin', owner]]);
  });

  test('a customer can never lose its last owner: demotion, removal and leaving are refused; two simultaneous demotions cannot both win', async () => {
    const { owner, customer_id: c } = await mk();
    await assert.rejects(admin.setRole(owner, c, owner, 'member'), { code: 'last_owner' });
    await assert.rejects(admin.removeMember(owner, c, owner), { code: 'last_owner' });
    assert.equal(await roleOf(owner, c), 'owner');
    for (let round = 0; round < 8; round++) {
      const { owner: o1, customer_id: cid } = await mk();
      const o2 = uid('o2');
      await admin.addMember(o1, cid, o2, 'owner');
      const rs = await Promise.allSettled([admin.setRole(o1, cid, o2, 'member'), admin.setRole(o2, cid, o1, 'member')]);
      const owners = (await db.owner.query(`SELECT count(*)::int n FROM customer_members WHERE customer_id=$1 AND role='owner'`, [cid])).rows[0].n;
      assert.ok(owners >= 1, `round ${round}: owners left ${owners}`);
      assert.ok(rs.some((r) => r.status === 'fulfilled') || rs.every((r) => r.status === 'rejected'));
    }
    await assert.rejects(db.owner.query(`DELETE FROM customer_members WHERE customer_id=$1`, [c]), { code: '23514' }, 'not even a direct SQL delete');
    await assert.rejects(db.owner.query(`UPDATE customer_members SET role='member' WHERE customer_id=$1`, [c]), { code: '23514' });
  });

  test('removal: owners remove anyone, admins only plain members, members only themselves; effective immediately', async () => {
    const { owner, customer_id: c } = await mk();
    const [adm, m1, m2, adm2] = [uid('a'), uid('m1'), uid('m2'), uid('a2')];
    await admin.addMember(owner, c, adm, 'admin'); await admin.addMember(owner, c, adm2, 'admin');
    await admin.addMember(owner, c, m1, 'member'); await admin.addMember(owner, c, m2, 'member');
    await assert.rejects(admin.removeMember(m1, c, m2), { code: 'not_authorized' }, 'a member cannot remove another');
    await assert.rejects(admin.removeMember(adm, c, adm2), { code: 'not_authorized' }, 'an admin cannot remove an admin');
    await assert.rejects(admin.removeMember(adm, c, owner), { code: 'not_authorized' }, 'nor an owner');
    await assert.rejects(admin.removeMember(uid('str'), c, m1), { code: 'not_authorized' });
    await admin.removeMember(adm, c, m1);
    assert.deepEqual(await dir.membershipsOf(m1), [], 'gone at once');
    await admin.removeMember(m2, c, m2);                                                   // leaving
    await admin.removeMember(owner, c, adm2);
    await assert.rejects(admin.removeMember(owner, c, uid('ghost')), { code: 'not_a_member' });
    assert.deepEqual((await hist(c)).filter((h) => h.action === 'remove').map((h) => h.user_id), [m1, m2, adm2]);
  });

  test('the actor\'s role is checked INSIDE the transaction: an owner demoted a moment earlier cannot finish what they started', async () => {
    const { owner, customer_id: c } = await mk();
    const co = uid('co'); await admin.addMember(owner, c, co, 'owner');
    const holder = await db.owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE customer_members SET role='member' WHERE customer_id=$1 AND user_id=$2`, [c, co]);      // co is being demoted, not yet committed
      const attempt = admin.addMember(co, c, uid('x'), 'admin').then(() => 'allowed', (e) => e.code);
      await new Promise((r) => setTimeout(r, 300));
      await holder.query('COMMIT');
      assert.equal(await attempt, 'not_authorized', 'after waiting for the demotion, co is no longer allowed');
    } finally { holder.release(); }
  });

  test('membership history is append-only', async () => {
    const { owner, customer_id: c } = await mk();
    await assert.rejects(db.poolFor('admin').query('UPDATE customer_member_history SET actor=\'x\''), { code: '42501' });
    await assert.rejects(db.owner.query('UPDATE customer_member_history SET actor=\'x\' WHERE customer_id=$1', [c]), /append-only/);
    await assert.rejects(db.owner.query('DELETE FROM customer_member_history WHERE customer_id=$1', [c]), /append-only/);
    await assert.rejects(db.owner.query('TRUNCATE customer_member_history'), /append-only/);
    assert.ok(owner);
  });

  test('role matrix for the directory tables: runtime reads only, admin cannot touch staff, billing reads the directory only to authorize a purchase', async () => {
    const rt = db.poolFor('runtime'), ad = db.poolFor('admin'), bl = db.poolFor('billing');
    await rt.query('SELECT * FROM customers'); await rt.query('SELECT * FROM customer_members');
    for (const sql of ['INSERT INTO customers (name, created_by) VALUES (\'x\',\'x\')', 'UPDATE customer_members SET role=\'owner\'', 'DELETE FROM customer_members', 'SELECT * FROM platform_staff', 'SELECT * FROM customer_member_history']) {
      await assert.rejects(rt.query(sql), { code: '42501' }, 'runtime: ' + sql);
    }
    for (const sql of ['INSERT INTO platform_staff (user_id, granted_by) VALUES (\'x\',\'x\')', 'UPDATE platform_staff SET active = true', 'DELETE FROM platform_staff', 'INSERT INTO platform_staff_customers (user_id, customer_id) VALUES (\'x\', gen_random_uuid())']) {
      await assert.rejects(ad.query(sql), { code: '42501' }, 'admin: ' + sql);
    }
    for (const t of ['platform_staff', 'customer_member_history']) await assert.rejects(bl.query(`SELECT 1 FROM ${t}`), { code: '42501' }, 'billing: ' + t);
    await bl.query('SELECT 1 FROM customers'); await bl.query('SELECT 1 FROM customer_members');                       // read-only: the gateway authorizes live
    for (const sql of ["INSERT INTO customers (name, created_by) VALUES ('x','x')", "UPDATE customers SET status = 'active'", "UPDATE customer_members SET role = 'owner'", 'DELETE FROM customer_members']) {
      await assert.rejects(bl.query(sql), { code: '42501' }, 'billing may not write: ' + sql);
    }
  });

  // ---- platform staff ------------------------------------------------------
  const grant = (user, o = {}) => db.owner.query(`INSERT INTO platform_staff (user_id, roles, all_customers, active, granted_by) VALUES ($1,$2,$3,$4,'dba')`,
    [user, o.roles ?? ['billing_admin'], o.all ?? false, o.active ?? true]);

  test('staff authorization: right role AND right customers, read live; unknown actions and strangers are denied', async () => {
    const [a, b] = [(await mk()).customer_id, (await mk()).customer_id];
    const allStaff = uid('all'), scoped = uid('sc'), wrong = uid('wr'), off = uid('off');
    await grant(allStaff, { all: true }); await grant(scoped); await grant(wrong, { roles: ['support_admin'], all: true }); await grant(off, { all: true, active: false });
    await db.owner.query('INSERT INTO platform_staff_customers (user_id, customer_id) VALUES ($1,$2)', [scoped, a]);
    const can = (u, action, c) => staff.authorize({ id: u }, action, c);
    assert.equal(await can(allStaff, 'override.set', a), true); assert.equal(await can(allStaff, 'billing.link', b), true);
    assert.equal(await can(scoped, 'override.set', a), true); assert.equal(await can(scoped, 'override.set', b), false, 'listed customers only');
    assert.equal(await can(wrong, 'override.set', a), false, 'support cannot touch billing'); assert.equal(await can(wrong, 'customer.status', a), true);
    assert.equal(await can(off, 'override.set', a), false); assert.equal(await can(uid('nobody'), 'override.set', a), false);
    assert.equal(await can(allStaff, 'drop.everything', a), false); assert.equal(await can(undefined, 'override.set', a), false);
    await db.owner.query('UPDATE platform_staff SET active = false WHERE user_id = $1', [allStaff]);
    assert.equal(await can(allStaff, 'override.set', a), false, 'revocation is immediate');
  });

  test('buildActor takes roles from the database, never the client; with no step-up provider the AdminService refuses everything', async () => {
    const s = uid('st'); await grant(s, { all: true });
    const user = { id: s };
    const actor = await staff.buildActor(user, {});
    assert.deepEqual(actor.roles, ['billing_admin']); assert.equal(actor.mfaVerifiedAt, undefined);
    assert.equal(await staff.buildActor({ id: uid('rand') }, {}), null, 'not staff -> no actor');
    const c = (await mk()).customer_id;
    const svc = new AdminService({ pool: db.poolFor('admin'), authorize: staff.authorize });
    const ask = (a) => svc.setOverride(a, c, 'meetings.cloud_recording', true, { reason: 'support ticket 12', expiresAt: new Date(Date.now() + 86_400_000) });
    await assert.rejects(ask(actor), { code: 'not_authorized' }, 'no MFA evidence -> fail closed');
    const fresh = await staff.buildActor(user, { stepUpAt: Date.now() - 30_000 });
    assert.deepEqual(await ask(fresh), { ok: true });
    await db.owner.query('UPDATE platform_staff SET active = false WHERE user_id = $1', [s]);
    await assert.rejects(ask(fresh), { code: 'not_authorized' }, 'revoked staff are stopped even with a fresh MFA claim');
  });

  test('suspension: staff only, recorded, blocks new members, and reverses', async () => {
    const { owner, customer_id: c } = await mk();
    const sup = uid('sup'); await grant(sup, { roles: ['support_admin'], all: true });
    await assert.rejects(admin.setStatus({ id: owner }, c, 'suspended'), { code: 'not_authorized' }, 'an owner cannot suspend themselves out of billing');
    await assert.rejects(admin.setStatus({ id: uid('x') }, c, 'suspended'), { code: 'not_authorized' });
    await assert.rejects(admin.setStatus({ id: sup }, c, 'banned'), { code: 'invalid_status' });
    await admin.setStatus({ id: sup }, c, 'suspended');
    assert.equal((await dir.membershipsOf(owner))[0].active, false, 'visible at once');
    await assert.rejects(admin.addMember(owner, c, uid(), 'member'), { code: 'customer_suspended' });
    await admin.setStatus({ id: sup }, c, 'suspended');                                    // idempotent: no duplicate history
    await admin.setStatus({ id: sup }, c, 'active');
    assert.equal((await dir.membershipsOf(owner))[0].active, true);
    assert.deepEqual((await hist(c)).filter((h) => /suspended|reactivated/.test(h.action)).map((h) => h.action), ['customer_suspended', 'customer_reactivated']);
    await assert.rejects(new DirectoryAdmin({ pool: db.poolFor('admin') }).setStatus({ id: sup }, c, 'suspended'), /authorizeStaff/);
  });

  test('a customer id is validated; the engine and the directory agree on who the tenant is', async () => {
    await assert.rejects(admin.addMember(uid(), 'not-a-uuid', uid(), 'member'), { code: 'customer_context_invalid' });
    const { owner, customer_id: c } = await mk();
    const access = new AccessService({ pool: db.poolFor('runtime') });
    await seedSubscription(db.owner, c, { plan: 'pro' });
    assert.equal((await access.canAccess((await dir.membershipsOf(owner))[0].customer_id, 'meetings.cloud_recording')).allowed, true);
    assert.ok(newCustomer());
  });
});
