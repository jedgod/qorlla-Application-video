'use strict';
// Meet's TURN configuration, in a real meeting between two Chromium participants (no relay server is needed for this test: it checks the CONFIGURATION and the relay-only ENFORCEMENT).
//   TURN_TEST_MODE=all    Meet has TURN_URLS + TURN_SHARED_SECRET and ICE_TRANSPORT_POLICY unset: credentials are issued, and a direct connection still works (the unreachable TURN server is simply unused)
//   TURN_TEST_MODE=relay  the same plus ICE_TRANSPORT_POLICY=relay with the TURN server UNREACHABLE: if relay-only is really enforced, NO media can flow and NO host/srflx/prflx candidate may exist.
//                         This is the negative control: a direct connection must never be mistaken for proof that a relay works.
// What this does NOT prove: that a real relay carries media (that needs a reachable TURN server) or anything about cellular networks.
// Start the Meet instances first:  TURN_URLS=turn:127.0.0.1:9 TURN_SHARED_SECRET=<40+ chars> node e2e/start-meet.cjs 3312   (and with ICE_TRANSPORT_POLICY=relay on 3313)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { MEET, startMain, startHost, joinAsGuest, flowing, sleep, RTC_HOOK, FAKE_MEDIA, chromium } = require('./harness.cjs');

const MODE = process.env.TURN_TEST_MODE || 'all', SECRET = process.env.TURN_SHARED_SECRET || '', skip = SECRET.length >= 32 ? false : 'set TURN_SHARED_SECRET (the same value Meet was started with)';
const evidence = { mode: MODE, meet: MEET };
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());

test('Meet issues short-lived per-participant TURN credentials to admitted participants only, and enforces the relay policy', { skip, timeout: 240000 }, async () => {
  const main = await startMain(5298); let host, gb;
  try {
    host = await startHost(main, { title: 'TURN config ' + MODE });
    const session = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('qorlla-session') || 'null')); assert.ok(session && session.token, 'the host page holds its session'); const c = claims(session.token);
    const ice = (token, id = c.meetingId) => fetch(`${MEET}/api/meetings/${encodeURIComponent(id)}/ice`, { headers: token ? { authorization: 'Bearer ' + token } : {} });

    // ---- who gets credentials
    assert.equal((await ice(null)).status, 401, 'no token: refused');
    assert.equal((await ice(session.token.slice(0, -4) + 'AAAA')).status, 401, 'a tampered token: refused');
    assert.equal((await ice(session.token, '00000000-0000-0000-0000-000000000000')).status, 403, 'a token for another meeting: refused');
    const ok = await ice(session.token); assert.equal(ok.status, 200); assert.equal(ok.headers.get('cache-control'), 'no-store'); const body = await ok.json();
    const turn = body.iceServers.find((s) => s.username); assert.ok(turn, 'a TURN entry with credentials is present');
    // ---- what the credentials look like (coturn REST scheme, checked with an independent computation)
    const [exp, who] = turn.username.split(':'); const ttl = Number(exp) - Math.floor(Date.now() / 1000);
    assert.equal(who, c.participantId, 'scoped to this participant'); assert.ok(ttl > 3500 && ttl <= 3601, 'about one hour, not open-ended: ' + ttl + ' s'); assert.equal(body.expiresIn, 3600);
    assert.equal(turn.credential, crypto.createHmac('sha1', SECRET).update(turn.username).digest('base64'), 'credential = base64(HMAC-SHA1(secret, username)), exactly what coturn verifies');
    assert.ok(/^turns?:/.test([].concat(turn.urls)[0])); assert.equal(body.iceTransportPolicy, MODE);
    // ---- the public config never carries them
    const pub = await (await fetch(`${MEET}/api/config`)).text(); assert.ok(!pub.includes(SECRET) && !pub.includes(turn.credential) && !/credential|username/i.test(pub), '/api/config exposes no TURN secret or credential');
    evidence.credentials = { participantScoped: true, ttlSeconds: ttl, policy: body.iceTransportPolicy, tokenlessStatus: 401, tamperedStatus: 401, otherMeetingStatus: 403 };

    // ---- a guest joins; what do the peer connections actually do?
    gb = await chromium.launch({ args: FAKE_MEDIA }); const ctx = await gb.newContext({ permissions: ['camera', 'microphone'] }); await ctx.addInitScript(RTC_HOOK); const guest = await ctx.newPage();
    await guest.goto(main.base + '/guest/meeting/' + host.meetingId + '/prejoin'); await joinAsGuest(guest, 'Turn Config Guest');
    await sleep(MODE === 'relay' ? 25000 : 8000);
    const view = await guest.evaluate(async () => { const pc = (window.__qpcs || [])[0]; if (!pc) return null; const cfg = pc.getConfiguration(); const rep = await pc.getStats(); const types = new Set(); let bytes = 0; rep.forEach((s) => { if (s.type === 'local-candidate') types.add(s.candidateType); if (s.type === 'inbound-rtp') bytes += s.bytesReceived || 0; });
      return { policy: cfg.iceTransportPolicy, localCandidateTypes: [...types].sort(), bytesReceived: bytes, ice: pc.iceConnectionState, connection: pc.connectionState }; });
    assert.ok(view, 'the guest created a peer connection'); evidence.guestView = view; assert.equal(view.policy, MODE, 'the peer connection uses the server\'s policy'); // Chromium's getConfiguration() does not report ICE servers, so the proof of what Meet configured is the config it passed to the RTCPeerConnection constructor (recorded by the test hook; credentials reduced to yes/no)
    const given = await guest.evaluate(() => window.__qcfg || []); evidence.constructorConfig = given; assert.ok(given.length >= 1, 'the guest created a peer connection');
    for (const c of given) { assert.equal(c.policy, MODE, 'every peer connection uses the server policy'); const t = c.servers.find((x) => x.hasCredential); assert.ok(t && t.urls.some((u) => /^turn:127.0.0.1:9/.test(u)), 'and carries the TURN server with a credential: ' + JSON.stringify(c.servers)); assert.ok(Number(t.expires) > Date.now() / 1000, 'which has not expired'); }
    if (MODE === 'all') {
      const f = await flowing(guest, 3000); assert.ok(f.ok, 'direct media flows both ways when relay-only is not required: ' + JSON.stringify(f.delta)); assert.ok(view.localCandidateTypes.includes('host'), 'host candidates were gathered: ' + view.localCandidateTypes);
    } else {
      assert.ok(!view.localCandidateTypes.some((t) => ['host', 'srflx', 'prflx'].includes(t)), 'RELAY-ONLY: no direct candidate type exists: ' + view.localCandidateTypes); assert.equal(view.bytesReceived, 0, 'RELAY-ONLY with an unreachable relay: no media at all');
      assert.ok(!['connected', 'completed'].includes(view.ice), 'and the connection is not up: ' + view.ice);
    }
  } finally { const f = process.env.CLIENTS_EVIDENCE_FILE; if (f) require('node:fs').writeFileSync(f, JSON.stringify(evidence, null, 2)); await gb?.close(); await host?.close(); main.stop(); }
});
