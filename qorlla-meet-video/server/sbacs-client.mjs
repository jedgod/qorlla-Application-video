// Client for the portal's internal entitlement API (SBACS). One instance per SERVICE IDENTITY (meet, storage, ...): each holds only its own Ed25519 private key.
// Every call carries a freshly signed, short-lived token { iss: qorlla-<service>, sub, aud, iat, exp<=5min, jti }; the portal holds public keys only.
//
// Modes (SBACS_MODE):
//   off      no call is made and nothing is ever refused (the default: existing behaviour is untouched)
//   shadow   every call is made and the outcome logged, but nothing is ever refused (to compare before enforcing)
//   enforce  a refusal is final; and if the entitlement service cannot be reached (timeout, 5xx, bad credential, open circuit, malformed answer) a NEW protected
//            operation FAILS CLOSED - kind 'unavailable', which callers turn into a retryable 503, never into permission.
// A circuit breaker stops hammering a service that is down: after `breakerFailures` consecutive failures it answers 'unavailable' at once for `breakerOpenMs`,
// then lets one probe through.
//
// Result shape: { ok: true, ... } | { ok: false, kind: 'denied' | 'quota' | 'unavailable' | 'invalid', reason, status, upgradeAvailable }
import crypto from 'node:crypto';

export const AUDIENCE = 'qorlla-sbacs';
const b64 = (b) => Buffer.from(b).toString('base64url');

export function mintToken({ service, privateKey, audience = AUDIENCE, issuer = 'qorlla-' + service, ttlSec = 120, now = Date.now(), jti = crypto.randomUUID() }) {
  const iat = Math.floor(now / 1000), body = b64(JSON.stringify({ iss: issuer, sub: service, aud: audience, iat, exp: iat + ttlSec, jti }));
  return 'qsv2.' + body + '.' + b64(crypto.sign(null, Buffer.from('qsv2.' + body), privateKey));
}

export function createSbacsClient({ mode = 'off', baseUrl = '', service, privateKeyPem = '', audience = AUDIENCE, ttlSec = 120, timeoutMs = 2500, breakerFailures = 5, breakerOpenMs = 10_000, fetchImpl = fetch, now = () => Date.now(), log = () => {} } = {}) {
  if (!['off', 'shadow', 'enforce'].includes(mode)) throw new Error('SBACS_MODE must be off, shadow or enforce');
  let key = null;
  if (mode !== 'off') {
    if (!service) throw new Error('SBACS client needs a service identity');
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('SBACS_URL must be the portal base URL');
    try { key = crypto.createPrivateKey(privateKeyPem); } catch { throw new Error(`SBACS ${service} private key is missing or unreadable`); }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error(`SBACS ${service} key must be Ed25519`);
  }
  let failures = 0, openUntil = 0;
  const unavailable = (reason, status = 0) => ({ ok: false, kind: 'unavailable', reason, status });

  async function post(op, body) {
    if (now() < openUntil) return unavailable('circuit_open');
    let res, json;
    try {
      res = await fetchImpl(baseUrl.replace(/\/+$/, '') + '/internal/v1/entitlements/' + op, {
        method: 'POST', headers: { authorization: 'Bearer ' + mintToken({ service, privateKey: key, audience, ttlSec, now: now() }), 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)
      });
      json = await res.json().catch(() => null);
    } catch (e) { return tripped(unavailable(e.name === 'TimeoutError' ? 'timeout' : 'unreachable')); }
    // 5xx / 429: the service is struggling. 404: our credential is not accepted (misconfiguration or rotation) - to us that is "unavailable", and it is logged loudly.
    if (res.status >= 500 || res.status === 429) return tripped(unavailable('service_error', res.status));
    if (res.status === 404 || res.status === 401) { log('error', 'sbacs.credential_rejected', { service, op }); return tripped(unavailable('credential_rejected', res.status)); }
    if (!json || typeof json !== 'object') return tripped(unavailable('malformed_answer', res.status));
    failures = 0; return { status: res.status, json };
  }
  function tripped(r) { if (++failures >= breakerFailures) { openUntil = now() + breakerOpenMs; log('error', 'sbacs.circuit_open', { service, failures }); } return r; }

  const isUnavailable = (r) => r && r.ok === false && r.kind === 'unavailable';
  function mapDecision({ status, json }) {
    if (status === 400) return { ok: false, kind: 'invalid', reason: json.reason || json.error || 'bad_request', status };
    if (json.allowed === true || (json.ok === true && status === 200)) return { ok: true, ...json, status };
    const reason = json.reason || json.error || 'denied';
    return { ok: false, kind: reason === 'quota_exhausted' ? 'quota' : 'denied', reason, upgradeAvailable: !!json.upgradeAvailable, status };
  }

  /** Runs `op`; applies the mode. `settling` operations (finalize/release/record) report truthfully in every mode: they are bookkeeping for work already done. */
  async function run(op, body, { settling = false } = {}) {
    if (mode === 'off') return { ok: true, skipped: 'off' };
    const r = await post(op, body); const out = isUnavailable(r) ? r : mapDecision(r);
    if (mode === 'shadow' && !settling) { log('info', 'sbacs.shadow', { service, op, feature: body.feature, ok: out.ok, kind: out.kind, reason: out.reason }); return { ok: true, shadow: out }; }
    return out;
  }
  return {
    mode, service, active: mode !== 'off',
    check: ({ accountId, feature, workspaceId }) => run('check', { accountId, feature, ...(workspaceId ? { workspaceId } : {}) }),
    reserve: ({ accountId, feature, units = 1, idempotencyKey, workspaceId, ttlMs }) => run('reserve', { accountId, feature, units, idempotencyKey, ...(workspaceId ? { workspaceId } : {}), ...(ttlMs ? { ttlMs } : {}) }),
    record: ({ accountId, feature, units = 1, idempotencyKey, workspaceId }) => run('record', { accountId, feature, units, idempotencyKey, ...(workspaceId ? { workspaceId } : {}) }, { settling: true }),
    finalize: ({ accountId, reservationId }) => run('finalize', { accountId, reservationId }, { settling: true }),
    release: ({ accountId, reservationId }) => run('release', { accountId, reservationId }, { settling: true }),
    breaker: () => ({ failures, open: now() < openUntil })
  };
}
