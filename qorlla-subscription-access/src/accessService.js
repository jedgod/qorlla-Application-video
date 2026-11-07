/**
 * AccessService - request-path enforcement (runs with the least-privilege `qorlla_sub_runtime` role).
 *
 * Guarantees
 *  - Identity: the customer id must be a UUID supplied by authenticated context. Nothing else is accepted.
 *  - Lifecycle: trial, grace, pause, cancel and expiry are evaluated with the DATABASE clock (lifecycle.js).
 *  - Capacity features are snapshot comparisons; consumption features are metered with atomic reservations.
 *  - A reservation reads the subscription, overrides and usage INSIDE its transaction, holding a per-(customer,
 *    feature) advisory lock and a SHARED per-customer lock that every write to subscriptions/entitlement_overrides
 *    takes exclusively (database trigger, schema/002), so a concurrent downgrade or override change cannot interleave
 *    with the check-and-write. No write privilege is needed for this.
 *  - Lock order is always quota -> customer. Writers only ever take the customer lock, so there is no cycle.
 *  - Idempotency is checked before any denial, holds across every reservation state, and a retry after commit
 *    replays the result instead of consuming quota twice.
 *  - Long jobs: reservations can be renewed (bounded), and a late commit still records the usage that happened.
 *  - Any database or audit failure DENIES (AccessUnavailableError, HTTP 503). The in-process cache is off by default.
 */

import { createPool, ensureSearchPath } from './schema.js';
import { getFeatureMeta, isValidFeature } from './plans.js';
import { decide, resolveFor } from './decision.js';
import { evaluateLifecycle, periodBounds, DEFAULT_LIFECYCLE } from './lifecycle.js';
import { withTx } from './db.js';
import { strictQuantity, DEFAULT_MAX_QUANTITY } from './validate.js';
import {
  SubscriptionError, FeatureNotAvailableError, LimitExceededError, SubscriptionInactiveError, OperationalGateError,
  InvalidCustomerError, IdempotencyConflictError, AccessUnavailableError,
} from './errors.js';
import { defaultCache } from './cache.js';

const DEFAULT_RESERVATION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RESERVATION_LIFETIME_MS = 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUB_COL_LIST = ['customer_id', 'id', 'plan_code', 'status', 'quantity', 'trial_ends_at', 'current_period_start',
  'current_period_end', 'grace_period_ends_at', 'cancel_at_period_end', 'canceled_at', 'paused_at', 'provider', 'provider_revision', 'metadata'];
const SUB_COLUMNS_S = SUB_COL_LIST.map((c) => `s.${c}`).join(', ');

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

