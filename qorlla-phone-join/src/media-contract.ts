import type { SipRtpBridge, StepOptions } from './admission.js';

/**
 * MEDIA GATEWAY CONTRACT: what the SIP/RTP <-> Qorlla WebRTC gateway (not in this repository) must implement, and the rule that turns its report into `mediaEstablished`.
 *
 * Lifecycle of one call leg
 *   negotiating   SIP INVITE accepted, SDP offer/answer exchanged with the carrier; ICE/DTLS-SRTP (WebRTC side) in progress
 *   ice_connected both media paths are connected, no audio seen yet
 *   audio_flowing RTP is arriving from the telephone AND being delivered to it (bidirectional), SRTP/DTLS-SRTP on the WebRTC side
 *   degraded      audio stopped in a direction (silence is allowed; no PACKETS is not), or ICE disconnected; the gateway must recover or terminate within its own timeout
 *   terminating   BYE sent / leg being torn down (also entered when the admission is aborted, times out, the host removes the caller, the Shield revokes, or the meeting ends)
 *   closed        both media paths released: no socket, no mixer input, no SFU participant remains
 *
 * Rules
 *  1. start() resolves only after audio has been OBSERVED in both directions; it rejects (or reports state != audio_flowing) otherwise. Signalling success is never audio.
 *  2. start() honours the AbortSignal; if it cannot be cancelled, stop(callId) must still remove anything that start() creates later (the admission calls stop() at the timeout and again when a late
 *     start() finally ends).
 *  3. stop() is idempotent and safe for a call that is not (yet, or no longer) attached.
 *  4. onEnded() fires exactly once per leg when the telephone hangs up or the leg dies, so the call can be recorded as ended and the meeting participant removed.
 *  5. The gateway never transcodes or records audio without the recording-consent policy of the meeting.
 */
export type MediaState = 'negotiating' | 'ice_connected' | 'audio_flowing' | 'degraded' | 'terminating' | 'closed';
export type AudioEvidence = {
  state: MediaState;
  inboundPackets: number;       // RTP packets received from the telephone since the leg started
  outboundPackets: number;      // RTP packets delivered to the telephone
  observedMs: number;           // how long both directions have been observed
  codec: string;                // negotiated codec, for example 'opus', 'PCMU', 'PCMA'
  encrypted: boolean;           // WebRTC side is DTLS-SRTP
  measuredAt: number;           // epoch ms of the measurement
};
export interface MediaGateway {
  start(callId: string, meetingSessionId: string, opts: StepOptions): Promise<AudioEvidence>;
  stop(callId: string, reason: string): Promise<void>;
  onEnded(listener: (callId: string, reason: string) => void): void;
  /** The id of the Meet verification credential this leg's meeting session was admitted with; Meet requires it with the media report (it ties the evidence to the signalling session it observed). */
  peerJti?(callId: string): string | undefined;
}
export type EvidencePolicy = { minPackets: number; minObservedMs: number; maxAgeMs: number; codecs: readonly string[]; now: () => number };
export const DEFAULT_POLICY: EvidencePolicy = { minPackets: 25, minObservedMs: 500, maxAgeMs: 5_000, codecs: ['opus', 'PCMU', 'PCMA'], now: Date.now };

/** True only when the evidence shows live, fresh, encrypted, bidirectional audio in an allowed codec. */
export function audioVerified(e: AudioEvidence | null | undefined, policy: Partial<EvidencePolicy> = {}): boolean {
  const p = { ...DEFAULT_POLICY, ...policy };
  if (!e || typeof e !== 'object' || e.state !== 'audio_flowing') return false;
  const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!n(e.inboundPackets) || !n(e.outboundPackets) || !n(e.observedMs) || !n(e.measuredAt)) return false;
  return e.inboundPackets >= p.minPackets && e.outboundPackets >= p.minPackets && e.observedMs >= p.minObservedMs && e.encrypted === true && p.codecs.includes(e.codec) && p.now() - e.measuredAt <= p.maxAgeMs && e.measuredAt <= p.now() + 1_000;
}

/** Adapts a MediaGateway to the SipRtpBridge the admission uses: `mediaEstablished` is true ONLY when audioVerified() accepts the evidence. */
export function verifiedBridge(gateway: MediaGateway, policy: Partial<EvidencePolicy> = {}): SipRtpBridge {
  return {
    async attach(callId, meetingSessionId, opts) {
      const evidence = await gateway.start(callId, meetingSessionId, opts ?? { signal: new AbortController().signal });
      return { mediaEstablished: audioVerified(evidence, policy) };
    },
    disconnect: (callId) => gateway.stop(callId, 'admission_disconnect')
  };
}
