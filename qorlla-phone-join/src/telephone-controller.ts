import { admitTelephoneCall, telephoneReady, type AdmissionOptions, type MeetingAuthority, type Readiness, type SipRtpBridge } from './admission.js';
import type { InboundCall, Logger, SipIngress } from './sip/adapter.js';
import { answer as buildAnswer, type Answer } from './sip/sdp.js';
import { RtpLeg } from './media/rtp-leg.js';
import { DtmfEntry, RULES, type EntryResult, type EntryRules } from './media/dtmf.js';
import { SipMediaGateway } from './media/sip-media-gateway.js';

/**
 * ONE telephone call from INVITE to hang-up. It performs no admission logic of its own: it answers the SIP call, collects the meeting ID and passcode by DTMF, and hands them to `admitTelephoneCall` (host approval, Security
 * Shield, passcode, atomic call ownership, timeouts and late-media handling all live there and in Meet). The caller hears nothing from the meeting, and the meeting hears nothing from the caller, until
 * the admission has returned `MEDIA_CONNECTED` on VERIFIED audio.
 *
 * Fail closed: nothing is allocated (no port, no leg, no 200 OK) unless all six readiness conditions hold; a call that cannot be answered correctly is refused with a final SIP response.
 */
export type ControllerConfig = {
  ingress: SipIngress; gateway: SipMediaGateway; bridge: SipRtpBridge; authority: MeetingAuthority;
  readiness: () => Promise<Readiness>;
  media: { bindHost: string; publicHost: string; portRange: readonly [number, number]; allowPlainRtp?: boolean; inactivityMs?: number; jitterDepth?: number; allowPortLatch?: boolean };
  admission?: AdmissionOptions; rules?: { meetingId?: EntryRules; passcode?: EntryRules }; maxEntryAttempts?: number;
  /** Called when a call ends for any reason AFTER it reached the meeting (admitted or still waiting): Meet and the ledger must be told. Wire `terminateCall(...)` here. */
  onEnded?: (callId: string, reason: string, phase: 'ivr' | 'admitting' | 'connected') => void | Promise<void>; log?: Logger; tones?: boolean;
};
const e164 = (n: string) => (n.startsWith('+') ? n : '+' + n);
/** A cue tone, generated here (no audio assets): `hz` for `ms`, at 8 kHz, as 20 ms frames. */
export function toneFrames(hz: number, ms: number): Int16Array[] {
  const out: Int16Array[] = []; for (let f = 0; f < ms / 20; f++) { const a = new Int16Array(160); for (let i = 0; i < 160; i++) a[i] = Math.round(6000 * Math.sin((2 * Math.PI * hz * (f * 160 + i)) / 8000)); out.push(a); } return out;
}
export class TelephoneController {
  private readonly phase = new Map<string, 'ivr' | 'admitting' | 'connected'>(); private readonly log: Logger;
  constructor(private readonly c: ControllerConfig) { this.log = c.log ?? (() => undefined); this.c.gateway.onEnded((id, reason) => { void this.ended(id, reason); }); }
  start() { this.c.ingress.onInvite((call) => this.handle(call)); }
  private async ended(callId: string, reason: string) { const p = this.phase.get(callId); this.phase.delete(callId); if (p && p !== 'ivr') { try { await this.c.onEnded?.(callId, reason, p); } catch (e) { this.log({ event: 'on_ended_failed', callId, message: String(e) }); } } else if (p) { try { await this.c.onEnded?.(callId, reason, 'ivr'); } catch { /* nothing reached the meeting */ } } }

