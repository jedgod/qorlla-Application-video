import type { AttachOptions } from '../admission.js';
import type { AudioEvidence, MediaGateway } from '../media-contract.js';
import type { RtpLeg } from './rtp-leg.js';
import type { Logger } from '../sip/adapter.js';

/**
 * The meeting-facing half of one call. Meet has NO server-side mixer or SFU (browsers form a full mesh), so the implementation of this interface is a WebRTC PEER that joins the meeting like a participant
 * (see mesh-peer.ts). It converts everything the meeting says into ONE 20 ms mono frame for the telephone and takes the telephone's frames into the meeting.
 */
export interface MeetingAudioSession {
  readonly sessionId?: string;                                   // the Meet verification credential id this session was admitted with (sent with the media report)
  readonly encrypted: boolean;                                   // true only for DTLS-SRTP media; a simulated / in-memory path is false and can therefore never be verified
  isConnected(): boolean;                                        // at least one meeting peer has an established media path
  pullFrame(): Int16Array | null;                                // meeting -> telephone: the mix of what arrived since the last pull, or null when no meeting RTP arrived
  pushFrame(pcm: Int16Array): void;                              // telephone -> meeting
  stats(): { framesFromMeeting: number; framesToMeeting: number; peers: number; lastFromMeetingAt: number };
  onClosed(listener: (reason: string) => void): void;
  close(reason?: string): Promise<void>;
}
export interface MeetingAudio { open(o: { callId: string; meetingSessionId: string; mediaToken?: string; signal: AbortSignal }): Promise<MeetingAudioSession> }

export type GatewayOptions = {
  meeting: MeetingAudio; minPackets?: number; minObservedMs?: number; attachTimeoutMs?: number; staleAfterMs?: number; recoverWithinMs?: number; watchdogMs?: number; log?: Logger; now?: () => number;
};
type Entry = {
  leg: RtpLeg; hangup: (reason: string) => void; session?: MeetingAudioSession; ended: boolean; cancelled: boolean; attached: boolean;
  base?: { inbound: number; at: number }; delivered: number; lastDeliveredAt: number; bothSince: number; degradedSince: number; onPcm?: (f: Int16Array) => void;
};
const FRAME_MS = 20;
export class SipMediaGateway implements MediaGateway {
  private readonly legs = new Map<string, Entry>(); private readonly listeners: ((id: string, reason: string) => void)[] = []; private readonly now: () => number; private readonly log: Logger; private dog?: NodeJS.Timeout;
  constructor(private readonly o: GatewayOptions) { this.now = o.now ?? Date.now; this.log = o.log ?? (() => undefined); }
  /** Called by the call controller when a telephone leg exists. From this moment the leg is owned here: stop() or the telephone hanging up ends it. */
  registerLeg(callId: string, leg: RtpLeg, hangup: (reason: string) => void) {
    if (this.legs.has(callId)) throw new Error('a leg is already registered for ' + callId);
    this.legs.set(callId, { leg, hangup, ended: false, cancelled: false, attached: false, delivered: 0, lastDeliveredAt: 0, bothSince: 0, degradedSince: 0 });
    leg.once('closed', (reason: string) => { void this.finish(callId, 'leg_' + reason, false); });
    if (!this.dog) { this.dog = setInterval(() => this.watch(), this.o.watchdogMs ?? 1000); this.dog.unref?.(); }
  }
  peerJti(callId: string): string | undefined { return this.legs.get(callId)?.session?.sessionId; }
  hasLeg(callId: string) { const e = this.legs.get(callId); return !!e && !e.ended; }
  onEnded(listener: (callId: string, reason: string) => void) { this.listeners.push(listener); }
  /** The telephone hung up (BYE / CANCEL): tear everything down; the SIP side needs no BYE of ours. */
  legEnded(callId: string, reason: string) { return this.finish(callId, reason, false); }

