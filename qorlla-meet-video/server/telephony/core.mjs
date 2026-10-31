// Qorlla Telephony v2: pure rules (no I/O). Adapted from the qorlla-telephony-v2 reference package; everything here fails closed.
import crypto from 'node:crypto';

export const err = (code, message, status = 400) => Object.assign(new Error(message || code), { code, status });

export function normalizeMeetingId(input) {                         // Qorlla meeting IDs are exactly 11 digits (spaces and dashes allowed when typed)
  const digits = String(input ?? '').replace(/[\s-]/g, '');
  if (!/^\d{11}$/.test(digits)) throw err('INVALID_MEETING_ID', 'The meeting ID must have 11 digits.');
  return digits;
}
export function normalizeE164(input) {
  const value = String(input ?? '').replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(value)) throw err('INVALID_E164', 'Enter an international number such as +12025550100.');
  return value;
}
export function assertAdmin(actor) { if (!actor || !actor.id || actor.admin !== true) throw err('FORBIDDEN', 'Only administrators can do this.', 403); }
// Read-only Number Authority access: an administrator OR an account the main app marked `viewer`. It grants READS only; every mutation still calls assertAdmin, which a viewer can never satisfy.
export function assertViewer(actor) { if (!actor || !actor.id || (actor.admin !== true && actor.viewer !== true)) throw err('FORBIDDEN', 'Only administrators or Number Authority viewers can do this.', 403); }
export function assertActor(actor) { if (!actor || !actor.id) throw err('UNAUTHENTICATED', 'Sign in first.', 401); }

// Regions Qorlla knows. A region being listed says nothing about numbers: availability always comes from the carrier.
export const COUNTRIES = { US: '1', CA: '1', GB: '44', IE: '353', GH: '233', NG: '234', KE: '254', UG: '256', TZ: '255', ZA: '27', EG: '20', SN: '221', CI: '225', IN: '91', SG: '65', JP: '81', AU: '61', NZ: '64', AE: '971', DE: '49', FR: '33', ES: '34', IT: '39', NL: '31', SE: '46', CH: '41', PT: '351', PL: '48', BR: '55', MX: '52' };
export function countryOfE164(e164) {
  const d = e164.slice(1); let best = null;
  for (const [cc, dial] of Object.entries(COUNTRIES)) if (d.startsWith(dial) && (!best || dial.length > COUNTRIES[best].length)) best = cc;
  return best;
}
export const allowedCountries = (env) => new Set(String(env.PHONE_ALLOWED_COUNTRIES || 'US,CA,GB').split(',').map((s) => s.trim().toUpperCase()).filter((c) => COUNTRIES[c]));

// Fraud and abuse screen for destinations: premium-rate and satellite prefixes, and emergency numbers, are never dialled from Qorlla.
const BLOCKED_PREFIXES = ['+1900', '+1976', '+1809', '+1829', '+1849', '+44909', '+44908', '+44871', '+44872', '+44873', '+4490', '+882', '+883', '+881', '+979', '+870', '+800', '+808', '+888', '+878'];
const EMERGENCY = new Set(['+911', '+999', '+112', '+1911', '+44999', '+44112']);
export function screenDestination(e164, env = process.env) {
  if (EMERGENCY.has(e164)) return { ok: false, code: 'EMERGENCY_NUMBER', message: 'Qorlla cannot place emergency calls. Use a regular phone.' };
  const bad = BLOCKED_PREFIXES.find((p) => e164.startsWith(p)); if (bad) return { ok: false, code: 'DESTINATION_BLOCKED', message: 'Calls to premium-rate or satellite numbers are blocked.' };
  const cc = countryOfE164(e164); if (!cc) return { ok: false, code: 'COUNTRY_UNKNOWN', message: 'Calling that country is not supported.' };
  if (!allowedCountries(env).has(cc)) return { ok: false, code: 'COUNTRY_NOT_ALLOWED', message: 'International calling to that country is not allowed for this workspace.' };
  return { ok: true, country: cc };
}

// Call state machine: carriers deliver events out of order and more than once, so a call only ever moves forward.
export const RANK = { queued: 0, placing: 1, ringing: 2, connected: 3, completed: 4, failed: 4, cancelled: 4 };
export const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
export function nextState(current, incoming) { return RANK[incoming] > RANK[current] ? incoming : current; }
export function fromTwilioStatus(s) { return { queued: 'placing', initiated: 'placing', ringing: 'ringing', 'in-progress': 'connected', answered: 'connected', completed: 'completed', busy: 'failed', 'no-answer': 'failed', failed: 'failed', canceled: 'cancelled' }[String(s || '').toLowerCase()] || null; }

