import test from 'node:test';
import assert from 'node:assert/strict';
import { audioVerified, verifiedBridge, type AudioEvidence, type MediaGateway } from '../src/media-contract.js';
import { admitTelephoneCall, type Readiness, type MeetingAuthority } from '../src/admission.js';

const NOW = 1_800_000_000_000, policy = { now: () => NOW };
const good: AudioEvidence = { state: 'audio_flowing', inboundPackets: 120, outboundPackets: 118, observedMs: 2400, codec: 'opus', encrypted: true, measuredAt: NOW - 200 };
const all: Readiness = { carrierConnected: true, inboundNumberCertified: true, gatewayHealthy: true, mediaBridgeCertified: true, billingCertified: true, productionApproved: true };
const open: MeetingAuthority = { verifyPhoneJoin: async () => ({ allowed: true, requiresHostApproval: false, meetingSessionId: 's1' }), requestHostApproval: async () => true };
const request = { meetingId: '12345678901', passcode: '12345678', callId: 'call_12345678', dialedNumber: '+12025550100' };

test('audio is verified only by live, fresh, encrypted, two-way packets in an allowed codec', () => {
  assert.equal(audioVerified(good, policy), true);
  const bad: [string, Partial<AudioEvidence> | null][] = [
    ['not flowing', { state: 'ice_connected' }], ['degraded', { state: 'degraded' }], ['no inbound audio', { inboundPackets: 0 }], ['no outbound audio', { outboundPackets: 0 }], ['too few packets', { inboundPackets: 5 }], ['too short', { observedMs: 100 }],
    ['unencrypted', { encrypted: false }], ['unknown codec', { codec: 'g729' }], ['stale', { measuredAt: NOW - 60_000 }], ['from the future', { measuredAt: NOW + 60_000 }], ['NaN packets', { inboundPackets: NaN }], ['string packets', { outboundPackets: '200' as any }], ['missing', null]];
  for (const [why, patch] of bad) assert.equal(audioVerified(patch === null ? null : { ...good, ...patch }, policy), false, why);
  assert.equal(audioVerified(undefined, policy), false); assert.equal(audioVerified({} as any, policy), false);
});
test('signalling is not audio: a gateway that connects but hears nothing never produces MEDIA_CONNECTED', async () => {
  const log: string[] = [];
  const silent: MediaGateway = { start: async () => ({ ...good, state: 'ice_connected', inboundPackets: 0, outboundPackets: 0, observedMs: 0 }), stop: async (id, why) => { log.push('stop:' + why); }, onEnded: () => {} };
  const r = await admitTelephoneCall(request, all, open, verifiedBridge(silent, policy)); assert.equal(r.status, 503); assert.equal(r.code, 'MEDIA_UNAVAILABLE'); assert.deepEqual(log, ['stop:admission_disconnect'], 'and the leg is torn down');
  const oneWay: MediaGateway = { start: async () => ({ ...good, outboundPackets: 0 }), stop: async () => {}, onEnded: () => {} }; assert.equal((await admitTelephoneCall(request, all, open, verifiedBridge(oneWay, policy))).code, 'MEDIA_UNAVAILABLE');
});
test('verified two-way audio is MEDIA_CONNECTED', async () => {
  const gw: MediaGateway = { start: async () => good, stop: async () => {}, onEnded: () => {} }; assert.equal((await admitTelephoneCall(request, all, open, verifiedBridge(gw, policy))).code, 'MEDIA_CONNECTED');
});
test('the abort signal reaches the gateway, and a gateway that rejects or hangs is a media failure', async () => {
  let signal: AbortSignal | undefined; const hang: MediaGateway = { start: (_c, _s, o) => { signal = o.signal; return new Promise(() => {}); }, stop: async () => {}, onEnded: () => {} };
  assert.equal((await admitTelephoneCall(request, all, open, verifiedBridge(hang, policy), { stepTimeoutMs: 30 })).code, 'MEDIA_UNAVAILABLE'); assert.equal(signal?.aborted, true);
  const rejects: MediaGateway = { start: async () => { throw new Error('SDP rejected'); }, stop: async () => {}, onEnded: () => {} }; assert.equal((await admitTelephoneCall(request, all, open, verifiedBridge(rejects, policy))).code, 'MEDIA_UNAVAILABLE');
});
