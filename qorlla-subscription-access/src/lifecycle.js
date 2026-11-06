/**
 * Subscription lifecycle evaluation. PURE: no I/O, the clock is an argument.
 *
 * Policy (fail closed):
 *  - paused / canceled / incomplete / expired / unknown status      -> not entitled (Basic only)
 *  - billing period not yet started (beyond a small clock skew)      -> not entitled
 *  - trial past trial_ends_at                                         -> not entitled
 *  - active / trialing past current_period_end (+ renewalGraceMs)    -> not entitled
 *  - past_due: entitled only inside the grace window. The window is the explicit
 *    grace_period_ends_at when set, otherwise current_period_end + defaultGraceMs.
 * "Not entitled" never means "no access": the caller falls back to the free Basic plan.
 */

import { isValidPlan } from './plans.js';

export const ACTIVE_STATUSES = Object.freeze(['active', 'trialing', 'past_due']);
export const ALL_STATUSES = Object.freeze(['trialing', 'active', 'past_due', 'paused', 'canceled', 'incomplete', 'expired']);
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_LIFECYCLE = Object.freeze({
  defaultGraceMs: 3 * DAY_MS,
  renewalGraceMs: 0,
  clockSkewMs: 5 * 60 * 1000,
});

const toMs = (v) => (v == null ? null : new Date(v).getTime());

function denied(sub, status, reason) {
  sub.effective_plan = 'basic';
  sub.effective_status = status;
  sub.entitled = false;
  sub.lifecycle_reason = reason;
  return sub;
}

function allowed(sub, status, reason) {
  sub.effective_plan = sub.plan_code;
  sub.effective_status = status;
  sub.entitled = true;
  if (reason) sub.lifecycle_reason = reason;
  return sub;
}

/** Mutates and returns `sub` with effective_plan, effective_status, entitled and lifecycle_reason. */
export function evaluateLifecycle(sub, now, options = {}) {
  const o = { ...DEFAULT_LIFECYCLE, ...options };
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) return denied(sub, 'unknown', 'invalid_clock');

  if (!isValidPlan(sub.plan_code)) return denied(sub, 'unknown', 'unknown_plan');
  if (sub.status === 'paused') return denied(sub, 'paused', 'paused');
  if (sub.status === 'canceled' || sub.status === 'incomplete' || sub.status === 'expired') {
    return denied(sub, sub.status, sub.status);
  }
  if (!ACTIVE_STATUSES.includes(sub.status)) return denied(sub, 'unknown', 'unknown_status');

  const start = toMs(sub.current_period_start);
  const end = toMs(sub.current_period_end);
  const trialEnd = toMs(sub.trial_ends_at);
  const graceEnd = toMs(sub.grace_period_ends_at);
  if (end == null || Number.isNaN(end) || (start != null && Number.isNaN(start))) {
    return denied(sub, 'unknown', 'invalid_period');
  }
  if (start != null && start > nowMs + o.clockSkewMs) return denied(sub, 'unknown', 'period_not_started');

  if (sub.status === 'past_due') {
    const until = graceEnd != null ? graceEnd : end + o.defaultGraceMs;
    return nowMs < until ? allowed(sub, 'past_due_grace', 'grace_period') : denied(sub, 'expired', 'grace_expired');
  }

  if (sub.status === 'trialing' && trialEnd != null && trialEnd <= nowMs) {
    return denied(sub, 'trial_expired', 'trial_expired');
  }
  if (end + o.renewalGraceMs <= nowMs) return denied(sub, 'expired', 'period_expired');

  return allowed(sub, sub.status);
}

/** UTC calendar boundaries. Never uses the server's local time zone. */
export function utcDay(nowMs) {
  const d = new Date(nowMs);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { start: new Date(start), end: new Date(start + DAY_MS) };
}

export function utcMonth(nowMs) {
  const d = new Date(nowMs);
  return {
    start: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)),
    end: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)),
  };
}

/**
 * Usage window for a consumption feature.
 *  billing: the subscription's own period when it is entitled and contains `now`; otherwise the UTC month.
 */
export function periodBounds(sub, meta, nowMs) {
  const period = meta?.period || 'billing';
  if (period === 'daily') return utcDay(nowMs);
  if (period === 'monthly') return utcMonth(nowMs);
  if (period === 'billing' && sub?.entitled && sub.source === 'db' && sub.current_period_start && sub.current_period_end) {
    const start = new Date(sub.current_period_start);
    const end = new Date(sub.current_period_end);
    if (start.getTime() <= nowMs && nowMs < end.getTime()) return { start, end };
  }
  return utcMonth(nowMs);
}