export function canJoinOccurrence({ meeting, now = new Date() }) {
  if (!meeting || !meeting.phoneAccessEnabled || meeting.locked || meeting.endedAt) return false;
  const start = new Date(meeting.startsAt).getTime(), end = new Date(meeting.endsAt).getTime(), t = now.getTime();
  return Number.isFinite(start) && Number.isFinite(end) && t >= start - 15 * 60_000 && t < end;
}
export function verifyWebhookHmac({ rawBody, signature, secret }) {   // generic HMAC-SHA256; a real carrier adapter implements the carrier's own scheme (see twilio.mjs)
  if (!Buffer.isBuffer(rawBody) || !secret || !signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  return crypto.timingSafeEqual(crypto.createHmac('sha256', secret).update(rawBody).digest(), Buffer.from(signature, 'hex'));
}

// What each capability needs before it may say "active". Evidence comes from the database, never from configuration alone.
export function deriveCapabilities(e) {
  const off = (g, msg) => ((e.flagsOff || []).includes(g) ? 'Certified, but switched off by the PHONE_FEATURES setting.' : msg);   // an independent feature flag, on top of the certified gate
  const providerActive = !!(e.providerConfigured && e.healthOk && e.webhookVerified);
  const row = (status, detail, proof = []) => ({ status, detail, proof });
  const provider = !e.providerConfigured ? row('not_connected', 'No carrier is configured on this server.')
    : !e.healthOk ? row('not_connected', 'A carrier is configured but its API has not passed a health check. Run Test connection.')
    : !e.webhookVerified ? row('pending', 'The carrier API answered, but no signed webhook has been received yet, so webhook configuration is unproven.', ['API health check passed ' + (e.healthCheckedAt || '')])
    : row('active', 'Carrier API and signed webhooks verified.', ['API health check ' + e.healthCheckedAt, 'Signed webhook received ' + e.webhookVerifiedAt]);
  const dialin = !providerActive ? row('not_connected', 'Needs a connected carrier.')
    : e.dialInCount === 0 ? row('not_connected', 'No shared dial-in numbers are provisioned.')
    : !e.gates.dialin ? row('pending', off('dialin', e.dialInCount + ' provider-confirmed dial-in number(s), but inbound routing is not certified.'), [e.dialInCount + ' active dial-in number(s)'])
    : row('active', e.dialInCount + ' dial-in number(s) with certified inbound routing.', ['Certified ' + e.gates.dialin]);
  const carrier = !providerActive ? row('off', 'Needs a connected carrier.')
    : !e.gates.carrier ? row('off', off('carrier', 'Inbound and outbound calling is not certified.'))
    : row('active', 'Inbound and outbound calls certified.', ['Certified ' + e.gates.carrier]);
  const number = e.personalNumbers > 0 ? row('active', e.personalNumbers + ' number(s) confirmed by the carrier.', ['Provider-confirmed assignment']) : row('unassigned', 'No number is assigned to you.');
  const bridge = !e.bridgeReady ? row('not_built', 'No SIP/RTP-to-Qorlla media gateway is installed. Telephone audio cannot reach the meeting.')
    : !e.gates.bridge ? row('pending', off('bridge', 'A media gateway is installed but two-way meeting audio is not certified.'))
    : row('active', 'Two-way telephone audio certified.', ['Certified ' + e.gates.bridge]);
  const billing = !e.gates.billing ? row('not_connected', off('billing', 'Telephony billing is not certified. Paid calling stays off.'))
    : e.reconciledUsage === 0 ? row('pending', 'Billing is certified but no provider usage has been reconciled yet.')
    : row('active', e.reconciledUsage + ' usage record(s) reconciled with provider charges.', ['Certified ' + e.gates.billing]);
  return { provider, dialin, carrier, number, bridge, billing,
    callingEnabled: provider.status === 'active' && carrier.status === 'active' && billing.status === 'active',
    phoneMeetingJoinEnabled: provider.status === 'active' && dialin.status === 'active' && bridge.status === 'active' };
}
