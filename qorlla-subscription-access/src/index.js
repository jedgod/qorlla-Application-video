/**
 * Public API
 *   createSubscriptionAccess()  request path (AccessService + middleware)       role: qorlla_sub_runtime
 *   AdminService                overrides, customer linking (MFA + authorize)   role: qorlla_sub_admin
 *   BillingProcessor            provider-neutral webhook inbox/outbox           role: qorlla_sub_billing
 *   migrate / seedCatalog       run as the migrator
 */

export * from './plans.js';
export * from './errors.js';
export * from './cache.js';
export { evaluateLifecycle, periodBounds, utcDay, utcMonth, ALL_STATUSES, ACTIVE_STATUSES } from './lifecycle.js';
export { decide, resolveFor } from './decision.js';
export { AccessService, createAccessService, validOverrideValue } from './accessService.js';
export { AdminService } from './admin.js';
export { BillingProcessor } from './billing.js';
export { Directory, DirectoryAdmin, ROLES } from './directory.js';
export { createIdentity } from './identity.js';
export { createStaff } from './staff.js';
export { createMeetGuard } from './meetGuard.js';
export { createSignedJsonAdapter, validateEvent, EVENT_TYPES, ENTITLEMENT_TYPES } from './billingAdapters.js';
export { migrate } from './migrate.js';
export { seedCatalog, verifyCatalog } from './seed.js';
export { requireFeature, loadSubscription, createMiddleware, respondWithAccessError } from './middleware.js';

import { AccessService } from './accessService.js';
import { createMiddleware } from './middleware.js';

export function createSubscriptionAccess(opts = {}) {
  const service = new AccessService(opts);
  const middleware = createMiddleware(service, opts);
  return { service, middleware };
}

export default createSubscriptionAccess;
