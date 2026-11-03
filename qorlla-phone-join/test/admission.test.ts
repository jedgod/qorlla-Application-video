import test from 'node:test';
import assert from 'node:assert/strict';
import { admitTelephoneCall, telephoneReady, READINESS_KEYS, type Readiness, type MeetingAuthority, type SipRtpBridge, type CallLedger } from '../src/admission.js';

const all: Readiness = { carrierConnected: true, inboundNumberCertified: true, gatewayHealthy: true, mediaBridgeCertified: true, billingCertified: true, productionApproved: true };
const request = { meetingId: 'ABC12345', passcode: '123456', callId: 'call_12345678', dialedNumber: '+12025550100' };
const open: MeetingAuthority = { verifyPhoneJoin: async () => ({ allowed: true, requiresHostApproval: false, meetingSessionId: 's1' }), requestHostApproval: async () => true };
const good = (log: string[] = []): SipRtpBridge => ({ attach: async () => { log.push('attach'); return { mediaEstablished: true }; }, disconnect: async () => { log.push('disconnect'); } });
const memoryLedger = (): CallLedger & { held: Set<string> } => { const held = new Set<string>(); return { held, claim: async (id) => (held.has(id) ? false : (held.add(id), true)), release: async (id) => { held.delete(id); } }; };

// ---------------------------------------------------------------- readiness: all six conditions, judged against the named list
test('disabled by default and never touches authority or bridge', async () => {
  let touched = false;
  const result = await admitTelephoneCall(request, { ...all, gatewayHealthy: false },
    { verifyPhoneJoin: async () => { touched = true; throw Error('unexpected'); }, requestHostApproval: async () => false },
    { attach: async () => { touched = true; throw Error('unexpected'); }, disconnect: async () => { touched = true; } });
  assert.equal(result.status, 503); assert.equal(result.code, 'PHONE_JOIN_UNAVAILABLE'); assert.equal(touched, false);
});
test('requires all six readiness gates', () => {
  assert.equal(READINESS_KEYS.length, 6);
  for (const key of READINESS_KEYS) assert.equal(telephoneReady({ ...all, [key]: false }), false, key);
  assert.equal(telephoneReady(all), true);
});
test('a missing, partial, truthy or malformed readiness is NOT ready (it used to count as ready)', async () => {
  for (const bad of [{}, { carrierConnected: true }, null, undefined, 'yes', 1, [], { ...all, billingCertified: 1 }, { ...all, productionApproved: 'true' }, { ...all, carrierConnected: undefined }]) assert.equal(telephoneReady(bad as any), false, JSON.stringify(bad));
  for (const key of READINESS_KEYS) { const partial: any = { ...all }; delete partial[key]; assert.equal(telephoneReady(partial), false, 'missing ' + key); }
  const log: string[] = []; const r = await admitTelephoneCall(request, {} as any, open, good(log));
  assert.equal(r.status, 503); assert.deepEqual(log, []);
});
test('extra readiness keys cannot compensate for a missing one', () => { const r: any = { ...all, somethingElse: true }; delete r.mediaBridgeCertified; assert.equal(telephoneReady(r), false); });

// ---------------------------------------------------------------- request validation
test('malformed requests are refused before the meeting service is asked', async () => {
  let asked = false; const authority: MeetingAuthority = { verifyPhoneJoin: async () => { asked = true; return { allowed: true, requiresHostApproval: false, meetingSessionId: 's' }; }, requestHostApproval: async () => true };
  const bad = [{ meetingId: 'abc' }, { meetingId: 'ABC 12345' }, { passcode: '12' }, { passcode: 'x'.repeat(129) }, { callId: 'short' }, { callId: 'call 12345678' }, { dialedNumber: '2025550100' }, { dialedNumber: '+0123456789' }, { dialedNumber: '+1202555010099999' }, { meetingId: 123 }, { passcode: null }];
  for (const patch of bad) { const r = await admitTelephoneCall({ ...request, ...patch } as any, all, authority, good()); assert.equal(r.code, 'INVALID_JOIN_REQUEST', JSON.stringify(patch)); assert.equal(r.status, 403); }
  assert.equal(asked, false);
});

