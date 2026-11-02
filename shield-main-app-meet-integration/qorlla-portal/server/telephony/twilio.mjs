// Twilio Programmable Voice adapter. Everything here follows Twilio's published contracts:
//  - webhook authenticity: X-Twilio-Signature = base64(HMAC-SHA1(authToken, fullUrl + sorted(name+value of every POST param)))
//  - TwiML responses, REST calls with Basic auth, Voice SDK access tokens (HS256 JWT with a voice grant)
// The REST base can be overridden outside production only (tests use tests/fake-twilio.mjs, a TEST DOUBLE). No real call has been
// placed with this code: live verification needs a Twilio account, a provisioned number and the compliance acknowledgement.
import crypto from 'node:crypto';

export class ProviderError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
export const xml = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** Verify a webhook. `url` must be the PUBLIC url Twilio called (we build it from configuration, never from request headers). */
export function verifySignature({ authToken, url, params, signature }) {
  if (!authToken || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', authToken).update(data, 'utf8').digest();
  let given; try { given = Buffer.from(String(signature), 'base64'); } catch { return false; }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
export const signFor = ({ authToken, url, params }) => crypto.createHmac('sha1', authToken).update(url + Object.keys(params).sort().map((k) => k + params[k]).join(''), 'utf8').digest('base64');

export const twiml = (...verbs) => `<?xml version="1.0" encoding="UTF-8"?><Response>${verbs.join('')}</Response>`;
export const say = (text) => `<Say>${xml(text)}</Say>`;
export const hangup = () => '<Hangup/>';
export const gather = ({ action, prompt, digits = 1, timeout = 6 }) => `<Gather input="dtmf" numDigits="${digits}" timeout="${timeout}" action="${xml(action)}" method="POST">${say(prompt)}</Gather>`;
export const dial = ({ action, callerId, numbers, timeout = 20 }) => `<Dial action="${xml(action)}" method="POST" callerId="${xml(callerId)}" timeout="${timeout}">${numbers.map((n) => `<Number>${xml(n)}</Number>`).join('')}</Dial>`;
export const record = ({ action, statusCallback, maxLength = 120 }) => `<Record action="${xml(action)}" method="POST" maxLength="${maxLength}" playBeep="true" trim="trim-silence" recordingStatusCallback="${xml(statusCallback)}" recordingStatusCallbackMethod="POST" transcribe="true" transcribeCallback="${xml(statusCallback.replace(/recording$/, 'transcription'))}"/>`;

/** Voice SDK access token (so a signed-in user's browser can place calls through our TwiML application). */
export function accessToken({ accountSid, apiKeySid, apiKeySecret, twimlAppSid, identity, ttlSeconds = 600, now = () => Date.now() }) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); const iat = Math.floor(now() / 1000);
  const header = { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' };
  const payload = { jti: `${apiKeySid}-${iat}`, iss: apiKeySid, sub: accountSid, iat, exp: iat + ttlSeconds, grants: { identity, voice: { incoming: { allow: false }, outgoing: { application_sid: twimlAppSid } } } };
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${crypto.createHmac('sha256', apiKeySecret).update(input).digest('base64url')}`;
}

export function createTwilio({ accountSid, authToken, apiBase = 'https://api.twilio.com', fetchImpl = fetch }) {
  const auth = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  async function rest(method, path, form) {
    const r = await fetchImpl(`${apiBase}/2010-04-01/Accounts/${accountSid}${path}`, { method, headers: { authorization: auth, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined, signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new ProviderError(r.status, j.message || `provider HTTP ${r.status}`, j.code);
    return j;
  }
  return {
    name: 'twilio',
    placeCall: ({ to, from, url, statusCallback }) => rest('POST', '/Calls.json', { To: to, From: from, Url: url, StatusCallback: statusCallback, StatusCallbackMethod: 'POST', StatusCallbackEvent: 'initiated ringing answered completed' }),
    hangup: (sid) => rest('POST', `/Calls/${encodeURIComponent(sid)}.json`, { Status: 'completed' }),
    /** Voicemail audio lives at the provider and needs our credentials: the portal streams it after its own permission check. */
    async fetchRecording(url) {
      const u = new URL(url); const base = new URL(apiBase);
      if (u.origin !== base.origin) throw new ProviderError(400, 'recording url is not on the provider', 'bad_recording_url');   // never send credentials elsewhere
      const r = await fetchImpl(url.endsWith('.mp3') || url.endsWith('.wav') ? url : url + '.mp3', { headers: { authorization: auth }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new ProviderError(r.status, 'recording unavailable');
      return r;
    }
  };
}
