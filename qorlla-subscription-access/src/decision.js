/**
 * Access decision. PURE: given the evaluated subscription, active overrides and (for consumption
 * features) the usage already counted, return an allow/deny decision. No I/O, so the same logic
 * runs for read-only checks and inside the reservation transaction.
 */

import { resolveEntitlements, minimumPlanFor, getFeatureMeta, isValidFeature } from './plans.js';

/** Entitlements that apply to this subscription. Overrides apply only to entitled subscriptions. */
export function resolveFor(sub, overrides = {}) {
  if (!sub.entitled) {
    return { values: resolveEntitlements('basic'), plan: 'basic', status: sub.effective_status, entitled: false };
  }
  return {
    values: { ...resolveEntitlements(sub.effective_plan), ...overrides },
    plan: sub.effective_plan,
    status: sub.effective_status,
    entitled: true,
  };
}

/**
 * @param {object} sub        evaluated subscription (see lifecycle.evaluateLifecycle)
 * @param {object} overrides  active overrides { featureKey: value }
 * @param {string} featureKey
 * @param {number} quantity   positive safe integer (validated by the caller)
 * @param {{used:number, reserved:number, bounds:{start:Date,end:Date}}|null} usage  required for consumption features
 */
export function decide(sub, overrides, featureKey, quantity, usage) {
  if (!isValidFeature(featureKey)) return { allowed: false, reason: 'unknown_feature', plan: null };
  const meta = getFeatureMeta(featureKey);
  const { values, plan, status, entitled } = resolveFor(sub, overrides);
  const raw = values[featureKey];
  const required_plan = minimumPlanFor(featureKey);
  const base = { plan, status, entitled, metering: meta.metering };

  if (raw === undefined || raw === false || raw === 0 || raw === null) {
    // A lapsed paid customer who asks for a paid feature is told the subscription is the problem.
    if (!entitled && required_plan && required_plan !== 'basic') {
      return { ...base, allowed: false, reason: 'subscription_inactive', lifecycle_reason: sub.lifecycle_reason, required_plan };
    }
    return { ...base, allowed: false, reason: 'feature_not_available', required_plan, limit: raw ?? false };
  }

  if (raw === true || raw === 'unlimited') return { ...base, allowed: true, limit: 'unlimited' };

  const limit = Number(raw);
  if (!Number.isFinite(limit) || limit < 0) return { ...base, allowed: false, reason: 'invalid_entitlement', limit: raw };

  if (meta.metering === 'capacity') {
    const ok = quantity <= limit;
    return { ...base, allowed: ok, reason: ok ? undefined : 'limit_exceeded', limit, requested: quantity, required_plan: ok ? undefined : required_plan };
  }

  if (meta.metering !== 'consumption') {
    // A numeric value on a non-metered feature has no defined meaning: deny rather than guess.
    return { ...base, allowed: false, reason: 'invalid_entitlement', limit: raw };
  }

  const used = usage?.used ?? 0;
  const reserved = usage?.reserved ?? 0;
  const remaining = limit - used - reserved;
  const common = {
    ...base, limit, used, reserved, requested: quantity,
    period_start: usage?.bounds?.start, period_end: usage?.bounds?.end,
  };
  if (quantity > remaining) {
    return { ...common, allowed: false, reason: 'limit_exceeded', remaining: Math.max(0, remaining), required_plan };
  }
  return { ...common, allowed: true, remaining: remaining - quantity };
}
