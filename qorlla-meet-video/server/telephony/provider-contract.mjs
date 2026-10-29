// Provider-neutral telecommunications contract. Qorlla does not depend on any one carrier: a provider declares what it CAN do, the service refuses anything it did not declare, and every provider is held to the same
// method contract (and the same ambiguity rules: a failed call is not proof that nothing happened; see number-authority.mjs).
//   internalExtensions - Qorlla-managed identities and extensions (no carrier, no public number)
//   publicNumbers      - public telephone numbers backed by AUTHORIZED carrier inventory
//   pstn               - calls to and from the public telephone network through an authorized interconnection
export const CAPABILITY_NAMES = ['internalExtensions', 'publicNumbers', 'pstn'];
const METHODS = {
  base: ['healthCheck'],
  internalExtensions: ['provisionExtension', 'releaseExtension', 'extensionExists'],
  publicNumbers: ['listAvailableNumbers', 'provisionNumber', 'releaseNumber', 'numberExists', 'findOwnedByE164'],
  pstn: ['startCall', 'endCall', 'fetchCall', 'verifyWebhook', 'parseWebhook']
};

/** What a provider declares. Anything undeclared is false (fail closed). */
export function capabilitiesOf(provider) {
  const c = (provider && provider.capabilities) || {};
  return Object.fromEntries(CAPABILITY_NAMES.map((n) => [n, c[n] === true]));
}

/** Throws a list of problems if the provider claims a capability it does not implement, or implements none of the base contract. Used by the contract tests and at start-up. */
export function assertProviderContract(provider) {
  const problems = [];
  if (!provider || typeof provider.name !== 'string' || !provider.name) problems.push('name');
  if (typeof (provider && provider.configured) !== 'boolean') problems.push('configured');
  const caps = capabilitiesOf(provider);
  for (const m of METHODS.base) if (typeof (provider && provider[m]) !== 'function') problems.push(m);
  for (const n of CAPABILITY_NAMES) if (caps[n]) for (const m of METHODS[n]) if (typeof provider[m] !== 'function') problems.push(n + ':' + m);
  if (caps.pstn && !caps.publicNumbers) problems.push('pstn requires publicNumbers (a call needs an authorized caller ID)');
  if (problems.length) throw Object.assign(new Error('provider contract violated: ' + problems.join(', ')), { code: 'PROVIDER_CONTRACT', problems });
  return caps;
}

export const unsupported = (what) => Object.assign(new Error(what + '_NOT_SUPPORTED'), { code: what + '_NOT_SUPPORTED', status: 503 });
