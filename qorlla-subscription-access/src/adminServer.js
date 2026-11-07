/**
 * The internal administration service. This is the ONLY process that holds the qorlla_sub_admin database role; the web tier does not.
 *
 * Every request must carry a short-lived signed assertion from the web tier (assertion.js). The service then enforces, in order:
 *   1. signature, freshness and well-formedness            (401 invalid_assertion)
 *   2. the assertion was minted for THIS route's action    (403)   - an assertion for one purpose cannot be replayed on another
 *   3. the assertion's customer equals the route's customer (403)  - cross-customer substitution is impossible
 *   4. the jti has never been seen                          (401)  - replay protection, stored in PostgreSQL (multi-instance safe)
 *   5. for staff actions: CURRENT platform staff with the right role and customer scope (read live)
 *   6. for sensitive actions: a fresh single-use step-up grant for exactly (session, user, action), spent by this call
 *   7. the operation itself, which re-checks its own rules (customer role, last owner, validation) inside its transaction
 * Every request, allowed or refused, is written to an append-only log. Errors never leak internals.
 */

import express from 'express';
import { createHash } from 'node:crypto';
import { verifyAssertion, AssertionError } from './assertion.js';
import { ROUTES } from './adminRoutes.js';
import { SubscriptionError, NotAuthorizedError } from './errors.js';
import { ensureSearchPath } from './schema.js';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {object} deps
 * @param {string[]} deps.keys          signing keys (>= 32 chars each; several during rotation)
 * @param {import('pg').Pool} deps.pool qorlla_sub_admin connection (request log + nonces)
 * @param {import('./stepup.js').StepUpService} deps.stepUp
 * @param {import('./directory.js').DirectoryAdmin} deps.directoryAdmin
 * @param {import('./admin.js').AdminService} deps.adminService
 * @param {ReturnType<import('./staff.js').createStaff>} deps.staff
 */
