// QorllaInternalProvider: the provider for Qorlla's OWN numbering system: identities and extensions, fully managed by Qorlla's Voice Engine. No carrier, no Twilio account, no public telephone numbers, no PSTN.
// It talks to the engine with a SHORT-LIVED WORKLOAD CREDENTIAL (scope voice.admin), never a shared secret. Public numbers and PSTN are explicitly NOT supported: asking for them fails closed.
import { signWorkloadJwt } from './number-sync.mjs';
import { transportFromEnv } from './workload-transport.mjs';
import { unsupported } from './provider-contract.mjs';

export class QorllaInternalProvider {         // duck-typed against provider-contract.mjs (it does not extend the carrier base class: it is not a carrier)
  /** tokenProvider: () => workload JWT (audience qorlla-shield, scope voice.admin on the engine). */
  constructor({ engineUrl, tokenProvider, fetchImpl = fetch, timeoutMs = 5000 }) {
    if (!/^https?:\/\//.test(String(engineUrl || ''))) throw new Error('QORLLA_ENGINE_URL is required');
    if (typeof tokenProvider !== 'function') throw new Error('a workload token provider is required');
    this.base = String(engineUrl).replace(/\/+$/, ''); this.token = tokenProvider; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  get name() { return 'qorlla-internal'; }
  get configured() { return true; }
  get capabilities() { return { internalExtensions: true, publicNumbers: false, pstn: false }; }
  async #call(method, path, body) {
    const r = await this.fetch(this.base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + await this.token() }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    const data = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(data.error || 'engine_' + r.status), { code: data.error || 'ENGINE_REFUSED', providerStatus: r.status, status: 502 }); return data;
  }
  async healthCheck() {
    try { const r = await this.fetch(this.base + '/readyz', { signal: AbortSignal.timeout(this.timeoutMs) }); const d = await r.json().catch(() => ({})); return { ok: r.ok && d.ok === true, detail: r.ok ? 'Voice Engine is ready.' : 'Voice Engine answered HTTP ' + r.status }; }
    catch { return { ok: false, detail: 'The Voice Engine could not be reached.' }; }
  }
  /** Idempotent: an account always gets the same extension back. */
  async provisionExtension(accountId) { const d = await this.#call('POST', '/v1/voice/admin/identities', { accountId }); return { accountId, extension: d.identity.extension, created: !!d.created, enabled: d.identity.enabled }; }
  /** "Release" for an internal identity = disable it: its live calls end and its sockets close (the extension is never reused for someone else). */
  async releaseExtension(accountId) { const d = await this.#call('POST', '/v1/voice/admin/identities/' + encodeURIComponent(accountId) + '/enabled', { enabled: false }); return { accountId, released: true, endedCalls: d.endedCalls }; }
  async extensionExists(accountId) { const d = await this.#call('GET', '/v1/voice/admin/identities?ids=' + encodeURIComponent(accountId)); const i = (d.identities || []).find((x) => x.account_id === accountId); return { exists: !!i, enabled: !!(i && i.enabled), extension: i ? i.extension : null }; }
  // public numbers and PSTN: not this provider's job; refuse explicitly
  async listAvailableNumbers() { return []; }
  async provisionNumber() { throw unsupported('PUBLIC_NUMBERS'); }
  async releaseNumber() { throw unsupported('PUBLIC_NUMBERS'); }
  async numberExists() { throw unsupported('PUBLIC_NUMBERS'); }
  async findOwnedByE164() { throw unsupported('PUBLIC_NUMBERS'); }
  async startCall() { throw unsupported('PSTN'); }
  async endCall() { throw unsupported('PSTN'); }
  async fetchCall() { throw unsupported('PSTN'); }
  verifyWebhook() { return false; }
  parseWebhook() { throw unsupported('PSTN'); }
}

/** Builds the provider from configuration (PHONE_CARRIER=internal). The workload key is the same kind of credential the other Qorlla services use. */
export function createInternalProvider(env = process.env, { fetchImpl } = {}) {
  const url = env.QORLLA_ENGINE_URL || env.VOICE_INTERNAL_URL, pem = String(env.PHONE_ENGINE_SYNC_KEY_PEM || '').replace(/\\n/g, '\n'), issuer = env.PHONE_ENGINE_SYNC_ISSUER;
  if (!url || !pem || !issuer) return null;
  const t = transportFromEnv(env);
  return new QorllaInternalProvider({ engineUrl: url, fetchImpl: fetchImpl || (t && t.fetchImpl) || fetch, tokenProvider: () => signWorkloadJwt({ privateKeyPem: pem, kid: env.PHONE_ENGINE_SYNC_KID || 'w1', issuer, subject: env.PHONE_ENGINE_SYNC_SUBJECT || 'svc:numbers-plans', cnfThumbprint: t ? t.thumbprint : undefined }) });
}
