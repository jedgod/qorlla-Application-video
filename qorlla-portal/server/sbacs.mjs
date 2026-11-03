// SBACS: the subscription entitlement engine. It answers ONE question: does this workspace's SUBSCRIPTION entitle it to use this feature?
// It never answers "is this action permitted": membership/roles (auth.member), document permissions, Meet consent, AI-gateway provider
// approval and account suspension are separate checks that must also pass. A paid plan never overrides any of them.
//   * plan comes from portal.workspace_effective_plan (Postgres), so webhook-confirmed state only; a browser redirect never changes it.
//   * a workspace-level override (portal.entitlement_overrides) may add or remove a feature or change its quota, until it expires.
//   * HARD_DENY features can never be granted by a plan or an override (uncertified or policy-forbidden capabilities).
//   * metered features: reserve() -> finalize() | release() under a row lock, so concurrent requests cannot exceed the quota.
import crypto from 'node:crypto';
import { z } from 'zod';
import { effectivePlan } from './entitlements.mjs';
import { UUID_RE } from './auth.mjs';

// Payment must never unlock these: PSTN needs an approved carrier + separate telephony certification; Private AI never leaves Qorlla.
export const HARD_DENY = new Set(['phone.pstn', 'ai.private.external']);
// usable by anyone, including a suspended workspace's guests: joining someone else's meeting is not a use of this workspace's plan
const ALWAYS = new Set(['meet.guest_join']);

export class EntitlementError extends Error {
  constructor(result) { super('Subscription access denied'); this.status = 403; this.code = 'subscription_access_denied'; this.result = result; }
}

