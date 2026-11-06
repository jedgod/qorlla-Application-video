/**
 * Customer directory: who belongs to which billing tenant, and in what role.
 *
 *  Directory       request path (qorlla_sub_runtime). Reads LIVE: nothing is cached, so removing a member, changing a role
 *                  or suspending a customer takes effect on the very next request.
 *  DirectoryAdmin  management (qorlla_sub_admin). Every change re-checks the ACTING user's role inside the same transaction,
 *                  keeps the "at least one owner" rule (also enforced by a database trigger), and writes append-only history.
 *
 * Roles: owner (everything, including other owners) > admin (add/remove plain members) > member.
 */

import pg from 'pg';
import { withTx } from './db.js';
import { SubscriptionError, NotAuthorizedError, InvalidCustomerError } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ROLES = Object.freeze(['owner', 'admin', 'member']);
const USER_RE = /^[A-Za-z0-9_.:@-]{1,100}$/;

const userId = (v) => { if (typeof v !== 'string' || !USER_RE.test(v)) throw new SubscriptionError('Invalid user id', 'invalid_user', {}, 400); return v; };
const customerId = (v) => { if (typeof v !== 'string' || !UUID_RE.test(v)) throw new InvalidCustomerError(); return v.toLowerCase(); };
const role = (v) => { if (!ROLES.includes(v)) throw new SubscriptionError('Invalid role', 'invalid_role', {}, 400); return v; };

export class Directory {
  constructor({ pool, connectionString } = {}) {
    this.ownsPool = !pool;
    this.pool = pool || new pg.Pool({ connectionString: connectionString || process.env.DATABASE_URL, max: 4 });
  }

  /** Every customer this user belongs to, with role and whether the customer is active. */
  async membershipsOf(user) {
    const { rows } = await this.pool.query(
      `SELECT m.customer_id, m.role, c.status, c.name FROM customer_members m JOIN customers c ON c.id = m.customer_id
        WHERE m.user_id = $1 ORDER BY m.added_at, m.customer_id`, [userId(user)]);
    return rows.map((r) => ({ customer_id: r.customer_id, role: r.role, active: r.status === 'active', name: r.name }));
  }

  async close() { if (this.ownsPool) await this.pool.end(); }
}

export class DirectoryAdmin {
  /**
   * @param {object} opts
   * @param {pg.Pool} [opts.pool]                      qorlla_sub_admin connection
   * @param {(actor, action, customerId) => Promise<boolean>} [opts.authorizeStaff]  needed only for suspend/reactivate
   * @param {number} [opts.maxOwnedCustomers=5]        anti-abuse cap on self-service customer creation
   * @param {(customerId:string) => void} [opts.onChange]
   */
  constructor(opts = {}) {
    this.ownsPool = !opts.pool;
    this.pool = opts.pool || new pg.Pool({ connectionString: opts.connectionString || process.env.DATABASE_URL, max: 4 });
    this.authorizeStaff = opts.authorizeStaff;
    this.maxOwned = opts.maxOwnedCustomers ?? 5;
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
  }

