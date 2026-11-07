/**
 * AdminService - privileged billing administration (runs with the `qorlla_sub_admin` role, never the request path).
 *
 * The service cannot verify who someone is; it enforces what the application tells it about the actor and refuses
 * to work without an authorization callback:
 *   actor = { id, roles: ['billing_admin'], mfaVerifiedAt: <ms epoch or Date> }   // from the verified admin session
 *   authorize(actor, action, customerId) -> true   // e.g. organization-ownership / tenant-scope check; REQUIRED
 * Every write needs a reason, is bounded, is recorded in append-only history, and raises a security event.
 */

import { createPool, ensureSearchPath } from './schema.js';
import { getFeatureMeta } from './plans.js';
import { withTx } from './db.js';
import { validOverrideValue } from './accessService.js';
import { InvalidOverrideError, InvalidCustomerError, NotAuthorizedError } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

export class AdminService {
  constructor(opts = {}) {
    if (typeof opts.authorize !== 'function') {
      throw new Error('AdminService requires an authorize(actor, action, customerId) callback (organization/tenant scope check)');
    }
    this.authorize = opts.authorize;
    this.ownsPool = !opts.pool;
    this.pool = opts.pool || createPool(opts.connectionString || process.env.DATABASE_URL, { max: opts.poolMax || 4 });
    this.requiredRole = opts.requiredRole || 'billing_admin';
    this.mfaMaxAgeMs = opts.mfaMaxAgeMs ?? 15 * 60 * 1000;
    this.maxOverrideMs = opts.maxOverrideMs ?? 366 * DAY_MS;
    this.allowPermanentOverrides = opts.allowPermanentOverrides === true;
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};   // e.g. invalidate caches on other instances
  }

  async _check(actor, action, customerId) {
    await ensureSearchPath(this.pool);
    if (!UUID_RE.test(String(customerId))) throw new InvalidCustomerError();
    if (!actor || typeof actor.id !== 'string' || !actor.id.trim()) throw new NotAuthorizedError('An identified administrator is required');
    if (!Array.isArray(actor.roles) || !actor.roles.includes(this.requiredRole)) throw new NotAuthorizedError('Billing administrator role required');
    const mfaAt = actor.mfaVerifiedAt == null ? NaN : new Date(actor.mfaVerifiedAt).getTime();
    if (!Number.isFinite(mfaAt) || Date.now() - mfaAt > this.mfaMaxAgeMs || mfaAt > Date.now() + 60_000) {
      throw new NotAuthorizedError('Recent multi-factor verification required');
    }
    if ((await this.authorize(actor, action, customerId)) !== true) throw new NotAuthorizedError();
  }

  async _denied(actor, action, customerId, why) {
    try {
      await this.pool.query('INSERT INTO security_events (event_type, severity, customer_id, details) VALUES ($1, $2, $3, $4)',
        ['admin_action_denied', 'warning', UUID_RE.test(String(customerId)) ? customerId : null, JSON.stringify({ action, actor: actor?.id ?? null, why })]);
    } catch { /* best effort */ }
  }

  async setOverride(actor, customerId, featureKey, value, { reason, expiresAt } = {}) {
    try { await this._check(actor, 'override.set', customerId); } catch (e) { await this._denied(actor, 'override.set', customerId, e.code); throw e; }
    const why = typeof reason === 'string' ? reason.trim() : '';
    if (why.length < 5 || why.length > 500) throw new InvalidOverrideError('A reason of 5-500 characters is required');
    const meta = getFeatureMeta(featureKey);
    if (!meta) throw new InvalidOverrideError(`Unknown feature: ${String(featureKey).slice(0, 80)}`);
    if (!validOverrideValue(meta, value)) {
      throw new InvalidOverrideError(meta.type === 'boolean' ? 'Boolean feature requires a boolean value' : 'Numeric feature requires an integer 0-999999999 or "unlimited"');
    }
    let expires = null;
    if (expiresAt != null) {
      expires = new Date(expiresAt);
      const t = expires.getTime();
      if (!Number.isFinite(t) || t <= Date.now()) throw new InvalidOverrideError('expiresAt must be a future date');
      if (t - Date.now() > this.maxOverrideMs) throw new InvalidOverrideError('expiresAt is further away than the permitted maximum');
    } else if (!this.allowPermanentOverrides) {
      throw new InvalidOverrideError('expiresAt is required (permanent overrides are disabled)');
    }

    await withTx(this.pool, async (client) => {
      const old = (await client.query('SELECT value FROM entitlement_overrides WHERE customer_id = $1 AND feature_key = $2 FOR UPDATE', [customerId, featureKey])).rows[0];
      await client.query(
        `INSERT INTO entitlement_overrides (customer_id, feature_key, value, reason, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (customer_id, feature_key) DO UPDATE SET
           value = EXCLUDED.value, reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at,
           created_by = EXCLUDED.created_by, created_at = now()`,
        [customerId, featureKey, JSON.stringify(value), why, expires, actor.id]);
      await client.query(
        `INSERT INTO entitlement_override_history (customer_id, feature_key, action, old_value, new_value, reason, expires_at, actor, actor_roles)
         VALUES ($1, $2, 'set', $3, $4, $5, $6, $7, $8)`,
        [customerId, featureKey, old ? JSON.stringify(old.value) : null, JSON.stringify(value), why, expires, actor.id, actor.roles]);
      await client.query('INSERT INTO security_events (event_type, severity, customer_id, details) VALUES ($1, $2, $3, $4)',
        ['override_set', 'info', customerId, JSON.stringify({ featureKey, actor: actor.id })]);
    });
    this.onChange(customerId);
    return { ok: true };
  }

  async removeOverride(actor, customerId, featureKey, { reason } = {}) {
    try { await this._check(actor, 'override.remove', customerId); } catch (e) { await this._denied(actor, 'override.remove', customerId, e.code); throw e; }
    const why = typeof reason === 'string' ? reason.trim() : '';
    if (why.length < 5 || why.length > 500) throw new InvalidOverrideError('A reason of 5-500 characters is required');
    const removed = await withTx(this.pool, async (client) => {
      const old = (await client.query('DELETE FROM entitlement_overrides WHERE customer_id = $1 AND feature_key = $2 RETURNING value', [customerId, featureKey])).rows[0];
      if (!old) return false;
      await client.query(
        `INSERT INTO entitlement_override_history (customer_id, feature_key, action, old_value, reason, actor, actor_roles)
         VALUES ($1, $2, 'remove', $3, $4, $5, $6)`, [customerId, featureKey, JSON.stringify(old.value), why, actor.id, actor.roles]);
      await client.query('INSERT INTO security_events (event_type, severity, customer_id, details) VALUES ($1, $2, $3, $4)',
        ['override_removed', 'info', customerId, JSON.stringify({ featureKey, actor: actor.id })]);
      return true;
    });
    if (removed) this.onChange(customerId);
    return { ok: true, removed };
  }

  /** Links a provider customer reference to a Qorlla customer. Only an administrator can create this mapping. */
  async linkBillingCustomer(actor, provider, externalCustomerId, customerId) {
    try { await this._check(actor, 'billing.link', customerId); } catch (e) { await this._denied(actor, 'billing.link', customerId, e.code); throw e; }
    await this.pool.query(
      'INSERT INTO billing_customers (provider, external_customer_id, customer_id, linked_by) VALUES ($1, $2, $3, $4)',
      [provider, externalCustomerId, customerId, actor.id]);
    return { ok: true };
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}
