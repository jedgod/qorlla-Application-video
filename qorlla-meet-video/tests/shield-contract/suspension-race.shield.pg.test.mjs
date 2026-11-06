// A5.5 investigation as a test: when a host is suspended while a telephone call has a LIVE verification-peer socket, two mechanisms can end it - the phone sweep (shield_host_suspended) and the signalling guard, which
// disconnects the revoked participant's peer socket and so ends the call as gateway_signaling_lost. This runs the race repeatedly against the real Shield and the real Meet, records which one won and what was audited, and
// asserts the invariants that must hold whoever wins. The distribution is printed as a diagnostic: it is evidence, not an assertion.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { skipReason, startContract, until, sleep } from './harness.mjs';

const skip = skipReason, ROUNDS = Number(process.env.RACE_ROUNDS || 8), ALLOW = 'svc:meet=meet.register|meet.signal|alerts.report;svc:ops=shield.admin|shield.suspend|alerts.report|alerts.read';
const { io: connect } = createRequire(path.join(import.meta.dirname, '..', '..', 'package.json'))('socket.io-client');
let P; const tag = () => crypto.randomBytes(3).toString('hex');
before(async () => { if (!skip) P = await startContract({ allowed: ALLOW, peer: true, recheckSeconds: '1' }); });
after(async () => { if (P) await P.close(); setTimeout(() => process.exit(process.exitCode || 0), 1500).unref(); });

test('SUSPENSION RACE: the call always ends, the credential is revoked, the Shield holds the record, a participant ended by the signalling guard is denied; the outcome distribution and the Meet-side audit trail are recorded', { skip, timeout: 280000 }, async (t) => {
  const outcomes = [], auditSeen = new Map();
  for (let i = 0; i < ROUNDS; i++) {
    const org = 'org-' + tag(), host = 'acct-host-' + tag(); await P.putOrg(org); await P.putPrincipal(host, { orgId: org });
    const m = await P.meeting({ hostAccountId: host, orgId: org }), d = await P.dial(m); assert.equal(d.body.result, 'approved'); const cr = await P.credential(d); assert.equal(cr.body.result, 'issued');
    const sock = connect(P.base, { auth: { kind: 'verification-peer', token: cr.body.credential }, transports: ['websocket'], reconnection: false }), seen = []; for (const e of ['revoked', 'session_revoked']) sock.on(e, (x) => seen.push(e + ':' + JSON.stringify(x)));
    const up = await new Promise((r) => { sock.once('connect', () => r('connected')); sock.once('connect_error', (e) => r('refused:' + e.message)); }); assert.equal(up, 'connected', 'the verification peer socket is live');
    const row0 = await P.callRow(d.callId), since = await P.sq('SELECT COALESCE(max(id),0) AS m FROM shield_events'); const t0 = Date.now();
    assert.equal((await P.shield('ops', 'POST', `/v1/shield/admin/principals/${host}/suspend`, {})).status, 200);
    assert.ok(await until(async () => !['APPROVED', 'MEDIA_CONNECTING'].includes((await P.callRow(d.callId)).state), 12000, 50), 'round ' + i + ': the call ended'); const ms = Date.now() - t0, row = await P.callRow(d.callId);
    await sleep(700);                                                                                                 // Meet writes its audit rows without waiting for them: let them land before they are read
    const events = (await P.adminMeet.query(`SELECT to_state, reason FROM ${P.meetSchema}.phone_call_events WHERE call_id=$1 ORDER BY id`, [row0.id])).rows, audit = (await P.adminMeet.query(`SELECT event_type, detail->>'reason' AS why FROM ${P.meetSchema}.audit_events WHERE meeting_id=$1 AND event_type LIKE 'phone.%' ORDER BY id`, [m.id])).rows.map((a) => a.event_type + (a.why ? '(' + a.why + ')' : ''));
    for (const a of audit) auditSeen.set(a.replace(/\(.*\)/, ''), (auditSeen.get(a.replace(/\(.*\)/, '')) || 0) + 1);
    const denied = (await P.adminMeet.query(`SELECT admission FROM ${P.meetSchema}.participants WHERE id=$1`, [row0.participant_id])).rows[0].admission, creds = await P.credRows(row0.id), shieldEv = (await P.sq('SELECT action, decision, reason FROM shield_events WHERE id > $1', [since.rows[0].m])).rows;
    const winner = /^shield_host_suspended/.test(row.end_reason || '') ? 'sweep(shield_host_suspended)' : row.end_reason === 'gateway_signaling_lost' ? 'guard/peer-lost(gateway_signaling_lost)' : 'other:' + row.end_reason;
    outcomes.push({ i, winner, state: row.state, ms, denied, audit, sockSaw: seen.length, credRevoked: creds.every((c) => c.revoked_at) });
    assert.ok(row.end_reason && /^(shield_host_suspended|gateway_signaling_lost)/.test(row.end_reason), 'round ' + i + ': an expected end reason, got ' + row.end_reason);
    assert.ok(creds.length === 1 && creds[0].revoked_at, 'round ' + i + ': the credential is revoked'); assert.ok(shieldEv.some((e) => e.action === 'meet.recheck' && e.decision === 'DENY' && /^REVOKED:/.test(e.reason)), 'round ' + i + ': the Shield recorded the revocation');
    if (row.end_reason === 'gateway_signaling_lost') assert.equal(denied, 'denied', 'round ' + i + ': a call ended by the guard has its participant denied (proof the Shield revoked it)');
    assert.ok(ms <= 30_000); sock.close();
  }
  const dist = {}; for (const o of outcomes) dist[o.winner] = (dist[o.winner] || 0) + 1;
  t.diagnostic('winners over ' + ROUNDS + ' rounds: ' + JSON.stringify(dist)); t.diagnostic('Meet audit event types seen (count): ' + JSON.stringify([...auditSeen])); t.diagnostic('per round: ' + JSON.stringify(outcomes.map((o) => [o.winner.split('(')[0], o.state, o.ms + 'ms', o.denied, o.audit.join('+')])));
});
