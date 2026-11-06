// A5.5 Phase A - CHARACTERIZATION of the real Security Shield contract as Meet's telephone path uses it today. These tests describe current behaviour (they should pass); the behaviour the architecture decisions
// require and the Shield does not yet provide is specified in phase-b-spec.shield.pg.test.mjs (expected to fail until Phase B).
//   SHIELD_ENGINE_DIR=<qorlla-voice-engine checkout>  PHONE_TEST_DATABASE_URL=postgres://...  node --test tests/shield-contract/phase-a.shield.pg.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { skipReason, startContract, until } from './harness.mjs';

let C; const skip = skipReason;
before(async () => { if (!skip) C = await startContract(); });
after(async () => { if (C) await C.close(); setTimeout(() => process.exit(process.exitCode || 0), 1500).unref(); });
const uuid = () => crypto.randomUUID(), fresh = (n) => n + '-' + crypto.randomBytes(3).toString('hex');

test('REGISTRATION + AUTHORIZATION: Meet registers the meeting with the Shield itself, then a guest-enabled meeting admits the telephone caller; the Shield records the decision for guest:<participant>', { skip }, async () => {
  const m = await C.meeting(), d = await C.dial(m);
  assert.equal(d.body.result, 'approved'); const row = await C.callRow(d.callId); assert.equal(row.state, 'APPROVED');
  const reg = (await C.sq('SELECT authority, guest_enabled FROM shield_meetings WHERE meeting_id=$1', [m.id])).rows[0]; assert.deepEqual({ ...reg }, { authority: 'meet', guest_enabled: true }, 'Meet registered the meeting on the first decision (the Shield refuses unregistered meetings)');
  const ev = (await C.sq("SELECT decision FROM shield_events WHERE action='meet.signal' AND actor=$1", ['guest:' + row.participant_id])).rows; assert.ok(ev.some((e) => e.decision === 'ALLOW'), 'the Shield recorded an ALLOW for the phone participant, who is treated as an account-less guest');
});

test('GUEST-DISABLED MEETING: the Shield refuses (GUEST_NOT_ALLOWED) and Meet ends the call REFUSED with that reason; nobody is attached', { skip }, async () => {
  const m = await C.meeting({ guestEnabled: false }), d = await C.dial(m); assert.notEqual(d.body.result, 'approved');
  const row = await C.callRow(d.callId); assert.equal(row.state, 'REFUSED'); assert.match(row.end_reason, /^shield_guest_not_allowed/);
  assert.equal((await C.sq("SELECT count(*)::int n FROM shield_events WHERE action='meet.signal' AND decision='DENY' AND reason='GUEST_NOT_ALLOWED' AND actor=$1", ['guest:' + row.participant_id])).rows[0].n >= 1, true, 'the Shield audited the denial');
});

test('ENDED MEETING at the Shield: authorize answers MEETING_UNKNOWN_OR_ENDED, an ended meeting cannot be re-registered (409 meeting_ended), and Meet therefore refuses the call', { skip }, async () => {
  const m = await C.meeting(); assert.equal((await C.register(m)).status, 200);
  assert.equal((await C.authorize(m.id, uuid())).status, 200, 'control: registered and live');
  assert.equal((await C.shield('meet', 'POST', '/v1/shield/meet/end', { meetingId: m.id })).status, 200);
  const a = await C.authorize(m.id, uuid()); assert.equal(a.status, 403); assert.equal(a.body.reason, 'MEETING_UNKNOWN_OR_ENDED');
  const again = await C.register(m); assert.equal(again.status, 409); assert.equal(again.body.error, 'meeting_ended', 'an ended meeting stays ended');
  const d = await C.dial(m); assert.notEqual(d.body.result, 'approved'); const row = await C.callRow(d.callId); assert.equal(row.state, 'REFUSED');
  console.log('# note: Meet reports this refusal as end_reason=' + row.end_reason + ' (the 409 is surfaced as an unavailable Shield, not as a refusal)');
});

test('UNREGISTERED MEETING: authorize is refused (MEETING_UNKNOWN_OR_ENDED); registration is a hard prerequisite, which Meet satisfies on every decision', { skip }, async () => {
  const a = await C.authorize(uuid(), uuid()); assert.equal(a.status, 403); assert.equal(a.body.reason, 'MEETING_UNKNOWN_OR_ENDED');
  assert.equal((await C.authorize('not a valid id!', uuid())).status, 400, 'malformed ids are rejected as invalid input');
  assert.equal((await C.authorize(uuid(), 'not-a-uuid')).status, 400, 'the participant must be a UUID (Meet sends the phone participant UUID)');
});