// ---------------------------------------------------------------- meeting authorization
test('a wrong meeting or passcode is refused and never reaches the bridge', async () => {
  const log: string[] = [];
  for (const decision of [{ allowed: false, requiresHostApproval: false }, { allowed: true, requiresHostApproval: false }, { allowed: true, requiresHostApproval: false, meetingSessionId: '' }, null, { allowed: 'yes', requiresHostApproval: false, meetingSessionId: 's' }]) {
    const r = await admitTelephoneCall(request, all, { verifyPhoneJoin: async () => decision as any, requestHostApproval: async () => true }, good(log));
    assert.equal(r.code, 'JOIN_DENIED', JSON.stringify(decision)); assert.equal(r.status, 403);
  }
  assert.deepEqual(log, []);
});
test('host refusal prevents bridge attachment', async () => {
  const log: string[] = [];
  const r = await admitTelephoneCall(request, all, { verifyPhoneJoin: async () => ({ allowed: true, requiresHostApproval: true, meetingSessionId: 's1' }), requestHostApproval: async () => false }, good(log));
  assert.equal(r.code, 'HOST_APPROVAL_DENIED'); assert.deepEqual(log, []);
});
test('approval is required unless the meeting says explicitly that it is not', async () => {
  const log: string[] = []; let asked = 0;
  const authority = (flag: unknown): MeetingAuthority => ({ verifyPhoneJoin: async () => ({ allowed: true, requiresHostApproval: flag as any, meetingSessionId: 's1' }), requestHostApproval: async () => { asked++; return false; } });
  for (const flag of [true, undefined, null, 'no', 0]) { const r = await admitTelephoneCall(request, all, authority(flag), good(log)); assert.equal(r.code, 'HOST_APPROVAL_DENIED', String(flag)); }
  assert.equal(asked, 5); assert.deepEqual(log, []);
  assert.equal((await admitTelephoneCall(request, all, authority(false), good(log))).code, 'MEDIA_CONNECTED'); assert.equal(asked, 5);
});
test('a host who never answers is a refusal, and the call is never attached', async () => {
  const log: string[] = [];
  const r = await admitTelephoneCall(request, all, { verifyPhoneJoin: async () => ({ allowed: true, requiresHostApproval: true, meetingSessionId: 's1' }), requestHostApproval: () => new Promise(() => {}) }, good(log), { hostApprovalTimeoutMs: 40 });
  assert.equal(r.code, 'HOST_APPROVAL_TIMEOUT'); assert.equal(r.status, 403); assert.deepEqual(log, []);
});
test('only a literal true from the host approves', async () => {
  for (const answer of ['true', 1, {}, undefined]) {
    const r = await admitTelephoneCall(request, all, { verifyPhoneJoin: async () => ({ allowed: true, requiresHostApproval: true, meetingSessionId: 's1' }), requestHostApproval: async () => answer as any }, good());
    assert.equal(r.code, 'HOST_APPROVAL_DENIED', String(answer));
  }
});

// ---------------------------------------------------------------- unavailable services
test('the meeting service failing or hanging gives a 503 and nothing is attached', async () => {
  const log: string[] = [];
  const down = await admitTelephoneCall(request, all, { verifyPhoneJoin: async () => { throw new Error('db down'); }, requestHostApproval: async () => true }, good(log));
  assert.equal(down.status, 503); assert.equal(down.code, 'MEETING_SERVICE_UNAVAILABLE');
  const hung = await admitTelephoneCall(request, all, { verifyPhoneJoin: () => new Promise(() => {}), requestHostApproval: async () => true }, good(log), { stepTimeoutMs: 40 });
  assert.equal(hung.status, 503); assert.equal(hung.code, 'MEETING_SERVICE_UNAVAILABLE'); assert.deepEqual(log, []);
});
test('the host-approval service failing is a 503, not an approval', async () => {
  const log: string[] = [];
  const r = await admitTelephoneCall(request, all, { verifyPhoneJoin: async () => ({ allowed: true, requiresHostApproval: true, meetingSessionId: 's1' }), requestHostApproval: async () => { throw new Error('queue down'); } }, good(log));
  assert.equal(r.status, 503); assert.deepEqual(log, []);
});

