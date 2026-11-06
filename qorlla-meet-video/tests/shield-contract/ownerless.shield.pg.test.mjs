// A5.5 follow-up: a telephone caller is only admitted into a meeting with a verified owner context (a registered host account the Shield knows). Real Shield, real Meet. Registration of ownerless meetings and
// browser-style admission are NOT changed: only the telephone bridge turns the Shield's `ownership: none` flag into a refusal.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { skipReason, startContract, until } from './harness.mjs';

const skip = skipReason, ALLOW = 'svc:meet=meet.register|meet.signal|alerts.report;svc:ops=shield.admin|shield.suspend|alerts.report|alerts.read';
let A, P; const uuid = () => crypto.randomUUID();
before(async () => { if (!skip) A = await startContract({ allowed: ALLOW }); });
after(async () => { if (A) await A.close(); if (P) await P.close(); setTimeout(() => process.exit(process.exitCode || 0), 1500).unref(); });
const disown = (C, m) => C.adminMeet.query(`UPDATE ${C.meetSchema}.meetings SET host_account_id=NULL, org_id=NULL WHERE id=$1`, [m.id]);

test('OWNERLESS admission: a meeting registered with no host account refuses the telephone caller (REFUSED, shield_ownerless_meeting, nobody attached); the same Meet admits an owned meeting', { skip }, async () => {
  const owned = await A.meeting(), d0 = await A.dial(owned); assert.equal(d0.body.result, 'approved', 'control: an owned meeting is admitted');
  const m = await A.meeting({ ownerless: true }), d = await A.dial(m); assert.notEqual(d.body.result, 'approved'); const row = await A.callRow(d.callId);
  assert.equal(row.state, 'REFUSED'); assert.match(row.end_reason, /^shield_ownerless_meeting/);
  assert.equal((await A.adminMeet.query(`SELECT admission FROM ${A.meetSchema}.participants WHERE id=$1`, [row.participant_id])).rows[0].admission, 'denied', 'the phone participant is denied, nothing is attached');
});

test('OWNERLESS compatibility: the Shield still registers such a meeting and still answers a browser-style guest authorize with ALLOW (flagged ownership: none): legacy registration and browser admission are unchanged', { skip }, async () => {
  const m = await A.meeting({ ownerless: true }); assert.equal((await A.register(m)).status, 200, 'registration compatibility');
  const a = await A.authorize(m.id, uuid()); assert.equal(a.status, 200); assert.equal(a.body.allow, true); assert.equal(a.body.ownership, 'none', 'the Shield says the meeting has no owner; the browser path ignores the flag');
});

test('OWNERLESS at every telephone checkpoint: promotion to MEDIA_CONNECTED is refused when the meeting loses its owner after approval; an already CONNECTED call is not retroactively ended by this rule', { skip }, async () => {
  const m = await A.meeting(), d = await A.dial(m); assert.equal(d.body.result, 'approved'); await disown(A, m);
  const c = await A.connect(d.callId, d.body.mediaToken); assert.equal(c.body.result, 'terminate', JSON.stringify(c.body)); const row = await A.callRow(d.callId); assert.equal(row.state, 'REFUSED'); assert.match(row.end_reason, /^shield_ownerless_meeting/);
  const m2 = await A.meeting(), d2 = await A.dial(m2); assert.equal((await A.connect(d2.callId, d2.body.mediaToken)).body.result, 'connected'); await disown(A, m2);
  await new Promise((r) => setTimeout(r, 3500)); assert.equal((await A.callRow(d2.callId)).state, 'MEDIA_CONNECTED', 'the rule governs NEW phone calls; the recheck of a connected call is unchanged');
});

test('OWNERLESS at credential issuance: a meeting that lost its owner after approval gets no verification-peer credential (denied, nothing issued, call REFUSED)', { skip, timeout: 120000 }, async () => {
  P = await startContract({ allowed: ALLOW, peer: true }); const m = await P.meeting(), d = await P.dial(m); assert.equal(d.body.result, 'approved'); await disown(P, m);
  const cr = await P.credential(d); assert.equal(cr.body.result, 'denied'); const row = await P.callRow(d.callId); assert.equal(row.state, 'REFUSED'); assert.match(row.end_reason, /^shield_ownerless_meeting/); assert.deepEqual(await P.credRows(row.id), [], 'no credential was issued');
});
