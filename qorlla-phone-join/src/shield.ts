import type { MeetingAuthority, MeetingDecision, StepOptions, VerifyOptions } from './admission.js';
import { signGatewayToken } from './gateway-auth.js';
import { parseSession } from './meet-authority.js';

/**
 * Qorlla Security Shield integration for telephone callers. The Shield is part of the voice engine (qorlla-voice-engine, src/shield.mjs) and Meet already talks to it with a short-lived ES256 workload
 * token (aud 'qorlla-shield'): POST /v1/shield/meet/{authorize,recheck,end} and /v1/shield/report. A telephone caller is a guest with no account, so the Shield's decision for them is about the MEETING:
 * unknown or ended meeting, guests not allowed, not admitted (host rejection) and - through the re-check - a meeting that ended or a host/org that was suspended. ANY failure to get an answer is a denial.
 * (Meet itself does not consult the Shield for telephone callers today; see docs/MEET_INTEGRATION.md.)
 */
export type ShieldConfig = {
  url: string;
  privateKeyPem: string;
  issuer: string;
  /** The workload identity the Shield knows this service as; it must hold the `meet.signal` scope there. */
  subject?: string;
  kid?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};
export type ShieldAnswer = { allow: boolean; reason: string };
export class ShieldClient {
  constructor(private readonly cfg: ShieldConfig) { if (!/^https?:\/\//.test(cfg.url)) throw new Error('ShieldConfig.url must be an http(s) URL'); }
  private async post(path: string, body: object, signal?: AbortSignal): Promise<{ status: number; data: any }> {
    const t = AbortSignal.timeout(this.cfg.timeoutMs ?? 4000);
    const token = signGatewayToken({ privateKeyPem: this.cfg.privateKeyPem, kid: this.cfg.kid, issuer: this.cfg.issuer, subject: this.cfg.subject ?? 'svc:meet', audience: 'qorlla-shield' });
    const r = await (this.cfg.fetchImpl ?? fetch)(this.cfg.url.replace(/\/+$/, '') + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([t, signal]) : t });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }
  /** A telephone caller who has been admitted (or has never needed approval). Anything but an explicit allow is a denial. */
  async authorize(meetingUuid: string, participantId: string, admission: 'admitted' | 'waiting' | 'denied', signal?: AbortSignal): Promise<ShieldAnswer> {
    try { const r = await this.post('/v1/shield/meet/authorize', { meetingId: meetingUuid, participantId, role: 'guest', admission }, signal); return r.status === 200 && r.data?.allow === true ? { allow: true, reason: 'ALLOW' } : { allow: false, reason: String(r.data?.reason || r.data?.error || 'SHIELD_REFUSED') }; }
    catch { return { allow: false, reason: 'SHIELD_UNAVAILABLE' }; }
  }
  /** -> the participants to revoke, or null when the Shield could not be asked. */
  async recheck(list: { meetingId: string; participantId: string }[]): Promise<{ meetingId: string; participantId: string; reason: string }[] | null> {
    try { const r = await this.post('/v1/shield/meet/recheck', { participants: list.slice(0, 500) }); return r.status === 200 && Array.isArray(r.data?.revoke) ? r.data.revoke : null; } catch { return null; }
  }
  async report(kind: string, ref?: string): Promise<boolean> { try { return (await this.post('/v1/shield/report', { kind, source: 'meet', ...(ref ? { ref: String(ref).replace(/[^A-Za-z0-9_.:@-]/g, '').slice(0, 80) } : {}) })).status === 200; } catch { return false; } }
}

/**
 * Puts the Shield in front of any MeetingAuthority. Every admission - including the one after a host approves - must be allowed by the Shield; a refusal or an unreachable Shield ends the call in the
 * meeting (so no ghost participant stays) and is never turned into an admission.
 */
export class ShieldedAuthority implements MeetingAuthority {
  constructor(private readonly inner: MeetingAuthority, private readonly shield: ShieldClient) {}
  private async guard(session: string, callId: string, signal?: AbortSignal): Promise<void> {
    const s = parseSession(session); const answer = s ? await this.shield.authorize(s.meetingUuid, s.callRef, 'admitted', signal) : { allow: false, reason: 'BAD_SESSION' };
    if (answer.allow) return;
    await this.inner.cancelAdmission?.(session, callId).catch(() => undefined);
    if (answer.reason === 'SHIELD_UNAVAILABLE') throw new Error('SHIELD_UNAVAILABLE');               // 503: the call could not be authorized, which is not the same as being refused
    throw new ShieldRefusal(answer.reason);
  }
  async verifyPhoneJoin(meetingId: string, passcode: string, opts?: VerifyOptions): Promise<MeetingDecision> {
    const d = await this.inner.verifyPhoneJoin(meetingId, passcode, opts);
    if (!d.allowed || !d.meetingSessionId) return d;
    if (d.requiresHostApproval !== false) return d;                                                  // the Shield is asked once the host has decided (below)
    try { await this.guard(d.meetingSessionId, opts?.callId ?? '', opts?.signal); } catch (e) { if (e instanceof ShieldRefusal) return { allowed: false, requiresHostApproval: false }; throw e; }
    return d;
  }
  async requestHostApproval(session: string, callId: string, opts?: StepOptions): Promise<boolean> {
    if (!(await this.inner.requestHostApproval(session, callId, opts))) return false;                // host rejection: nothing further to do
    try { await this.guard(session, callId, opts?.signal); } catch (e) { if (e instanceof ShieldRefusal) return false; throw e; }
    return true;
  }
  cancelAdmission(session: string, callId: string): Promise<void> { return this.inner.cancelAdmission ? this.inner.cancelAdmission(session, callId) : Promise.resolve(); }
}
class ShieldRefusal extends Error { constructor(readonly reason: string) { super(reason); } }

export type OpenCall = { callId: string; meetingSessionId: string };
/**
 * Periodic Shield re-check of connected telephone callers (mirrors Meet's startSessionGuard for signalling sessions): a meeting that ended, or a host/org that was suspended, ends the calls; if the Shield
 * stays unreachable past the grace period every call is ended (fail closed). `terminate` must hang the call up in the media bridge, in Meet, and in the ledger.
 */
export function startPhoneSessionGuard(o: { shield: ShieldClient; listOpen: () => Promise<OpenCall[]>; terminate: (call: OpenCall, reason: string) => Promise<void>; intervalMs?: number; graceMs?: number; now?: () => number; log?: Pick<Console, 'error'> }) {
  const now = o.now ?? Date.now, grace = o.graceMs ?? 120_000, log = o.log ?? console; let lastOk = now(), running = false;
  const tick = async () => {
    if (running) return; running = true;
    try {
      const open = (await o.listOpen()).map((c) => ({ c, s: parseSession(c.meetingSessionId) })).filter((x): x is { c: OpenCall; s: { meetingUuid: string; callRef: string } } => !!x.s);
      if (!open.length) { lastOk = now(); return; }
      const revoke = await o.shield.recheck(open.map((x) => ({ meetingId: x.s.meetingUuid, participantId: x.s.callRef })));
      if (!revoke) { if (now() - lastOk > grace) { log.error('[phone-join] shield unreachable beyond the grace period: ending telephone calls'); for (const x of open) await o.terminate(x.c, 'SHIELD_UNAVAILABLE').catch(() => o.shield.report('phone_termination_failed', x.c.callId)); } return; }
      lastOk = now();
      for (const rv of revoke) { const x = open.find((y) => y.s.meetingUuid === rv.meetingId && y.s.callRef === rv.participantId); if (x) await o.terminate(x.c, rv.reason).catch(() => o.shield.report('phone_termination_failed', x.c.callId)); }
    } finally { running = false; }
  };
  const t = setInterval(() => { tick().catch(() => undefined); }, o.intervalMs ?? 15_000); t.unref?.();
  return { stop: () => clearInterval(t), tick };
}
