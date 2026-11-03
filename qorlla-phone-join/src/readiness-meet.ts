import { READINESS_KEYS, type Readiness } from './admission.js';
import { signGatewayToken } from './gateway-auth.js';
import { GATEWAY_AUDIENCE } from './meet-authority.js';

const NOT_READY: Readiness = { carrierConnected: false, inboundNumberCertified: false, gatewayHealthy: false, mediaBridgeCertified: false, billingCertified: false, productionApproved: false };
export type ReadinessConfig = {
  baseUrl: string;
  /** The gateway's workload identity; it needs the `phone.readiness` scope in Meet. */
  auth: { privateKeyPem: string; issuer: string; subject: string; kid?: string; audience?: string; cnfThumbprint?: string };
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Evidence older than this is not evidence (default 10 s). */
  maxAgeMs?: number;
  /** How long one answer may be reused (default 2 s). */
  cacheMs?: number;
  now?: () => number;
};
/**
 * The six readiness conditions from Meet, which computes them from stored, FRESH evidence (carrier health and signed webhook, certified dial-in numbers, the gateway heartbeat, an installed and certified bridge,
 * reconciled billing, an explicit production approval). This client never invents a value: any failure - network, timeout, a non-200, a malformed or incomplete answer, an answer that is too old, a flag that is not
 * exactly `true` - gives a readiness of all false. It never throws, and it never caches a failure for longer than one request.
 */
export class MeetReadiness {
  private cache: { at: number; value: Readiness } | null = null; lastError: string | null = null;
  constructor(private readonly cfg: ReadinessConfig) { if (!/^https?:\/\//.test(cfg.baseUrl)) throw new Error('ReadinessConfig.baseUrl must be an http(s) URL'); }
  async get(): Promise<Readiness> {
    const now = (this.cfg.now ?? Date.now)(), cacheMs = this.cfg.cacheMs ?? 2000;
    if (this.cache && now - this.cache.at >= 0 && now - this.cache.at < cacheMs) return this.cache.value;
    try {
      const a = this.cfg.auth, token = signGatewayToken({ privateKeyPem: a.privateKeyPem, kid: a.kid, issuer: a.issuer, subject: a.subject, audience: a.audience ?? GATEWAY_AUDIENCE, cnfThumbprint: a.cnfThumbprint });
      const r = await (this.cfg.fetchImpl ?? fetch)(this.cfg.baseUrl.replace(/\/+$/, '') + '/api/phone/ivr/readiness', { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 3000) });
      if (r.status !== 200) throw new Error('readiness ' + r.status);
      const body: any = await r.json(), at = Date.parse(body?.generatedAt), maxAge = Math.min(this.cfg.maxAgeMs ?? 10_000, Number.isFinite(body?.maxAgeMs) ? Math.max(0, body.maxAgeMs) : Infinity);
      if (!body || typeof body.readiness !== 'object' || body.readiness === null || Array.isArray(body.readiness)) throw new Error('malformed readiness');
      if (!Number.isFinite(at) || now - at > maxAge || at > now + 5000) throw new Error('stale or future readiness');
      const value = Object.fromEntries(READINESS_KEYS.map((k) => [k, body.readiness[k] === true])) as Readiness;
      this.cache = { at: now, value }; this.lastError = null; return value;
    } catch (e) { this.cache = null; this.lastError = (e as Error).message; return { ...NOT_READY }; }
  }
}

/** Meet's directory (bridge secret: a control-plane credential, NOT for the gateway): meeting number -> the Meet meeting and its scheduled-meeting id. One-to-one by construction in Meet; a duplicate is an error here too. */
export class MeetDirectoryClient {
  constructor(private readonly cfg: { baseUrl: string; bridgeSecret: string; fetchImpl?: typeof fetch; timeoutMs?: number }) { if (String(cfg.bridgeSecret).length < 32) throw new Error('bridgeSecret must be at least 32 characters'); }
  async resolve(meetingNumber: string): Promise<{ meetingId: string; sourceId: string | null; locked: boolean; waitingRoom: boolean } | null> {
    const digits = String(meetingNumber).replace(/\D/g, ''); if (!/^\d{11}$/.test(digits)) return null;
    const r = await (this.cfg.fetchImpl ?? fetch)(this.cfg.baseUrl.replace(/\/+$/, '') + '/api/integrations/phone/meetings/' + digits, { headers: { 'x-qorlla-bridge-secret': this.cfg.bridgeSecret }, signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 3000) });
    if (r.status === 404) return null; if (r.status !== 200) throw new Error('directory ' + r.status);
    const b: any = await r.json();
    if (typeof b?.meetingId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(b.meetingId) || (b.sourceId !== null && (typeof b.sourceId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(b.sourceId)))) throw new Error('malformed directory answer');
    return { meetingId: b.meetingId.toLowerCase(), sourceId: b.sourceId, locked: b.locked === true, waitingRoom: b.waitingRoom === true };
  }
}
