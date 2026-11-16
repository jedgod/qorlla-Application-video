import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMeetingCode } from '../src/meeting-code.js';
import { MeetDirectoryClient } from '../src/readiness-meet.js';
import { admitTelephoneCall, type Readiness } from '../src/admission.js';

// Gate A5.3: one definition of a meeting code, used by admission, the authority and the directory client.
test('normalizeMeetingCode: exactly 11 or 12 digits, only a space or hyphen is removed, the digits are returned untouched', () => {
  assert.equal(normalizeMeetingCode('12345678901'), '12345678901'); assert.equal(normalizeMeetingCode('123456789012'), '123456789012'); assert.equal(normalizeMeetingCode('123 4567 8901'), '12345678901'); assert.equal(normalizeMeetingCode('1234-5678-9012'), '123456789012');
  assert.equal(normalizeMeetingCode('012345678901'), '012345678901'); assert.equal(normalizeMeetingCode('00000000000'), '00000000000');
  for (const bad of ['', '1234567890', '1234567890123', '1234567890a', 'a1234567890', '12345\t678901', '12345678901\n', '+12345678901', '12345678.901', '１２３４５６７８９０１', 12345678901, null, undefined, ['12345678901'], '1'.repeat(41)]) assert.equal(normalizeMeetingCode(bad), null, JSON.stringify(bad));
});

test('the directory client resolves 11- and 12-digit codes with the exact digits in the path, and never asks about anything else', async () => {
  const asked: string[] = [], c = new MeetDirectoryClient({ baseUrl: 'http://meet.test', bridgeSecret: 'x'.repeat(32), fetchImpl: (async (u: string) => { asked.push(u); return new Response(JSON.stringify({ meetingId: '11111111-1111-4111-8111-111111111111', sourceId: null, locked: false, waitingRoom: false }), { status: 200 }); }) as never });
  assert.ok(await c.resolve('012345678901')); assert.ok(await c.resolve('123 4567 8901')); assert.equal(await c.resolve('1234567890123'), null); assert.equal(await c.resolve('1234567890'), null); assert.equal(await c.resolve('12345678x01'), null);
  assert.deepEqual(asked, ['http://meet.test/api/integrations/phone/meetings/012345678901', 'http://meet.test/api/integrations/phone/meetings/12345678901']);
});

test('admission refuses a malformed code before anything else happens (no ledger claim, no authority call)', async () => {
  const calls: string[] = [], ready: Readiness = { carrierConnected: true, inboundNumberCertified: true, gatewayHealthy: true, mediaBridgeCertified: true, billingCertified: true, productionApproved: true, meetCertified: true } as never;
  const ledger = { claim: async () => { calls.push('claim'); return true; }, release: async () => undefined, transition: async () => true };
  const authority = { verifyPhoneJoin: async () => { calls.push('verify'); return { allowed: false, requiresHostApproval: false }; }, requestHostApproval: async () => false };
  const bridge = { connect: async () => undefined, disconnect: async () => undefined } as never;
  for (const meetingId of ['1234567890', '1234567890123', 'abcdefghijk', '12345678901x']) {
    const r = await admitTelephoneCall({ meetingId, passcode: '4321', callId: 'call_12345678', dialedNumber: '+12025550100' }, ready, authority as never, bridge, { ledger } as never).catch((e) => ({ error: String(e) }));
    assert.equal((r as { code?: string }).code, 'INVALID_JOIN_REQUEST', meetingId + ' -> ' + JSON.stringify(r));
  }
  assert.deepEqual(calls, [], 'nothing was claimed or verified');
});
