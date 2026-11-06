// A5.5 Phase B3 - Meet against the REAL Shield: ended-meeting refusal, meeting-end notification, report failures that are visible but never block a termination, credential issuance racing a suspension, and the Shield-outage
// deadline for connected calls (monotonic, started by the FIRST failed recheck, not extended by repeats, cleared by recovery, inherited across a Meet restart). The real Shield is never faked; "unreachable" is made by a
// transparent proxy in front of it. Contract A (fast timings: recheck 1 s, outage grace 10 s) and contract B (production timings: recheck 15 s, grace 120 s, so the 30 s and 120 s objectives are measured as shipped).
//   SHIELD_ENGINE_DIR=<qorlla-voice-engine>  PHONE_TEST_DATABASE_URL=postgres://...  node --test tests/shield-contract/phase-b-meet.shield.pg.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { skipReason, startContract, until, sleep } from './harness.mjs';

const skip = skipReason, GRACE_FAST = 10, ALLOW = 'svc:meet=meet.register|meet.signal|alerts.report;svc:ops=shield.admin|shield.suspend|alerts.report|alerts.read';
let A, B, P; const tag = () => crypto.randomBytes(3).toString('hex'), uuid = () => crypto.randomUUID();
before(async () => { if (!skip) A = await startContract({ allowed: ALLOW, recheckSeconds: '1', graceSeconds: GRACE_FAST }); });
after(async () => { if (A) await A.close(); if (B) await B.close(); if (P) await P.close(); setTimeout(() => process.exit(process.exitCode || 0), 1500).unref(); });
async function owned(C, o = {}) { const org = 'org-' + tag(), host = 'acct-host-' + tag(); await C.putOrg(org); await C.putPrincipal(host, { orgId: org }); const m = await C.meeting({ hostAccountId: host, orgId: org, ...o }); assert.equal((await C.register(m)).status, 200); return { ...m, org, host, suspend: () => C.shield('ops', 'POST', `/v1/shield/admin/principals/${host}/suspend`, {}), restore: () => C.shield('ops', 'POST', `/v1/shield/admin/principals/${host}/restore`, {}) }; }
async function connectedCall(C, m) { const d = await C.dial(m); assert.equal(d.body.result, 'approved', JSON.stringify(d.body)); const c = await C.connect(d.callId, d.body.mediaToken); assert.equal(c.body.result, 'connected'); return d; }
const endedAt = async (C, callId) => { const r = await C.callRow(callId); return r.ended_at ? new Date(r.ended_at).getTime() : null; };

test('B3 ENDED MEETING is a REFUSAL with its own reason (shield_meeting_ended), not an unavailable Shield', { skip }, async () => {
  const m = await owned(A); await A.shield('meet', 'POST', '/v1/shield/meet/end', { meetingId: m.id }); const d = await A.dial(m); assert.notEqual(d.body.result, 'approved');
  const row = await A.callRow(d.callId); assert.equal(row.state, 'REFUSED'); assert.match(row.end_reason, /^shield_meeting_ended/);
});

test('B3 MEETING END is pushed to the Shield whenever the Shield is in use (here the host ends the meeting): the Shield then refuses it, and a counter records the notice', { skip }, async () => {
  const m = await owned(A); assert.equal((await A.register(m)).status, 200); assert.equal((await A.authorize(m.id, uuid())).status, 200, 'control: live');
  const before = (await A.counters()).shield.meeting_end_sent; assert.equal(await A.endMeeting(m), 200);
  assert.ok(await until(async () => (await A.authorize(m.id, uuid())).body.reason === 'MEETING_UNKNOWN_OR_ENDED', 6000), 'the Shield was told the meeting is over');
  assert.ok((await A.counters()).shield.meeting_end_sent > before, 'and the notice is counted');
});

