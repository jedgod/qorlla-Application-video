/**
 * Platform staff authorization for AdminService / DirectoryAdmin.
 *
 *   authorize(actor, action, customerId)   -> Promise<boolean>     // the AdminService callback
 *   buildActor(user, req)                  -> Promise<actor|null>  // roles come from the DATABASE, never from the client
 *
 * Staff are rows in platform_staff, managed by the DBA (no application role can write them). They are read LIVE on every
 * call: revoking a staff member (active = false) or narrowing their customers takes effect at once. A staff member sees
 * either every customer (all_customers) or only the customers listed for them.
 *
 * MFA: the main application has no multi-factor sign-in today, so there is nothing true to report. `stepUp(req, user)` must
 * return the epoch milliseconds of the user's last MFA/step-up verification; the DEFAULT returns null, which makes
 * AdminService refuse every privileged action (fail closed) until a real step-up provider is connected.
 */

import pg from 'pg';

const ACTION_ROLE = Object.freeze({
  'override.set': 'billing_admin',
  'override.remove': 'billing_admin',
  'billing.link': 'billing_admin',
  'customer.status': 'support_admin',
});

export function createStaff({ pool, connectionString, stepUp = async () => null } = {}) {
  const own = !pool;
  const p = pool || new pg.Pool({ connectionString: connectionString || process.env.DATABASE_URL, max: 3 });

  async function staffRow(userId) {
    if (typeof userId !== 'string' || !userId) return null;
    const r = (await p.query('SELECT roles, all_customers FROM platform_staff WHERE user_id = $1 AND active', [userId])).rows[0];
    return r || null;
  }

  async function authorize(actor, action, customerId) {
    const need = ACTION_ROLE[action];
    if (!need || !actor?.id) return false;                                   // unknown actions are denied
    const s = await staffRow(actor.id);
    if (!s || !s.roles.includes(need)) return false;
    if (s.all_customers) return true;
    const scoped = await p.query('SELECT 1 FROM platform_staff_customers WHERE user_id = $1 AND customer_id = $2', [actor.id, customerId]);
    return scoped.rowCount > 0;
  }

  /** The actor AdminService expects, built from the database. Null when the user is not (or no longer) active staff. */
  async function buildActor(user, req) {
    if (!user?.id) return null;
    const s = await staffRow(user.id);
    if (!s) return null;
    return { id: user.id, roles: s.roles, mfaVerifiedAt: (await stepUp(req, user)) ?? undefined };
  }

  return { authorize, buildActor, close: async () => { if (own) await p.end(); } };
}