  async handle(call: InboundCall): Promise<void> {
    const id = call.callId;
    let ready: Readiness | null = null; try { ready = await this.c.readiness(); } catch { /* unknown readiness is "not ready" */ }
    if (!telephoneReady(ready)) { call.reject(503, 'Service Unavailable'); this.log({ event: 'call_refused', callId: id, why: 'not_ready' }); return; }
    const ans = buildAnswer(call.offer, { ip: this.c.media.publicHost, port: 0, sipSourceIp: call.source.address, allowPlainRtp: this.c.media.allowPlainRtp });
    if ('refuse' in ans) { call.reject(488, 'Not Acceptable Here'); this.log({ event: 'call_refused', callId: id, why: ans.refuse }); return; }
    const leg = new RtpLeg({ bindHost: this.c.media.bindHost, portRange: this.c.media.portRange, remote: { address: call.source.address, port: call.offer.port }, codec: ans.codec, pt: ans.pt, dtmfPt: ans.dtmfPt, ptime: 20,
      srtp: ans.crypto && call.offer.crypto ? { localKey: ans.crypto.key, remoteKey: call.offer.crypto.key } : undefined, inactivityMs: this.c.media.inactivityMs, jitterDepth: this.c.media.jitterDepth, allowPortLatch: this.c.media.allowPortLatch });
    let port: number; try { port = await leg.open(); } catch { call.reject(503, 'Service Unavailable'); return; }
    this.c.gateway.registerLeg(id, leg, () => call.hangup('gateway_stop')); this.phase.set(id, 'ivr');
    call.onEnded((reason) => { void this.c.gateway.legEnded(id, 'sip_' + reason); });                                // the telephone hung up (or the dialog died): everything for this call goes
    try { await call.answer(withPort(ans, port).sdp); } catch { await this.c.gateway.legEnded(id, 'answer_failed'); return; }
    this.log({ event: 'call_answered', callId: id, codec: ans.codec, srtp: ans.secure });
    await this.ivr(call, leg, ready!);
  }

  private async ivr(call: InboundCall, leg: RtpLeg, readiness: Readiness) {
    const id = call.callId, attempts = this.c.maxEntryAttempts ?? 3; let queue: Int16Array[] = []; leg.source = () => queue.shift() ?? null;
    const play = (hz: number, ms: number) => { if (this.c.tones !== false) queue = toneFrames(hz, ms); };
    const holder: { entry: DtmfEntry | null } = { entry: null }; const onDigit = (d: string) => holder.entry?.push(d); leg.on('dtmf', onDigit);
    const gone = new AbortController(); call.onEnded(() => gone.abort());
    const collect = async (rules: EntryRules): Promise<EntryResult> => { holder.entry = new DtmfEntry(rules, gone.signal); play(880, 200); const r = await holder.entry.result; holder.entry = null; return r; };
    try {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const mid = await collect(this.c.rules?.meetingId ?? RULES.meetingId); if (!mid.ok) { if (mid.reason === 'cancelled') return; play(330, 400); continue; }
        const pin = await collect(this.c.rules?.passcode ?? RULES.pin); if (!pin.ok) { if (pin.reason === 'cancelled') return; play(330, 400); continue; }
        this.phase.set(id, 'admitting'); queue = [];
        const result = await admitTelephoneCall({ meetingId: mid.digits, passcode: pin.digits, callId: id, dialedNumber: e164(call.dialed), callerNumber: /^\+[1-9]\d{5,14}$/.test(call.caller) ? call.caller : undefined }, readiness, this.c.authority, this.c.bridge, this.c.admission ?? {});
        this.log({ event: 'admission_result', callId: id, code: result.code, status: result.status });
        if (result.code === 'MEDIA_CONNECTED') { this.phase.set(id, 'connected'); return; }                      // from here the gateway owns the leg until stop() or the telephone hangs up
        if (result.status === 503) break;                                                                         // unavailable is not a wrong-number problem: do not let the caller keep trying
        this.phase.set(id, 'ivr'); play(330, 400);
      }
    } finally { leg.off('dtmf', onDigit); holder.entry?.cancel(); }
    if (this.phase.get(id) !== 'connected' && this.c.gateway.hasLeg(id)) { await new Promise((r) => setTimeout(r, this.c.tones === false ? 0 : 450)); await this.c.gateway.stop(id, 'admission_failed'); }   // let the refusal tone play, then hang up
  }
}
const withPort = (a: Answer, port: number): Answer => ({ ...a, sdp: a.sdp.replace(/^m=audio 0 /m, `m=audio ${port} `) });