test('B3 REPORTS: a late-media report reaches the Shield and becomes a PHONE_LATE_MEDIA alert; when the Shield cannot take it the failure is a structured log line and a counter, and the call answer is NOT delayed (even if the Shield hangs)', { skip }, async () => {
  const mk = async () => { const m = await A.meeting({ guestEnabled: false }); const d = await A.dial(m); assert.equal((await A.callRow(d.callId)).state, 'REFUSED'); return d; };       // a call that is over (refused)
  const live = (d) => A.hook('/api/phone/ivr/media', { callId: d.callId, mediaToken: d.body.mediaToken || 'x'.repeat(24), evidence: { state: 'audio_flowing', inboundPackets: 50, outboundPackets: 50, observedMs: 1500, codec: 'opus', encrypted: true, measuredAt: Date.now(), source: 'synthetic' } });
  const c0 = (await A.counters()).shield; let d = await mk(), t = Date.now(); let r = await live(d); assert.equal(r.body.result, 'terminate'); assert.ok(await until(async () => (await A.counters()).shield.report_sent > c0.report_sent, 5000), 'reported');
  const alerts = (await A.shield('ops', 'GET', '/v1/shield/alerts?state=active')).body.alerts; assert.ok(alerts.some((a) => a.kind === 'phone_late_media'), 'the Shield raised the alert: ' + JSON.stringify(alerts.map((a) => a.kind)));
  A.setOutage(true); d = await mk(); t = Date.now(); r = await live(d); const quick = Date.now() - t; assert.equal(r.body.result, 'terminate'); assert.ok(await until(async () => (await A.counters()).shield.report_failed > c0.report_failed, 6000), 'the failure is counted');
  assert.match(A.meetLog(), /"event":"shield_report_failed","kind":"phone_late_media"/, 'and logged as one structured line'); assert.ok(quick < 1500, 'the answer was not held up by the report (' + quick + ' ms)');
  A.setOutage(true, true); d = await mk(); t = Date.now(); r = await live(d); assert.equal(r.body.result, 'terminate'); assert.ok(Date.now() - t < 2500, 'even a Shield that never answers does not delay the answer (' + (Date.now() - t) + ' ms)'); A.setOutage(false);
});

test('B3 CREDENTIAL ISSUANCE vs SUSPENSION: a suspension before the request denies it (no credential, call REFUSED); one issued first is revoked when the suspension ends the call; racing both leaves NO live credential and NO connected call', { skip, timeout: 120000 }, async () => {
  const A = P = await startContract({ allowed: ALLOW, recheckSeconds: '1', graceSeconds: GRACE_FAST, peer: true });                 // this contract has the verification peer (and so credentials) configured; the others do not, because with a peer, evidence alone never promotes
  // (1) suspension first
  let m = await owned(A), d = await A.dial(m); assert.equal(d.body.result, 'approved'); await m.suspend(); let cr = await A.credential(d); assert.equal(cr.body.result, 'denied'); const row = await A.callRow(d.callId);
  assert.equal(row.state, 'REFUSED'); assert.match(row.end_reason, /^shield_host_suspended/); assert.deepEqual(await A.credRows(row.id), [], 'no credential was issued');
  // (2) credential first, suspension after
  m = await owned(A); d = await A.dial(m); cr = await A.credential(d); assert.equal(cr.body.result, 'issued'); assert.ok(cr.body.ttlSeconds <= 60, 'credential lifetime rule is unchanged'); const id = (await A.callRow(d.callId)).id; await m.suspend();
  assert.ok(await until(async () => (await A.callRow(d.callId)).state !== 'APPROVED', 8000), 'the call ended after the suspension'); const creds = await A.credRows(id); assert.ok(creds.length === 1 && creds[0].revoked_at && !creds[0].consumed_at, 'the unused credential is revoked: ' + JSON.stringify(creds));
  // (3) racing
  for (let i = 0; i < 4; i++) {
    m = await owned(A); d = await A.dial(m); const [s, c2] = await Promise.all([m.suspend(), A.credential(d)]); assert.equal(s.status, 200); const rid = (await A.callRow(d.callId)).id;
    assert.ok(await until(async () => ['REFUSED', 'TERMINATED', 'CANCELLED'].includes((await A.callRow(d.callId)).state), 8000), 'round ' + i + ': the call ended (credential result was ' + c2.body.result + ')');
    assert.ok((await A.credRows(rid)).every((x) => x.revoked_at), 'round ' + i + ': no live credential remains');
  }
});

