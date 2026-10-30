// Authorization for the three operations surfaces. Identity (MAIN-signed cookie JWT, JWKS, live session check, CSRF on writes) is the portal's own `identity` middleware; this adds the authority on top:
//   customer: MAIN identity only; every query is scoped to that user id (ownership)
//   staff:    MAIN identity + a portal.ops_staff row whose employment_status is 'active' + explicit permissions
//   admin:    staff with an admin role + MFA proven by the MAIN token (amr contains "mfa", auth_time fresh). MAIN issues neither yet, so admin stays closed until it does (see docs).
// Any failure to LOOK UP authority (database error) answers 503 and never falls through to the handler: failure cannot be a bypass.
export const ADMIN_ROLES = ['super_admin', 'ops_admin'];
export const LEAD_ROLES = ['super_admin', 'ops_admin', 'supervisor'];
export const PERMISSIONS = ['ticket:read', 'ticket:work', 'billing:refund:request', 'numbers:read', 'numbers:request', 'meetings:diagnose', 'calling:read', 'calling:request', 'workforce:self'];
export const ROLES = ['super_admin', 'ops_admin', 'supervisor', 'support_agent', 'billing_agent', 'technical_agent'];

export function createOpsAuth({ cfg, pool, auth, log, now = () => Date.now() }) {
  const { identity } = auth;
  const unavailable = (res) => res.status(503).json({ error: 'Authorization service unavailable' });
  /** identity + an ACTIVE staff record. Sets req.staff = { user_id, role, permissions, lead, admin }. */
  const staff = (req, res, next) => identity(req, res, async (err) => {
    if (err) return next(err);
    let row;
    try { row = (await pool.query('SELECT user_id, display_name, team, role, employment_status, permissions FROM portal.ops_staff WHERE user_id=$1', [req.actor])).rows[0]; }
    catch (e) { log?.error('staff lookup failed', { err: e.message }); return unavailable(res); }
    if (!row || row.employment_status !== 'active') return res.status(403).json({ error: 'Staff access required' });
    req.staff = { ...row, lead: LEAD_ROLES.includes(row.role), admin: ADMIN_ROLES.includes(row.role) };
    next();
  });
  const mfaOk = (claims) => {
    if (!cfg.ops.requireMfa) return true;
    const amr = Array.isArray(claims?.amr) ? claims.amr : [], at = Number(claims?.auth_time);
    return amr.includes('mfa') && Number.isFinite(at) && now() / 1000 - at <= cfg.ops.mfaMaxAgeSeconds && at <= now() / 1000 + 5;
  };
  const admin = (req, res, next) => staff(req, res, (err) => {
    if (err) return next(err);
    if (!req.staff) return;
    if (!req.staff.admin) return res.status(403).json({ error: 'Administrator role required' });
    if (!mfaOk(req.claims)) return res.status(403).json({ error: 'Multi-factor authentication required', code: 'mfa_required' });
    next();
  });
  /** Staff with the named permission, or a lead (leads hold every operational permission). */
  const can = (...perms) => (req, res, next) => (req.staff.lead || perms.some((p) => req.staff.permissions.includes(p)) ? next() : res.status(403).json({ error: 'Permission required', required: perms }));
  const lead = (req, res, next) => (req.staff.lead ? next() : res.status(403).json({ error: 'Supervisor role required' }));
  /** Bootstrap: a platform admin (PLATFORM_ADMIN_USER_IDS) with MFA may create the first staff records; it grants nothing else. */
  const platformAdmin = (req, res, next) => identity(req, res, (err) => {
    if (err) return next(err);
    if (!(cfg.platformAdmins || []).includes(req.actor)) return res.status(404).json({ error: 'Not found' });
    if (!mfaOk(req.claims)) return res.status(403).json({ error: 'Multi-factor authentication required', code: 'mfa_required' });
    next();
  });
  return { identity, staff, admin, can, lead, platformAdmin, mfaOk };
}
