/**
 * Express middleware.
 * Customer identity MUST come from authenticated context (req.auth / req.actor / req.user, set by upstream code that has
 * verified the session). Query-string, route-param, body and header sources are never consulted.
 * Any failure to reach a decision DENIES the request (503), it never lets it through.
 */

import { CustomerContextMissingError, SubscriptionError } from './errors.js';
import { strictQuantity, DEFAULT_MAX_QUANTITY } from './validate.js';

function extractCustomerId(req, options = {}) {
  if (typeof options.customerId === 'function') return options.customerId(req);
  if (options.customerId) return options.customerId;
  return req.auth?.customer_id || req.actor?.customer_id || req.user?.customer_id || null;
}

/** Turns any error into a safe response. Unknown errors are "access unavailable", never a pass. */
function fail(res, err) {
  if (err instanceof SubscriptionError) {
    return res.status(err.statusCode).json({ error: err.code, message: err.message });
  }
  console.error('[subscription-access] middleware failed closed:', err?.message);
  return res.status(503).json({ error: 'access_unavailable', message: 'Access could not be verified; denied' });
}

const DENIAL_STATUS = { subscription_inactive: 402 };

/**
 * requireFeature('meetings.cloud_recording', { service })
 * requireFeature('meetings.participants', { service, quantity: (req) => Number(req.body.max_participants) })
 *
 * An ADMISSION check. It does not hold quota: metered operations use reserve()/commitReservation().
 */
export function requireFeature(featureKey, options = {}) {
  const service = options.service;
  if (!service) throw new Error('requireFeature: options.service is required');

  return async (req, res, next) => {
    try {
      const customerId = extractCustomerId(req, options);
      if (!customerId) return fail(res, new CustomerContextMissingError());

      // The count is validated BEFORE any entitlement or quota check, with no fallback: a count function that yields nothing,
      // text, a fraction, zero, a negative, NaN/Infinity or something above the ceiling is a 400. A route with no quantity
      // semantics (a plain feature flag) passes no `quantity` option and is checked for 1.
      const max = options.maxQuantity ?? service.maxQuantity ?? DEFAULT_MAX_QUANTITY;
      const quantity = typeof options.quantity === 'function'
        ? strictQuantity(options.quantity(req), { required: options.quantityRequired !== false, max, name: featureKey })
        : strictQuantity(options.quantity === undefined ? 1 : options.quantity, { max, name: featureKey });

      const decision = await service.canAccess(customerId, featureKey, {
        quantity,
        requestId: req.id || req.headers?.['x-request-id'],
        actor: req.auth?.user_id || req.actor?.id,
      });

      req.subscription = { customerId, plan: decision.plan, status: decision.status, decision };
      // The exact number that was checked. Handlers must use THIS value, never re-read the raw request.
      req.validated = { ...(req.validated || {}), [featureKey]: quantity };
      if (decision.allowed) return next();

      return res.status(DENIAL_STATUS[decision.reason] || 403).json({
        error: 'subscription_required',
        code: decision.reason,
        feature: featureKey,
        plan: decision.plan,
        required_plan: decision.required_plan,
        limit: decision.limit,
        used: decision.used,
        reserved: decision.reserved,
        remaining: decision.remaining,
        lifecycle_reason: decision.lifecycle_reason,
        upgrade_url: options.upgradeUrl || '/pricing',
      });
    } catch (err) {
      return fail(res, err);
    }
  };
}

/** Context loader: attaches the entitlement snapshot, performs no feature check. */
export function loadSubscription(options = {}) {
  const service = options.service;
  if (!service) throw new Error('loadSubscription: options.service is required');

  return async (req, res, next) => {
    try {
      const customerId = extractCustomerId(req, options);
      if (!customerId) return fail(res, new CustomerContextMissingError());
      const sub = await service.getSubscription(customerId);
      const features = await service.getResolvedEntitlements(customerId);
      req.subscription = { customerId, plan: features.__plan, status: features.__status, entitled: features.__entitled, subscription: sub, features };
      return next();
    } catch (err) {
      return fail(res, err);
    }
  };
}

export function createMiddleware(service, defaults = {}) {
  const customer = (req) => {
    const id = extractCustomerId(req, defaults);
    if (!id) throw new CustomerContextMissingError();
    return id;
  };
  return {
    requireFeature: (featureKey, opts = {}) => requireFeature(featureKey, { service, ...defaults, ...opts }),
    loadSubscription: (opts = {}) => loadSubscription({ service, ...defaults, ...opts }),

    // Reservation helpers: always scoped to the authenticated customer, never to a reservation id alone.
    reserve: (req, featureKey, quantity = 1, extra = {}) => service.reserve(customer(req), featureKey, quantity, extra),
    commitReservation: (req, reservationId, extra = {}) => service.commitReservation(reservationId, { ...extra, customerId: customer(req) }),
    releaseReservation: (req, reservationId) => service.releaseReservation(reservationId, { customerId: customer(req) }),
    renewReservation: (req, reservationId, extra = {}) => service.renewReservation(reservationId, { ...extra, customerId: customer(req) }),
  };
}

/** Shared error responder for route handlers that call the helpers above directly. */
export { fail as respondWithAccessError };
