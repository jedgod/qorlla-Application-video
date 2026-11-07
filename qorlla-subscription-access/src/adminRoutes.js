/**
 * The internal administration API, in one table used by BOTH the server (to register handlers) and the web-tier client (to sign and
 * call), so a route and the action id inside its signed assertion can never drift apart.
 *   stepup: a fresh, single-use step-up grant for exactly this action must exist (spent by the call)
 *   staff:  the caller must be CURRENT platform staff with the right role and customer scope (read live from the database)
 *   cid:    where the customer id comes from; the assertion MUST have been minted for that same customer
 */
export const ROUTES = Object.freeze({
  registerBegin:   { method: 'POST',   path: '/v1/stepup/passkey/register/begin',  act: 'stepup.register.begin' },
  registerFinish:  { method: 'POST',   path: '/v1/stepup/passkey/register/finish', act: 'stepup.register.finish' },
  assertBegin:     { method: 'POST',   path: '/v1/stepup/passkey/assert/begin',    act: 'stepup.assert.begin' },
  assertFinish:    { method: 'POST',   path: '/v1/stepup/passkey/assert/finish',   act: 'stepup.assert.finish' },
  totpBegin:       { method: 'POST',   path: '/v1/stepup/totp/begin',              act: 'stepup.totp.begin' },
  totpConfirm:     { method: 'POST',   path: '/v1/stepup/totp/confirm',            act: 'stepup.totp.confirm' },
  totpVerify:      { method: 'POST',   path: '/v1/stepup/totp/verify',             act: 'stepup.totp.verify' },
  sessionRevoke:   { method: 'POST',   path: '/v1/session/revoke',                 act: 'session.revoke' },
  orgCreate:       { method: 'POST',   path: '/v1/orgs',                           act: 'org.create' },
  memberAdd:       { method: 'POST',   path: '/v1/orgs/:cid/members',              act: 'member.add',       cid: 'params' },
  memberSetRole:   { method: 'PUT',    path: '/v1/orgs/:cid/members/:uid/role',    act: 'member.set_role',  cid: 'params', stepup: true },
  memberRemove:    { method: 'DELETE', path: '/v1/orgs/:cid/members/:uid',         act: 'member.remove',    cid: 'params' },
  orgStatus:       { method: 'PUT',    path: '/v1/orgs/:cid/status',               act: 'customer.status',  cid: 'params', stepup: true, staff: true },
  overrideSet:     { method: 'PUT',    path: '/v1/billing/:cid/overrides/:feature', act: 'override.set',    cid: 'params', stepup: true, staff: true },
  overrideRemove:  { method: 'DELETE', path: '/v1/billing/:cid/overrides/:feature', act: 'override.remove', cid: 'params', stepup: true, staff: true },
  billingLink:     { method: 'POST',   path: '/v1/billing/links',                  act: 'billing.link',     cid: 'body.customerId', stepup: true, staff: true },
});

export const fillPath = (route, params = {}) => route.path.replace(/:([a-z]+)/g, (_, k) => {
  if (params[k] === undefined) throw new Error(`missing path parameter ${k}`);
  return encodeURIComponent(params[k]);
});
