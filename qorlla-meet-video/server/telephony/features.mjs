// Provider-capability registry for call preferences. A saved preference is NOT an enforced one: it only becomes "active" after the carrier adapter applied it AND read it back.
// Today's Twilio adapter declares NO supported features (see twilio.mjs), so every feature honestly reports "saved, inactive". The pipeline below is real and tested with a fake carrier
// that does support them, so adding a real implementation later means filling in applyFeature/readFeature, not redesigning anything.
import crypto from 'node:crypto';
import { normalizeE164, err } from './core.mjs';

export const FEATURES = {
  forwarding: { label: 'Call forwarding' }, voicemail: { label: 'Voicemail' }, doNotDisturb: { label: 'Do not disturb' }, callWaiting: { label: 'Call waiting' },
  spamProtection: { label: 'Spam protection' }, blockedNumbers: { label: 'Blocked numbers' }, callerId: { label: 'Caller ID name' }
};
export const FEATURE_IDS = Object.keys(FEATURES);
const bool = (v) => v === true;
// Hash over a CANONICAL form (keys sorted): PostgreSQL jsonb reorders keys, so the same setting must hash the same however it was read.
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
export const hashOf = (cfg) => crypto.createHash('sha256').update(JSON.stringify(canon(cfg))).digest('hex');

// Validate what the main app sends. Only known features and known fields survive; everything is bounded.
export function cleanDesired(input) {
  const i = input && typeof input === 'object' ? input : {}, out = {};
  for (const id of FEATURE_IDS) {
    if (!(id in i)) continue; const v = i[id] && typeof i[id] === 'object' ? i[id] : {};
    if (id === 'forwarding') { const on = bool(v.enabled); out[id] = on ? { enabled: true, to: normalizeE164(v.to) } : { enabled: false }; }
    else if (id === 'voicemail') out[id] = bool(v.enabled) ? { enabled: true, greeting: String(v.greeting || '').slice(0, 300) } : { enabled: false };
    else if (id === 'blockedNumbers') { const n = Math.max(0, Math.min(100, Math.round(Number(v.count) || 0))); out[id] = n > 0 && bool(v.enabled) ? { enabled: true, count: n } : { enabled: false }; }
    else if (id === 'callerId') { const name = String(v.name || '').slice(0, 40).trim(); out[id] = bool(v.enabled) && name ? { enabled: true, name } : { enabled: false }; }
    else out[id] = { enabled: bool(v.enabled) };
  }
  return out;
}

export const featureSupport = (carrier) => (carrier && carrier.features instanceof Set ? carrier.features : new Set());

// Why a preference is or is not enforced, in plain words. Evaluated every time from live evidence.
export function evaluateFeature({ desired, record, providerConfigured, providerActive, flagOn, hasNumber, supported }) {
  if (!desired || !desired.enabled) return { state: 'off', reason: 'Not turned on.' };
  if (!providerConfigured) return { state: 'inactive', reason: 'No carrier is connected, so this is saved but not enforced.' };
  if (!providerActive) return { state: 'inactive', reason: 'The carrier connection is not verified yet, so this is saved but not enforced.' };
  if (!flagOn) return { state: 'inactive', reason: 'Applying settings to the carrier is switched off (PHONE_FEATURES).' };
  if (!hasNumber) return { state: 'inactive', reason: 'You have no Qorlla number for this to apply to.' };
  if (!supported) return { state: 'inactive', reason: 'This carrier connection cannot enforce this setting yet.' };
  if (!record || record.state === 'requested' || record.state === 'off') return { state: 'pending', reason: 'Being applied at the carrier.' };
  if (record.state === 'active') return { state: 'active', reason: 'Confirmed by the carrier' + (record.confirmed_at ? ' ' + new Date(record.confirmed_at).toISOString() : '') + '.' };
  if (record.state === 'drift') return { state: 'drift', reason: 'The carrier\'s setting differs from yours; it is being corrected.' };
  return { state: 'failed', reason: 'The carrier did not accept it' + (record.error_code ? ' (' + record.error_code + ')' : '') + '.' };
}
export { err };
