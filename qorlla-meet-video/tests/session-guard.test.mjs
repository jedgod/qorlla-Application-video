// A5.5: the signalling guard and telephone verification peers. Deterministic: a fake socket layer, a scripted Shield client, no database. What it proves:
//  - every session the Shield revokes leaves ONE audit row (reason + whether it was a browser or a phone peer), whichever mechanism closes the call;
//  - a revoked phone peer has its CALL ended through the phone module with the Shield's reason BEFORE its socket is closed, so the call never ends as "signalling lost" when the Shield is the cause;
//  - browsers are handled as before; failures of the audit or of the call termination never stop the revocation; in an outage the phone module's own deadline governs phone peers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startSessionGuard } from '../server/shield-client.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sock = (steps, { peer = false, mid = 'm1', pid = 'p1' } = {}) => ({ data: { user: { meetingId: mid, participantId: pid }, ...(peer ? { peer: { call: 'c' } } : {}) }, emit: (e) => steps.push('emit:' + e), disconnect: () => steps.push('disconnect:' + pid) });
async function run({ sockets, recheck, lastOk = Date.now(), graceMs = 120000, audit, onPhonePeer, reports = [], ms = 150 }) {
  const map = new Map(sockets.map((s, i) => [i, s])); for (const [i, s] of map) { const d = s.disconnect; s.disconnect = (...x) => { d(...x); map.delete(i); }; }                  // like socket.io: a disconnected socket is gone from the list
  const client = { state: { lastOk }, recheck: async () => recheck, report: async (k, r) => { reports.push([k, r]); return true; } }, io = { sockets: { sockets: map } }, db = { query: async () => ({}) };
  const stop = startSessionGuard({ io, db, client, config: { recheckMs: 20, graceMs }, log: { error() { /* expected */ } }, audit, onPhonePeer }); await sleep(ms); stop();
}
const revoke = (...pids) => ({ revoke: pids.map((pid) => ({ meetingId: 'm1', participantId: pid, reason: 'HOST_SUSPENDED' })) });

test('a revoked phone peer: audit row, then its CALL is ended with the Shield reason, then the socket is closed - in that order; a browser is only audited and closed', async () => {
  const steps = [], phone = sock(steps, { peer: true, pid: 'phone1' }), web = sock(steps, { pid: 'web1' });
  await run({ sockets: [phone, web], recheck: revoke('phone1', 'web1'), audit: (m, p, t, d) => steps.push(`audit:${p}:${t}:${d.reason}:${d.kind}`), onPhonePeer: async (m, p, r) => { steps.push(`call-ended:${p}:${r}`); } });
  const own = (p) => steps.filter((s) => s.includes(p)); assert.deepEqual(own('phone1'), ['audit:phone1:session.revoked_by_shield:HOST_SUSPENDED:phone-peer', 'call-ended:phone1:HOST_SUSPENDED', 'disconnect:phone1'], 'audit, then the call, then the socket');
  assert.deepEqual(own('web1'), ['audit:web1:session.revoked_by_shield:HOST_SUSPENDED:browser', 'disconnect:web1'], 'a browser is audited and closed; no call is involved');
  assert.ok(steps.indexOf('emit:session_revoked') >= 0);
});

test('a failure of the call termination or of the audit never stops the revocation: the socket is still closed, and a failed termination is reported', async () => {
  const steps = [], reports = [], phone = sock(steps, { peer: true, pid: 'phone2' });
  await run({ sockets: [phone], recheck: revoke('phone2'), reports, audit: () => { throw new Error('audit down'); }, onPhonePeer: async () => { throw new Error('phone module down'); } });
  assert.ok(steps.includes('disconnect:phone2')); assert.ok(reports.some(([k]) => k === 'phone_termination_failed'), 'and the Shield is told');
});

test('without a phone hook (legacy wiring) a phone peer is closed like any session; with one, an UNREACHABLE Shield beyond the grace closes browsers but leaves phone peers to the phone module\'s own deadline', async () => {
  let steps = [], phone = sock(steps, { peer: true, pid: 'phone3' }), web = sock(steps, { pid: 'web3' }), audits = [];
  await run({ sockets: [phone, web], recheck: null, lastOk: Date.now() - 500000, graceMs: 1000, audit: (m, p, t, d) => audits.push(p + ':' + d.reason), onPhonePeer: async () => { steps.push('phone-module'); } });
  assert.ok(steps.includes('disconnect:web3'), 'the browser is closed beyond the grace period'); assert.ok(!steps.includes('disconnect:phone3') && !steps.includes('phone-module'), 'the phone peer is left to the phone module'); assert.deepEqual(audits, ['web3:SHIELD_UNAVAILABLE']);
  steps = []; phone = sock(steps, { peer: true, pid: 'phone4' }); await run({ sockets: [phone], recheck: null, lastOk: Date.now() - 500000, graceMs: 1000 });
  assert.ok(steps.includes('disconnect:phone4'), 'with no phone hook the old behaviour is unchanged');
});

test('inside the grace period an unreachable Shield closes nothing', async () => {
  const steps = [], web = sock(steps, { pid: 'web5' }); await run({ sockets: [web], recheck: null, lastOk: Date.now(), graceMs: 120000, audit: () => steps.push('audit') }); assert.deepEqual(steps, []);
});

test('a slow call termination is not repeated by the next ticks: one audit row and one termination per revoked session, and ticks do not overlap', async () => {
  const steps = [], phone = sock(steps, { peer: true, pid: 'phone6' }); let calls = 0, audits = 0;
  await run({ sockets: [phone], recheck: revoke('phone6'), audit: () => { audits++; }, onPhonePeer: async () => { calls++; await sleep(120); }, ms: 500 });                  // the termination is slower than several ticks
  assert.equal(audits, 1); assert.equal(calls, 1); assert.equal(steps.filter((s) => s === 'disconnect:phone6').length, 1);
});
