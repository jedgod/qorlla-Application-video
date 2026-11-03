import crypto from 'node:crypto';
import type { MeetingAuthority, MeetingDecision, StepOptions, VerifyOptions } from './admission.js';

/**
 * MeetingAuthority backed by the REAL Qorlla Meet. Meet stays the authority for meetings, PINs, the waiting room, host approval, locks, bans and per-caller attempt limits; this adapter only calls the
 * endpoints Meet actually has (qorlla-meet-video/server):
 *
 *   GET  /api/resolve/:digits                                   public       meeting number -> { meetingId } (404 = unavailable/ended)
 *   POST /api/phone/ivr/verify                                  signed       { eventId, callId, from, meetingId, pin } -> { result: connected | waiting | denied | locked, callRef, say }
 *   POST /api/phone/ivr/disconnect                              signed       { eventId, callId, type } -> { result: ended | unknown }
 *   GET  /api/integrations/scheduled-meetings/:sourceId/phone-calls   bridge secret   { calls: [{ id (= callRef), status: waiting|connected|denied|removed|ended, ... }] }
 *
 * "signed" = header `x-qorlla-signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` with PHONE_WEBHOOK_SECRET (Meet's own scheme, 300 s skew, event ids are idempotent).
 * "bridge secret" = header `x-qorlla-bridge-secret` (QORLLA_BRIDGE_SECRET, 32+ characters), the existing server-to-server credential.
 *
 * The meeting session id this adapter hands to the admission is `<meetingUuid>.<callRef>`: everything later (host approval, cancellation, the Shield re-check) can be derived from it on ANY gateway replica.
 */
export interface MeetingDirectory {
  /** The main app's scheduled-meeting id for a Meet meeting. Meet's phone-calls endpoint is keyed by it, and Meet has no endpoint that returns it, so the deployment must supply this (null = unknown). */
  sourceIdFor(meetingUuid: string): Promise<string | null>;
}
export type MeetConfig = {
  baseUrl: string;
  webhookSecret: string;
  bridgeSecret: string;
  directory: MeetingDirectory;
  fetchImpl?: typeof fetch;
  /** How often the host's decision is polled (default 1 s). */
  pollMs?: number;
  /** Per-request timeout (default 5 s). */
  requestTimeoutMs?: number;
  now?: () => number;
};
/** Meet accepts event ids of 8-120 characters from [A-Za-z0-9_.:-]; a hash keeps them valid and stable for any call id. */
const eventId = (kind: string, callId: string) => kind + '-' + crypto.createHash('sha256').update(callId).digest('hex').slice(0, 40);
export const sessionId = (meetingUuid: string, callRef: string) => meetingUuid + '.' + callRef;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export function parseSession(id: string): { meetingUuid: string; callRef: string } | null {
  const m = new RegExp('^(' + UUID + ')\\.(' + UUID + ')$', 'i').exec(String(id || '')); return m ? { meetingUuid: m[1].toLowerCase(), callRef: m[2].toLowerCase() } : null;
}
/** Meet's signature header, byte for byte (see telephony: phone.mjs createProvider().sign). */
export const signMeetRequest = (rawBody: string, secret: string, t: number = Math.floor(Date.now() / 1000)) => 't=' + t + ',v1=' + crypto.createHmac('sha256', secret).update(t + '.' + rawBody).digest('hex');