export function createSbacs({ pool }) {
  const periodStart = "date_trunc('month', now())::date";

  async function suspended(db, workspaceId) {
    const r = (await db.query(`SELECT (w.suspended_at IS NOT NULL OR s.status = 'suspended') AS blocked FROM portal.workspaces w LEFT JOIN portal.subscriptions s ON s.workspace_id = w.id WHERE w.id = $1`, [workspaceId])).rows[0];
    return !r || r.blocked;                                                         // unknown workspace = blocked
  }
  /** plan row + non-expired override, merged. source says where the answer came from. */
  async function resolve(db, workspaceId, feature) {
    const plan = await effectivePlan(db, workspaceId);
    const base = (await db.query('SELECT enabled, quota, quota_approved FROM portal.entitlements WHERE plan_slug=$1 AND feature=$2', [plan, feature])).rows[0];
    const ov = (await db.query('SELECT enabled, quota FROM portal.entitlement_overrides WHERE workspace_id=$1 AND feature=$2 AND (expires_at IS NULL OR expires_at > now())', [workspaceId, feature])).rows[0];
    const row = ov || base;
    // a plan quota that Qorlla has not approved is shown (provisionalQuota) but never enforced; an explicit override is a deliberate decision, so it is
    const enforced = ov ? ov.quota : (base && base.quota_approved ? base.quota : null);
    return { plan, enabled: !!row?.enabled, quota: enforced !== null && enforced !== undefined ? Number(enforced) : null, provisionalQuota: !ov && base && !base.quota_approved && base.quota !== null ? Number(base.quota) : null, source: ov ? 'override' : (base ? 'plan' : 'none') };
  }
  async function usageOf(db, workspaceId, feature) {
    const r = (await db.query(`SELECT used, reserved FROM portal.subscription_usage WHERE workspace_id=$1 AND feature=$2 AND period_start=${periodStart}`, [workspaceId, feature])).rows[0];
    return { used: Number(r?.used || 0), reserved: Number(r?.reserved || 0) };
  }
  async function upgradeAvailable(db, plan, feature) {
    const r = await db.query(`SELECT 1 FROM portal.entitlements e JOIN portal.plans p ON p.slug=e.plan_slug JOIN portal.plans cur ON cur.slug=$1
      WHERE e.feature=$2 AND e.enabled AND p.listed AND p.sort_order > cur.sort_order LIMIT 1`, [plan, feature]);
    return r.rowCount > 0;
  }

  async function anyPlanGrants(db, feature) {
    return (await db.query('SELECT 1 FROM portal.entitlements e JOIN portal.plans p ON p.slug=e.plan_slug WHERE e.feature=$1 AND e.enabled AND p.listed LIMIT 1', [feature])).rowCount > 0;
  }
  /** The feature gate. Pure read; metered operations must still reserve(). */
  async function check({ workspaceId, featureKey, db = pool, quota = true }) {
    const deny = (reason, extra = {}) => ({ allowed: false, reason, feature: featureKey, upgradeAvailable: false, ...extra });
    if (HARD_DENY.has(featureKey)) return deny('not_available');
    if (ALWAYS.has(featureKey)) return { allowed: true, feature: featureKey, plan: null, quota: null };
    if (await suspended(db, workspaceId)) return deny('account_suspended');
    const r = await resolve(db, workspaceId, featureKey);
    if (!r.enabled) return deny('not_in_plan', { plan: r.plan, upgradeAvailable: await upgradeAvailable(db, r.plan, featureKey) });
    if (r.quota !== null && quota) {
      const u = await usageOf(db, workspaceId, featureKey);
      if (u.used + u.reserved >= r.quota) return deny('quota_exhausted', { plan: r.plan, quota: r.quota, used: u.used, upgradeAvailable: await upgradeAvailable(db, r.plan, featureKey) });
      return { allowed: true, feature: featureKey, plan: r.plan, quota: r.quota, used: u.used, source: r.source };
    }
    return { allowed: true, feature: featureKey, plan: r.plan, quota: null, source: r.source };
  }

  /** Every known feature, as the clients should show it (server-authoritative; the UI never decides). */
  async function effective(workspaceId, db = pool) {
    const blocked = await suspended(db, workspaceId), plan = await effectivePlan(db, workspaceId);
    const keys = (await db.query(`SELECT DISTINCT feature, description FROM portal.entitlements WHERE description IS NOT NULL ORDER BY feature`)).rows;
    const usedBy = new Map((await db.query(`SELECT feature, used FROM portal.subscription_usage WHERE workspace_id=$1 AND period_start=${periodStart}`, [workspaceId])).rows.map((r) => [r.feature, Number(r.used)]));
    const features = {};
    for (const k of keys) {
      // state is what a client should show: enabled | restricted (this plan lacks it; `upgrade` says whether a plan offers it) | unavailable (no plan can grant it) | suspended
      if (HARD_DENY.has(k.feature)) { features[k.feature] = { enabled: false, state: 'unavailable', reason: 'not_available', upgrade: false, description: k.description }; continue; }
      if (blocked && !ALWAYS.has(k.feature)) { features[k.feature] = { enabled: false, state: 'suspended', reason: 'account_suspended', upgrade: false, description: k.description }; continue; }
      const r = await resolve(db, workspaceId, k.feature), u = usedBy.has(k.feature) ? { used: usedBy.get(k.feature) } : null;
      let state = 'enabled', upgrade = false;
      if (!r.enabled) { upgrade = await upgradeAvailable(db, r.plan, k.feature); state = upgrade || (await anyPlanGrants(db, k.feature)) ? 'restricted' : 'unavailable'; }
      features[k.feature] = { enabled: r.enabled, state, upgrade, quota: r.enabled ? r.quota : null, provisionalQuota: r.enabled ? r.provisionalQuota : null, unlimited: r.enabled && r.quota === null && r.provisionalQuota === null, used: u ? u.used : undefined, source: r.source, description: k.description };
    }
    return { plan, suspended: blocked, features };
  }

  async function event(db, { workspaceId = null, actorId = null, kind, detail = {} }) {
    await db.query('INSERT INTO portal.entitlement_events(workspace_id, actor_id, kind, detail) VALUES($1,$2,$3,$4)', [workspaceId, actorId, kind, detail]);
  }

  // ---- metered usage ----
  async function withTx(fn) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  /** Reserve `units` before doing the work. Idempotent per (workspace, idempotencyKey). */
  async function reserve({ workspaceId, featureKey, units = 1, idempotencyKey, ttlMs = 15 * 60_000 }) {
    if (!idempotencyKey) throw new Error('idempotencyKey required');
    const gate = await check({ workspaceId, featureKey });
    if (!gate.allowed && gate.reason !== 'quota_exhausted') return { ok: false, ...gate };
    return withTx(async (c) => {
      const prior = (await c.query('SELECT id, status, feature, units FROM portal.usage_reservations WHERE workspace_id=$1 AND idempotency_key=$2', [workspaceId, idempotencyKey])).rows[0];
      if (prior) return prior.feature === featureKey && Number(prior.units) === units ? { ok: true, reservationId: prior.id, status: prior.status, replay: true } : { ok: false, reason: 'idempotency_conflict', feature: featureKey };
      await c.query(`INSERT INTO portal.subscription_usage(workspace_id, feature, period_start) VALUES($1,$2,${periodStart}) ON CONFLICT DO NOTHING`, [workspaceId, featureKey]);
      await c.query(`SELECT 1 FROM portal.subscription_usage WHERE workspace_id=$1 AND feature=$2 AND period_start=${periodStart} FOR UPDATE`, [workspaceId, featureKey]);
      // look again UNDER the lock: a concurrent retry of the same key may have won while this one waited
      const again = (await c.query('SELECT id, status, feature, units FROM portal.usage_reservations WHERE workspace_id=$1 AND idempotency_key=$2', [workspaceId, idempotencyKey])).rows[0];
      if (again) return again.feature === featureKey && Number(again.units) === units ? { ok: true, reservationId: again.id, status: again.status, replay: true } : { ok: false, reason: 'idempotency_conflict', feature: featureKey };
      // give back reservations whose work never settled (crashed caller)
      const stale = await c.query(`UPDATE portal.usage_reservations SET status='expired', settled_at=now() WHERE workspace_id=$1 AND feature=$2 AND status='reserved' AND expires_at < now() AND period_start=${periodStart} RETURNING units`, [workspaceId, featureKey]);
      const back = stale.rows.reduce((n, r) => n + Number(r.units), 0);
      if (back) await c.query(`UPDATE portal.subscription_usage SET reserved = GREATEST(reserved - $3, 0) WHERE workspace_id=$1 AND feature=$2 AND period_start=${periodStart}`, [workspaceId, featureKey, back]);
      const r = await resolve(c, workspaceId, featureKey), u = await usageOf(c, workspaceId, featureKey);
      if (!r.enabled) return { ok: false, reason: 'not_in_plan', feature: featureKey, plan: r.plan };
      if (r.quota !== null && u.used + u.reserved + units > r.quota) return { ok: false, reason: 'quota_exhausted', feature: featureKey, plan: r.plan, quota: r.quota, used: u.used, upgradeAvailable: await upgradeAvailable(c, r.plan, featureKey) };
      const ins = await c.query(`INSERT INTO portal.usage_reservations(workspace_id, feature, period_start, units, idempotency_key, expires_at) VALUES($1,$2,${periodStart},$3,$4, now() + ($5 || ' milliseconds')::interval) RETURNING id`, [workspaceId, featureKey, units, idempotencyKey, String(ttlMs)]);
      await c.query(`UPDATE portal.subscription_usage SET reserved = reserved + $3 WHERE workspace_id=$1 AND feature=$2 AND period_start=${periodStart}`, [workspaceId, featureKey, units]);
      return { ok: true, reservationId: ins.rows[0].id, status: 'reserved' };
    });
  }
  async function settle(reservationId, to) {
    return withTx(async (c) => {
      const r = (await c.query('SELECT * FROM portal.usage_reservations WHERE id=$1 FOR UPDATE', [reservationId])).rows[0];
      if (!r) return { ok: false, reason: 'unknown_reservation' };
      if (r.status === 'expired') {
        // the reaper already gave these units back. The work may still have happened, so a late finalize is RECORDED (it can briefly exceed the quota); a late release changes nothing.
        if (to === 'finalized') {
          await c.query(`INSERT INTO portal.subscription_usage(workspace_id, feature, period_start) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [r.workspace_id, r.feature, r.period_start]);
          await c.query(`UPDATE portal.subscription_usage SET used = used + $4 WHERE workspace_id=$1 AND feature=$2 AND period_start=$3`, [r.workspace_id, r.feature, r.period_start, r.units]);
          await c.query(`UPDATE portal.usage_reservations SET status='finalized', settled_at=now() WHERE id=$1`, [reservationId]);
          return { ok: true, status: 'finalized', late: true };
        }
        return { ok: true, status: 'expired' };
      }
      if (r.status !== 'reserved') return { ok: r.status === to, status: r.status };          // settling twice is a no-op; settling the other way is refused
      await c.query(`SELECT 1 FROM portal.subscription_usage WHERE workspace_id=$1 AND feature=$2 AND period_start=$3 FOR UPDATE`, [r.workspace_id, r.feature, r.period_start]);
      await c.query(`UPDATE portal.subscription_usage SET reserved = GREATEST(reserved - $4, 0), used = used + $5 WHERE workspace_id=$1 AND feature=$2 AND period_start=$3`, [r.workspace_id, r.feature, r.period_start, r.units, to === 'finalized' ? r.units : 0]);
      await c.query(`UPDATE portal.usage_reservations SET status=$2, settled_at=now() WHERE id=$1`, [reservationId, to]);
      return { ok: true, status: to };
    });
  }
  const finalize = (id) => settle(id, 'finalized');
  const release = (id) => settle(id, 'released');
  /** Give back every reservation whose time has run out (call on start-up and periodically): a crashed worker never leaves units allocated. */
  async function reapExpired() {
    return withTx(async (c) => {
      const rows = (await c.query(`UPDATE portal.usage_reservations SET status='expired', settled_at=now() WHERE status='reserved' AND expires_at < now() RETURNING workspace_id, feature, period_start, units`)).rows;
      for (const r of rows) await c.query('UPDATE portal.subscription_usage SET reserved = GREATEST(reserved - $4, 0) WHERE workspace_id=$1 AND feature=$2 AND period_start=$3', [r.workspace_id, r.feature, r.period_start, r.units]);
      return rows.length;
    });
  }
  /** reserve -> run -> finalize. A thrown error (or `{ release: true }` from a replay / no-op) gives the units back; success commits them. */
  async function metered({ workspaceId, featureKey, units = 1, idempotencyKey, ttlMs }, fn) {
    const r = await reserve({ workspaceId, featureKey, units, idempotencyKey, ttlMs });
    if (!r.ok) throw new EntitlementError(r);
    const unwrap = (o) => (o && o.__noCharge ? o.value : o);
    if (r.replay && r.status !== 'reserved') return unwrap(await fn({ replay: true, reservation: r }));            // this key was already settled: do the work again without charging again
    let out;
    try { out = await fn({ replay: false, reservation: r }); } catch (e) { await release(r.reservationId).catch(() => {}); throw e; }
    if (out && out.__noCharge) { await release(r.reservationId).catch(() => {}); return out.value; }
    await finalize(r.reservationId); return out;
  }

  // ---- audited administration (callers must be platform admins; the routes for that come in a later slice) ----
  async function setOverride({ workspaceId, feature, enabled, quota = null, reason, expiresAt = null, actorId }) {
    if (HARD_DENY.has(feature)) throw Object.assign(new Error('This capability cannot be enabled by an override'), { status: 400 });
    return withTx(async (c) => {
      await c.query(`INSERT INTO portal.entitlement_overrides(workspace_id, feature, enabled, quota, reason, expires_at, created_by) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (workspace_id, feature) DO UPDATE SET enabled=EXCLUDED.enabled, quota=EXCLUDED.quota, reason=EXCLUDED.reason, expires_at=EXCLUDED.expires_at, created_by=EXCLUDED.created_by, created_at=now()`, [workspaceId, feature, enabled, quota, reason, expiresAt, actorId]);
      await event(c, { workspaceId, actorId, kind: 'override.set', detail: { feature, enabled, quota, reason, expiresAt } });
    });
  }
  async function setSuspended({ workspaceId, suspended: on, reason = null, actorId }) {
    return withTx(async (c) => {
      await c.query('UPDATE portal.workspaces SET suspended_at = CASE WHEN $2 THEN now() ELSE NULL END, suspended_reason = $3 WHERE id=$1', [workspaceId, on, on ? reason : null]);
      await event(c, { workspaceId, actorId, kind: on ? 'workspace.suspended' : 'workspace.unsuspended', detail: { reason } });
    });
  }

  /** Express middleware. Sits AFTER auth.member (identity + membership already proven); a failure here is 403 subscription_access_denied. */
  function requireEntitlement(featureKey, { quota = true } = {}) {      // quota:false = a metered route that reserves itself, so a retry of finished work is not refused here
    return async (req, res, next) => {
      try {
        if (!req.actor || !req.workspace) return res.status(401).json({ error: 'authentication_required' });
        const key = typeof featureKey === 'function' ? featureKey(req) : featureKey;      // a function lets one route pick its key from the request (doc / sheet / slides)
        const result = await check({ workspaceId: req.workspace, featureKey: key, quota });
        if (!result.allowed) return res.status(403).json({ error: 'subscription_access_denied', reason: result.reason, feature: key, upgradeAvailable: !!result.upgradeAvailable });
        req.entitlement = result; next();
      } catch (e) { next(e); }
    };
  }
  // A suspended workspace is DENIED, not downgraded: every workspace route refuses it except the pages that explain the suspension.
  const SUSPENDED_OK = [/^\/api\/v1\/subscriptions\//, /^\/api\/v1\/session$/, /^\/api\/v1\/workspaces?$/, /^\/api\/v1\/billing(\/invoices)?$/];
  function wrapMember(member) {
    return (req, res, next) => member(req, res, async (err) => {
      if (err) return next(err);
      try {
        if (req.method === 'GET' && SUSPENDED_OK.some((re) => re.test(req.path))) return next();
        if (await suspended(pool, req.workspace)) return res.status(403).json({ error: 'This workspace is suspended.', code: 'account_suspended' });
        next();
      } catch (e) { next(e); }
    });
  }

  // ---- account -> workspace (for services that know an account, never a workspace) ----
  const normAccount = (a) => { const s = String(a || '').replace(/^u_/, '').toLowerCase(); return UUID_RE.test(s) ? s : null; };
  async function isMember(accountId, workspaceId) {
    const uid = normAccount(accountId); if (!uid || !UUID_RE.test(String(workspaceId))) return false;
    return (await pool.query('SELECT 1 FROM portal.members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, uid])).rowCount > 0;
  }
  /** An explicit workspace must be one the account belongs to. Otherwise the account's primary workspace: the one it owns (earliest first), else its earliest membership. */
  async function resolveWorkspace(accountId, workspaceId = null) {
    const uid = normAccount(accountId); if (!uid) return { error: 'bad_account' };
    if (workspaceId) return (await isMember(uid, workspaceId)) ? { workspaceId } : { error: 'not_a_member' };
    const r = (await pool.query(`SELECT m.workspace_id FROM portal.members m JOIN portal.workspaces w ON w.id=m.workspace_id WHERE m.user_id=$1 ORDER BY (m.role='owner') DESC, w.created_at, w.id LIMIT 1`, [uid])).rows[0];
    return r ? { workspaceId: r.workspace_id } : { error: 'no_workspace' };
  }
  const reservationInfo = async (id) => { if (!UUID_RE.test(String(id))) return null; const r = (await pool.query('SELECT feature, workspace_id FROM portal.usage_reservations WHERE id=$1', [id])).rows[0]; return r ? { feature: r.feature, workspaceId: r.workspace_id } : null; };
  /** Record work that has ALREADY been done (idempotent per key). It never refuses on quota: delivered work cannot be un-delivered; the counter may exceed the ceiling. */
  async function record({ workspaceId, featureKey, units = 1, idempotencyKey }) {
    if (!idempotencyKey) throw new Error('idempotencyKey required');
    if (HARD_DENY.has(featureKey)) return { ok: false, reason: 'not_available', feature: featureKey };
    return withTx(async (c) => {
      await c.query(`INSERT INTO portal.subscription_usage(workspace_id, feature, period_start) VALUES($1,$2,${periodStart}) ON CONFLICT DO NOTHING`, [workspaceId, featureKey]);
      await c.query(`SELECT 1 FROM portal.subscription_usage WHERE workspace_id=$1 AND feature=$2 AND period_start=${periodStart} FOR UPDATE`, [workspaceId, featureKey]);
      const again = (await c.query('SELECT id, feature, units, status, period_start FROM portal.usage_reservations WHERE workspace_id=$1 AND idempotency_key=$2', [workspaceId, idempotencyKey])).rows[0];
      if (again) {
        if (again.feature !== featureKey || Number(again.units) !== units) return { ok: false, reason: 'idempotency_conflict', feature: featureKey };
        if (again.status === 'finalized') return { ok: true, replay: true };
        // the same operation was reserved (or expired / released) earlier: delivered work completes it, exactly once
        await c.query('UPDATE portal.subscription_usage SET reserved = GREATEST(reserved - $4, 0), used = used + $5 WHERE workspace_id=$1 AND feature=$2 AND period_start=$3', [workspaceId, featureKey, again.period_start, again.status === 'reserved' ? units : 0, units]);
        await c.query("UPDATE portal.usage_reservations SET status='finalized', settled_at=now() WHERE id=$1", [again.id]);
        return { ok: true, recorded: units, completed: again.status };
      }
      await c.query(`INSERT INTO portal.usage_reservations(workspace_id, feature, period_start, units, status, idempotency_key, expires_at, settled_at) VALUES($1,$2,${periodStart},$3,'finalized',$4, now(), now())`, [workspaceId, featureKey, units, idempotencyKey]);
      await c.query(`UPDATE portal.subscription_usage SET used = used + $3 WHERE workspace_id=$1 AND feature=$2 AND period_start=${periodStart}`, [workspaceId, featureKey, units]);
      return { ok: true, recorded: units };
    });
  }
  return { reservationInfo, isMember, resolveWorkspace, record, check, effective, resolve, usageOf, reserve, finalize, release, reapExpired, metered, setOverride, setSuspended, event, requireEntitlement, wrapMember, suspended: (id) => suspended(pool, id) };
}

/** Read-only SBACS endpoints. Checkout / change / cancel / resume stay on the existing /api/v1/billing/* routes (CSRF, roles, idempotency, provider confirmation). */
export function registerSbacs(app, { pool, auth, h, sbacs, cfg = {}, flags = null, billing = null }) {
  const { member } = auth;
  const noStore = (res) => res.set('Cache-Control', 'no-store');
  app.get('/api/v1/subscriptions/plans', h(async (req, res) => {
    const plans = (await pool.query('SELECT slug, name, description, contact_sales, sort_order FROM portal.plans WHERE listed ORDER BY sort_order, slug')).rows;
    const prices = (await pool.query('SELECT plan_slug, billing_interval, currency, amount_cents FROM portal.plan_prices WHERE active ORDER BY plan_slug, billing_interval')).rows;
    const ents = (await pool.query('SELECT plan_slug, feature, enabled, quota, description FROM portal.entitlements WHERE description IS NOT NULL ORDER BY plan_slug, feature')).rows;
    res.set('Cache-Control', 'public, max-age=60').json({ plans: plans.map((p) => ({ ...p, prices: prices.filter((x) => x.plan_slug === p.slug),
      features: Object.fromEntries(ents.filter((e) => e.plan_slug === p.slug).map((e) => [e.feature, { enabled: e.enabled && e.feature !== 'phone.pstn', quota: e.enabled ? e.quota : null, description: e.description }])) })) });
  }));
  app.get('/api/v1/subscriptions/current', member, h(async (req, res) => {
    const e = await sbacs.effective(req.workspace);
    const s = (await pool.query('SELECT plan_slug, status, current_period_end, cancel_at_period_end FROM portal.subscriptions WHERE workspace_id=$1', [req.workspace])).rows[0];
    // `live` = the provider is configured AND the operators switched live billing on; clients show checkout / payment actions only then. canManage = owner, admin or billing contact.
    const live = !!(billing && billing.available() && flags && (await flags.enabled('billing_live')) && (await flags.enabled('checkout')));
    noStore(res).json({ plan: e.plan, suspended: e.suspended, billing: { live, providerConfigured: !!(billing && billing.available()), hasBillingCustomer: !!(billing && billing.available() && (await billing.hasBillingCustomer(req.workspace))), canManage: ['owner', 'admin', 'billing'].includes(req.role) }, subscription: s ? { plan: s.plan_slug, status: s.status, renewsOrEndsAt: s.current_period_end, cancelAtPeriodEnd: s.cancel_at_period_end } : null });
  }));
  app.get('/api/v1/subscriptions/entitlements', member, h(async (req, res) => noStore(res).json(await sbacs.effective(req.workspace))));
  app.get('/api/v1/subscriptions/usage', member, h(async (req, res) => {
    const e = await sbacs.effective(req.workspace);
    // enforced limits are shown as limits; provisional (unapproved) ones are NOT shown as a limit, only the amount used
    noStore(res).json({ period: 'month', usage: Object.entries(e.features).filter(([, f]) => f.enabled && ((f.quota !== null && f.quota !== undefined) || f.used > 0)).map(([feature, f]) => ({ feature, used: f.used || 0, quota: f.quota ?? null, limitStatus: f.quota !== null && f.quota !== undefined ? 'enforced' : (f.provisionalQuota ? 'provisional' : 'none'), description: f.description })) });
  }));
}

// ---- service-to-service identity (workload identity) ------------------------------------------------------------------------------------------------
// Each calling service (meet, storage, clips, docs) holds its OWN Ed25519 private key; the portal holds only the matching PUBLIC keys (SBACS_SERVICE_PUBLIC_KEYS="meet=<base64 SPKI DER>,...").
// There is no shared secret: compromising the portal cannot mint a service's credential. A service signs a short-lived token:
//     qsv2.<base64url JSON {iss, sub, aud, iat, exp, jti}>.<base64url Ed25519 signature over "qsv2.<payload>">
// and the portal accepts it only when ALL hold: the signature verifies under the key registered for `sub`; iss === "qorlla-<sub>"; aud === the configured audience;
// exp is in the future and exp-iat <= 5 minutes; iat is not in the future (30 s skew); and the operation + feature asked about are inside that service's scope.
// Any credential problem answers 404 (the interface is not discoverable); an out-of-scope request answers 403.
export const AUDIENCE = 'qorlla-sbacs';
const OPS = ['check', 'reserve', 'record', 'finalize', 'release'];
export const SERVICE_SCOPES = {
  meet: { features: ['meet.'], ops: OPS }, storage: { features: ['storage.'], ops: OPS },
  clips: { features: ['clips.'], ops: OPS }, docs: { features: ['docs.', 'sheets.', 'slides.'], ops: OPS }
};
const b64 = (b) => Buffer.from(b).toString('base64url');
export function mintServiceToken({ service, privateKey, audience = AUDIENCE, issuer = 'qorlla-' + service, ttlSec = 120, now = Date.now(), jti = crypto.randomUUID() }) {
  const iat = Math.floor(now / 1000), body = b64(JSON.stringify({ iss: issuer, sub: service, aud: audience, iat, exp: iat + ttlSec, jti }));
  return 'qsv2.' + body + '.' + b64(crypto.sign(null, Buffer.from('qsv2.' + body), privateKey));
}
/** publicKeys: { service: KeyObject }. Returns { service } or null. Never throws. */
export function verifyServiceToken(token, { publicKeys = {}, audience = AUDIENCE, now = Date.now() } = {}) {
  try {
    const m = /^qsv2\.([A-Za-z0-9_-]{20,600})\.([A-Za-z0-9_-]{86})$/.exec(String(token || '')); if (!m) return null;
    const c = JSON.parse(Buffer.from(m[1], 'base64url').toString());
    if (!c || typeof c.sub !== 'string' || !Object.hasOwn(SERVICE_SCOPES, c.sub) || !Object.hasOwn(publicKeys, c.sub)) return null;
    if (!crypto.verify(null, Buffer.from('qsv2.' + m[1]), publicKeys[c.sub], Buffer.from(m[2], 'base64url'))) return null;
    const t = Math.floor(now / 1000);
    if (c.iss !== 'qorlla-' + c.sub || c.aud !== audience || typeof c.jti !== 'string' || c.jti.length < 8) return null;
    if (!Number.isInteger(c.exp) || !Number.isInteger(c.iat) || c.exp <= t || c.exp - c.iat > 300 || c.exp <= c.iat || c.iat > t + 30) return null;
    return { service: c.sub };
  } catch { return null; }
}

/** Service-to-service interface for modules outside the portal (Meet, storage, Clips). Off unless SBACS_SERVICE_PUBLIC_KEYS registers at least one service.
 *  The caller names the ACCOUNT (never a workspace on its own authority): the workspace is resolved server-side from membership, and an explicit workspaceId must be one the account belongs to. */
export function registerSbacsInternal(app, { h, sbacs, cfg }) {
  const gate = (op) => (req, res, next) => {
    const svc = verifyServiceToken(String(req.get('authorization') || '').replace(/^Bearer /, ''), { publicKeys: cfg.sbacsServicePublicKeys || {}, audience: cfg.sbacsAudience || AUDIENCE });
    if (!svc) return res.status(404).type('text/plain').send('not found');
    if (!SERVICE_SCOPES[svc.service].ops.includes(op)) return res.status(403).json({ error: 'out_of_scope', service: svc.service });
    req.service = svc.service; next();
  };
  const inScope = (req, res, feature) => {
    if (SERVICE_SCOPES[req.service].features.some((pre) => feature.startsWith(pre))) return true;
    res.status(403).json({ error: 'out_of_scope', service: req.service }); return false;
  };
  const account = z.string().regex(/^[A-Za-z0-9_.:@-]{1,128}$/), ws = z.string().uuid(), feat = z.string().regex(/^[a-z][a-z0-9_.]{2,63}$/), key = z.string().min(8).max(160);
  const subject = { accountId: account, workspaceId: ws.optional() };
  /** account -> workspace, or an explanatory refusal already written to `res` */
  const workspaceOf = async (res, accountId, workspaceId) => {
    const r = await sbacs.resolveWorkspace(accountId, workspaceId);
    if (r.error) { res.status(r.error === 'bad_account' ? 400 : 403).json({ ok: false, allowed: false, reason: r.error }); return null; }
    return r.workspaceId;
  };
  app.post('/internal/v1/entitlements/check', gate('check'), h(async (req, res) => {
    const p = z.object({ ...subject, feature: feat }).strict().parse(req.body); if (!inScope(req, res, p.feature)) return;
    const r = await sbacs.resolveWorkspace(p.accountId, p.workspaceId);
    if (r.error === 'bad_account') return res.status(400).json({ allowed: false, reason: 'bad_account' });
    if (r.error === 'not_a_member') return res.status(403).json({ allowed: false, reason: 'not_a_member' });
    if (r.error) return res.set('Cache-Control', 'no-store').json(p.feature === 'meet.guest_join' ? { allowed: true, feature: p.feature } : { allowed: false, reason: 'no_workspace', feature: p.feature, upgradeAvailable: false });
    res.set('Cache-Control', 'no-store').json(await sbacs.check({ workspaceId: r.workspaceId, featureKey: p.feature }));
  }));
  app.post('/internal/v1/entitlements/reserve', gate('reserve'), h(async (req, res) => {
    const p = z.object({ ...subject, feature: feat, units: z.number().int().min(1).max(1_000_000).default(1), idempotencyKey: key, ttlMs: z.number().int().min(1000).max(86_400_000).optional() }).strict().parse(req.body);
    if (!inScope(req, res, p.feature)) return;
    const w = await workspaceOf(res, p.accountId, p.workspaceId); if (!w) return;
    const r = await sbacs.reserve({ workspaceId: w, featureKey: p.feature, units: p.units, idempotencyKey: p.idempotencyKey, ttlMs: p.ttlMs });
    res.set('Cache-Control', 'no-store').status(r.ok ? 200 : 403).json(r);
  }));
  // work that ALREADY happened (e.g. media accepted while the entitlement service was unreachable) is recorded even beyond a quota: it cannot be un-delivered
  app.post('/internal/v1/entitlements/record', gate('record'), h(async (req, res) => {
    const p = z.object({ ...subject, feature: feat, units: z.number().int().min(1).max(1_000_000).default(1), idempotencyKey: key }).strict().parse(req.body);
    if (!inScope(req, res, p.feature)) return;
    const w = await workspaceOf(res, p.accountId, p.workspaceId); if (!w) return;
    res.set('Cache-Control', 'no-store').json(await sbacs.record({ workspaceId: w, featureKey: p.feature, units: p.units, idempotencyKey: p.idempotencyKey }));
  }));
  for (const action of ['finalize', 'release']) {
    app.post('/internal/v1/entitlements/' + action, gate(action), h(async (req, res) => {
      const p = z.object({ accountId: account, reservationId: z.string().uuid() }).strict().parse(req.body);
      const info = await sbacs.reservationInfo(p.reservationId);                          // a service settles only reservations in its own scope, for workspaces the named account belongs to
      if (!info) return res.status(404).json({ error: 'unknown_reservation' });
      if (!inScope(req, res, info.feature)) return;
      if (!(await sbacs.isMember(p.accountId, info.workspaceId))) return res.status(403).json({ ok: false, reason: 'not_a_member' });
      res.set('Cache-Control', 'no-store').json(await sbacs[action](p.reservationId));
    }));
  }
}