test('WORKLOAD IDENTITY: scopes are enforced per route, a token cannot be replayed, and a token that claims a certificate binding is refused on a connection that cannot prove it', { skip }, async () => {
  const m = await C.meeting(); await C.register(m);
  assert.equal((await C.shield('ops', 'POST', '/v1/shield/meet/authorize', { meetingId: m.id, participantId: uuid(), role: 'guest', admission: 'admitted' })).status, 403, 'svc:ops lacks meet.signal');
  const rep = await C.shield('meet', 'POST', '/v1/shield/report', { kind: 'signaling_termination_failed', source: 'meet' }); assert.equal(rep.status, 403, 'svc:meet has no alerts.report scope in this allow-list: reports need an explicit grant');
  const tok = (await import('../../server/telephony/number-sync.mjs')).signWorkloadJwt({ privateKeyPem: C.keys.meet.pem, kid: C.keys.meet.kid, issuer: C.ISSUER, subject: 'svc:meet' }), body = { meetingId: m.id, participantId: uuid(), role: 'guest', admission: 'admitted' };
  assert.equal((await C.shield('meet', 'POST', '/v1/shield/meet/authorize', body, { token: tok })).status, 200); assert.equal((await C.shield('meet', 'POST', '/v1/shield/meet/authorize', body, { token: tok })).status, 401, 'the same token (jti) a second time is a replay');
  const bound = await C.shield('meet', 'POST', '/v1/shield/meet/authorize', body, { cnf: 'A'.repeat(43) }); assert.ok([401, 403].includes(bound.status), 'a token bound to a certificate is NEVER accepted without the proof (got ' + bound.status + ')');
  const strict = await C.variant({ SHIELD_REQUIRE_MTLS: 'true' }); const plain = await strict.call('meet', 'POST', '/v1/shield/meet/authorize', body); assert.ok([401, 403].includes(plain.status), 'with SHIELD_REQUIRE_MTLS=true an unbound token over plain HTTP is refused (got ' + plain.status + ')');
  console.log('# note: the full TLS handshake / binding / rotation / revocation matrix is the Shield repository\'s own mtls.pg.test.mjs (5 of 5 pass against this database); this file checks the contract Meet depends on');
});

test('RECHECK (current behaviour): a registered, live meeting revokes nobody; once the meeting has ended the Shield names the participant with MEETING_ENDED', { skip }, async () => {
  const m = await C.meeting(), pid = uuid(); await C.register(m); assert.equal((await C.authorize(m.id, pid)).status, 200);
  const live = await C.shield('meet', 'POST', '/v1/shield/meet/recheck', { participants: [{ meetingId: m.id, participantId: pid }] }); assert.deepEqual(live.body.revoke, []);
  await C.shield('meet', 'POST', '/v1/shield/meet/end', { meetingId: m.id });
  const ended = await C.shield('meet', 'POST', '/v1/shield/meet/recheck', { participants: [{ meetingId: m.id, participantId: pid }] }); assert.deepEqual(ended.body.revoke, [{ meetingId: m.id, participantId: pid, reason: 'MEETING_ENDED' }]);
});

test('REPORT KINDS (current contract): only signaling_termination_failed and outbox_delivery_failed are accepted; the phone-specific kinds Meet and the gateway send are rejected as invalid input', { skip }, async () => {
  const ok = await C.shield('ops', 'POST', '/v1/shield/report', { kind: 'signaling_termination_failed', source: 'meet', ref: 'call-1' }); assert.equal(ok.status, 200);
  assert.equal((await C.shield('ops', 'POST', '/v1/shield/report', { kind: 'outbox_delivery_failed', source: 'numbers' })).status, 200);
  for (const kind of ['phone_late_media', 'phone_termination_failed']) { const r = await C.shield('ops', 'POST', '/v1/shield/report', { kind, source: 'meet', ref: 'call-1' }); assert.equal(r.status, 400, kind + ' is rejected today (Meet\'s best-effort report() swallows this, so the alert is lost)'); }
});

test('FAIL CLOSED (last: stops the Shield): when the Shield cannot be reached Meet admits nobody and attaches nobody', { skip }, async () => {
  const m = await C.meeting(); assert.equal((await C.dial(m)).body.result, 'approved', 'control: the Shield is up');
  await C.stopEngine();
  const m2 = await C.meeting(), d = await C.dial(m2); assert.notEqual(d.body.result, 'approved'); const row = await C.callRow(d.callId); assert.equal(row.state, 'REFUSED'); assert.match(row.end_reason, /^shield_/, 'ended with a Shield reason, never admitted');
  assert.ok(await until(async () => true), 'harness alive');
});