test('B3 OUTAGE during a CONNECTED call (grace ' + GRACE_FAST + ' s): calls not yet connected end at once; the connected call lives until the deadline from the FIRST failed recheck and not a second longer; repeated failures do not extend it', { skip }, async () => {
  const m = await owned(A), connected = await connectedCall(A, m), pending = await A.dial(await owned(A));                              // one connected, one only approved
  assert.equal((await A.callRow(pending.callId)).state, 'APPROVED'); const t0 = Date.now(); A.setOutage(true);
  assert.ok(await until(async () => (await A.callRow(pending.callId)).state === 'REFUSED', 6000), 'an approved-but-not-connected call is ended at once (fail closed)');
  assert.equal((await A.callRow(connected.callId)).state, 'MEDIA_CONNECTED', 'the connected call is still up inside the grace period (' + (Date.now() - t0) + ' ms)');
  assert.ok(await until(async () => (await A.callRow(connected.callId)).state === 'TERMINATED', (GRACE_FAST + 8) * 1000, 250), 'terminated by the deadline'); const elapsed = (await endedAt(A, connected.callId)) - t0;
  assert.ok(elapsed >= (GRACE_FAST - 2) * 1000 && elapsed <= (GRACE_FAST + 4) * 1000, 'ended ' + elapsed + ' ms after the outage began (grace ' + GRACE_FAST * 1000 + ' ms, recheck 1 s)'); assert.match((await A.callRow(connected.callId)).end_reason, /^shield_shield_unavailable/); A.setOutage(false);
  const k = (await A.counters()).phone; assert.ok(k.shield_outage_started >= 1 && k.calls_ended_by_outage >= 2);
});

test('B3 REFRESH of a connected call: an EXPLICIT Shield refusal (suspended host) ends it on the very next media refresh; an UNREACHABLE Shield does NOT end it on a refresh (the outage deadline decides)', { skip }, async () => {
  const m = await owned(A), d = await connectedCall(A, m); A.setOutage(true); const r1 = await A.connect(d.callId, d.body.mediaToken); assert.equal(r1.body.result, 'connected', 'a refresh during an outage keeps the call (answer: ' + JSON.stringify(r1.body) + ')'); assert.equal((await A.callRow(d.callId)).state, 'MEDIA_CONNECTED'); A.setOutage(false);
  assert.ok(await until(async () => (await A.callRow(d.callId)).state === 'MEDIA_CONNECTED', 3000)); const m2 = await owned(A), d2 = await connectedCall(A, m2); await m2.suspend();
  const r2 = await A.connect(d2.callId, d2.body.mediaToken); assert.equal(r2.body.result, 'terminate', 'the refresh after a suspension is refused: ' + JSON.stringify(r2.body)); const row = await A.callRow(d2.callId); assert.equal(row.state, 'TERMINATED'); assert.match(row.end_reason, /^shield_host_suspended/);
});

test('B3 SHIELD RECOVERY before the deadline: the connected call is untouched, the outage is cleared, and a LATER outage gets a fresh full grace period', { skip }, async () => {
  const m = await owned(A), d = await connectedCall(A, m), rec0 = (await A.counters()).phone.shield_outage_recovered; A.setOutage(true); await sleep(4000); A.setOutage(false);
  assert.ok(await until(async () => (await A.counters()).phone.shield_outage_recovered > rec0, 6000), 'recovery noticed'); await sleep((GRACE_FAST - 4 + 3) * 1000);               // well past the ORIGINAL deadline
  assert.equal((await A.callRow(d.callId)).state, 'MEDIA_CONNECTED', 'the call survived: the first outage ended before its deadline');
  const t1 = Date.now(); A.setOutage(true); await sleep((GRACE_FAST - 3) * 1000); assert.equal((await A.callRow(d.callId)).state, 'MEDIA_CONNECTED', 'a new outage restarts the clock: still up ' + (Date.now() - t1) + ' ms in');
  assert.ok(await until(async () => (await A.callRow(d.callId)).state === 'TERMINATED', 12000, 250)); A.setOutage(false);
});

