/**
 * Server-side entitlement enforcement in front of the Qorlla Meet API (Express).
 *
 * Meet itself has no notion of a customer. Two trusted facts make enforcement possible:
 *  1. Scheduled meetings are created through the bridge (`POST /api/integrations/scheduled-meetings`), which is already
 *     authenticated with the shared bridge secret. The main application resolves the host's customer from the VERIFIED
 *     session (identity.js) and sends it as `customerId`. Mount `bridgeCreate()` AFTER the bridge authentication.
 *  2. Meet records which customer owns a meeting; `lookupMeeting(idOrCode)` returns it with the number of people CURRENTLY in
 *     the meeting. Anonymous meetings (no customer) are limited to the free Basic plan, or denied: never unlimited.
 *
 *   app.post('/api/integrations/scheduled-meetings', bridgeAuth, guard.bridgeCreate(), handler)
 *   app.post('/api/meetings/:id/join',               guard.join(), handler)
 *   app.post('/api/meetings/:id/recording/start',    guard.feature('meetings.cloud_recording', { customerOf: byMeeting }), handler)
 *
 * Every failure to reach a decision answers 503 and does not call the handler. The participant cap is a snapshot comparison:
 * two joins racing for the last seat can both pass; make `lookupMeeting` + the insert atomic in Meet if that matters.
 */

import { decide } from './decision.js';
import { respondWithAccessError } from './middleware.js';
import { strictQuantity, DEFAULT_MAX_QUANTITY } from './validate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASIC = Object.freeze({ entitled: true, effective_plan: 'basic', effective_status: 'active' });
const STATUS = { subscription_inactive: 402 };

const denial = (res, d, feature) => res.status(STATUS[d.reason] || 403).json({
  error: 'subscription_required', code: d.reason, feature, plan: d.plan, required_plan: d.required_plan,
  limit: d.limit, remaining: d.remaining, upgrade_url: '/pricing',
});

export function createMeetGuard({ service, lookupMeeting, unowned = 'basic', maxQuantity = service?.maxQuantity ?? DEFAULT_MAX_QUANTITY } = {}) {
  if (!service) throw new Error('createMeetGuard requires the AccessService');
  if (!['basic', 'deny', 'allow'].includes(unowned)) throw new Error("unowned must be 'basic', 'deny' or 'allow'");

  /** A decision for a meeting that has no customer. */
  const unownedDecision = (feature, quantity) => {
    if (unowned === 'allow') return { allowed: true };
    if (unowned === 'deny') return { allowed: false, reason: 'subscription_inactive', plan: null };
    return decide(BASIC, {}, feature, quantity, null);
  };

  const check = (customerId, feature, quantity) =>
    (customerId ? service.canAccess(customerId, feature, { quantity }) : Promise.resolve(unownedDecision(feature, quantity)));

  /** Bridge create: a trusted caller names the customer; the plan decides what the meeting may be. */
  const bridgeCreate = () => async (req, res, next) => {
    try {
      const b = req.body || {};
      if (typeof b.customerId !== 'string' || !UUID_RE.test(b.customerId)) return res.status(400).json({ error: 'customer_required' });
      const wants = [['meetings.host', 1]];
      if (b.webinar === true) wants.push(['meetings.webinar_mode', 1]);
      if (b.recording === true) wants.push(['meetings.cloud_recording', 1]);
      if (b.breakoutRooms === true) wants.push(['meetings.breakout_rooms', 1]);
      for (const [key, field] of [['meetings.participants', 'maxParticipants'], ['meetings.duration_minutes', 'durationMinutes']]) {
        if (b[field] !== undefined) {
          // Present means valid: text, fractions, zero, negatives, NaN/Infinity and values above the ceiling are all rejected,
          // never defaulted. (`null` counts as present-and-wrong, not as absent.)
          wants.push([key, strictQuantity(b[field], { required: true, max: maxQuantity, name: field })]);
        }
      }
      for (const [feature, quantity] of wants) {
        const d = await service.canAccess(b.customerId, feature, { quantity, actor: 'meet-bridge' });
        if (!d.allowed) return denial(res, d, feature);
      }
      req.meetingCustomerId = b.customerId.toLowerCase();
      return next();
    } catch (err) {
      return respondWithAccessError(res, err);
    }
  };

  /** Join: the participant cap of the meeting's customer (or the free plan for an anonymous meeting). */
  const join = () => async (req, res, next) => {
    try {
      let info;
      try { info = await lookupMeeting(req.params.id); } catch { return respondWithAccessError(res, new Error('lookup failed')); }
      if (!info) return next();                                           // unknown meeting: let Meet answer 404
      const count = Number(info.participantCount);
      // The count comes from Meet's own data; an impossible one is a fault, not a number to trust.
      if (!Number.isSafeInteger(count) || count < 0 || count > maxQuantity) return respondWithAccessError(res, new Error('bad participant count'));
      const customerId = info.customerId && UUID_RE.test(info.customerId) ? info.customerId : null;
      const d = await check(customerId, 'meetings.participants', count + 1);
      if (!d.allowed) return denial(res, d, 'meetings.participants');
      return next();
    } catch (err) {
      return respondWithAccessError(res, err);
    }
  };

  /** Any other feature (recording, webinar, breakout rooms, ...). `customerOf(req)` returns the meeting's customer or null. */
  const feature = (featureKey, { customerOf, quantity = 1 } = {}) => {
    if (typeof customerOf !== 'function') throw new Error('feature() requires customerOf(req)');
    return async (req, res, next) => {
      try {
        const customerId = await customerOf(req);
        const q = typeof quantity === 'function' ? quantity(req) : quantity;
        const d = await check(customerId && UUID_RE.test(customerId) ? customerId : null, featureKey, q);
        if (!d.allowed) return denial(res, d, featureKey);
        return next();
      } catch (err) {
        return respondWithAccessError(res, err);
      }
    };
  };

  return { bridgeCreate, join, feature };
}
