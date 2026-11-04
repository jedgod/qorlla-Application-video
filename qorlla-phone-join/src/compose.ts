import type { CallLedger, MeetingAuthority, SipRtpBridge } from './admission.js';
import type { OpenCall } from './shield.js';
import { DEFAULT_DEADLINES, type LossReason, type StateDeadlines } from './ledger-pg.js';

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
 * Crash recovery, for any replica. A call whose gateway died is NOT assumed dead the moment a timer runs out: its lease must have lapsed, been challenged, and stayed unrenewed for a grace period (see
 * ledger-pg.ts); each state has its own deadline. A call that qualifies is taken over by exactly ONE reaper under a new ownership generation, its media is disconnected, it is ended in the meeting service,
 * and only then released. A leg that cannot be disconnected is marked ORPHANED and reported (onOrphan) so an operator is told; its call id is never reused. If this reaper itself loses the call to a newer
 * owner while it works, it stops touching it (finishReap is fenced and answers false).
 */
export function startReaper(o: { ledger: { reapStale(o?: { deadlines?: Partial<StateDeadlines> }): Promise<string[]>; sessionOf(id: string): Promise<string | null>; finishReap(id: string, terminated: boolean): Promise<boolean | void>; renew?(id: string): Promise<boolean>; purgeReleased?(ms: number): Promise<number> }; bridge: SipRtpBridge; authority: MeetingAuthority; deadlines?: Partial<StateDeadlines>; intervalMs?: number; onOrphan?: (callId: string) => void; log?: Pick<Console, 'error'> }) {
  const log = o.log ?? console; let running = false;
  const tick = async (): Promise<string[]> => {
    if (running) return []; running = true; const done: string[] = [];
    try {
      for (const callId of await o.ledger.reapStale({ deadlines: o.deadlines })) {
        if (o.ledger.renew && !(await o.ledger.renew(callId).catch(() => true))) continue;        // lost to a newer owner already: not ours to tear down
        const session = (await o.ledger.sessionOf(callId)) ?? '';
        let media = false; try { await o.bridge.disconnect(callId); media = true; } catch (e) { log.error('[phone-join] reaper: media of ' + callId + ' could not be disconnected: ' + (e as Error).message); }
        await o.authority.cancelAdmission?.(session, callId).catch(() => undefined);
        if ((await o.ledger.finishReap(callId, media)) === false) continue; if (!media) o.onOrphan?.(callId); done.push(callId);
      }
      await o.ledger.purgeReleased?.(o.deadlines?.released ?? DEFAULT_DEADLINES.released);
    } finally { running = false; }
    return done;
  };
  const t = setInterval(() => { tick().catch((e) => log.error('[phone-join] reaper failed: ' + (e as Error).message)); }, o.intervalMs ?? 30_000); t.unref?.();
  return { stop: () => clearInterval(t), tick };
}

/**
 * Keeps this gateway's leases alive and FAILS CLOSED when ownership is gone. Every tick renews every call this instance owns. A call it no longer owns (a newer generation took it, or a write was fenced) has its
 * local media leg disconnected at once and is reported (onLost). When the database cannot be reached, nothing is assumed: the lease just is not renewed; but once a whole lease period passes without a confirmed
 * renewal (the earliest moment a reaper could lawfully take the call), a not-yet-connected leg is stopped locally too. Connected calls keep running (Meet's media verification governs them).
 */
export function startLeaseKeeper(o: { ledger: { renewAll(): Promise<{ lost: string[] }>; unconfirmed(): string[]; forget(id: string): void; onLost(cb: (id: string, reason: LossReason) => void): void }; bridge: SipRtpBridge; intervalMs?: number; onLost?: (callId: string, reason: LossReason) => void; log?: Pick<Console, 'error'> }) {
  const log = o.log ?? console; let running = false;
  const stopLeg = async (id: string, reason: LossReason) => { await o.bridge.disconnect(id).catch((e) => log.error('[phone-join] lease: leg of ' + id + ' could not be stopped: ' + (e as Error).message)); o.onLost?.(id, reason); };
  o.ledger.onLost((id, reason) => { void stopLeg(id, reason); });
  const tick = async (): Promise<void> => {
    if (running) return; running = true;
    try { await o.ledger.renewAll(); for (const id of o.ledger.unconfirmed()) { o.ledger.forget(id); await stopLeg(id, 'unconfirmed'); } } finally { running = false; }
  };
  const t = setInterval(() => { tick().catch((e) => log.error('[phone-join] lease keeper failed: ' + (e as Error).message)); }, o.intervalMs ?? 5_000); t.unref?.();
  return { stop: () => clearInterval(t), tick };
}