  /** Creates a customer and makes the creating user its owner. Who may call this (sign-up, invitation) is the application's decision. */
  async createCustomer(creatorUserId, name) {
    const creator = userId(creatorUserId);
    const label = typeof name === 'string' ? name.trim() : '';
    if (!label || label.length > 120) throw new SubscriptionError('A customer name of 1-120 characters is required', 'invalid_name', {}, 400);
    const id = await withTx(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`owner-cap:${creator}`]);
      const owned = Number((await c.query(`SELECT count(*) AS n FROM customer_members WHERE user_id = $1 AND role = 'owner'`, [creator])).rows[0].n);
      if (owned >= this.maxOwned) throw new SubscriptionError('Too many customers owned by this user', 'customer_limit', {}, 409);
      const cid = (await c.query('INSERT INTO customers (name, created_by) VALUES ($1, $2) RETURNING id', [label, creator])).rows[0].id;
      await c.query(`INSERT INTO customer_members (customer_id, user_id, role, added_by) VALUES ($1, $2, 'owner', $2)`, [cid, creator]);
      await c.query(`INSERT INTO customer_member_history (customer_id, user_id, action, new_role, actor) VALUES ($1, $2, 'customer_created', 'owner', $2)`, [cid, creator]);
      return cid;
    });
    return { customer_id: id };
  }

  /** Reads the acting user's role INSIDE the transaction and holds it until commit, so it cannot change under the operation. */
  async _actorRole(c, actorUserId, cid) {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`members:${cid}`]);
    const r = (await c.query('SELECT role FROM customer_members WHERE customer_id = $1 AND user_id = $2 FOR SHARE', [cid, actorUserId])).rows[0];
    return r?.role || null;
  }

  async addMember(actorUserId, cid, newUserId, newRole) {
    const [actor, customer, target, r] = [userId(actorUserId), customerId(cid), userId(newUserId), role(newRole)];
    await withTx(this.pool, async (c) => {
      const mine = await this._actorRole(c, actor, customer);
      if (mine !== 'owner' && !(mine === 'admin' && r === 'member')) throw new NotAuthorizedError('Your role may not add this member');
      if ((await c.query('SELECT status FROM customers WHERE id = $1', [customer])).rows[0]?.status !== 'active') throw new SubscriptionError('Customer is not active', 'customer_suspended', {}, 403);
      try {
        await c.query('INSERT INTO customer_members (customer_id, user_id, role, added_by) VALUES ($1, $2, $3, $4)', [customer, target, r, actor]);
      } catch (e) { if (e.code === '23505') throw new SubscriptionError('Already a member', 'already_member', {}, 409); throw e; }
      await c.query(`INSERT INTO customer_member_history (customer_id, user_id, action, new_role, actor) VALUES ($1, $2, 'add', $3, $4)`, [customer, target, r, actor]);
    });
    this.onChange(customer);
    return { ok: true };
  }

  async setRole(actorUserId, cid, targetUserId, newRole) {
    const [actor, customer, target, r] = [userId(actorUserId), customerId(cid), userId(targetUserId), role(newRole)];
    await withTx(this.pool, async (c) => {
      if ((await this._actorRole(c, actor, customer)) !== 'owner') throw new NotAuthorizedError('Only an owner may change roles');
      const old = (await c.query('SELECT role FROM customer_members WHERE customer_id = $1 AND user_id = $2 FOR UPDATE', [customer, target])).rows[0];
      if (!old) throw new SubscriptionError('Not a member', 'not_a_member', {}, 404);
      if (old.role === r) return;
      try { await c.query('UPDATE customer_members SET role = $3 WHERE customer_id = $1 AND user_id = $2', [customer, target, r]); }
      catch (e) { if (e.code === '23514') throw new SubscriptionError('A customer must keep at least one owner', 'last_owner', {}, 409); throw e; }
      await c.query(`INSERT INTO customer_member_history (customer_id, user_id, action, old_role, new_role, actor) VALUES ($1, $2, 'role_change', $3, $4, $5)`, [customer, target, old.role, r, actor]);
    });
    this.onChange(customer);
    return { ok: true };
  }

  /** Owners remove anyone; admins remove plain members; anybody may remove themselves (leave). */
  async removeMember(actorUserId, cid, targetUserId) {
    const [actor, customer, target] = [userId(actorUserId), customerId(cid), userId(targetUserId)];
    await withTx(this.pool, async (c) => {
      const mine = await this._actorRole(c, actor, customer);
      const row = (await c.query('SELECT role FROM customer_members WHERE customer_id = $1 AND user_id = $2 FOR UPDATE', [customer, target])).rows[0];
      if (!row) throw new SubscriptionError('Not a member', 'not_a_member', {}, 404);
      const allowed = actor === target || mine === 'owner' || (mine === 'admin' && row.role === 'member');
      if (!allowed) throw new NotAuthorizedError('Your role may not remove this member');
      try { await c.query('DELETE FROM customer_members WHERE customer_id = $1 AND user_id = $2', [customer, target]); }
      catch (e) { if (e.code === '23514') throw new SubscriptionError('A customer must keep at least one owner', 'last_owner', {}, 409); throw e; }
      await c.query(`INSERT INTO customer_member_history (customer_id, user_id, action, old_role, actor) VALUES ($1, $2, 'remove', $3, $4)`, [customer, target, row.role, actor]);
    });
    this.onChange(customer);
    return { ok: true };
  }

  /** Staff action (non-payment, abuse, legal hold). Needs the staff authorization callback. */
  async setStatus(staffActor, cid, status) {
    if (typeof this.authorizeStaff !== 'function') throw new Error('DirectoryAdmin.setStatus requires authorizeStaff');
    const customer = customerId(cid);
    if (!['active', 'suspended'].includes(status)) throw new SubscriptionError('Invalid status', 'invalid_status', {}, 400);
    if (!staffActor?.id || (await this.authorizeStaff(staffActor, 'customer.status', customer)) !== true) throw new NotAuthorizedError();
    await withTx(this.pool, async (c) => {
      const res = await c.query('UPDATE customers SET status = $2 WHERE id = $1 AND status <> $2', [customer, status]);
      if (!res.rowCount) return;
      await c.query(`INSERT INTO customer_member_history (customer_id, user_id, action, actor) VALUES ($1, $2, $3, $2)`,
        [customer, staffActor.id, status === 'suspended' ? 'customer_suspended' : 'customer_reactivated']);
    });
    this.onChange(customer);
    return { ok: true };
  }

  async close() { if (this.ownsPool) await this.pool.end(); }
}