test('B3 RESTART during an uninterrupted outage does NOT grant a fresh grace period: the new Meet process inherits the original start', { skip }, async () => {
  const m = await owned(A), d = await connectedCall(A, m), t0 = Date.now(); A.setOutage(true); await sleep(3000);
  assert.ok((await A.auditRows('phone.shield_outage_start')).length >= 1, 'the outage start is on the audit trail'); const tr = Date.now(); await A.restartMeet(); const restartMs = Date.now() - tr;
  if (restartMs > (GRACE_FAST - 3) * 1000) { console.log('# restart took ' + restartMs + ' ms: too slow to discriminate on this host'); A.setOutage(false); return; }
  assert.equal((await A.callRow(d.callId)).state, 'MEDIA_CONNECTED', 'still inside the original grace after the restart');
  assert.ok(await until(async () => (await A.callRow(d.callId)).state === 'TERMINATED', 20000, 250), 'terminated'); const total = (await endedAt(A, d.callId)) - t0;
  assert.ok(total <= (GRACE_FAST + 5) * 1000, 'ended ' + total + ' ms after the outage began; a fresh grace after the restart (' + restartMs + ' ms) would have been ~' + (restartMs + 3000 + GRACE_FAST * 1000) + ' ms'); A.setOutage(false);
});

test('B3 OBJECTIVES AS SHIPPED (recheck 15 s, outage grace 120 s): a suspension terminates the connected call within 30 s of its commit; a Shield outage terminates a connected call by 120 s (+ one recheck)', { skip, timeout: 330000 }, async (t) => {
  B = await startContract({ allowed: ALLOW });
  // (1) suspension latency: from the suspension's committed time (principal row) to the call's terminal timestamp
  const m = await owned(B), d = await connectedCall(B, m); const s = await m.suspend(); assert.equal(s.status, 200);
  const commit = new Date((await B.sq('SELECT updated_at FROM shield_principals WHERE account_id=$1', [m.host])).rows[0].updated_at).getTime();
  assert.ok(await until(async () => (await B.callRow(d.callId)).state === 'TERMINATED', 40000, 250), 'terminated'); const latency = (await endedAt(B, d.callId)) - commit;
  t.diagnostic('measured: suspension committed -> call terminated = ' + latency + ' ms (objective 30000 ms; recheck interval 15000 ms)'); assert.ok(latency <= 30_000, 'suspension latency ' + latency + ' ms exceeds the 30 s objective');
  // (2) outage at the 120 s maximum
  const m2 = await owned(B), d2 = await connectedCall(B, m2), t0 = Date.now(); B.setOutage(true);
  const media = setInterval(() => { B.connect(d2.callId, d2.body.mediaToken).catch(() => undefined); }, 4000);              // a healthy call keeps reporting fresh media: Meet's own lost-media timer must not end it before the Shield deadline does
  try {
    await sleep(60_000); const mid = await B.callRow(d2.callId); assert.equal(mid.state, 'MEDIA_CONNECTED', 'still connected inside the 120 s grace (' + (Date.now() - t0) + ' ms; end_reason ' + mid.end_reason + ')');
    assert.ok(await until(async () => (await B.callRow(d2.callId)).state === 'TERMINATED', 90_000, 500), 'terminated');
  } finally { clearInterval(media); }
  const total = (await endedAt(B, d2.callId)) - t0; t.diagnostic('end_reason of the outage termination: ' + (await B.callRow(d2.callId)).end_reason);
  t.diagnostic('measured: outage began -> connected call terminated = ' + total + ' ms (maximum 120000 ms + one 15000 ms recheck)'); assert.ok(total >= 105_000 && total <= 120_000 + 15_000 + 5_000, 'outage termination took ' + total + ' ms'); B.setOutage(false);
});