export class MeetPhoneAuthority implements MeetingAuthority {
  private readonly f: typeof fetch; private readonly pollMs: number; private readonly timeoutMs: number;
  constructor(private readonly cfg: MeetConfig) {
    if (!/^https?:\/\//.test(cfg.baseUrl)) throw new Error('MeetConfig.baseUrl must be an http(s) URL');
    if (String(cfg.webhookSecret).length < 16) throw new Error('webhookSecret must be at least 16 characters');
    if (String(cfg.bridgeSecret).length < 32) throw new Error('bridgeSecret must be at least 32 characters');
    this.f = cfg.fetchImpl ?? fetch; this.pollMs = cfg.pollMs ?? 1000; this.timeoutMs = cfg.requestTimeoutMs ?? 5000;
  }
  private url(p: string) { return this.cfg.baseUrl.replace(/\/+$/, '') + p; }
  private signal(opts?: StepOptions) { const t = AbortSignal.timeout(this.timeoutMs); return opts?.signal ? AbortSignal.any([t, opts.signal]) : t; }
  private async signedPost(path: string, body: object, opts?: StepOptions): Promise<{ status: number; data: any }> {
    const raw = JSON.stringify(body);
    const r = await this.f(this.url(path), { method: 'POST', headers: { 'content-type': 'application/json', 'x-qorlla-signature': signMeetRequest(raw, this.cfg.webhookSecret, Math.floor((this.cfg.now ?? Date.now)() / 1000)) }, body: raw, signal: this.signal(opts) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }

  async verifyPhoneJoin(meetingNumber: string, passcode: string, opts?: VerifyOptions): Promise<MeetingDecision> {
    const digits = String(meetingNumber).replace(/\D/g, ''), no: MeetingDecision = { allowed: false, requiresHostApproval: false };
    // Meet's PIN is 4-12 digits and the meeting number is 11: anything else cannot be right, and is refused without spending an attempt in Meet
    if (!/^\d{11}$/.test(digits) || !/^\d{4,12}$/.test(passcode) || !opts?.callId || opts.callId.length > 120 || !opts.callerNumber) return no;      // Meet stores the first 120 characters of a call id: a longer one could not be found again
    // The meeting's real id (needed by the Security Shield). Unavailable is not a refusal by itself: Meet is still asked, so it counts the failed attempt against the caller.
    let meetingUuid: string | null = null;
    try { const r = await this.f(this.url('/api/resolve/' + digits), { signal: this.signal(opts) }); if (r.status === 200) { const j: any = await r.json().catch(() => ({})); if (typeof j.meetingId === 'string' && parseSession(j.meetingId + '.' + j.meetingId)) meetingUuid = j.meetingId.toLowerCase(); } else if (r.status !== 404) throw new Error('resolve ' + r.status); }
    catch (e) { if (opts.signal.aborted) throw e; throw new Error('meet unavailable'); }
    const { status, data } = await this.signedPost('/api/phone/ivr/verify', { eventId: eventId('gw', opts.callId), callId: opts.callId, from: opts.callerNumber, meetingId: digits, pin: passcode }, opts);
    if (status !== 200 || typeof data?.result !== 'string') throw new Error('meet refused the verification request (' + status + ')');     // includes 503 "telephony is not enabled" and 401: never read as "allowed"
    const callRef = typeof data.callRef === 'string' ? data.callRef.toLowerCase() : '';
    if ((data.result === 'connected' || data.result === 'waiting') && meetingUuid && parseSession(sessionId(meetingUuid, callRef))) {
      return { allowed: true, requiresHostApproval: data.result === 'waiting', meetingSessionId: sessionId(meetingUuid, callRef) };
    }
    if (data.result === 'connected' || data.result === 'waiting') { if (opts.callId) await this.cancelByCall(opts.callId).catch(() => undefined); throw new Error('meet admitted the call but its meeting could not be identified'); }   // do not leave a ghost participant
    return no;                                                                                                                            // denied / locked / anything else
  }

  /** Waits for the host's decision by watching the call in Meet. true only when Meet reports the call connected; denied, removed, ended or vanished is a refusal. */
  async requestHostApproval(session: string, callId: string, opts?: StepOptions): Promise<boolean> {
    const s = parseSession(session); if (!s) return false;
    const sourceId = await this.cfg.directory.sourceIdFor(s.meetingUuid);
    if (!sourceId || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(sourceId)) throw new Error('the meeting has no scheduled-meeting id: its calls cannot be watched');
    for (;;) {
      if (opts?.signal.aborted) throw new Error('aborted');
      const r = await this.f(this.url('/api/integrations/scheduled-meetings/' + encodeURIComponent(sourceId) + '/phone-calls'), { headers: { 'x-qorlla-bridge-secret': this.cfg.bridgeSecret }, signal: this.signal(opts) });
      if (r.status === 404) return false; if (r.status !== 200) throw new Error('phone-calls ' + r.status);
      const j: any = await r.json().catch(() => null), call = Array.isArray(j?.calls) ? j.calls.find((c: any) => String(c?.id).toLowerCase() === s.callRef) : null;
      if (!call) return false;
      if (call.status === 'connected') return true;
      if (call.status !== 'waiting') return false;
      await new Promise<void>((resolve, reject) => { const t = setTimeout(resolve, this.pollMs); opts?.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true }); });
    }
  }

  /** Ends the call in Meet (removes the participant, frees the waiting-room slot). Idempotent: Meet answers a repeat with the stored result. */
  async cancelAdmission(session: string, callId: string): Promise<void> { await this.cancelByCall(callId); void session; }
  private async cancelByCall(callId: string): Promise<void> {
    const { status } = await this.signedPost('/api/phone/ivr/disconnect', { eventId: eventId('gwend', callId), callId, type: 'gateway_cancelled' });
    if (status >= 500) throw new Error('meet could not end the call (' + status + ')');
  }
  /** The gateway reports that the telephone hung up (or the leg died). */
  async callEnded(callId: string, type = 'caller_hung_up'): Promise<void> { await this.signedPost('/api/phone/ivr/disconnect', { eventId: eventId('gwend', callId), callId, type: type.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'ended' }); }
}
