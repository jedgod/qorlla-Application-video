import type { CallLedger, MeetingAuthority, SipRtpBridge } from './admission.js';
import type { OpenCall } from './shield.js';

/**
 * Ends one connected call everywhere, in an order that cannot leave a half-open call: media first (so no audio flows), then the meeting (no ghost participant), then the durable record.
 * Every step is attempted even if an earlier one failed; the call is marked `ended` only when the media was really torn down, otherwise `orphaned` for an operator.
 */
export function terminateCall(deps: { bridge: SipRtpBridge; authority: MeetingAuthority; ledger?: CallLedger }) {
  return async (call: OpenCall, reason: string): Promise<void> => {
    let mediaDown = false;
    await deps.ledger?.transition?.(call.callId, 'terminating', { reason }).catch(() => false);
    try { await deps.bridge.disconnect(call.callId); mediaDown = true; } catch { /* recorded below */ }
    await deps.authority.cancelAdmission?.(call.meetingSessionId, call.callId).catch(() => undefined);
    await deps.ledger?.transition?.(call.callId, mediaDown ? 'ended' : 'orphaned', { reason }).catch(() => false);
    if (!mediaDown) throw new Error('media for ' + call.callId + ' could not be disconnected');
  };
}

/**
 * Crash recovery, for any replica: claims left open by a gateway process that died (mid-attach, mid-approval) are taken by exactly ONE reaper, their media is disconnected, they are ended in the meeting service,
 * and only then released. A leg that cannot be disconnected is marked ORPHANED and reported (onOrphan) so an operator is told; its call id is never reused.
 */
export function startReaper(o: { ledger: { reapStale(ms: number): Promise<string[]>; sessionOf(id: string): Promise<string | null>; finishReap(id: string, terminated: boolean): Promise<void> }; bridge: SipRtpBridge; authority: MeetingAuthority; olderThanMs?: number; intervalMs?: number; onOrphan?: (callId: string) => void; log?: Pick<Console, 'error'> }) {
  const log = o.log ?? console; let running = false;
  const tick = async (): Promise<string[]> => {
    if (running) return []; running = true; const done: string[] = [];
    try {
      for (const callId of await o.ledger.reapStale(o.olderThanMs ?? 90_000)) {
        const session = (await o.ledger.sessionOf(callId)) ?? '';
        let media = false; try { await o.bridge.disconnect(callId); media = true; } catch (e) { log.error('[phone-join] reaper: media of ' + callId + ' could not be disconnected: ' + (e as Error).message); }
        await o.authority.cancelAdmission?.(session, callId).catch(() => undefined);
        await o.ledger.finishReap(callId, media); if (!media) o.onOrphan?.(callId); done.push(callId);
      }
    } finally { running = false; }
    return done;
  };
  const t = setInterval(() => { tick().catch((e) => log.error('[phone-join] reaper failed: ' + (e as Error).message)); }, o.intervalMs ?? 30_000); t.unref?.();
  return { stop: () => clearInterval(t), tick };
}
