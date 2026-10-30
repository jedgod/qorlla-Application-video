'use strict';
// Relay proof against a REAL coturn: media must flow THROUGH the relay, and the credential rules must be enforced by the relay itself.
// This is a LOCAL mechanism test (coturn in a throwaway loopback container, both participants on this PC). It is NOT cross-network evidence and says nothing about cellular, NAT traversal or public exposure.
//   Start coturn (loopback test config, see docs/MEET_TURN.md), a Meet with ICE_TRANSPORT_POLICY=relay and TURN_URLS pointing at it, then:
//   QORLLA_TEST_NO_CTX_PERMISSIONS=1 (REQUIRED for a loopback relay, see harness.ctxPermissions) QORLLA_TEST_MEET_URL=http://localhost:3314 TURN_TEST_SECRET=<secret> TURN_TEST_URL=turn:127.0.0.1:47400 RELAY_EXPECT_PROTOCOL=udp node --test qorlla-clients/e2e/turn-relay.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { ctxPermissions, MEET, startMain, startHost, joinAsGuest, flowing, sample, sleep, RTC_HOOK, FAKE_MEDIA, chromium } = require('./harness.cjs');

const SECRET = process.env.TURN_TEST_SECRET || '', TURN = process.env.TURN_TEST_URL || 'turn:127.0.0.1:47400', EXPECT = process.env.RELAY_EXPECT_PROTOCOL || 'udp', CONTAINER = process.env.TURN_TEST_CONTAINER || 'qorlla-turn-localtest';
const skip = SECRET.length >= 32 ? false : 'set TURN_TEST_SECRET (the secret coturn and Meet were started with)';
const evidence = { meet: MEET, transportExpected: EXPECT, scope: 'local loopback mechanism test, not cross-network' };
const cred = (username) => crypto.createHmac('sha1', SECRET).update(username).digest('base64');
const turnLog = () => { try { return execFileSync('docker', ['logs', CONTAINER], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) + ''; } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); } };

/** Asks coturn for a relay candidate with the given credentials from a plain page; resolves what happened. */
async function probe(page, iceServer) {
  return page.evaluate(async (server) => {
    const pc = new RTCPeerConnection({ iceServers: [server], iceTransportPolicy: 'relay' }), types = [], errors = [];
    pc.addEventListener('icecandidate', (e) => { if (e.candidate) types.push(e.candidate.type); });
    pc.addEventListener('icecandidateerror', (e) => errors.push({ code: e.errorCode, text: String(e.errorText || '').slice(0, 60) }));
    pc.createDataChannel('probe'); await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => { const t = setTimeout(r, 7000); pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); r(); } }); });
    pc.close(); return { relayCandidates: types.filter((t) => t === 'relay').length, otherCandidates: types.filter((t) => t !== 'relay').length, errors };
  }, iceServer);
}

