/**
 * Typed errors.
 *
 * Every error carries a stable `code` and an HTTP `statusCode`. Messages never include
 * secrets, SQL text or another tenant's data.
 */

export class SubscriptionError extends Error {
  constructor(message, code, details = {}, statusCode = 403) {
    super(message);
    this.name = 'SubscriptionError';
    this.code = code;
    this.details = details;
    this.statusCode = statusCode;
  }
}

export class FeatureNotAvailableError extends SubscriptionError {
  constructor(featureKey, plan, requiredPlan) {
    super(
      `Feature '${featureKey}' is not available on the ${plan} plan`,
      'feature_not_available',
      { feature: featureKey, plan, required_plan: requiredPlan }
    );
  }
}

export class LimitExceededError extends SubscriptionError {
  constructor(featureKey, plan, limit, used, requested) {
    super(
      `Limit exceeded for '${featureKey}'`,
      'limit_exceeded',
      { feature: featureKey, plan, limit, used, requested, remaining: Math.max(0, (limit || 0) - used) }
    );
  }
}

export class SubscriptionInactiveError extends SubscriptionError {
  constructor(status, reason) {
    super(
      `Subscription is not entitled (status: ${status}${reason ? ', ' + reason : ''})`,
      'subscription_inactive',
      { status, reason },
      402
    );
  }
}

export class OperationalGateError extends SubscriptionError {
  constructor(featureKey) {
    super(
      `'${featureKey}' is entitled but the operational capability is not enabled`,
      'operational_gate_off',
      { feature: featureKey },
      403
    );
  }
}

export class CustomerContextMissingError extends SubscriptionError {
  constructor() {
    super('Authenticated customer context is required', 'customer_context_required', {}, 401);
  }
}

/** The customer id from the authenticated context is not a UUID: a server-side bug, never a client choice. */
export class InvalidCustomerError extends SubscriptionError {
  constructor() {
    super('Authenticated customer context is invalid', 'customer_context_invalid', {}, 401);
  }
}

export class InvalidOverrideError extends SubscriptionError {
  constructor(message, details) {
    super(message, 'invalid_override', details, 400);
  }
}

export class InvalidQuantityError extends SubscriptionError {
  constructor() {
    super('quantity must be a positive safe integer', 'invalid_quantity', {}, 400);
  }
}

export class QuantityRequiredError extends SubscriptionError {
  constructor(name = 'quantity') {
    super(`${name} is required`, 'quantity_required', { field: name }, 400);
  }
}

export class QuantityTooLargeError extends SubscriptionError {
  constructor(name = 'quantity', max) {
    super(`${name} exceeds the permitted maximum`, 'quantity_too_large', { field: name, max }, 400);
  }
}

export class IdempotencyConflictError extends SubscriptionError {
  constructor() {
    super('The idempotency key was already used with a different request', 'idempotency_key_conflict', {}, 409);
  }
}

export class NotAuthorizedError extends SubscriptionError {
  constructor(message = 'Not authorized for this administrative action') {
    super(message, 'not_authorized', {}, 403);
  }
}

/** The access decision could not be made (database/audit failure). Callers must treat this as DENIED. */
export class AccessUnavailableError extends SubscriptionError {
  constructor(cause) {
    super('Access could not be verified; denied', 'access_unavailable', {}, 503);
    this.cause = cause;
  }
}

export class BillingSignatureError extends SubscriptionError {
  constructor(reason = 'invalid_signature') {
    super('Webhook signature verification failed', 'webhook_signature_invalid', { reason }, 401);
  }
}

export class BillingEventError extends SubscriptionError {
  constructor(message, code = 'webhook_event_invalid') {
    super(message, code, {}, 400);
  }
}
