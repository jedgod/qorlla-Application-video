// Inbound IVR for the shared dial-in numbers (TwiML). The call is reached only by a number Qorlla provisioned; the meeting rules (PIN, attempt limits, waiting room, host admit/deny,
// lock, end, recording consent) are the existing Qorlla Phone rules in phone.mjs, reused unchanged. FAIL CLOSED: until a media bridge is installed AND certified, callers are told
// joining by phone is not available and the call ends. Nothing here ever claims a telephone caller is in the meeting audio without a bridge that says so.
import { normalizeMeetingId } from './core.mjs';

const GENERIC = 'We could not connect you to that meeting. Check the meeting ID and PIN and try again.';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const R = (inner) => '<?xml version="1.0" encoding="UTF-8"?><Response>' + inner + '</Response>';
const say = (t) => '<Say>' + esc(t) + '</Say>';
const HANG = '<Hangup/>';

export async function voiceTwiml({ db, phone, bridge, audio, params, query, base, gateCertified }) {
  if (query.intent) {                                              // the answered leg of a call Qorlla placed: needs a browser voice gateway, which fails closed
    const t = audio.ready ? audio.outboundTwiml({ intent: String(query.intent) }) : null;
    return R(t || say('Calling is not available right now.') + HANG);
  }
  const callSid = String(params.CallSid || ''), from = String(params.From || ''), to = String(params.To || '');
  const { rowCount } = await db.query("SELECT 1 FROM qphone_numbers WHERE e164=$1 AND kind='dialin' AND state='active'", [to]);
  if (!rowCount) return R('<Reject reason="rejected"/>');         // not one of our dial-in numbers
  if (!bridge.ready || !gateCertified) return R(say('Joining meetings by telephone is not available yet. Please join from the Qorlla app or website.') + HANG);
  const step = String(query.step || 'id'), attempt = Math.max(0, Math.min(5, Number(query.a) || 0)), url = (s, extra = '') => esc(base + '/api/telephony/webhooks/twilio/voice?step=' + s + extra);
  const gather = (action, prompt) => '<Gather input="dtmf" finishOnKey="#" timeout="10" action="' + url(action.step, action.extra) + '" method="POST">' + say(prompt) + '</Gather>' + say('We did not receive any input. Goodbye.') + HANG;
  const digits = String(params.Digits || '');
  if (step === 'id') {
    if (!digits) return R(gather({ step: 'id', extra: '&a=' + attempt }, 'Enter the 11-digit meeting ID, followed by pound.'));
    let id; try { id = normalizeMeetingId(digits); } catch { return attempt >= 2 ? R(say(GENERIC) + HANG) : R(say(GENERIC) + gather({ step: 'id', extra: '&a=' + (attempt + 1) }, 'Enter the 11-digit meeting ID, followed by pound.')); }
    return R(gather({ step: 'pin', extra: '&m=' + id + '&a=0' }, 'Enter the telephone access PIN, followed by pound.'));
  }
  if (step === 'pin') {
    let id; try { id = normalizeMeetingId(query.m); } catch { return R(say(GENERIC) + HANG); }
    if (!digits) return R(gather({ step: 'pin', extra: '&m=' + id + '&a=' + attempt }, 'Enter the telephone access PIN, followed by pound.'));
    const r = await phone.verifyCall({ eventId: 'tw-' + callSid + '-p' + attempt, callId: callSid, from, meetingId: id, pin: digits }, 'twilio');
    if (r.result === 'denied' || r.result === 'locked') return attempt >= 2 || r.result === 'locked' ? R(say(GENERIC) + HANG) : R(say(GENERIC) + gather({ step: 'pin', extra: '&m=' + id + '&a=' + (attempt + 1) }, 'Enter the telephone access PIN, followed by pound.'));
    if (r.result === 'waiting') return R(say(r.say) + '<Pause length="10"/><Redirect method="POST">' + url('wait', '&m=' + id + '&a=0') + '</Redirect>');
    return R(say(r.say) + (r.recordingNotice ? say(r.consentPrompt) : '') + await bridge.join({ callSid, meetingId: id, callRef: r.callRef }));
  }
  if (step === 'wait') {
    const st = await phone.statusOf(callSid, 'twilio');
    if (st === 'connected') return R(say('The host let you in.') + await bridge.join({ callSid, meetingId: String(query.m || ''), callRef: null }));
    if (st === 'waiting' && attempt < 30) return R('<Pause length="10"/><Redirect method="POST">' + url('wait', '&m=' + esc(String(query.m || '')) + '&a=' + (attempt + 1)) + '</Redirect>');
    return R(say(st === 'waiting' ? 'The host did not let you in. Goodbye.' : GENERIC) + HANG);
  }
  return R(say(GENERIC) + HANG);
}
