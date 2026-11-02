import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { normalizeMeetingId, normalizeE164, verifyWebhookHmac, deriveCapabilityState, canJoinOccurrence } from '../src/core.mjs';
test('11-digit meeting IDs preserve correct format', () => {
 assert.equal(normalizeMeetingId('123 4567 8901'), '12345678901');
 assert.throws(() => normalizeMeetingId('1234567890'), /INVALID_MEETING_ID/);
});
test('E164 destination validation', () => {
 assert.equal(normalizeE164('+1 (202) 555-0100'), '+12025550100');
 assert.throws(() => normalizeE164('2025550100'), /INVALID_E164/);
});
test('webhook HMAC verifies raw bytes', () => {
 const rawBody=Buffer.from('{"event":"ringing"}');
 const secret='test-secret';
 const signature=crypto.createHmac('sha256',secret).update(rawBody).digest('hex');
 assert.equal(verifyWebhookHmac({rawBody,signature,secret}),true);
 assert.equal(verifyWebhookHmac({rawBody:Buffer.from('changed'),signature,secret}),false);
});
test('phone meeting join stays disabled until bridge certified', () => {
 const state=deriveCapabilityState({providerConnected:true,provisionedDialInCount:2,assignedNumberCount:1,carrierCertified:true,bridgeCertified:false,billingCertified:false});
 assert.equal(state.phoneMeetingJoinEnabled,false);
});
test('meeting occurrence window and lock', () => {
 const meeting={startsAt:'2026-10-28T10:00:00Z',endsAt:'2026-10-28T11:00:00Z',phoneAccessEnabled:true,locked:false};
 assert.equal(canJoinOccurrence({meeting,now:new Date('2026-10-28T10:30:00Z')}),true);
 assert.equal(canJoinOccurrence({meeting:{...meeting,locked:true},now:new Date('2026-10-28T10:30:00Z')}),false);
});
