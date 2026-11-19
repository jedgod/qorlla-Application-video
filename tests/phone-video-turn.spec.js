const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { PASSWORD } = require('./support/meet-stack');
const { startVoiceStack } = require('./support/voice-stack');

// Phone video through a TURN RELAY ONLY (the engine tells every client iceTransportPolicy=relay, so no direct or server-reflexive path can carry media), in two real Chromium
// browsers with fake camera and microphone, against the real local coturn. It records the SELECTED candidate pair and the connection statistics of both sides, drives an ICE restart
// and checks that audio and video keep flowing afterwards.
// Run: QORLLA_TEST_VOICE_DB=<scratch postgres url> QORLLA_TEST_TURN_SECRET=<coturn static secret> QORLLA_TEST_TURN_URL=turn:127.0.0.1:3479?transport=udp npx playwright test tests/phone-video-turn.spec.js --project=chromium
// What this does NOT prove: that the two peers are on different physical networks (both browsers run on this one machine; only the media path is forced through the relay), a
// mobile network, or TURN credential expiry (coturn REST credentials here are issued for 600 s).
const MAIN = 5333, VOICE = 5334, SECRET = process.env.QORLLA_TEST_TURN_SECRET, URL = process.env.QORLLA_TEST_TURN_URL || 'turn:127.0.0.1:3479?transport=udp';
test.describe('Phone video over a TURN relay', () => {
  test.skip(!SECRET, 'set QORLLA_TEST_TURN_SECRET (the local coturn static secret)');
  test.describe.configure({ mode: 'serial' });
  let stack;
  test.beforeAll(async () => { test.setTimeout(150000); stack = await startVoiceStack({ mainPort: MAIN, voicePort: VOICE, engineEnv: { TURN_URLS: URL, TURN_SHARED_SECRET: SECRET, VOICE_RELAY_ONLY: 'true' } }); });
  test.afterAll(async () => { if (stack) await stack.stop(); });
  const rand = () => Math.random().toString(36).slice(2, 7);
  async function account(browser, name) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['microphone', 'camera'] }), u = (name + rand()).toLowerCase();
    expect((await ctx.request.post(stack.base + '/api/auth/register', { data: { username: u, displayName: name + ' Test', password: PASSWORD, email: u + '@example.test' } })).status()).toBeLessThan(300); return ctx;
  }
  async function openPhone(ctx) {
    const page = await ctx.newPage(); page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300))); await page.goto(stack.base + '/qorlla.html#phone');
    await expect(async () => { await page.locator('.nav-item[data-view=phone]').click(); await expect(page.locator('#phTab-dial')).toBeVisible({ timeout: 3000 }); }).toPass({ timeout: 30000 }); return page;
  }
  const ready = (p) => expect.poll(() => p.evaluate(() => !!(window.qorllaVoice && window.qorllaVoice.ws && window.qorllaVoice.ws.readyState === 1)), { timeout: 30000 }).toBe(true);
  const extOf = (p) => p.evaluate(async () => { for (let i = 0; i < 60; i++) { try { const d = await (await fetch('/api/voice/directory', { credentials: 'same-origin' })).json(); const me = (d.people || []).find((x) => x.self); if (me) return me.extension; } catch (e) { /* retry */ } await new Promise((r) => setTimeout(r, 500)); } return ''; });
  // everything a reviewer needs about one side of the media path: the selected pair, its candidate types, RTT, bytes and frames in both directions
  const stats = (p) => p.evaluate(async () => {
    const pc = window.qorllaVoice.pc, rep = await pc.getStats(), by = {}; rep.forEach((x) => { by[x.id] = x; });
    const tr = [...rep.values()].find((x) => x.type === 'transport'), pair = tr && by[tr.selectedCandidatePairId], loc = pair && by[pair.localCandidateId], rem = pair && by[pair.remoteCandidateId];
    const o = { iceTransportPolicy: pc.getConfiguration().iceTransportPolicy, state: pc.connectionState, ice: pc.iceConnectionState, dtls: tr && tr.dtlsState, cipher: tr && tr.srtpCipher, selected: pair ? { local: loc && { type: loc.candidateType, protocol: loc.protocol, relayProtocol: loc.relayProtocol || null }, remote: rem && { type: rem.candidateType, protocol: rem.protocol }, rttMs: pair.currentRoundTripTime == null ? null : Math.round(pair.currentRoundTripTime * 1000), bytesSent: pair.bytesSent, bytesReceived: pair.bytesReceived } : null, rtp: {} };
    rep.forEach((x) => { if (x.type === 'inbound-rtp') o.rtp['in-' + x.kind] = { bytes: x.bytesReceived, packets: x.packetsReceived, lost: x.packetsLost, frames: x.framesDecoded || null }; if (x.type === 'outbound-rtp') o.rtp['out-' + x.kind] = { bytes: x.bytesSent, packets: x.packetsSent, frames: x.framesEncoded || null }; });
    return o;
  });
  const grow = async (p, key) => { const a = (await stats(p)).rtp[key]; await p.waitForTimeout(2500); const b = (await stats(p)).rtp[key]; return a && b && b.bytes > a.bytes; };

  test('relay-only: the selected pair is a TURN relay on both sides, audio and video flow both ways, an ICE restart keeps them flowing', async ({ browser }, info) => {
    test.setTimeout(170000);
    const ca = await account(browser, 'Ray'), cb = await account(browser, 'Sam'), pa = await openPhone(ca), pb = await openPhone(cb); await ready(pa); await ready(pb);
    const ext = await extOf(pb); await expect.poll(() => pa.evaluate(async (e) => { const d = await (await fetch('/api/voice/directory', { credentials: 'same-origin' })).json(); return (d.people || []).some((p) => p.extension === e && !p.self); }, ext), { timeout: 30000 }).toBe(true);
    await pa.locator('#qpDialNumber').fill(ext); await expect(pa.locator('#phCall')).toBeEnabled(); await pa.locator('#phCall').click();
    await expect(pb.locator('#voiceIncoming')).toBeVisible({ timeout: 20000 }); await pb.locator('#viAnswer').click();
    for (const p of [pa, pb]) await expect(p.locator('#vbStatus')).toContainText('Connected', { timeout: 60000 });
    await pa.locator('#stVideo').click(); await expect(pb.locator('#voiceAsk')).toBeVisible({ timeout: 15000 }); await pb.locator('#vaskYes').click();
    for (const p of [pa, pb]) await expect.poll(() => p.evaluate(() => { const v = document.querySelector('.qp-stage .qv-remote'); return !!(v && v.videoWidth > 0); }), { timeout: 30000 }).toBe(true);
    const evidence = { note: 'both browsers on one machine, media forced through the local coturn (relay-only); not a different-network test', before: {}, afterRestart: {} };
    for (const [k, p] of [['caller', pa], ['callee', pb]]) {
      const s = evidence.before[k] = await stats(p);
      expect(s.iceTransportPolicy).toBe('relay'); expect(s.selected.local.type, k + ' selected local candidate').toBe('relay'); expect(s.dtls).toBe('connected'); expect(s.cipher, 'the negotiated SRTP cipher is reported').toBeTruthy();
      expect(await grow(p, 'in-audio'), k + ' audio in').toBe(true); expect(await grow(p, 'in-video'), k + ' video in').toBe(true); expect(await grow(p, 'out-video'), k + ' video out').toBe(true);
    }
    await pa.evaluate(() => window.qorllaVoice.sendOffer(true));                                                   // an ICE restart, as the client does itself when the path breaks
    await pa.waitForTimeout(4000);
    for (const [k, p] of [['caller', pa], ['callee', pb]]) {
      await expect.poll(async () => (await stats(p)).state, { timeout: 30000 }).toBe('connected'); const s = evidence.afterRestart[k] = await stats(p);
      expect(s.selected.local.type, k + ' after the restart').toBe('relay'); expect(await grow(p, 'in-audio'), k + ' audio after the restart').toBe(true); expect(await grow(p, 'in-video'), k + ' video after the restart').toBe(true);
    }
    const out = process.env.TURN_EVIDENCE_FILE || path.join(info.outputDir, 'turn-evidence.json'); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(evidence, null, 2)); console.log('TURN evidence written to ' + out);
    await pa.locator('#stEnd').click();
  });
});
