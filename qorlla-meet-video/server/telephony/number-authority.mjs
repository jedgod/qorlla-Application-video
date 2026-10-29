// Rules shared by the Numbers & Plans service. A carrier error is NOT proof that an operation did not happen.
/** 'failed' only when the carrier answered with an explicit refusal (4xx other than 404/408). 404 on a release means the number is already gone (confirmed). Everything else -
 *  timeouts, unreachable carrier, 5xx, malformed answers, 408 - is 'uncertain': the number stays locked until reconcile() asks the carrier. */
export function classifyProviderError(e, kind) {
  const s = e && e.providerStatus;
  if (kind === 'release' && s === 404) return 'confirmed';
  if (Number.isInteger(s) && s >= 400 && s < 500 && s !== 404 && s !== 408) return 'failed';
  return 'uncertain';
}
export const nextBackoffSeconds = (attempts) => Math.min(300, 2 ** Math.min(attempts, 8));
