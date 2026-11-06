import { normalizeMeetingCode } from './meeting-code.js';
import crypto from 'node:crypto';
import type { MeetingAuthority, MeetingDecision, StepOptions, VerifyOptions } from './admission.js';
import { signGatewayToken } from './gateway-auth.js';
import type { AudioEvidence } from './media-contract.js';

/**
 * MeetingAuthority backed by the REAL Qorlla Meet (branch feature/qorlla-meet-telephone-admission-meet: lifecycle v4.24). Meet stays the authority for meetings, PINs, the waiting room, host approval, locks, bans,
 * per-caller attempt limits, the Security Shield and - above all - for whether a caller is CONNECTED. This adapter only calls Meet's phone gateway routes:
 *
 *   POST /api/phone/ivr/verify             { eventId, callId, from, meetingId, pin } -> approved | waiting | denied | locked   (NEVER connected: a PIN is not audio)
 *   GET  /api/phone/ivr/calls/:ref/decision?waitMs=   durable, bounded long-poll for the host's decision; hands over the media token once   (workload identity)
 *   POST /api/phone/ivr/status             { callId }  the same, by call id, for the test-double / carrier scheme
 *   POST /api/phone/ivr/media              { eventId, callId, mediaToken, evidence } -> connected | connecting | terminate  (Meet judges the evidence itself)
 *   POST /api/phone/ivr/disconnect         { eventId, callId, type }
 *   POST /api/phone/ivr/gateway-health     { instance, healthy }   heartbeat, the evidence behind "gatewayHealthy"
 *
 * Authentication is one of Meet's two existing schemes (not a new one):
 *   workload  - the ES256 workload token with the gateway's OWN audience ('qorlla-phone-gateway'), identity and scopes (production).
 *   hmac      - the provider's signature `t=<unix>,v1=<HMAC-SHA256 of "<t>.<raw body>">` (the test double / carrier path).
 * The meeting session id handed to the admission is `<meetingUuid>.<callRef>`, so every later step can be derived on ANY gateway replica.
 */
export type MeetAuth =
  | { kind: 'hmac'; secret: string }
  | { kind: 'workload'; privateKeyPem: string; issuer: string; subject: string; kid?: string; audience?: string; cnfThumbprint?: string };
export type MeetConfig = {
  baseUrl: string;
  auth: MeetAuth;
  /** For mutual TLS: a fetch over an https agent with the gateway's client certificate (see Meet's workload-transport). */
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  /** One long-poll for the host's decision waits at most this long (default 15 s, Meet caps it at 20 s). The admission's own host timeout bounds the total. */
  decisionWaitMs?: number;
  /** Polling interval for the hmac scheme, which has no long-poll (default 1 s). */
  pollMs?: number;
};
export const GATEWAY_AUDIENCE = 'qorlla-phone-gateway';
/** Meet accepts event ids of 8-120 characters from [A-Za-z0-9_.:-]; a hash keeps them valid and stable for any call id. */
const eventId = (kind: string, callId: string) => kind + '-' + crypto.createHash('sha256').update(callId).digest('hex').slice(0, 40);
export const sessionId = (meetingUuid: string, callRef: string) => meetingUuid + '.' + callRef;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export function parseSession(id: string): { meetingUuid: string; callRef: string } | null {
  const m = new RegExp('^(' + UUID + ')\\.(' + UUID + ')$', 'i').exec(String(id || '')); return m ? { meetingUuid: m[1].toLowerCase(), callRef: m[2].toLowerCase() } : null;
}
/** Meet's provider signature, byte for byte (phone.mjs createProvider().sign). */
export const signMeetRequest = (rawBody: string, secret: string, t: number = Math.floor(Date.now() / 1000)) => 't=' + t + ',v1=' + crypto.createHmac('sha256', secret).update(t + '.' + rawBody).digest('hex');
export type MediaReply = { result: string; action?: string; state?: string; refreshed?: boolean };

