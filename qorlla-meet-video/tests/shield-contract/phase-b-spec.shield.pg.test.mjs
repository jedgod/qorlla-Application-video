// A5.5 Phase B SPECIFICATION - written BEFORE any enforcement change. Each test encodes one architectural decision and is EXPECTED TO FAIL against today's Shield and Meet; a failure here is the evidence of the gap,
// and the test goes green only when the approved Phase B change is made. Not part of any default run: it is skipped unless SHIELD_CONTRACT_SPEC=1 (and the engine/database variables of Phase A are set).
//   SHIELD_CONTRACT_SPEC=1 SHIELD_ENGINE_DIR=<qorlla-voice-engine>  PHONE_TEST_DATABASE_URL=postgres://...  node --test tests/shield-contract/phase-b-spec.shield.pg.test.mjs
// Proposed reason codes (new): HOST_SUSPENDED, ORG_SUSPENDED. Proposed report kinds (new): phone_late_media, phone_termination_failed. Existing kinds stay supported.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { skipReason, startContract, until } from './harness.mjs';

const skip = skipReason || (process.env.SHIELD_CONTRACT_SPEC === '1' ? false : 'Phase B specification: set SHIELD_CONTRACT_SPEC=1 to run (expected to fail until Phase B)');
let C;
before(async () => { if (!skip) C = await startContract(); });
after(async () => { if (C) await C.close(); setTimeout(() => process.exit(process.exitCode || 0), 1500).unref(); });
const uuid = () => crypto.randomUUID(), tag = () => crypto.randomBytes(3).toString('hex');
async function suspendedHostMeeting(kind) {                   // a meeting whose host is a verified member of an organization; then the host (or the organization) is suspended through the Shield's real admin routes
  const org = 'org-' + tag(), host = 'acct-host-' + tag(); await C.putOrg(org); await C.putPrincipal(host, { orgId: org });
  const m = await C.meeting({ hostAccountId: host, orgId: org }); assert.equal((await C.register(m)).status, 200);
  return { m, org, host, suspend: async () => { const r = await C.shield('ops', 'POST', kind === 'org' ? `/v1/shield/admin/orgs/${org}/suspend` : `/v1/shield/admin/principals/${host}/suspend`, {}); assert.equal(r.status, 200, 'the admin suspension itself works: ' + JSON.stringify(r.body)); } };
}

test('SPEC S1 - a SUSPENDED HOST makes the meeting ineligible: authorize is denied with HOST_SUSPENDED', { skip }, async () => {
  const s = await suspendedHostMeeting('host'), pid = uuid(); assert.equal((await C.authorize(s.m.id, pid)).status, 200, 'control: allowed before the suspension'); await s.suspend();
  const a = await C.authorize(s.m.id, uuid()); assert.deepEqual({ status: a.status, allow: a.body.allow, reason: a.body.reason }, { status: 403, allow: false, reason: 'HOST_SUSPENDED' }, 'today the Shield never looks at the host of a guest\'s meeting');
});

test('SPEC S2 - a SUSPENDED ORGANIZATION makes the meeting ineligible: authorize is denied with ORG_SUSPENDED', { skip }, async () => {
  const s = await suspendedHostMeeting('org'); assert.equal((await C.authorize(s.m.id, uuid())).status, 200, 'control'); await s.suspend();
  const a = await C.authorize(s.m.id, uuid()); assert.deepEqual({ status: a.status, allow: a.body.allow, reason: a.body.reason }, { status: 403, allow: false, reason: 'ORG_SUSPENDED' });
});

test('SPEC S3 - RECHECK names every account-less participant of a meeting whose host or organization is suspended, so Meet can end their calls', { skip }, async () => {
  for (const kind of ['host', 'org']) {
    const s = await suspendedHostMeeting(kind), pids = [uuid(), uuid()]; for (const p of pids) assert.equal((await C.authorize(s.m.id, p)).status, 200); await s.suspend();
    const r = await C.shield('meet', 'POST', '/v1/shield/meet/recheck', { participants: pids.map((p) => ({ meetingId: s.m.id, participantId: p })) });
    assert.deepEqual(r.body.revoke.map((x) => x.participantId).sort(), [...pids].sort(), kind + ' suspension must revoke both phone participants (today: ' + JSON.stringify(r.body.revoke) + ')');
    assert.ok(r.body.revoke.every((x) => x.reason === (kind === 'host' ? 'HOST_SUSPENDED' : 'ORG_SUSPENDED')));
  }
});

test('SPEC S4 - PHONE-SPECIFIC OPERATIONAL REPORTS are accepted (and validated): phone_late_media and phone_termination_failed; the existing kinds keep working; an unknown kind is still refused', { skip }, async () => {
  for (const kind of ['phone_late_media', 'phone_termination_failed']) { const r = await C.shield('ops', 'POST', '/v1/shield/report', { kind, source: 'meet', ref: 'call-' + tag() }); assert.equal(r.status, 200, kind + ' must be accepted (today: ' + r.status + ' ' + JSON.stringify(r.body) + ')'); }
  assert.equal((await C.shield('ops', 'POST', '/v1/shield/report', { kind: 'signaling_termination_failed', source: 'meet' })).status, 200);
  assert.equal((await C.shield('ops', 'POST', '/v1/shield/report', { kind: 'phone_made_up_kind', source: 'meet' })).status, 400, 'validation stays strict');
});

test('SPEC S5 - ADMISSION is denied for a suspended host through the real Meet: the call ends REFUSED with a Shield reason and nobody is attached', { skip }, async () => {
  const s = await suspendedHostMeeting('host'); await s.suspend(); const d = await C.dial(s.m);
  assert.notEqual(d.body.result, 'approved', 'a suspended host\'s meeting must not admit a telephone caller'); const row = await C.callRow(d.callId); assert.equal(row.state, 'REFUSED'); assert.match(row.end_reason, /^shield_host_suspended/);
});

test('SPEC S6 - CONNECTED-CALL REVOCATION end to end: a suspension that becomes effective terminates the already-connected phone leg within a bounded time (the call state ends with a Shield reason)', { skip }, async () => {
  const s = await suspendedHostMeeting('org'), d = await C.dial(s.m); assert.equal(d.body.result, 'approved'); const c = await C.connect(d.callId, d.body.mediaToken); assert.equal(c.body.result, 'connected');
  assert.equal((await C.callRow(d.callId)).state, 'MEDIA_CONNECTED'); await s.suspend(); const OBJECTIVE_MS = 10_000;                           // the bounded revocation-latency objective is a Phase B proposal; the existing 1 s test interval is used here
  const ended = await until(async () => { const r = await C.callRow(d.callId); return r.state === 'TERMINATED' || r.state === 'REFUSED' ? r : null; }, OBJECTIVE_MS, 200);
  assert.ok(ended, 'the connected call must be terminated within ' + OBJECTIVE_MS + ' ms of the suspension (still ' + (await C.callRow(d.callId)).state + ')'); assert.match(ended.end_reason, /^shield_/);
  // (credential revocation, peer closure and the gateway hang-up apply only in gateway mode; they are covered by the gateway-mode lifecycle tests and by the liveness acceptance test, not by this provider test-double flow)
});