export function createAdminServer({ keys, pool, stepUp, directoryAdmin, adminService, staff, logger = console }) {
  if (!Array.isArray(keys) || !keys.length || keys.some((k) => typeof k !== 'string' || k.length < 32)) throw new Error('createAdminServer requires at least one signing key of 32+ characters');
  for (const [n, d] of Object.entries({ pool, stepUp, directoryAdmin, adminService, staff })) if (!d) throw new Error(`createAdminServer requires ${n}`);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50kb' }));
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const insert = (c, outcome, status, detail = {}) => pool.query(
    `INSERT INTO admin_requests (jti, user_id, session_hash, action, customer_id, outcome, status, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [c?.jti ?? null, c?.sub ?? null, c?.sid ? sha(c.sid) : null, c?.act ?? null, c?.cid ?? null, outcome, status, JSON.stringify(detail)]);
  /** Best effort, for refusals (there is nothing to protect). */
  const record = (c, outcome, status, detail = {}) => insert(c, outcome, status, detail).catch((e) => logger.error('[admin] request log failed:', e.message));

  const stepupRequired = () => new SubscriptionError('A fresh step-up verification is required for this action', 'stepup_required', {}, 403);

  function sendError(res, e) {
    if (e instanceof SubscriptionError) return res.status(e.statusCode).json({ error: e.code });
    logger.error('[admin] internal error:', e?.code || '', e?.message);
    return res.status(500).json({ error: 'internal_error' });
  }

  /** Steps 1-4. Sets req.claims; logs the outcome when the response finishes. */
  const authenticate = (name) => async (req, res, next) => {
    const route = ROUTES[name];
    let claims;
    try { await ensureSearchPath(pool); claims = verifyAssertion(req.get('x-qorlla-assertion'), keys); }
    catch (e) {
      const reason = e instanceof AssertionError ? e.reason : 'error';
      await record(null, 'invalid', 401, { reason, route: route.act });
      return res.status(401).json({ error: 'invalid_assertion' });
    }
    const deny = async (why, status = 403) => { await record(claims, 'denied', status, { why }); return res.status(status).json({ error: status === 401 ? 'invalid_assertion' : 'forbidden' }); };
    if (claims.act !== route.act) return deny('act_mismatch');
    if (route.cid) {
      const want = route.cid === 'params' ? req.params.cid : req.body?.customerId;
      if (typeof want !== 'string' || !UUID_RE.test(want) || claims.cid?.toLowerCase() !== want.toLowerCase()) return deny('customer_mismatch');
    }
    try {
      const fresh = await pool.query(`INSERT INTO service_nonces (jti, expires_at) VALUES ($1, to_timestamp($2::double precision / 1000.0) + interval '2 minutes') ON CONFLICT DO NOTHING`, [claims.jti, claims.exp]);
      if (!fresh.rowCount) { await record(claims, 'replay', 401, {}); return res.status(401).json({ error: 'invalid_assertion' }); }
      if (Math.random() < 0.02) pool.query('DELETE FROM service_nonces WHERE expires_at < now()').catch(() => {});
    } catch (e) { logger.error('[admin] nonce store failed:', e.message); return res.status(503).json({ error: 'unavailable' }); }       // cannot prove freshness -> refuse
    req.claims = claims;
    // Write the INTENT before anything runs. If it cannot be recorded, the request is refused: no log, no privileged action.
    try { await insert(claims, 'attempt', 0, { route: route.act }); } catch (e) { logger.error('[admin] cannot record intent:', e.message); return res.status(503).json({ error: 'unavailable' }); }
    // Write the OUTCOME before the reply leaves, so a client never sees a result that has no record.
    const reply = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      const outcome = status < 400 ? 'ok' : status === 401 || status === 403 ? 'denied' : 'error';
      record(claims, outcome, status, { code: res.locals.errorCode }).finally(() => reply(body));
      return res;
    };
    return next();
  };

  /** Steps 5-6 for staff / sensitive routes. Returns an AdminService actor for staff routes. */
  async function authorizeSensitive(req, route) {
    const { sub, sid, cid } = req.claims;
    let actor = null;
    if (route.staff) {
      const roles = await staff.rolesOf(sub);
      if (!roles) throw new NotAuthorizedError('Not platform staff');
      if ((await staff.authorize({ id: sub }, route.act, cid)) !== true) throw new NotAuthorizedError();                  // before spending the proof
      actor = { id: sub, roles };
    }
    if (route.stepup) {
      const grant = await stepUp.consume({ sessionHash: sid, userId: sub, action: route.act });
      if (!grant) throw stepupRequired();
      if (actor) actor.mfaVerifiedAt = grant.verifiedAt;
    }
    return actor;
  }

  const handle = (name, fn) => {
    const route = ROUTES[name];
    app[route.method.toLowerCase()](route.path, authenticate(name), async (req, res) => {
      try {
        const actor = await authorizeSensitive(req, route);
        const out = await fn(req, actor);
        res.status(out?.status || 200).json(out?.body ?? out ?? { ok: true });
      } catch (e) { res.locals.errorCode = e?.code; sendError(res, e); }
    });
  };

  const me = (req) => ({ userId: req.claims.sub, sessionHash: req.claims.sid });
  const b = (req) => req.body || {};

  // ---- step-up ceremonies --------------------------------------------------------------------------------------------------
  handle('registerBegin',  (req) => stepUp.beginRegistration({ ...me(req), userName: b(req).userName, enrollmentToken: b(req).enrollmentToken }));
  handle('registerFinish', (req) => stepUp.finishRegistration({ ...me(req), response: b(req).response, label: b(req).label, enrollmentToken: b(req).enrollmentToken }));
  handle('assertBegin',    (req) => stepUp.beginAssertion({ ...me(req), action: b(req).action }));
  handle('assertFinish',   (req) => stepUp.finishAssertion({ ...me(req), action: b(req).action, response: b(req).response }));
  handle('totpBegin',      (req) => stepUp.beginTotp({ ...me(req), enrollmentToken: b(req).enrollmentToken }));
  handle('totpConfirm',    async (req) => { const r = await stepUp.confirmTotp({ ...me(req), code: b(req).code }); if (!r.ok) throw new NotAuthorizedError('Step-up verification failed'); return r; });
  handle('totpVerify',     async (req) => { const r = await stepUp.verifyTotp({ ...me(req), action: b(req).action, code: b(req).code }); if (!r.ok) throw new NotAuthorizedError('Step-up verification failed'); return r; });
  handle('sessionRevoke',  async (req) => { await stepUp.revokeSession(req.claims.sid); return { ok: true }; });

  // ---- organizations (customer roles are enforced by DirectoryAdmin, inside its transaction) ---------------------------------
  handle('orgCreate',     async (req) => ({ status: 201, body: await directoryAdmin.createCustomer(req.claims.sub, b(req).name) }));
  handle('memberAdd',     (req) => directoryAdmin.addMember(req.claims.sub, req.params.cid, b(req).userId, b(req).role));
  handle('memberSetRole', (req) => directoryAdmin.setRole(req.claims.sub, req.params.cid, req.params.uid, b(req).role));
  handle('memberRemove',  (req) => directoryAdmin.removeMember(req.claims.sub, req.params.cid, req.params.uid));
  handle('orgStatus',     (req, actor) => directoryAdmin.setStatus(actor, req.params.cid, b(req).status));

  // ---- billing administration (platform staff only, fresh step-up spent per call) -------------------------------------------
  handle('overrideSet',    (req, actor) => adminService.setOverride(actor, req.params.cid, req.params.feature, b(req).value, { reason: b(req).reason, expiresAt: b(req).expiresAt }));
  handle('overrideRemove', (req, actor) => adminService.removeOverride(actor, req.params.cid, req.params.feature, { reason: b(req).reason }));
  handle('billingLink',    (req, actor) => adminService.linkBillingCustomer(actor, b(req).provider, b(req).externalCustomerId, b(req).customerId));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  return app;
}
