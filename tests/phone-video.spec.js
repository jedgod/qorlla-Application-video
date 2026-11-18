const { test, expect } = require('@playwright/test');
const { PASSWORD } = require('./support/meet-stack');
const { startVoiceStack } = require('./support/voice-stack');

// Phone video inside the same call and Move to Qorlla Meeting, in two real Chromium browsers with fake camera and microphone
// (real WebRTC, the real main app, the real Voice Engine). Run: QORLLA_TEST_VOICE_DB=<scratch postgres url> npx playwright test tests/phone-video.spec.js --project=chromium
// What this does not prove: real cameras, mobile browsers, cross-network (TURN) video, or that the other person actually joins the Meet room.
const MAIN = 5323, VOICE = 5324;
test.describe('Phone video and Move to Qorlla Meeting', () => {
  test.describe.configure({ mode: 'serial' });
  let stack;
  test.beforeAll(async () => { test.setTimeout(150000); stack = await startVoiceStack({ mainPort: MAIN, voicePort: VOICE }); });
  test.afterAll(async () => { if (stack) await stack.stop(); });
  const rand = () => Math.random().toString(36).slice(2, 7);
  async function account(browser, name) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['microphone', 'camera'] }), u = (name + rand()).toLowerCase();
    const r = await ctx.request.post(stack.base + '/api/auth/register', { data: { username: u, displayName: name + ' Test', password: PASSWORD, email: u + '@example.test' } });
    expect(r.status()).toBeLessThan(300); return { ctx, name: name + ' Test' };
  }
  async function openPhone(ctx) {
    const page = await ctx.newPage(); page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
    await page.goto(stack.base + '/qorlla.html#phone');
    await expect(async () => { await page.locator('.nav-item[data-view=phone]').click(); await expect(page.locator('#phTab-dial')).toBeVisible({ timeout: 3000 }); }).toPass({ timeout: 30000 }); return page;
  }
  const ready = (page) => expect.poll(() => page.evaluate(() => !!(window.qorllaVoice && window.qorllaVoice.ws && window.qorllaVoice.ws.readyState === 1)), { timeout: 30000 }).toBe(true);
  const extOf = (page) => page.evaluate(async () => { for (let i = 0; i < 60; i++) { try { const d = await (await fetch('/api/voice/directory', { credentials: 'same-origin' })).json(); const me = (d.people || []).find((p) => p.self); if (me) return me.extension; } catch (e) { /* retry */ } await new Promise((r) => setTimeout(r, 500)); } return ''; });
  const inDirectory = (page, ext) => expect.poll(() => page.evaluate(async (e) => { const d = await (await fetch('/api/voice/directory', { credentials: 'same-origin' })).json(); return (d.people || []).some((p) => p.extension === e && !p.self); }, ext), { timeout: 30000 }).toBe(true);
  async function connect(browser) {
    const a = await account(browser, 'Ann'), b = await account(browser, 'Ben'), pa = await openPhone(a.ctx), pb = await openPhone(b.ctx);
    await ready(pa); await ready(pb); const ext = await extOf(pb); expect(ext).toMatch(/^\d{3,8}$/); await inDirectory(pa, ext);
    await pa.locator('#qpDialNumber').fill(ext); await expect(pa.locator('#phCall')).toBeEnabled(); await pa.locator('#phCall').click();
    await expect(pb.locator('#voiceIncoming')).toBeVisible({ timeout: 20000 }); await pb.locator('#viAnswer').click();
    for (const p of [pa, pb]) await expect(p.locator('#vbStatus')).toContainText('Connected', { timeout: 40000 });
    return { a, b, pa, pb, ext };
  }
  const hasRemoteVideo = (page) => expect.poll(() => page.evaluate(() => { const v = document.querySelector('.qp-stage .qv-remote'); return !!(v && v.videoWidth > 0); }), { timeout: 30000 }).toBe(true);

  test('video is asked for first: accept shows both cameras; the audio call is the same call', async ({ browser }) => {
    test.setTimeout(150000);
    const { pa, pb } = await connect(browser), callId = await pa.evaluate(() => window.qorllaVoice.callId);
    await pa.locator('#stVideo').click();
    await expect(pb.locator('#voiceAsk')).toBeVisible({ timeout: 15000 }); await expect(pb.locator('#vaskT')).toContainText('wants to start video');
    expect(await pb.evaluate(() => document.body.classList.contains('qv-on')), 'nothing is shown to the callee before they accept').toBe(false);
    await pb.locator('#vaskYes').click();
    await hasRemoteVideo(pa); await hasRemoteVideo(pb);
    expect(await pa.evaluate(() => window.qorllaVoice.callId)).toBe(callId);
    await expect(pa.locator('#stVideo')).toHaveAttribute('aria-pressed', 'true');
    await pa.locator('#stVideo').click();                                   // stop video: the call carries on
    await expect.poll(() => pb.evaluate(() => document.body.classList.contains('qv-remote-on'))).toBe(false);
    await expect(pb.locator('#vbStatus')).toContainText('Connected');
    await pa.locator('#stEnd').click();
  });

  test('declining video leaves the voice call untouched and tells the requester', async ({ browser }) => {
    test.setTimeout(150000);
    const { pa, pb } = await connect(browser);
    await pa.locator('#stVideo').click(); await expect(pb.locator('#voiceAsk')).toBeVisible({ timeout: 15000 }); await pb.locator('#vaskNo').click();
    await expect.poll(() => pa.evaluate(() => document.body.classList.contains('qv-on')), { timeout: 15000 }).toBe(false);
    await expect(pa.locator('#vbStatus')).toContainText('Connected'); await expect(pb.locator('#vbStatus')).toContainText('Connected');
    await pa.locator('#stEnd').click();
  });

  test('Video Call (Phone) places the call and asks for video once it connects', async ({ browser }) => {
    test.setTimeout(150000);
    const a = await account(browser, 'Cam'), b = await account(browser, 'Dee'), pa = await openPhone(a.ctx), pb = await openPhone(b.ctx);
    await ready(pa); await ready(pb); const ext = await extOf(pb); await inDirectory(pa, ext);
    await pa.locator('#qpDialNumber').fill(ext); await pa.locator('#phVideoMore').click(); await expect(pa.locator('#phVideoMenu')).toBeVisible();
    await pa.locator('#phVideoMenu button', { hasText: 'Video Call (Phone)' }).click();
    await expect(pb.locator('#voiceIncoming')).toBeVisible({ timeout: 20000 }); await pb.locator('#viAnswer').click();
    await expect(pb.locator('#voiceAsk')).toBeVisible({ timeout: 30000 }); await pb.locator('#vaskYes').click();
    await hasRemoteVideo(pa); await hasRemoteVideo(pb); await pa.locator('#stEnd').click();
  });

  test('Move to Qorlla Meeting asks first, opens the meeting on both sides, keeps the call and mutes the phone microphone until cancelled', async ({ browser }) => {
    test.setTimeout(150000);
    const { pa, pb } = await connect(browser);
    await pa.locator('#stMove').click();
    await expect(pb.locator('#voiceAsk')).toBeVisible({ timeout: 15000 }); await expect(pb.locator('#vaskT')).toContainText('Move to a Qorlla Meeting');
    await expect(pa.locator('#voiceMoveBar')).toBeVisible();
    await expect(pa.locator('#vbStatus')).toContainText('Connected');             // still on the phone call while waiting
    await pb.locator('#vaskYes').click();
    await expect(pa.locator('#startDialog')).toBeVisible({ timeout: 15000 });     // host start screen
    await expect(pb.locator('#joinDialog, #startDialog[data-mode=join]').first()).toBeVisible({ timeout: 15000 });
    expect(await pa.evaluate(() => window.qorllaVoice.muted)).toBe(true); expect(await pb.evaluate(() => window.qorllaVoice.muted)).toBe(true);
    await expect(pa.locator('#vbStatus')).toContainText('Connected');
    await pa.locator('#vmbStay').click();                                          // cancel: back to a normal call, unmuted, the other side is told
    await expect.poll(() => pb.evaluate(() => window.qorllaVoice.muted), { timeout: 10000 }).toBe(false);
    expect(await pa.evaluate(() => window.qorllaVoice.muted)).toBe(false);
    await expect(pa.locator('#voiceMoveBar')).toBeHidden(); await pa.locator('#sdCancel').click(); await expect(pa.locator('#startDialog')).toBeHidden();
    await pa.locator('#stEnd').click();
  });

  test('declining the move keeps the phone call', async ({ browser }) => {
    test.setTimeout(150000);
    const { pa, pb } = await connect(browser);
    await pa.locator('#stMove').click(); await expect(pb.locator('#voiceAsk')).toBeVisible({ timeout: 15000 }); await pb.locator('#vaskNo').click();
    await expect(pa.locator('#voiceMoveBar')).toBeHidden({ timeout: 15000 });
    await expect(pa.locator('#vbStatus')).toContainText('Connected'); await expect(pb.locator('#vbStatus')).toContainText('Connected');
    expect(await pa.evaluate(() => window.qorllaVoice.muted)).toBe(false);
    await pa.locator('#stEnd').click();
  });
});
