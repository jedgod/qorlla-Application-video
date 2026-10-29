// Telephony provider interface. A carrier adapter implements these; the rest of Qorlla never talks to a carrier directly.
import { TwilioProvider } from './twilio.mjs';
import { createInternalProvider } from './qorlla-internal.mjs';

export class TelephonyProvider {
  get name() { return 'none'; }
  get configured() { return false; }
  get capabilities() { return { internalExtensions: false, publicNumbers: false, pstn: false }; }       // see provider-contract.mjs: undeclared = false
  async healthCheck() { throw new Error('NOT_IMPLEMENTED'); }
  async listAvailableNumbers(_country, _type) { throw new Error('NOT_IMPLEMENTED'); }
  async provisionNumber(_request) { throw new Error('NOT_IMPLEMENTED'); }
  async releaseNumber(_providerNumberId) { throw new Error('NOT_IMPLEMENTED'); }
  async numberExists(_providerNumberId) { throw new Error('NOT_IMPLEMENTED'); }          // read-only: does the carrier still own this number? -> { exists }
  async findOwnedByE164(_e164) { throw new Error('NOT_IMPLEMENTED'); }                 // read-only: does the carrier account own this number? -> { providerNumberId, e164 } | null
  async startCall(_request) { throw new Error('NOT_IMPLEMENTED'); }
  async endCall(_providerCallId) { throw new Error('NOT_IMPLEMENTED'); }
  async fetchCall(_providerCallId) { throw new Error('NOT_IMPLEMENTED'); }
  verifyWebhook(_req) { throw new Error('NOT_IMPLEMENTED'); }
  parseWebhook(_params, _headers) { throw new Error('NOT_IMPLEMENTED'); }
}

// Intentionally inert: with no carrier configured nothing can be provisioned, dialled or reported as connected.
export class UnconfiguredProvider extends TelephonyProvider {
  get name() { return 'unconfigured'; }
  get capabilities() { return { internalExtensions: false, publicNumbers: false, pstn: false }; }
  async healthCheck() { return { ok: false, detail: 'No carrier is configured (set PHONE_CARRIER=twilio with TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN).' }; }
  async listAvailableNumbers() { return []; }
  async provisionNumber() { throw Object.assign(new Error('PROVIDER_NOT_CONFIGURED'), { code: 'PROVIDER_NOT_CONFIGURED', status: 503 }); }
  async releaseNumber() { throw Object.assign(new Error('PROVIDER_NOT_CONFIGURED'), { code: 'PROVIDER_NOT_CONFIGURED', status: 503 }); }
  async numberExists() { throw Object.assign(new Error('PROVIDER_NOT_CONFIGURED'), { code: 'PROVIDER_NOT_CONFIGURED', status: 503 }); }
  async findOwnedByE164() { throw Object.assign(new Error('PROVIDER_NOT_CONFIGURED'), { code: 'PROVIDER_NOT_CONFIGURED', status: 503 }); }
  async startCall() { throw Object.assign(new Error('PROVIDER_NOT_CONFIGURED'), { code: 'PROVIDER_NOT_CONFIGURED', status: 503 }); }
  async endCall() { throw Object.assign(new Error('PROVIDER_NOT_CONFIGURED'), { code: 'PROVIDER_NOT_CONFIGURED', status: 503 }); }
  async fetchCall() { throw Object.assign(new Error('PROVIDER_NOT_CONFIGURED'), { code: 'PROVIDER_NOT_CONFIGURED', status: 503 }); }
  verifyWebhook() { return false; }
  parseWebhook() { throw Object.assign(new Error('PROVIDER_NOT_CONFIGURED'), { code: 'PROVIDER_NOT_CONFIGURED', status: 503 }); }
}

// Media bridge (SIP/RTP <-> Qorlla Meet WebRTC) and browser audio gateway: interfaces only. No implementation exists in this repository, so both fail closed.
export class UnconfiguredBridge { get ready() { return false; } async join() { throw Object.assign(new Error('BRIDGE_NOT_CONFIGURED'), { code: 'BRIDGE_NOT_CONFIGURED', status: 503 }); } }
export class UnconfiguredAudioGateway { get ready() { return false; } outboundTwiml() { return null; } }

export function createCarrier(env = process.env, opts = {}) {
  const name = String(env.PHONE_CARRIER || '').toLowerCase();
  if (name === 'internal') return createInternalProvider(env) || new UnconfiguredProvider();       // Qorlla's own identities and extensions: no carrier, no public numbers, no PSTN
  if (name === 'twilio' && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN)
    return new TwilioProvider({ sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN, base: env.TWILIO_API_BASE || 'https://api.twilio.com', webhookBase: env.PHONE_PUBLIC_BASE || '', fetchImpl: opts.fetchImpl || fetch });
  return new UnconfiguredProvider();
}
