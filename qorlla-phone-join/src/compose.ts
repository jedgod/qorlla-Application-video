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
