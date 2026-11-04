import type { SipRtpBridge, AttachOptions } from './admission.js';
import { audioVerified, type AudioEvidence, type EvidencePolicy, type MediaGateway } from './media-contract.js';
import type { MediaReply } from './meet-authority.js';

/** What the media layer needs from the meeting service: report evidence, learn what Meet decided. */
export interface MediaReporter { reportMedia(callId: string, mediaToken: string, evidence: AudioEvidence | null, opts?: { signal?: AbortSignal; peerJti?: string }): Promise<MediaReply> }

/**
 * The bridge the admission uses with the real Meet. `mediaEstablished` is true only when TWO independent judges agree: this gateway's own evidence check (audioVerified) AND Meet's (it re-evaluates the
 * raw evidence, checks the one-time media token, the meeting state and the Security Shield, and answers `connected`). Signalling success, a PIN, a host's approval or an acknowledged webhook never get here.
 * A leg Meet tells to terminate is torn down and never reported as connected. Live legs are remembered (call id -> media token) so their evidence can be refreshed (startMediaKeepAlive).
 */
export function meetConfirmedBridge(o: { gateway: MediaGateway; meet: MediaReporter; policy?: Partial<EvidencePolicy> }): SipRtpBridge & { legs: Map<string, string> } {
  const legs = new Map<string, string>();
  return {
    legs,
    async attach(callId: string, meetingSessionId: string, opts?: AttachOptions) {
      const evidence = await o.gateway.start(callId, meetingSessionId, opts ?? { signal: new AbortController().signal });
      if (opts?.signal.aborted) {                                                                                 // the admission gave up (timeout) while the gateway was still setting this leg up: it exists NOW
        await o.gateway.stop(callId, 'late_media').catch(() => undefined);                                       // end it,
        if (opts.mediaToken && evidence) await o.meet.reportMedia(callId, opts.mediaToken, evidence, { peerJti: o.gateway.peerJti?.(callId) }).catch(() => undefined);   // and tell Meet it appeared (not cancelled: Meet records late media for a call it has already ended)
        return { mediaEstablished: false };
      }
      if (!audioVerified(evidence, o.policy)) return { mediaEstablished: false };
      const token = opts?.mediaToken; if (!token) return { mediaEstablished: false };                                  // no token: Meet cannot accept the report, so there is nothing to connect
      const reply = await o.meet.reportMedia(callId, token, evidence, { signal: opts?.signal, peerJti: o.gateway.peerJti?.(callId) });
      if (reply.action === 'terminate' || reply.result !== 'connected') return { mediaEstablished: false };
      legs.set(callId, token); return { mediaEstablished: true };
    },
    async disconnect(callId: string) { legs.delete(callId); await o.gateway.stop(callId, 'admission_disconnect'); }
  };
}

/**
 * Keeps connected calls proven: every interval each live leg is measured and reported to Meet. Meet ends a call whose audio stops being verified (and the sweeper ends one that stops being reported), so this is what
 * keeps a call alive - and what notices, from Meet's answer, that a call must end now (`terminate`, a refusal, a revoked authorization).
 */
export function startMediaKeepAlive(o: { legs: Map<string, string>; measure: (callId: string) => Promise<AudioEvidence | null>; meet: MediaReporter; terminate: (callId: string, reason: string) => Promise<void>; intervalMs?: number; log?: Pick<Console, 'error'> }) {
  let running = false; const log = o.log ?? console;
  const tick = async () => {
    if (running) return; running = true;
    try {
      for (const [callId, token] of [...o.legs]) {
        try {
          const evidence = await o.measure(callId).catch(() => null), reply = await o.meet.reportMedia(callId, token, evidence);
          if (reply.action === 'terminate' || reply.result !== 'connected') { o.legs.delete(callId); await o.terminate(callId, reply.action === 'terminate' ? 'meet_terminated' : 'meet_not_connected'); }
        } catch (e) { log.error('[phone-join] media report failed for ' + callId + ': ' + (e as Error).message); }                  // Meet unreachable: the leg stays, and Meet's own stale-media sweeper ends the call if reports do not resume
      }
    } finally { running = false; }
  };
  const t = setInterval(() => { tick().catch(() => undefined); }, o.intervalMs ?? 5000); t.unref?.();
  return { stop: () => clearInterval(t), tick };
}
