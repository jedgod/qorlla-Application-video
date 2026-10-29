import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedTransition, validExtension, validCallId, validIdempotencyKey, safeSignal, cleanCandidate, turnCredentials, iceServersFor, secretEquals, makeLimiter, callSeconds, ringSeconds } from '../src/core.mjs';

const ID = 'b00c477c-0b2e-42c5-ae21-211e14799322';
// ---- the five checks shipped with v1.0
test('valid extensions', () => { assert.equal(validExtension('2041'), true); assert.equal(validExtension('+12025550100'), false); });
test('state machine prevents backwards transitions', () => { assert.equal(allowedTransition('ringing', 'active'), true); assert.equal(allowedTransition('ended', 'active'), false); assert.equal(allowedTransition('active', 'ringing'), false); });
test('signal requires valid UUID', () => { assert.equal(safeSignal({ type: 'offer', callId: 'bad', sdp: 'x' }), false); });
test('rejects oversize SDP', () => { assert.equal(safeSignal({ type: 'offer', callId: ID, sdp: 'v=0' + 'a'.repeat(65537) }), false); });
test('rejects invalid ICE payload', () => { assert.equal(safeSignal({ type: 'ice', callId: ID, candidate: { candidate: 23 } }), false); });

// ---- additions
test('extensions are 3 to 8 digits only', () => { for (const v of ['123', '12345678']) assert.equal(validExtension(v), true); for (const v of ['12', '123456789', '12a', '', null, 123, '١٢٣']) assert.equal(validExtension(v), false); });
test('every terminal state is final and only ringing can become missed', () => {
  for (const s of ['rejected', 'missed', 'ended', 'failed']) for (const t of ['ringing', 'active', 'ended', 'rejected', 'missed', 'failed']) assert.equal(allowedTransition(s, t), false, s + '->' + t);
  assert.equal(allowedTransition('active', 'missed'), false); assert.equal(allowedTransition('ringing', 'missed'), true); assert.equal(allowedTransition('active', 'rejected'), false);
});
test('call ids and idempotency keys are validated', () => { assert.equal(validCallId(ID), true); assert.equal(validCallId(ID + 'x'), false); assert.equal(validIdempotencyKey('a'.repeat(12)), true); assert.equal(validIdempotencyKey('short'), false); assert.equal(validIdempotencyKey('has space has space'), false); });
test('signals: SDP must look like SDP; ICE fields are bounded', () => {
  assert.equal(safeSignal({ type: 'offer', callId: ID, sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' }), true); assert.equal(safeSignal({ type: 'offer', callId: ID, sdp: 'not sdp' }), false); assert.equal(safeSignal({ type: 'bye', callId: ID }), false);
  assert.equal(safeSignal({ type: 'ice', callId: ID, candidate: null }), true); assert.equal(safeSignal({ type: 'ice', callId: ID, candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 } }), true);
  assert.equal(safeSignal({ type: 'ice', callId: ID, candidate: { candidate: 'x', sdpMLineIndex: 99 } }), false); assert.equal(safeSignal({ type: 'ice', callId: ID, candidate: { candidate: 'x'.repeat(4096) } }), false); assert.equal(safeSignal({ type: 'ice', callId: ID, candidate: 'string' }), false);
});
test('only the standard candidate fields are forwarded', () => { assert.deepEqual(cleanCandidate({ candidate: 'c', sdpMid: '0', sdpMLineIndex: 1, evil: '<script>', __proto__: { x: 1 } }), { candidate: 'c', sdpMid: '0', sdpMLineIndex: 1, usernameFragment: null }); assert.equal(cleanCandidate(null), null); });
test('TURN credentials follow the coturn REST scheme and fail without a secret', () => {
  const c = turnCredentials('alice', 600, 1000, 's3cret'); assert.equal(c.username, '1600:alice'); assert.match(c.credential, /^[A-Za-z0-9+/]+=*$/); assert.equal(c.credential, turnCredentials('alice', 600, 1000, 's3cret').credential); assert.notEqual(c.credential, turnCredentials('alice', 600, 1000, 'other').credential);
  assert.throws(() => turnCredentials('alice', 600, 1000, ''), /turn_not_configured/);
});
test('ICE servers: nothing third-party by default, TURN only when really configured', () => {
  assert.deepEqual(iceServersFor('a', {}), { iceServers: [], iceTransportPolicy: 'all', stun: false, turn: false });                                     // no Google STUN, no empty TURN entry
  const r = iceServersFor('a', { STUN_URL: 'stun:turn.example:3478', TURN_URLS: 'turn:turn.example:3478?transport=udp, turns:turn.example:5349?transport=tcp, http://evil.example', TURN_SHARED_SECRET: 'x' }, 1000);
  assert.equal(r.iceServers.length, 2); assert.deepEqual(r.iceServers[1].urls, ['turn:turn.example:3478?transport=udp', 'turns:turn.example:5349?transport=tcp']); assert.ok(r.iceServers[1].username && r.iceServers[1].credential); assert.equal(r.turn, true);
  assert.equal(iceServersFor('a', { TURN_URLS: 'turn:t:3478' }).turn, false);                                                  // URLs without a secret are not used
});
test('ICE policy: TURN can be required and relay-only can be forced, and a misconfiguration fails closed instead of silently weakening privacy', () => {
  assert.throws(() => iceServersFor('a', { VOICE_REQUIRE_TURN: 'true' }), /turn_not_configured/); assert.throws(() => iceServersFor('a', { VOICE_RELAY_ONLY: 'true' }), /turn_not_configured/);
  assert.throws(() => iceServersFor('a', { VOICE_REQUIRE_TURN: 'true', TURN_URLS: 'turn:t:3478' }), /turn_not_configured/);                       // URLs without the secret are not a working relay
  const env = { TURN_URLS: 'turn:t:3478?transport=udp', TURN_SHARED_SECRET: 'x'.repeat(32), VOICE_REQUIRE_TURN: 'true', VOICE_RELAY_ONLY: 'true' };
  const r = iceServersFor('a', env, 1000); assert.equal(r.iceTransportPolicy, 'relay'); assert.equal(r.turn, true); assert.equal(iceServersFor('a', { ...env, VOICE_RELAY_ONLY: 'false' }, 1000).iceTransportPolicy, 'all');
});
test('emergency numbers are never extensions: they cannot be provisioned, dialled, invited or blocked', async () => {
  const { validExtension, isEmergencyNumber, EMERGENCY_NUMBERS } = await import('../src/core.mjs');
  for (const n of ['911', '112', '999', '000', '110', '119', '933']) { assert.equal(isEmergencyNumber(n), true, n); assert.equal(validExtension(n), false, n); }
  for (const n of ['2000', '9110', '1120', '911911', '020']) { assert.equal(validExtension(n), true, n); assert.equal(isEmergencyNumber(n), false, n); }
  assert.ok(EMERGENCY_NUMBERS.size >= 10); assert.equal(validExtension(911), false);
});
test('admin secret comparison is exact and handles any length', () => { assert.equal(secretEquals('a'.repeat(40), 'a'.repeat(40)), true); assert.equal(secretEquals('a'.repeat(40), 'a'.repeat(41)), false); assert.equal(secretEquals('', ''), false); assert.equal(secretEquals(undefined, 'x'), false); });
test('limiter allows a burst, refuses the excess, and recovers after the window', () => { let t = 0; const l = makeLimiter({ max: 3, windowMs: 1000, now: () => t }); assert.deepEqual([1, 2, 3, 4].map(() => l.take('k')), [true, true, true, false]); assert.equal(l.take('other'), true); t = 1001; assert.equal(l.take('k'), true); });
test('duration comes from server timestamps and is zero for unanswered calls', () => { assert.equal(callSeconds({ answered_at: null, ended_at: null }), 0); assert.equal(callSeconds({ answered_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:01:30Z' }), 90); });
test('ring timeout is bounded', () => { assert.equal(ringSeconds({}), 60); assert.equal(ringSeconds({ VOICE_RING_SECONDS: '30' }), 30); assert.equal(ringSeconds({ VOICE_RING_SECONDS: '1' }), 60); assert.equal(ringSeconds({ VOICE_RING_SECONDS: '99999' }), 60); });
