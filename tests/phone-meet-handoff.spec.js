const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const { PASSWORD } = require('./support/meet-stack');
const { startVoiceStack } = require('./support/voice-stack');

// Phone -> Meet hand-off v2.2, END TO END in two real Chromium sessions (fake camera and microphone) against the real main app, the real Voice Engine on PostgreSQL and the REAL Qorlla Meet
// (node on :3310, own PostgreSQL schema). Meet must be running WITH a Shield workload credential for this test engine: node scripts/phone-meet-test-meet.cjs (it writes the JWKS this spec serves). What this proves: the whole path on one machine with synthetic media. What it does NOT prove: physical
// devices, other networks, TURN, or mobile browsers.
const MAIN = 5343, VOICE = 5344;
test.describe('Phone to Meet hand-off (v2.2)', () => {
  test.describe.configure({ mode: 'serial' });
  let stack, jwks;
  test.beforeAll(async () => {
    test.setTimeout(150000);
    const JWKS = process.env.QORLLA_TEST_MEET_JWKS || require('node:os').tmpdir() + '/meet-jwks.json';                       // written by the script that started Meet with its workload key
    jwks = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(fs.readFileSync(JWKS)); }); await new Promise((ok) => jwks.listen(5345, '127.0.0.1', ok));
    stack = await startVoiceStack({ mainPort: MAIN, voicePort: VOICE, engineEnv: { VOICE_MOVE_RELEASE_WINDOW_SECONDS: '150', VOICE_MOVE_FRESH_MS: '8000', SHIELD_ENABLED: 'true', SHIELD_WORKLOAD_JWKS_URL: 'http://127.0.0.1:5345/jwks.json', SHIELD_WORKLOAD_ISSUER: 'qorlla-workload', SHIELD_WORKLOAD_ALLOWED: 'svc:meet=meet.signal' } });
  });
  test.afterAll(async () => { if (stack) await stack.stop(); if (jwks) await new Promise((ok) => jwks.close(ok)); });
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
  async function connect(browser) {
    const ca = await account(browser, 'Ann'), cb = await account(browser, 'Ben'), pa = await openPhone(ca), pb = await openPhone(cb); await ready(pa); await ready(pb); const ext = await extOf(pb);
    await expect.poll(() => pa.evaluate(async (e) => { const d = await (await fetch('/api/voice/directory', { credentials: 'same-origin' })).json(); return (d.people || []).some((p) => p.extension === e && !p.self); }, ext), { timeout: 30000 }).toBe(true);
    await pa.locator('#qpDialNumber').fill(ext); await expect(pa.locator('#phCall')).toBeEnabled(); await pa.locator('#phCall').click();
    await expect(pb.locator('#voiceIncoming')).toBeVisible({ timeout: 20000 }); await pb.locator('#viAnswer').click();
    for (const p of [pa, pb]) await expect(p.locator('#vbStatus')).toContainText('Connected', { timeout: 40000 });
    await expect.poll(() => pa.evaluate(() => !!(window.qorllaVoice.peerCaps && window.qorllaVoice.peerCaps.move >= 2)), { timeout: 15000 }).toBe(true);
    return { ca, cb, pa, pb };
  }
  async function agree(pa, pb) {
    pa.on('response', (r) => { if (/\/move|meetings\/(create|[0-9 %]+\/settings)/.test(r.url()) && r.status() >= 400) console.log('[agree resp]', r.request().method(), r.status(), r.url().replace(/^https?:\/\/[^/]+/, '')); });
    await pa.locator('#stMove').click(); await expect(pb.locator('#voiceAsk')).toBeVisible({ timeout: 20000 }).catch(async (e) => { console.log('[agree] ask not shown; A toast/bar:', await pa.evaluate(() => (document.getElementById('toast') || {}).textContent + ' | ' + document.getElementById('vmbText').textContent), '| peerCaps', await pa.evaluate(() => JSON.stringify(window.qorllaVoice.peerCaps)), await pa.evaluate(() => window.qorllaVoice.ctl && window.qorllaVoice.ctl.readyState)); throw e; }); await pb.locator('#vaskYes').click();
    await expect(pa.locator('#vmbOpen')).toBeVisible({ timeout: 20000 }); await expect(pb.locator('#vmbOpen')).toBeVisible({ timeout: 20000 });
  }
  /** Presses Open meeting, then the Start / Join button of the dialog it opens, and returns the Meet window that appears. */
  async function openMeet(page) {
    const pop = page.context().waitForEvent('page', { timeout: 30000 });
    await page.locator('#vmbOpen').click(); await expect(page.locator('#startDialog')).toBeVisible({ timeout: 15000 }); await expect(page.locator('#sdGo')).toBeEnabled({ timeout: 20000 }); await page.locator('#sdGo').click();
    const meet = await pop; await meet.waitForURL(/localhost:3310/, { timeout: 30000 }); return meet;
  }
  const phoneState = (p) => p.evaluate(() => ({ callId: window.qorllaVoice.callId, muted: window.qorllaVoice.muted }));
  const inboundAudio = (m) => m.evaluate(async () => (await window.__qorllaMeetProbe()).bytes);

  test('both join the SAME Meet room, hear each other, and only then does the server end the phone call (once, with the reason)', async ({ browser }) => {
    test.setTimeout(240000);
    const { pa, pb } = await connect(browser), callId = await pa.evaluate(() => window.qorllaVoice.callId);
    await agree(pa, pb);
    expect((await phoneState(pa)).muted, 'phone microphones are off during the move').toBe(true); expect((await phoneState(pb)).muted).toBe(true);
    const ma = await openMeet(pa);
    expect((await phoneState(pa)).callId, 'the phone call is still up while only ONE person is in Meet').toBe(callId); expect((await phoneState(pb)).callId).toBe(callId);
    await pa.waitForTimeout(6000); expect((await phoneState(pa)).callId, 'and it stays up: a lone participant never releases it').toBe(callId);
    const mb = await openMeet(pb);
    await expect.poll(async () => (await ma.evaluate(() => window.__qorllaMeetProbe())).participantId, { timeout: 30000 }).not.toBe(''); await expect.poll(async () => (await mb.evaluate(() => window.__qorllaMeetProbe())).participantId, { timeout: 30000 }).not.toBe('');
    const pra = await ma.evaluate(() => window.__qorllaMeetProbe()), prb = await mb.evaluate(() => window.__qorllaMeetProbe()); expect(pra.meetingId).toBe(prb.meetingId); expect(pra.participantId).not.toBe(prb.participantId);
    await expect.poll(() => inboundAudio(ma), { timeout: 60000 }).toBeGreaterThan(1000); await expect.poll(() => inboundAudio(mb), { timeout: 60000 }).toBeGreaterThan(1000);   // bidirectional audio inside Meet
    await expect.poll(() => pa.evaluate(() => window.qorllaVoice.callId), { timeout: 60000 }).toBeNull(); await expect.poll(() => pb.evaluate(() => window.qorllaVoice.callId), { timeout: 30000 }).toBeNull();
    const calls = await pa.evaluate(async () => (await window.qorllaVoice.api('/calls')).calls); const c = calls.find((x) => x.id === callId); expect(c.status).toBe('ended'); expect(c.end_reason).toBe('moved_to_meeting');
    expect(calls.filter((x) => x.id === callId).length).toBe(1);
  });

  test('premature release is impossible: B agrees but never joins -> the phone call carries on, microphones come back, the hand-off expires', async ({ browser }) => {
    test.setTimeout(300000);
    const { pa, pb } = await connect(browser), callId = await pa.evaluate(() => window.qorllaVoice.callId); await agree(pa, pb);
    await openMeet(pa);                                                                                              // only A ever enters Meet
    await expect.poll(async () => (await pa.evaluate(async (id) => window.qorllaVoice.api('/calls/' + id + '/move'), callId)).state, { timeout: 175000 }).toBe('expired');           // the 150 s window ends (the SERVER's record)
    await expect(pa.locator('#voiceMoveBar')).toBeHidden({ timeout: 15000 });
    for (const [who, p] of [['host', pa], ['guest', pb]]) { await expect.poll(() => p.evaluate(() => window.qorllaVoice.muted), { message: who + ' microphone restored', timeout: 15000 }).toBe(false); expect((await phoneState(p)).callId).toBe(callId); await expect(p.locator('#vbStatus')).toContainText('Connected'); }
    const st = await pa.evaluate(async (id) => window.qorllaVoice.api('/calls/' + id + '/move'), callId); expect(st.state).toBe('expired'); expect(st.closedReason).toBe('release_deadline_passed');
  });

  test('refresh recovery: B reloads its page mid hand-off, the server still holds the move, B resumes (microphone off) and the hand-off completes', async ({ browser }) => {
    test.setTimeout(240000);
    const { pa, pb } = await connect(browser), callId = await pa.evaluate(() => window.qorllaVoice.callId); await agree(pa, pb);
    const ma = await openMeet(pa), mb = await openMeet(pb);
    await pb.reload(); await expect(pb.locator('#voiceMoveBar')).toBeVisible({ timeout: 60000 }); await expect(pb.locator('#vmbText')).toContainText('still in progress');       // resumed from the server's record
    await expect.poll(() => inboundAudio(ma), { timeout: 60000 }).toBeGreaterThan(1000);
    await expect.poll(() => pa.evaluate(() => window.qorllaVoice.callId), { timeout: 90000 }).toBeNull();
    const c = (await pa.evaluate(async () => (await window.qorllaVoice.api('/calls')).calls)).find((x) => x.id === callId); expect(c.end_reason).toBe('moved_to_meeting'); void mb;
  });
});