export class MeetPhoneAuthority implements MeetingAuthority {
  private readonly f: typeof fetch; private readonly timeoutMs: number; private readonly waitMs: number; private readonly pollMs: number;
  constructor(private readonly cfg: MeetConfig) {
    if (!/^https?:\/\//.test(cfg.baseUrl)) throw new Error('MeetConfig.baseUrl must be an http(s) URL');
    if (cfg.auth.kind === 'hmac' && String(cfg.auth.secret).length < 16) throw new Error('the hmac secret must be at least 16 characters');
    if (cfg.auth.kind === 'workload' && (!cfg.auth.privateKeyPem || !cfg.auth.issuer || !cfg.auth.subject)) throw new Error('workload authentication needs privateKeyPem, issuer and subject');
    this.f = cfg.fetchImpl ?? fetch; this.timeoutMs = cfg.requestTimeoutMs ?? 5000; this.waitMs = Math.min(20000, cfg.decisionWaitMs ?? 15000); this.pollMs = cfg.pollMs ?? 1000;
  }
  private url(p: string) { return this.cfg.baseUrl.replace(/\/+$/, '') + p; }
  private signal(opts?: StepOptions, extraMs = 0) { const t = AbortSignal.timeout(this.timeoutMs + extraMs); return opts?.signal ? AbortSignal.any([t, opts.signal]) : t; }
  private headers(raw: string | null): Record<string, string> {
    const a = this.cfg.auth;
    if (a.kind === 'hmac') return raw === null ? {} : { 'content-type': 'application/json', 'x-qorlla-signature': signMeetRequest(raw, a.secret) };
    return { ...(raw === null ? {} : { 'content-type': 'application/json' }), authorization: 'Bearer ' + signGatewayToken({ privateKeyPem: a.privateKeyPem, kid: a.kid, issuer: a.issuer, subject: a.subject, audience: a.audience ?? GATEWAY_AUDIENCE, cnfThumbprint: a.cnfThumbprint, ...(raw === null ? {} : { body: raw }) }) };
  }
  private async post(path: string, body: object, opts?: StepOptions): Promise<{ status: number; data: any }> {
    const raw = JSON.stringify(body); const r = await this.f(this.url(path), { method: 'POST', headers: this.headers(raw), body: raw, signal: this.signal(opts) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }
  private async get(path: string, opts?: StepOptions, extraMs = 0): Promise<{ status: number; data: any }> {
    const r = await this.f(this.url(path), { headers: this.headers(null), signal: this.signal(opts, extraMs) }); return { status: r.status, data: await r.json().catch(() => ({})) };
  }

  async verifyPhoneJoin(meetingNumber: string, passcode: string, opts?: VerifyOptions): Promise<MeetingDecision> {
    const digits = normalizeMeetingCode(meetingNumber), no: MeetingDecision = { allowed: false, requiresHostApproval: false };
    // Meet's PIN is 4-12 digits and the meeting code 11 (the main app's ID) or 12 digits (Meet's own): anything else cannot be right, and is refused without spending an attempt in Meet
    if (!digits || !/^\d{4,12}$/.test(passcode) || !opts?.callId || opts.callId.length > 120 || !opts.callerNumber) return no;      // Meet stores the first 120 characters of a call id: a longer one could not be found again
    const { status, data } = await this.post('/api/phone/ivr/verify', { eventId: eventId('gw', opts.callId), callId: opts.callId, from: opts.callerNumber, meetingId: digits, pin: passcode }, opts);
    if (status !== 200 || typeof data?.result !== 'string') throw new Error('meet refused the verification request (' + status + ')');            // includes 503 "not enabled / not ready" and 401: never read as "allowed"
    const callRef = typeof data.callRef === 'string' ? data.callRef.toLowerCase() : '', meetingId = typeof data.meetingId === 'string' ? data.meetingId.toLowerCase() : '';
    if (data.result === 'connected') { await this.cancelByCall(opts.callId).catch(() => undefined); throw new Error('meet reported a caller connected before any media was verified: this Meet predates the telephone lifecycle'); }
    if (data.result === 'approved' || data.result === 'waiting') {
      const session = parseSession(meetingId + '.' + callRef);
      if (!session) { await this.cancelByCall(opts.callId).catch(() => undefined); throw new Error('meet admitted the call but did not identify it'); }                  // do not leave a ghost participant
      return { allowed: true, requiresHostApproval: data.result === 'waiting', meetingSessionId: sessionId(session.meetingUuid, session.callRef), ...(data.result === 'approved' && typeof data.mediaToken === 'string' ? { mediaToken: data.mediaToken } : {}) };
    }
    return no;                                                                                                                                       // denied / locked / anything else
  }

  /** The host's decision, from Meet's durable record. Approved only when Meet says so; refused, timed out, cancelled or vanished is a refusal. */
  async requestHostApproval(session: string, callId: string, opts?: StepOptions): Promise<{ approved: boolean; mediaToken?: string }> {
    const s = parseSession(session); if (!s) return { approved: false };
    for (;;) {
      if (opts?.signal.aborted) throw new Error('aborted');
      const r = this.cfg.auth.kind === 'workload'
        ? await this.get('/api/phone/ivr/calls/' + s.callRef + '/decision?waitMs=' + this.waitMs, opts, this.waitMs)
        : await this.post('/api/phone/ivr/status', { callId }, opts);
      if (r.status === 404) return { approved: false }; if (r.status !== 200) throw new Error('decision ' + r.status);
      const d = r.data?.decision; if (d === 'approved') return { approved: true, ...(typeof r.data.mediaToken === 'string' ? { mediaToken: r.data.mediaToken } : {}) };
      if (d !== 'pending') return { approved: false };
      if (this.cfg.auth.kind !== 'workload') await new Promise<void>((resolve, reject) => { const t = setTimeout(resolve, this.pollMs); opts?.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true }); });
    }
  }

  /** Reports what the media is doing. Meet decides; only `result: 'connected'` means a person can be heard. `action: 'terminate'` means Meet does not want this leg: tear it down. */
  async reportMedia(callId: string, mediaToken: string, evidence: AudioEvidence | null, opts?: StepOptions & { peerJti?: string }): Promise<MediaReply> {
    const { status, data } = await this.post('/api/phone/ivr/media', { eventId: 'ev-' + crypto.randomUUID(), callId, mediaToken, ...(opts?.peerJti ? { peerJti: opts.peerJti } : {}), evidence: evidence ? { ...evidence, source: 'rtp' } : null }, opts);
    if (status !== 200 || typeof data?.result !== 'string') throw new Error('meet refused the media report (' + status + ')'); return data as MediaReply;
  }

  /**
   * The restricted verification-phase credential: a short-lived (<= 60 s), SINGLE-USE token Meet issues only after the PIN, the host and the Security Shield have said yes, and only to the gateway that holds the call's
   * one-time media token. It lets this gateway's WebRTC peer negotiate media over Meet's signalling and NOTHING else. Anything but an explicit `issued` answer is a refusal.
   */
  async requestPeerCredential(callId: string, mediaToken: string, opts?: StepOptions): Promise<{ credential: string; jti: string; expiresAt: number; ttlSeconds: number }> {
    const { status, data } = await this.post('/api/phone/ivr/peer-credential', { callId, mediaToken }, opts);
    if (status !== 200 || data?.result !== 'issued' || typeof data.credential !== 'string' || typeof data.jti !== 'string') throw new Error('meet did not issue a verification credential (' + status + (typeof data?.result === 'string' ? ' ' + data.result : '') + ')');
    return { credential: data.credential, jti: data.jti, expiresAt: Number(data.expiresAt) || 0, ttlSeconds: Number(data.ttlSeconds) || 0 };
  }

  /**
   * Where Meet says the call stands, for reconciliation (A5.5 liveness): `over` (refused, timed out, cancelled, ended), `live` (pending or approved, including connected), or `unknown` (Meet does not know the call, or
   * could not be asked). Nothing is inferred from silence: only an explicit answer is `over`/`live`.
   */
  async callState(session: string, callId: string, opts?: StepOptions): Promise<'live' | 'over' | 'unknown'> {
    const s = parseSession(session); try {
      const r = this.cfg.auth.kind === 'workload' ? (s ? await this.get('/api/phone/ivr/calls/' + s.callRef + '/decision?waitMs=0', opts) : { status: 404, data: {} }) : await this.post('/api/phone/ivr/status', { callId }, opts);
      if (r.status !== 200) return 'unknown'; const d = r.data?.decision; if (d === 'pending' || d === 'approved') return 'live'; return typeof d === 'string' ? 'over' : 'unknown';
    } catch { return 'unknown'; }
  }
  /** Ends the call in Meet (removes the participant, frees the waiting-room slot). Idempotent: Meet answers a repeat with the stored result. */
  async cancelAdmission(session: string, callId: string): Promise<void> { await this.cancelByCall(callId); void session; }
  private async cancelByCall(callId: string): Promise<void> {
    const { status } = await this.post('/api/phone/ivr/disconnect', { eventId: eventId('gwend', callId), callId, type: 'gateway_cancelled' }); if (status >= 500) throw new Error('meet could not end the call (' + status + ')');
  }
  /** The gateway reports that the telephone hung up, or that the leg Meet asked to be torn down is gone (this also CONFIRMS the hang-up in Meet). */
  async callEnded(callId: string, type = 'caller_hung_up'): Promise<void> { await this.post('/api/phone/ivr/disconnect', { eventId: eventId('gwend', callId), callId, type: type.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'ended' }); }
  /** The gateway's heartbeat: the evidence behind readiness' gatewayHealthy. Send it every few seconds while the gateway is really working; stop sending it and Meet stops counting the gateway healthy. */
  async heartbeat(instance: string, healthy: boolean): Promise<boolean> { const r = await this.post('/api/phone/ivr/gateway-health', { instance, healthy }); return r.status === 200; }
}
