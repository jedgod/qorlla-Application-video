/** Server-side signaling policy: participant, call state, device ownership, message size. */
import {safeSignal} from './core.mjs';
export function authorizeSignal({message,call,account,deviceId,lease}) {
 if (!safeSignal(message)) return 'invalid_signal';
 if (!call || ![call.caller_id,call.callee_id].includes(account)) return 'not_participant';
 if (call.status !== 'active') return 'call_not_active';
 if (!lease || lease.account_id !== account || lease.device_id !== deviceId || lease.call_id !== call.id) return 'device_not_owner';
 if (new Date(lease.expires_at).getTime() <= Date.now()) return 'lease_expired';
 return null;
}
export function signalEnvelope(message, fromDevice) {
 return {type:message.type,callId:message.callId,fromDevice,...(message.type==='ice'?{candidate:message.candidate}:{sdp:message.sdp})};
}
