/**
 * Billing-provider adapters. An adapter turns ONE provider's webhook into the neutral event shape below.
 * No provider SDK and no payment collection here: a real provider needs its own adapter with the same two methods,
 *   verify(rawBody: Buffer, headers, nowMs) -> { ok: boolean, reason?: string }   // exact raw bytes, constant time
 *   parse(rawBody: Buffer) -> neutral event
 *
 * Neutral event
 *   { provider, eventId, type, revision, occurredAt, externalCustomerId,
 *     subscription?: { externalId, planCode, status, quantity?, trialEndsAt?, currentPeriodStart, currentPeriodEnd,
 *                      gracePeriodEndsAt?, cancelAtPeriodEnd?, canceledAt?, pausedAt? },
 *     invoice?: object }
 * `revision` is a monotonic number for the subscription (provider version / sequence). A snapshot is applied only if
 * its revision is higher than the one already stored, so replays and out-of-order delivery cannot move state backwards.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { isValidPlan } from './plans.js';
import { ALL_STATUSES } from './lifecycle.js';
import { BillingEventError } from './errors.js';

export const EVENT_TYPES = Object.freeze([
  'subscription.created', 'subscription.updated', 'subscription.canceled', 'subscription.paused', 'subscription.resumed',
  'subscription.trial_ending', 'invoice.paid', 'invoice.payment_failed', 'invoice.refunded', 'refund.created',
]);
/** Types that may carry a snapshot which changes entitlements. Everything else is outbox-only. */
export const ENTITLEMENT_TYPES = Object.freeze([
  'subscription.created', 'subscription.updated', 'subscription.canceled', 'subscription.paused', 'subscription.resumed',
  'invoice.paid', 'invoice.payment_failed',
]);

const isDate = (v) => v != null && Number.isFinite(new Date(v).getTime());
const str = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max;

/** Strict structural validation of a neutral event. Throws BillingEventError. */
export function validateEvent(provider, e) {
  const bad = (m) => { throw new BillingEventError(m); };
  if (!e || typeof e !== 'object') bad('event must be an object');
  if (e.provider !== provider) bad('event provider does not match the endpoint');
  if (!str(e.eventId, 200)) bad('eventId required');
  if (!EVENT_TYPES.includes(e.type)) return { ...e, unknownType: true };
  if (!str(e.externalCustomerId, 200)) bad('externalCustomerId required');
  if (!isDate(e.occurredAt)) bad('occurredAt must be a date');
  const s = e.subscription;
  if (s != null) {
    if (!Number.isSafeInteger(e.revision) || e.revision < 1) bad('revision must be a positive integer for a subscription snapshot');
    if (typeof s !== 'object') bad('subscription must be an object');
    if (!str(s.externalId, 200)) bad('subscription.externalId required');
    if (!isValidPlan(s.planCode)) bad('subscription.planCode is not a known plan');
    if (!ALL_STATUSES.includes(s.status)) bad('subscription.status is not a known status');
    if (!isDate(s.currentPeriodStart) || !isDate(s.currentPeriodEnd)) bad('subscription period dates required');
    if (new Date(s.currentPeriodEnd) <= new Date(s.currentPeriodStart)) bad('subscription period must end after it starts');
    for (const k of ['trialEndsAt', 'gracePeriodEndsAt', 'canceledAt', 'pausedAt']) if (s[k] != null && !isDate(s[k])) bad(`subscription.${k} must be a date`);
    if (s.quantity != null && (!Number.isSafeInteger(s.quantity) || s.quantity < 1)) bad('subscription.quantity must be a positive integer');
  } else if (e.revision != null && (!Number.isSafeInteger(e.revision) || e.revision < 0)) {
    bad('revision must be a non-negative integer');
  }
  return e;
}

/**
 * Reference adapter for a provider that signs `${timestamp}.${rawBody}` with HMAC-SHA256 and sends
 *   <header>: t=<unix seconds>,v1=<hex>[,v1=<hex>]       (several v1 values = key rotation)
 * Use it for providers with this scheme, or as the model for another provider's adapter.
 */
export function createSignedJsonAdapter({ provider, secrets, header = 'x-signature', toleranceSec = 300, parse } = {}) {
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(provider || '')) throw new Error('provider must be a short lowercase identifier');
  const keys = (Array.isArray(secrets) ? secrets : [secrets]).filter((s) => typeof s === 'string' && s.length >= 32);
  if (!keys.length) throw new Error('at least one webhook secret of 32+ characters is required');
  const name = header.toLowerCase();

  return {
    provider,
    verify(rawBody, headers = {}, nowMs = Date.now()) {
      if (!Buffer.isBuffer(rawBody)) return { ok: false, reason: 'raw_body_required' };
      const h = headers[name] ?? headers[header];
      if (typeof h !== 'string' || h.length > 1024) return { ok: false, reason: 'missing_signature' };
      let t = null; const v1 = [];
      for (const part of h.split(',')) {
        const [k, v] = part.trim().split('=');
        if (k === 't' && /^\d{1,12}$/.test(v || '')) t = Number(v);
        else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v || '')) v1.push(Buffer.from(v, 'hex'));
      }
      if (t == null || !v1.length) return { ok: false, reason: 'malformed_signature' };
      if (Math.abs(nowMs / 1000 - t) > toleranceSec) return { ok: false, reason: 'timestamp_out_of_tolerance' };
      let match = false;
      for (const key of keys) {
        const mac = createHmac('sha256', key).update(`${t}.`).update(rawBody).digest();
        for (const cand of v1) if (cand.length === mac.length && timingSafeEqual(cand, mac)) match = true;   // no early exit
      }
      return match ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
    },
    parse(rawBody) {
      const obj = JSON.parse(rawBody.toString('utf8'));
      return parse ? parse(obj) : obj;
    },
    /** For tests and provider simulators: produce the header value for a body. */
    sign(rawBody, nowMs = Date.now(), key = keys[0]) {
      const t = Math.floor(nowMs / 1000);
      return `t=${t},v1=${createHmac('sha256', key).update(`${t}.`).update(rawBody).digest('hex')}`;
    },
  };
}