export class AccessService {
  constructor(opts = {}) {
    this.ownsPool = !opts.pool;
    this.pool = opts.pool || createPool(opts.connectionString || process.env.DATABASE_URL, {
      max: opts.poolMax || 10,
      connectionTimeoutMillis: opts.connectionTimeoutMs || 5000,
      idleTimeoutMillis: 30_000,
    });

    this.cache = opts.cache || defaultCache;
    this.cacheEnabled = opts.cacheEnabled === true;
    if (this.cacheEnabled && process.env.NODE_ENV === 'production' && opts.singleInstance !== true) {
      throw new Error('cacheEnabled is refused in production unless singleInstance:true: an in-process cache cannot be invalidated across instances');
    }
    this.cacheTtlMs = opts.cacheTtlMs || 15_000;

    this.maxQuantity = opts.maxQuantity ?? DEFAULT_MAX_QUANTITY;
    this.failClosedOnAuditError = opts.failClosedOnAuditError !== false;
    this.auditMode = opts.audit === 'denied' ? 'denied' : 'all';
    this.reservationTtlMs = opts.reservationTtlMs || DEFAULT_RESERVATION_TTL_MS;
    this.maxReservationLifetimeMs = opts.maxReservationLifetimeMs || DEFAULT_MAX_RESERVATION_LIFETIME_MS;
    // Reservations for ONE customer+feature are serialised on purpose; lock_timeout bounds how long a request will queue.
    this.lockTimeoutMs = opts.lockTimeoutMs || 5000;
    this.statementTimeoutMs = opts.statementTimeoutMs || 10_000;
    this.lifecycleOptions = {
      defaultGraceMs: opts.defaultGraceMs ?? DEFAULT_LIFECYCLE.defaultGraceMs,
      renewalGraceMs: opts.renewalGraceMs ?? DEFAULT_LIFECYCLE.renewalGraceMs,
      clockSkewMs: opts.clockSkewMs ?? DEFAULT_LIFECYCLE.clockSkewMs,
    };
    // 'basic': a customer with no subscription row gets the free Basic plan. 'deny': they get nothing paid or free.
    this.missingSubscription = opts.missingSubscription || 'basic';
    if (!['basic', 'deny'].includes(this.missingSubscription)) throw new Error("missingSubscription must be 'basic' or 'deny'");
    // Entitlement is not capability. A gate must be explicitly opened by operations; PSTN is closed by default.
    this.gates = { 'phone.pstn': false, ...(opts.operationalGates || {}) };
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  _customer(customerId) {
    if (!isUuid(customerId)) throw new InvalidCustomerError();
    return customerId.toLowerCase();
  }

  /** No fallbacks: missing, malformed, fractional, non-positive, non-finite and excessive quantities are all rejected. */
  _quantity(q) {
    return strictQuantity(q, { required: true, max: this.maxQuantity });
  }

  /** Public methods run inside this: typed errors pass through, everything else becomes "denied: unavailable". */
  async _guard(fn) {
    try { await ensureSearchPath(this.pool); return await fn(); } catch (err) {
      if (err instanceof SubscriptionError) throw err;
      console.error('[subscription-access] access check failed closed:', err.code || '', err.message);
      throw new AccessUnavailableError(err);
    }
  }

  _tx(fn, { readOnly = false } = {}) {
    return withTx(this.pool, fn, { readOnly, lockTimeoutMs: this.lockTimeoutMs, statementTimeoutMs: this.statementTimeoutMs });
  }

  // -------------------------------------------------------------------------
  // Subscription + overrides + lifecycle (one statement, database clock)
  // -------------------------------------------------------------------------

  async _loadState(q, id, { useCache = false } = {}) {
    const ck = `sub:${id}`;
    let row; let overrides; let now;
    const hit = useCache && this.cacheEnabled ? this.cache.get(ck) : undefined;
    if (hit !== undefined) {
      ({ row, overrides } = hit); now = new Date();                         // the lifecycle is still evaluated against the clock
    } else {
      const r = (await q.query(
        `SELECT t.db_now, ${SUB_COLUMNS_S},
                COALESCE((SELECT jsonb_object_agg(o.feature_key, o.value) FROM entitlement_overrides o
                           WHERE o.customer_id = $1 AND (o.expires_at IS NULL OR o.expires_at > now())), '{}'::jsonb) AS overrides
           FROM (SELECT now() AS db_now) t LEFT JOIN subscriptions s ON s.customer_id = $1`, [id])).rows[0];
      now = r.db_now; overrides = r.overrides || {};
      const { db_now: _clock, overrides: _ovr, ...rest } = r;
      row = rest.customer_id ? rest : null;
      if (useCache && this.cacheEnabled) this.cache.set(ck, { row, overrides }, this.cacheTtlMs);
    }
    const sub = this._evaluate(id, row, now);
    return { sub, overrides: sub.entitled ? cleanOverrides(overrides) : {}, now };
  }

  _evaluate(customerId, row, now) {
    if (!row) {
      if (this.missingSubscription === 'deny') {
        return { customer_id: customerId, plan_code: 'basic', status: 'incomplete', source: 'none', effective_plan: 'basic', effective_status: 'none', entitled: false, lifecycle_reason: 'no_subscription' };
      }
      return { customer_id: customerId, plan_code: 'basic', status: 'active', quantity: 1, source: 'default', effective_plan: 'basic', effective_status: 'active', entitled: true, lifecycle_reason: 'default_basic' };
    }
    return evaluateLifecycle({ ...row, source: 'db' }, now, this.lifecycleOptions);
  }

  async getSubscription(customerId) {
    return this._guard(async () => (await this._loadState(this.pool, this._customer(customerId), { useCache: true })).sub);
  }

  async getOverrides(customerId) {
    return this._guard(async () => (await this._loadState(this.pool, this._customer(customerId), { useCache: true })).overrides);
  }

  async getResolvedEntitlements(customerId) {
    return this._guard(async () => {
      const { sub, overrides } = await this._loadState(this.pool, this._customer(customerId), { useCache: true });
      const r = resolveFor(sub, overrides);
      return { ...r.values, __plan: r.plan, __status: r.status, __entitled: r.entitled };
    });
  }

  /** Which of these customers are suspended in the directory? (A customer with no directory row is not suspended.) */
  async suspendedCustomers(customerIds) {
    return this._guard(async () => {
      const ids = (customerIds || []).map((c) => this._customer(c));
      if (!ids.length) return new Set();
      const { rows } = await this.pool.query(`SELECT id FROM customers WHERE id = ANY($1::uuid[]) AND status = 'suspended'`, [ids]);
      return new Set(rows.map((r) => r.id));
    });
  }

  // -------------------------------------------------------------------------
  // Usage (consumption only, counted by when the operation started)
  // -------------------------------------------------------------------------

  async _usage(q, customerId, featureKey, bounds) {
    const { rows } = await q.query(
      `SELECT
         (SELECT COALESCE(SUM(quantity), 0) FROM usage_events
           WHERE customer_id = $1 AND feature_key = $2 AND occurred_at >= $3 AND occurred_at < $4)::bigint AS used,
         (SELECT COALESCE(SUM(quantity), 0) FROM quota_reservations
           WHERE customer_id = $1 AND feature_key = $2 AND status = 'reserved' AND expires_at > now())::bigint AS reserved`,
      [customerId, featureKey, bounds.start, bounds.end]);
    return { used: Number(rows[0].used), reserved: Number(rows[0].reserved), bounds };
  }

  async getConsumed(customerId, featureKey, periodStart, periodEnd) {
    return this._guard(async () => (await this._usage(this.pool, this._customer(customerId), featureKey, { start: periodStart, end: periodEnd })).used);
  }

  async getActiveReservations(customerId, featureKey) {
    return this._guard(async () => (await this._usage(this.pool, this._customer(customerId), featureKey, { start: new Date(0), end: new Date('9999-12-31') })).reserved);
  }

  // -------------------------------------------------------------------------
  // Access decision
  // -------------------------------------------------------------------------

  async _gateOpen(featureKey, customerId) {
    const g = this.gates[featureKey];
    if (g === undefined) return true;
    return (typeof g === 'function' ? await g(customerId, featureKey) : g) === true;
  }

  async _decideWith(q, id, featureKey, quantity, { useCache = false } = {}) {
    const { sub, overrides, now } = await this._loadState(q, id, { useCache });
    // missingSubscription:'deny' means "no subscription row, no access at all" - not even the free Basic features.
    if (sub.source === 'none') {
      return { allowed: false, reason: 'subscription_inactive', plan: null, status: 'none', entitled: false, lifecycle_reason: 'no_subscription' };
    }
    const meta = getFeatureMeta(featureKey);
    const usage = meta.metering === 'consumption' ? await this._usage(q, id, featureKey, periodBounds(sub, meta, now.getTime())) : null;
    let decision = decide(sub, overrides, featureKey, quantity, usage);
    // Every consumption decision carries its usage window (an unlimited plan has no usage query, but is still metered).
    if (usage && !decision.period_start) decision = { ...decision, period_start: usage.bounds.start, period_end: usage.bounds.end };
    if (decision.allowed && !(await this._gateOpen(featureKey, id))) {
      decision = { ...decision, allowed: false, reason: 'operational_gate_off', gate: 'closed' };
    }
    return decision;
  }

  /** Read-only decision from one consistent snapshot. Audited. Use reserve() for metered work. */
  async canAccess(customerId, featureKey, opts = {}) {
    return this._guard(async () => {
      const id = this._customer(customerId);
      const quantity = this._quantity(opts.quantity === undefined ? 1 : opts.quantity);
      if (!isValidFeature(featureKey)) {
        const d = { allowed: false, reason: 'unknown_feature', plan: null };
        await this._audit(this.pool, id, featureKey, d, quantity, opts);
        return d;
      }
      // Non-metered features need one statement; metered ones read usage too, so they share a repeatable-read snapshot.
      const decision = getFeatureMeta(featureKey).metering === 'consumption'
        ? await this._tx((c) => this._decideWith(c, id, featureKey, quantity), { readOnly: true })
        : await this._decideWith(this.pool, id, featureKey, quantity, { useCache: true });
      await this._audit(this.pool, id, featureKey, decision, quantity, opts);
      return decision;
    });
  }

  async assertAccess(customerId, featureKey, opts = {}) {
    const d = await this.canAccess(customerId, featureKey, opts);
    if (d.allowed) return d;
    if (d.reason === 'limit_exceeded') throw new LimitExceededError(featureKey, d.plan, d.limit, d.used || 0, opts.quantity || 1);
    if (d.reason === 'feature_not_available' || d.reason === 'unknown_feature') throw new FeatureNotAvailableError(featureKey, d.plan, d.required_plan);
    if (d.reason === 'operational_gate_off') throw new OperationalGateError(featureKey);
    throw new SubscriptionInactiveError(d.status, d.lifecycle_reason);
  }

  // -------------------------------------------------------------------------
  // Reservations
  // -------------------------------------------------------------------------

  /**
   * Atomically check and hold quota for a consumption feature.
   * Requires a stable, server-generated idempotencyKey (<= 200 chars).
   * Returns { allowed, reservationId, expires_at, ... } or a denial. A repeated key replays the earlier result.
   */
  async reserve(customerId, featureKey, quantity = 1, opts = {}) {
    return this._guard(async () => {
      const id = this._customer(customerId);
      const qty = this._quantity(quantity);
      if (opts.soft) throw new SubscriptionError('soft quota reservations are disabled', 'soft_quota_disabled', {}, 400);
      const key = opts.idempotencyKey;
      if (typeof key !== 'string' || key.length < 1 || key.length > 200) {
        throw new SubscriptionError('idempotencyKey required (1-200 characters)', 'invalid_idempotency_key', {}, 400);
      }
      const meta = getFeatureMeta(featureKey);
      if (!meta || meta.metering !== 'consumption') {
        throw new SubscriptionError('reserve() is only valid for consumption features', 'not_consumption_feature', { feature: featureKey }, 400);
      }
      const ttlMs = Math.min(Math.max(Number(opts.ttlMs ?? this.reservationTtlMs), 1000), this.maxReservationLifetimeMs);

      return this._tx(async (c) => {
        // quota lock first, then the shared customer lock; one round trip, evaluated in that order (MATERIALIZED CTE).
        await c.query(
          `WITH q AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended($1, 0)))
           SELECT pg_advisory_xact_lock_shared(hashtextextended($2, 0)) FROM q`, [`quota:${id}:${featureKey}`, `sub:${id}`]);

        // 1. Idempotency first: a retry must never be denied, double-counted or re-evaluated.
        const prior = (await c.query(
          `SELECT r.id, r.quantity, r.status, r.expires_at, (r.expires_at <= now()) AS timed_out, u.metadata AS result_metadata
             FROM quota_reservations r LEFT JOIN usage_events u ON u.reservation_id = r.id
            WHERE r.customer_id = $1 AND r.feature_key = $2 AND r.idempotency_key = $3`,
          [id, featureKey, key])).rows[0];
        if (prior) {
          if (Number(prior.quantity) !== qty) throw new IdempotencyConflictError();
          const status = prior.status === 'reserved' && prior.timed_out ? 'expired' : prior.status;
          const ok = status === 'reserved' || status === 'committed';
          // A replay NEVER means "go ahead": the caller must look at `status`.
          //   committed -> the original finished; `result` is what it stored when it committed
          //   reserved  -> the original is STILL RUNNING (answer 409/202, do not run the work again)
          //   released / expired -> the original FAILED or was abandoned (a new key is needed)
          return { allowed: ok, reason: ok ? undefined : `reservation_${status}`, reservationId: prior.id, status, replay: true,
            pending: status === 'reserved', expires_at: prior.expires_at, result: status === 'committed' ? (prior.result_metadata?.result ?? null) : undefined };
        }

        // 2. Authoritative decision inside the transaction, with both locks held.
        const decision = await this._decideWith(c, id, featureKey, qty);
        if (!decision.allowed) {
          await this._audit(c, id, featureKey, decision, qty, opts, { inTx: true });
          return decision;
        }
        // Unlimited plans are still recorded: the reservation is what makes a retry recognisable, so the protected work
        // cannot run twice, and the usage is metered for analytics. It simply never runs out.

        // 3. Hold the quota.
        const ins = await c.query(
          `INSERT INTO quota_reservations
             (customer_id, feature_key, quantity, expires_at, max_expires_at, period_start, period_end, idempotency_key, metadata)
           VALUES ($1, $2, $3, now() + make_interval(secs => $4::double precision), now() + make_interval(secs => $5::double precision), $6, $7, $8, $9)
           RETURNING id, expires_at`,
          [id, featureKey, qty, ttlMs / 1000, this.maxReservationLifetimeMs / 1000, decision.period_start, decision.period_end, key, opts.metadata || {}]);
        const result = { ...decision, allowed: true, held: true, reservationId: ins.rows[0].id, expires_at: ins.rows[0].expires_at };
        await this._audit(c, id, featureKey, result, qty, { ...opts, reservationId: ins.rows[0].id }, { inTx: true });
        return result;
      });
    });
  }

  async _reservationNotFound(customerId, reservationId) {
    // Same answer for "does not exist" and "belongs to someone else"; the second is recorded for alerting.
    try {
      const other = await this.pool.query('SELECT 1 FROM quota_reservations WHERE id = $1 AND customer_id <> $2', [reservationId, customerId]);
      if (other.rowCount) await this._securityEvent(this.pool, 'reservation_cross_tenant_attempt', 'warning', customerId, { reservationId });
    } catch { /* best effort */ }
    return { ok: false, reason: 'reservation_not_found' };
  }

  async commitReservation(reservationId, { customerId, metadata = {} } = {}) {
    return this._guard(async () => {
      const id = this._customer(customerId);
      if (!isUuid(reservationId)) return { ok: false, reason: 'reservation_not_found' };
      const out = await this._tx(async (c) => {
        const r = (await c.query(
          `SELECT *, (expires_at <= now()) AS timed_out FROM quota_reservations WHERE id = $1 AND customer_id = $2 FOR UPDATE`, [reservationId, id])).rows[0];
        if (!r) return null;
        if (r.status === 'committed') return { ok: true, reservationId, replay: true };
        if (r.status === 'released') return { ok: false, reason: 'reservation_released' };
        const late = r.status === 'expired' || r.timed_out;
        // The work already happened: record the usage whatever the clock says. Dropping it would be a free ride.
        await c.query(
          `INSERT INTO usage_events (customer_id, feature_key, quantity, reservation_id, occurred_at, period_start, period_end, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [r.customer_id, r.feature_key, r.quantity, r.id, r.reserved_at, r.period_start, r.period_end, metadata]);
        await c.query(`UPDATE quota_reservations SET status = 'committed', committed_at = now(), late = $2 WHERE id = $1`, [r.id, late]);
        if (late) await this._securityEvent(c, 'late_commit', 'warning', id, { reservationId: r.id, feature: r.feature_key, quantity: r.quantity }, { inTx: true });
        return { ok: true, reservationId, late };
      });
      return out || this._reservationNotFound(id, reservationId);
    });
  }

  async releaseReservation(reservationId, { customerId } = {}) {
    return this._guard(async () => {
      const id = this._customer(customerId);
      if (!isUuid(reservationId)) return { ok: false, reason: 'reservation_not_found' };
      const out = await this._tx(async (c) => {
        const r = (await c.query('SELECT id, status FROM quota_reservations WHERE id = $1 AND customer_id = $2 FOR UPDATE', [reservationId, id])).rows[0];
        if (!r) return null;
        if (r.status === 'committed') return { ok: false, reason: 'already_committed' };
        if (r.status === 'released' || r.status === 'expired') return { ok: true, replay: true };
        await c.query(`UPDATE quota_reservations SET status = 'released' WHERE id = $1`, [r.id]);
        return { ok: true };
      });
      return out || this._reservationNotFound(id, reservationId);
    });
  }

  /** Extend a live reservation for a long job. Bounded by max_expires_at; an expired reservation must be re-reserved. */
  async renewReservation(reservationId, { customerId, extendMs } = {}) {
    return this._guard(async () => {
      const id = this._customer(customerId);
      if (!isUuid(reservationId)) return { ok: false, reason: 'reservation_not_found' };
      const ext = Math.min(Math.max(Number(extendMs ?? this.reservationTtlMs), 1000), this.maxReservationLifetimeMs);
      const { rows } = await this.pool.query(
        `UPDATE quota_reservations
            SET expires_at = LEAST(now() + make_interval(secs => $3::double precision), max_expires_at), renewed_count = renewed_count + 1
          WHERE id = $1 AND customer_id = $2 AND status = 'reserved' AND expires_at > now()
          RETURNING expires_at, max_expires_at`, [reservationId, id, ext / 1000]);
      if (rows.length) return { ok: true, expires_at: rows[0].expires_at, at_maximum: rows[0].expires_at >= rows[0].max_expires_at };
      const exists = (await this.pool.query('SELECT status FROM quota_reservations WHERE id = $1 AND customer_id = $2', [reservationId, id])).rows[0];
      return exists ? { ok: false, reason: exists.status === 'reserved' ? 'reservation_expired' : `reservation_${exists.status}` } : this._reservationNotFound(id, reservationId);
    });
  }

  /** Marks timed-out reservations 'expired' so they stop holding quota rows. Safe to run from many instances. */
  async sweepExpiredReservations({ limit = 1000 } = {}) {
    return this._guard(async () => {
      const { rowCount } = await this.pool.query(
        `UPDATE quota_reservations SET status = 'expired'
          WHERE id IN (SELECT id FROM quota_reservations WHERE status = 'reserved' AND expires_at <= now()
                       ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)`, [limit]);
      return { expired: rowCount };
    });
  }

  startSweeper(intervalMs = 60_000) {
    const t = setInterval(() => { this.sweepExpiredReservations().catch((e) => console.error('[subscription-access] sweep failed:', e.message)); }, intervalMs);
    t.unref?.();
    return () => clearInterval(t);
  }

  // -------------------------------------------------------------------------
  // Audit + security events (append-only tables)
  // -------------------------------------------------------------------------

  async _audit(q, customerId, featureKey, decision, quantity, ctx = {}, { inTx = false } = {}) {
    if (this.auditMode === 'denied' && decision.allowed) return;
    // Fail-closed (default): an audit failure aborts the whole transaction, so no savepoint is needed.
    // Fail-open (explicit opt-out): a savepoint lets the transaction carry on without the audit row.
    const savepoint = inTx && !this.failClosedOnAuditError;
    try {
      if (savepoint) await q.query('SAVEPOINT audit_sp');
      await q.query(
        `INSERT INTO access_audit
           (customer_id, feature_key, allowed, reason, plan_code, limit_value, used_value, requested_quantity, actor, request_id, reservation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [customerId, String(featureKey).slice(0, 100), !!decision.allowed, decision.reason || null, decision.plan || null,
          decision.limit != null ? JSON.stringify(decision.limit) : null, decision.used ?? null, quantity,
          ctx.actor ? String(ctx.actor).slice(0, 200) : null, ctx.requestId ? String(ctx.requestId).slice(0, 200) : null,
          isUuid(ctx.reservationId) ? ctx.reservationId : null]);
      if (savepoint) await q.query('RELEASE SAVEPOINT audit_sp');
    } catch (err) {
      console.error('[subscription-access] audit failed:', err.message);
      if (savepoint) { try { await q.query('ROLLBACK TO SAVEPOINT audit_sp'); } catch { /* ignore */ } }
      // Reported on a separate connection: the caller's transaction may already be aborted.
      await this._securityEvent(this.pool, 'audit_write_failed', 'critical', customerId, { error: err.message, featureKey });
      if (this.failClosedOnAuditError) throw err;
    }
  }

  async _securityEvent(q, eventType, severity, customerId, details, { inTx = false } = {}) {
    try {
      if (inTx) await q.query('SAVEPOINT sec_sp');
      await q.query('INSERT INTO security_events (event_type, severity, customer_id, details) VALUES ($1, $2, $3, $4)',
        [eventType, severity, customerId, JSON.stringify(details || {})]);
      if (inTx) await q.query('RELEASE SAVEPOINT sec_sp');
    } catch (err) {
      console.error('[subscription-access] security event write failed:', err.message);
      if (inTx) { try { await q.query('ROLLBACK TO SAVEPOINT sec_sp'); } catch { /* ignore */ } }
    }
  }

  invalidate(customerId) {
    this.cache.del(`sub:${customerId}`);
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}

/** Same rules the override writer enforces, applied again when reading (defence in depth). */
export function validOverrideValue(meta, value) {
  if (meta.type === 'boolean') return typeof value === 'boolean';
  if (meta.type === 'numeric') return value === 'unlimited' || (Number.isSafeInteger(value) && value >= 0 && value <= 999_999_999);
  return false;
}

/** A corrupt or unknown override row grants nothing. */
function cleanOverrides(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    const meta = getFeatureMeta(k);
    if (meta && validOverrideValue(meta, v)) out[k] = v;
  }
  return out;
}

export function createAccessService(opts) {
  return new AccessService(opts);
}