// ---------------------------------------------------------------- media connection failures
test('cannot report success without established media', async () => {
  const log: string[] = [];
  for (const media of [{ mediaEstablished: false }, {}, null, { mediaEstablished: 'true' }]) {
    const r = await admitTelephoneCall(request, all, open, { attach: async () => media as any, disconnect: async () => { log.push('disconnect'); } });
    assert.equal(r.status, 503); assert.equal(r.code, 'MEDIA_UNAVAILABLE');
  }
  assert.equal(log.length, 4);
});
test('a bridge that throws or hangs is torn down, because it may have partly attached', async () => {
  const log: string[] = [];
  const threw = await admitTelephoneCall(request, all, open, { attach: async () => { throw new Error('SDP failed'); }, disconnect: async () => { log.push('disconnect'); } });
  assert.equal(threw.code, 'MEDIA_UNAVAILABLE');
  const hung = await admitTelephoneCall(request, all, open, { attach: () => new Promise(() => {}), disconnect: async () => { log.push('disconnect'); } }, { stepTimeoutMs: 40 });
  assert.equal(hung.code, 'MEDIA_UNAVAILABLE'); assert.deepEqual(log, ['disconnect', 'disconnect']);
});
test('a failing teardown does not turn a failed admission into a crash or a success', async () => {
  const r = await admitTelephoneCall(request, all, open, { attach: async () => ({ mediaEstablished: false }), disconnect: async () => { throw new Error('already gone'); } });
  assert.equal(r.status, 503);
});
test('authorized bridged call succeeds only with media', async () => {
  const log: string[] = []; const r = await admitTelephoneCall(request, all, open, good(log));
  assert.equal(r.code, 'MEDIA_CONNECTED'); assert.equal(r.status, 200); assert.deepEqual(log, ['attach']);
});

// ---------------------------------------------------------------- replay / idempotency
test('the same call id is admitted once; a replay is refused and cannot attach a second leg', async () => {
  const ledger = memoryLedger(), log: string[] = [];
  assert.equal((await admitTelephoneCall(request, all, open, good(log), { ledger })).code, 'MEDIA_CONNECTED');
  const again = await admitTelephoneCall(request, all, open, good(log), { ledger });
  assert.equal(again.status, 409); assert.equal(again.code, 'DUPLICATE_CALL'); assert.deepEqual(log, ['attach']);
});
test('a failed admission frees the call id so the gateway can retry; a connected one keeps it', async () => {
  const ledger = memoryLedger();
  assert.equal((await admitTelephoneCall(request, all, { verifyPhoneJoin: async () => ({ allowed: false, requiresHostApproval: false }), requestHostApproval: async () => true }, good(), { ledger })).code, 'JOIN_DENIED'); assert.equal(ledger.held.size, 0);
  assert.equal((await admitTelephoneCall(request, all, open, { attach: async () => ({ mediaEstablished: false }), disconnect: async () => {} }, { ledger })).code, 'MEDIA_UNAVAILABLE'); assert.equal(ledger.held.size, 0);
  assert.equal((await admitTelephoneCall(request, all, open, good(), { ledger })).code, 'MEDIA_CONNECTED'); assert.equal(ledger.held.size, 1);
});
test('two simultaneous requests with one call id: exactly one gets through', async () => {
  const ledger = memoryLedger(), log: string[] = [];
  const results = await Promise.all([1, 2, 3, 4].map(() => admitTelephoneCall(request, all, open, good(log), { ledger })));
  assert.equal(results.filter((r) => r.code === 'MEDIA_CONNECTED').length, 1); assert.equal(results.filter((r) => r.code === 'DUPLICATE_CALL').length, 3); assert.deepEqual(log, ['attach']);
});
test('a ledger that is down fails closed', async () => {
  const log: string[] = [];
  const r = await admitTelephoneCall(request, all, open, good(log), { ledger: { claim: async () => { throw new Error('redis down'); }, release: async () => {} } });
  assert.equal(r.status, 503); assert.deepEqual(log, []);
});
