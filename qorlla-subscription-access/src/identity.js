/**
 * Identity: turns a LIVE main-application session into the verified tenant context the engine trusts.
 *
 *   createIdentity({ getUser, directory }).authenticate(req)  ->  { customer_id, user_id, role } | null
 *
 * - `getUser(req)` is the main app's own `auth.getUser`: it validates the session cookie against the stored (hashed, expiring)
 *   sessions, so a signed-out, expired or forged session yields no user. Nothing is cached here.
 * - The customer comes from the directory, read live: a user can only ever act for a customer they currently belong to,
 *   in the role they currently hold. A client may NAME the customer it wants (a user can belong to several); the name is
 *   only a request and is accepted only if the directory confirms the membership.
 * - Every failure is a specific, non-leaking denial. A directory failure is a 503, never a pass.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultSelect = (req) => {
  const v = req.get ? req.get('x-qorlla-customer') : req.headers?.['x-qorlla-customer'];
  return typeof v === 'string' && v ? v.trim().toLowerCase() : null;
};

export function createIdentity({ getUser, directory, selectCustomer = defaultSelect, requireVerifiedEmail = false, onDenied = () => {} } = {}) {
  if (typeof getUser !== 'function') throw new Error('createIdentity requires getUser(req) from the main application');
  if (!directory) throw new Error('createIdentity requires a Directory');

  /** @returns {Promise<{ok:true, customer_id, user_id, role} | {ok:false, status:number, code:string, choices?:object[]}>} */
  async function resolve(req) {
    let user;
    try { user = await getUser(req); } catch { return { ok: false, status: 503, code: 'access_unavailable' }; }
    if (!user || typeof user.id !== 'string') return { ok: false, status: 401, code: 'unauthenticated' };
    if (requireVerifiedEmail && user.emailVerified !== true) return { ok: false, status: 403, code: 'email_unverified' };

    let memberships;
    try { memberships = await directory.membershipsOf(user.id); } catch { return { ok: false, status: 503, code: 'access_unavailable' }; }
    if (!memberships.length) return { ok: false, status: 403, code: 'no_customer' };

    const requested = selectCustomer(req);
    if (requested != null) {
      if (!UUID_RE.test(requested)) return { ok: false, status: 403, code: 'not_a_member' };
      const m = memberships.find((x) => x.customer_id === requested);
      if (!m) { onDenied({ code: 'not_a_member', user_id: user.id, requested }); return { ok: false, status: 403, code: 'not_a_member' }; }
      if (!m.active) return { ok: false, status: 403, code: 'customer_suspended' };
      return { ok: true, customer_id: m.customer_id, user_id: user.id, role: m.role };
    }

    const active = memberships.filter((m) => m.active);
    if (!active.length) return { ok: false, status: 403, code: 'customer_suspended' };
    if (active.length > 1) {
      return { ok: false, status: 409, code: 'customer_selection_required', choices: active.map((m) => ({ customer_id: m.customer_id, name: m.name, role: m.role })) };
    }
    return { ok: true, customer_id: active[0].customer_id, user_id: user.id, role: active[0].role };
  }

  /** For createExampleApp({ authenticate }) and similar: the verified context or null. */
  const authenticate = async (req) => {
    const r = await resolve(req);
    return r.ok ? { customer_id: r.customer_id, user_id: r.user_id, role: r.role } : null;
  };

  /** Express middleware: sets req.auth or answers with the specific denial. */
  const middleware = () => async (req, res, next) => {
    const r = await resolve(req);
    if (!r.ok) {
      const body = { error: r.code };
      if (r.choices) body.choices = r.choices;
      return res.status(r.status).json(body);
    }
    req.auth = { customer_id: r.customer_id, user_id: r.user_id, role: r.role };
    return next();
  };

  /** Express middleware, after `middleware()`: only these customer roles may continue. */
  const requireRole = (...roles) => (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) return res.status(403).json({ error: 'insufficient_role' });
    return next();
  };

  return { resolve, authenticate, middleware, requireRole };
}