  async start(callId: string, meetingSessionId: string, opts: AttachOptions): Promise<AudioEvidence> {
    const e = this.legs.get(callId); if (!e || e.ended) throw new Error('no telephone leg for ' + callId);
    if (e.attached) throw new Error('already attached'); e.cancelled = false;
    const abort = () => { e.cancelled = true; }; opts.signal.addEventListener('abort', abort, { once: true }); if (opts.signal.aborted) e.cancelled = true;
    const minPackets = this.o.minPackets ?? 25, minMs = this.o.minObservedMs ?? 500, deadline = this.now() + (this.o.attachTimeoutMs ?? 8000);
    try {
      const session = await this.o.meeting.open({ callId, meetingSessionId, mediaToken: opts.mediaToken, signal: opts.signal });
      if (e.cancelled || e.ended) { await session.close('cancelled').catch(() => undefined); throw new Error('attach cancelled'); }     // a stop() / timeout arrived while the session was opening: nothing may remain
      e.session = session; e.attached = true; session.onClosed((r) => { void this.finish(callId, 'meeting_' + r, true); });
      e.base = { inbound: e.leg.stats().inboundPackets, at: this.now() }; e.delivered = 0; e.bothSince = 0;
      e.leg.source = () => { const f = session.pullFrame(); if (f) { e.delivered++; e.lastDeliveredAt = this.now(); } return f; };
      e.onPcm = (f) => session.pushFrame(f); e.leg.on('pcm', e.onPcm);
      for (;;) {
        if (e.cancelled || e.ended) throw new Error('attach cancelled');
        const ev = this.evidence(e, minPackets, minMs); if (ev.state === 'audio_flowing') return ev;
        if (this.now() >= deadline) return ev;                    // not verified: the admission refuses the call and stop() cleans up
        await new Promise((r) => setTimeout(r, FRAME_MS));
      }
    } catch (err) { if (e.cancelled || e.ended) await this.finish(callId, 'attach_cancelled', true); throw err; }
    finally { opts.signal.removeEventListener('abort', abort); }
  }
  /** Current measurement of an attached leg (for the keep-alive reports to Meet); null when the call has no media. */
  measure(callId: string): AudioEvidence | null { const e = this.legs.get(callId); return e && e.attached && !e.ended ? this.evidence(e, this.o.minPackets ?? 25, this.o.minObservedMs ?? 500) : null; }
  private evidence(e: Entry, minPackets: number, minMs: number): AudioEvidence {
    const s = e.leg.stats(), now = this.now(), ms = e.session?.stats(), inbound = Math.max(0, s.inboundPackets - (e.base?.inbound ?? 0));
    const fresh = this.o.staleAfterMs ?? 2000, live = !!e.session && e.session.isConnected();
    const inFresh = now - s.lastInboundAt <= fresh, outFresh = e.delivered > 0 && now - e.lastDeliveredAt <= fresh;
    const both = live && inbound >= 1 && e.delivered >= 1 && inFresh && outFresh; if (both && !e.bothSince) e.bothSince = now; if (!both && e.bothSince && !(inFresh && outFresh)) e.bothSince = 0;
    const observedMs = e.bothSince ? now - e.bothSince : 0, ok = both && inbound >= minPackets && e.delivered >= minPackets && observedMs >= minMs;
    void ms;
    return { state: ok ? 'audio_flowing' : (e.bothSince || inbound > 0 || e.delivered > 0 ? 'degraded' : (live ? 'ice_connected' : 'negotiating')), inboundPackets: inbound, outboundPackets: e.delivered, observedMs, codec: s.codec, encrypted: s.encrypted && !!e.session?.encrypted, measuredAt: now };
  }
  /** Interrupted media is given `recoverWithinMs` to come back; after that the call is ended (and reported), never left hanging open. */
  private watch() {
    const now = this.now();
    for (const [id, e] of this.legs) {
      if (!e.attached || e.ended) continue; const ev = this.evidence(e, 1, 0), healthy = ev.state === 'audio_flowing' || (now - e.leg.stats().lastInboundAt <= (this.o.staleAfterMs ?? 2000) && e.delivered > 0 && now - e.lastDeliveredAt <= (this.o.staleAfterMs ?? 2000));
      if (healthy) { e.degradedSince = 0; continue; } if (!e.degradedSince) e.degradedSince = now;
      if (now - e.degradedSince > (this.o.recoverWithinMs ?? 5000)) { this.log({ event: 'media_interrupted', callId: id }); void this.finish(id, 'media_interrupted', true); }
    }
  }
  async stop(callId: string, reason: string): Promise<void> { const e = this.legs.get(callId); if (e) e.cancelled = true; await this.finish(callId, reason, true); }
  private async finish(callId: string, reason: string, sendBye: boolean): Promise<void> {
    const e = this.legs.get(callId); if (!e) return; e.cancelled = true; if (e.ended) return; e.ended = true;
    if (e.onPcm) e.leg.off('pcm', e.onPcm); e.leg.source = null;
    try { if (sendBye) e.hangup(reason); } catch { /* the SIP side is already gone */ }
    e.leg.close(reason); const s = e.session; e.session = undefined; if (s) await s.close(reason).catch(() => undefined);
    this.legs.delete(callId); for (const l of this.listeners) { try { l(callId, reason); } catch { /* a listener must not break teardown */ } }
    if (this.legs.size === 0 && this.dog) { clearInterval(this.dog); this.dog = undefined; }
  }
  async closeAll(reason = 'shutdown') { await Promise.all([...this.legs.keys()].map((id) => this.finish(id, reason, true))); }
  activeLegs() { return [...this.legs.entries()].filter(([, e]) => !e.ended).length; }
}
