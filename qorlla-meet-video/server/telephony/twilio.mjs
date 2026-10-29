// Twilio Programmable Voice adapter, using Twilio's documented REST API and webhook signature scheme directly (no SDK dependency).
// STATUS: implemented and tested against a local stand-in for the Twilio API. It has NOT been run against real Twilio: that is certification step T01-T03.
// The account token never leaves this object: it is not logged and not included in any error or health-check result.
import crypto from 'node:crypto';

const providerError = (code, status, detail) => Object.assign(new Error(detail || code), { code, status: status && status >= 400 && status < 600 ? 502 : 502, providerStatus: status });

export class TwilioProvider {
  constructor({ sid, token, base = 'https://api.twilio.com', webhookBase = '', fetchImpl = fetch }) {
    if (!/^AC[0-9a-zA-Z]{8,64}$/.test(String(sid || ''))) throw new Error('TWILIO_ACCOUNT_SID is not valid');
    this.sid = sid; this.base = String(base).replace(/\/+$/, ''); this.webhookBase = String(webhookBase || '').replace(/\/+$/, ''); this.fetch = fetchImpl;
    this.auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
    this.verifyToken = (url, params, signature) => verifySignature({ token, url, params, signature });   // token stays in this closure
  }
  get name() { return 'twilio'; }
  get configured() { return true; }
  get webhookConfigured() { return /^https:\/\//.test(this.webhookBase) || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(this.webhookBase); }
  async #req(method, path, form, query) {
    const url = this.base + '/2010-04-01/Accounts/' + this.sid + path + (query ? '?' + new URLSearchParams(query) : '');
    let r; try { r = await this.fetch(url, { method, headers: { authorization: this.auth, accept: 'application/json', ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined, signal: AbortSignal.timeout(15000) }); }
    catch (e) { throw providerError('PROVIDER_UNREACHABLE', 0, 'The carrier could not be reached.'); }
    if (r.status === 204) return {};
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw providerError(r.status === 401 ? 'PROVIDER_AUTH_FAILED' : r.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_REJECTED', r.status, 'The carrier refused the request (HTTP ' + r.status + (data.code ? ', code ' + data.code : '') + ').');
    return data;
  }
  async healthCheck() {
    try { const a = await this.#req('GET', '.json'); return { ok: a.status === 'active', detail: a.status === 'active' ? 'Carrier account is active.' : 'Carrier account status: ' + String(a.status || 'unknown'), accountType: a.type || null }; }
    catch (e) { return { ok: false, detail: e.code === 'PROVIDER_AUTH_FAILED' ? 'The carrier rejected the credentials.' : e.message }; }
  }
  async listAvailableNumbers(country, type = 'Local') {
    if (!/^[A-Z]{2}$/.test(country)) throw providerError('INVALID_COUNTRY', 400);
    const d = await this.#req('GET', '/AvailablePhoneNumbers/' + country + '/' + (type === 'TollFree' ? 'TollFree' : 'Local') + '.json', null, { VoiceEnabled: 'true', PageSize: '20' });
    return (d.available_phone_numbers || []).map((n) => ({ e164: n.phone_number, locality: n.locality || '', region: n.region || '', voice: !!(n.capabilities && n.capabilities.voice) })).filter((n) => /^\+[1-9]\d{7,14}$/.test(n.e164));
  }
  async provisionNumber({ e164, friendlyName }) {
    const form = { PhoneNumber: e164, FriendlyName: String(friendlyName || 'Qorlla').slice(0, 60) };
    if (this.webhookBase) { form.VoiceUrl = this.webhookBase + '/api/telephony/webhooks/twilio/voice'; form.VoiceMethod = 'POST'; form.StatusCallback = this.webhookBase + '/api/telephony/webhooks/twilio/status'; form.StatusCallbackMethod = 'POST'; }
    const n = await this.#req('POST', '/IncomingPhoneNumbers.json', form);
    if (!n.sid || !/^\+[1-9]\d{7,14}$/.test(n.phone_number || '')) throw providerError('PROVIDER_BAD_RESPONSE', 200, 'The carrier did not confirm the number.');
    return { providerNumberId: n.sid, e164: n.phone_number };
  }
  async releaseNumber(providerNumberId) { await this.#req('DELETE', '/IncomingPhoneNumbers/' + encodeURIComponent(providerNumberId) + '.json'); return { released: true }; }
  async startCall({ from, to, url, statusCallback }) {
    const c = await this.#req('POST', '/Calls.json', { From: from, To: to, Url: url, Method: 'POST', StatusCallback: statusCallback, StatusCallbackMethod: 'POST', StatusCallbackEvent: 'initiated ringing answered completed' });
    if (!c.sid) throw providerError('PROVIDER_BAD_RESPONSE', 200, 'The carrier did not return a call id.'); return { providerCallId: c.sid, status: c.status };
  }
  async endCall(providerCallId) { await this.#req('POST', '/Calls/' + encodeURIComponent(providerCallId) + '.json', { Status: 'completed' }); return { ended: true }; }
  async fetchCall(providerCallId) {
    const c = await this.#req('GET', '/Calls/' + encodeURIComponent(providerCallId) + '.json');
    return { status: c.status, durationSeconds: c.duration == null ? null : Number(c.duration), price: c.price == null ? null : Math.abs(Number(c.price)), priceUnit: c.price_unit || null, direction: c.direction || '' };
  }
  // Twilio signs the full URL it requested (query string included) plus every POST parameter, sorted by name, with HMAC-SHA1 and the account token (base64, X-Twilio-Signature).
  verifyWebhook({ url, params, signature }) { return this.verifyToken(url, params, signature); }
  parseWebhook(params, headers = {}) {
    const p = params || {}, token = String(headers['i-twilio-idempotency-token'] || '');
    const basis = [p.CallSid || p.CallSidLegacy || '', p.CallStatus || '', p.SequenceNumber || '', p.Timestamp || '', p.Digits ? 'd' : ''].join('|');
    return { eventId: token || 'tw-' + crypto.createHash('sha256').update(basis + '|' + (headers.__path || '')).digest('hex').slice(0, 40), providerCallId: String(p.CallSid || ''), status: String(p.CallStatus || ''), from: String(p.From || ''), to: String(p.To || ''), direction: String(p.Direction || ''),
      digits: p.Digits == null ? '' : String(p.Digits), duration: p.CallDuration == null ? null : Number(p.CallDuration), sequence: p.SequenceNumber == null ? null : Number(p.SequenceNumber), timestamp: p.Timestamp || null };
  }
}

export function twilioSignature({ token, url, params }) {
  const data = Object.keys(params || {}).sort().reduce((s, k) => s + k + (Array.isArray(params[k]) ? params[k].join('') : params[k]), String(url));
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
}
export function verifySignature({ token, url, params, signature }) {
  if (!token || !signature || typeof signature !== 'string') return false;
  const expected = Buffer.from(twilioSignature({ token, url, params })), got = Buffer.from(signature);
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}