test('a relay-only meeting carries audio and video THROUGH coturn: the selected pair is relay on both ends', { skip, timeout: 300000 }, async () => {
  const main = await startMain(5299); let host, gb;
  try {
    const before = (turnLog().match(/ALLOCATE processed, success/g) || []).length;
    host = await startHost(main, { title: 'Relay proof ' + EXPECT });
    gb = await chromium.launch({ args: FAKE_MEDIA }); const ctx = await gb.newContext(ctxPermissions()); await ctx.addInitScript(RTC_HOOK); const guest = await ctx.newPage();
    await guest.goto(main.base + '/guest/meeting/' + host.meetingId + '/prejoin'); await joinAsGuest(guest, 'Relay Guest');
    await guest.waitForFunction(() => document.querySelectorAll('.tile').length >= 2, null, { timeout: 60000 }); await host.page.waitForFunction(() => document.querySelectorAll('.tile').length >= 2, null, { timeout: 60000 }); await sleep(10000);
    const diag = (p) => p.evaluate(async () => { const out = { events: (window.__qlog || []).map((e) => e.slice(1)), pairs: [] }; for (const pc of window.__qpcs || []) { const rep = await pc.getStats(), by = {}; rep.forEach((x) => { by[x.id] = x; }); rep.forEach((x) => { if (x.type === 'candidate-pair') out.pairs.push({ state: x.state, nominated: !!x.nominated, local: (by[x.localCandidateId] || {}).candidateType, remote: (by[x.remoteCandidateId] || {}).candidateType, sent: x.bytesSent, received: x.bytesReceived }); }); } return out; });
    evidence.diagnostics = { guest: await diag(guest), host: await diag(host.page) };
    const [g, h] = [await flowing(guest, 5000), await flowing(host.page, 5000)];
    for (const [who, f] of [['guest', g], ['host', h]]) {
      assert.ok(f.ok, who + ': media flows both ways through the relay: ' + JSON.stringify(f.delta)); assert.ok(f.after.pairs.length >= 1, who + ': a nominated candidate pair exists');
      for (const p of f.after.pairs) { assert.equal(p.local, 'relay', who + ': the LOCAL candidate of the selected pair is a relay candidate, not host/srflx: ' + JSON.stringify(p)); assert.equal(p.relayProtocol, EXPECT, who + ': the TURN transport used to reach coturn'); }
    }
    const after = (turnLog().match(/ALLOCATE processed, success/g) || []).length; assert.ok(after - before >= 2, 'coturn itself logged successful allocations for both participants: ' + (after - before));
    assert.ok(!turnLog().includes(SECRET), 'the shared secret never appears in the relay log');
    const summary = (f) => ({ pairs: f.after.pairs, deltaBytesAndFrames: f.delta, packetsLost: f.after.packetsLost, packetsReceived: f.after.packetsReceived, jitterMsMax: f.after.jitterMsMax });
    evidence.relayMeeting = { guest: summary(g), host: summary(h), coturnSuccessfulAllocations: after - before };
  } finally { const f = process.env.CLIENTS_EVIDENCE_FILE; if (f) require('node:fs').writeFileSync(f, JSON.stringify(evidence, null, 2)); await gb?.close(); await host?.close(); main.stop(); }
});

test('coturn enforces credentials itself: valid works, wrong password and expired credentials are refused (Chromium itself refuses a turn: URL with no credentials)', { skip, timeout: 120000 }, async () => {
  const b = await chromium.launch(); try {
    const page = await (await b.newContext()).newPage(); await page.goto(MEET + '/');
    const url = TURN + '?transport=' + EXPECT, now = Math.floor(Date.now() / 1000), fresh = (now + 600) + ':probe-participant', old = (now - 3600) + ':probe-participant';
    const valid = await probe(page, { urls: url, username: fresh, credential: cred(fresh) });
    assert.ok(valid.relayCandidates >= 1, 'control: valid credentials give a relay candidate (so the two refusals below mean something): ' + JSON.stringify(valid));
    const wrong = await probe(page, { urls: url, username: fresh, credential: cred(fresh + 'x') });
    assert.equal(wrong.relayCandidates, 0, 'a wrong password gets no relay candidate: ' + JSON.stringify(wrong)); assert.ok(wrong.errors.some((e) => e.code === 401), 'and coturn answers 401: ' + JSON.stringify(wrong.errors));
    const expired = await probe(page, { urls: url, username: old, credential: cred(old) });
    assert.equal(expired.relayCandidates, 0, 'an EXPIRED (but correctly signed) credential is refused for a new allocation: ' + JSON.stringify(expired));
    evidence.credentialEnforcement = { validRelayCandidates: valid.relayCandidates, wrongPassword: { relayCandidates: wrong.relayCandidates, errors: wrong.errors }, expired: { relayCandidates: expired.relayCandidates, errors: expired.errors } };
  } finally { const f = process.env.CLIENTS_EVIDENCE_FILE; if (f) require('node:fs').writeFileSync(f, JSON.stringify(evidence, null, 2)); await b.close(); }
});
