const { test, expect } = require('@playwright/test');
const { startVoiceStack } = require('./support/voice-stack');
const { PASSWORD } = require('./support/meet-stack');

// Ringtones: eight ORIGINAL tones written for Qorlla (synthesized in the browser; no audio files, nothing from any third party). The preview in Phone settings and the real
// incoming-call ring share one catalogue, and the ring a person hears is the one they saved. Real main app + real voice engine + two real browsers.
const MAIN = 5401, VOICE = 5402;
const TONES = { classic: [880, 880], soft: [523, 659], chime: [1046, 784, 1046], marimba: [659, 784, 988, 784, 659], pulse: [740, 740, 740], rise: [392, 494, 587, 784], bell: [1319, 1047], lullaby: [523, 587, 659, 523] };
const WAVES = { classic: 'sine', soft: 'sine', chime: 'sine', marimba: 'triangle', pulse: 'square', rise: 'triangle', bell: 'sine', lullaby: 'sine' };

test.describe('ringtones: an original catalogue; the chosen tone is the one that rings', () => {
  test.describe.configure({ mode: 'serial' });
  let stack; const rand = () => Math.random().toString(36).slice(2, 7);
  test.beforeAll(async () => { stack = await startVoiceStack({ mainPort: MAIN, voicePort: VOICE, engineEnv: { VOICE_RING_SECONDS: '30' } }); });
  test.afterAll(async () => { if (stack) await stack.stop(); });

  // records every oscillator the page starts (waveform + frequency), so tests can tell WHICH tone was played
  const spy = () => { window.__osc = []; const s = OscillatorNode.prototype.start; OscillatorNode.prototype.start = function (...a) { window.__osc.push({ type: this.type, f: Math.round(this.frequency.value) }); return s.apply(this, a); }; };
  async function person(browser, name) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] }), username = name.toLowerCase() + rand();
    expect((await ctx.request.post(stack.base + '/api/auth/register', { data: { username, displayName: name, password: PASSWORD } })).status()).toBe(201);
    await ctx.addInitScript(spy); const page = await ctx.newPage(); await page.goto(stack.base + '/qorlla.html#home');
    await expect(async () => { await page.locator('.nav-item[data-view=phone]').click(); await expect(page.locator('#phTab-dial')).toBeVisible({ timeout: 3000 }); }).toPass({ timeout: 30000 });
    await expect.poll(() => page.evaluate(() => !!(window.qorllaVoice && window.qorllaVoice.ws && window.qorllaVoice.ws.readyState === 1)), { timeout: 20000 }).toBe(true);
    await expect(page.locator('#qpMyExt')).toContainText('Your Qorlla extension'); return { ctx, page, username, ext: (await page.locator('#qpMyExt').textContent()).match(/extension: (\d+)/)[1] };
  }
  const put = (p, ringtone) => p.ctx.request.put(stack.base + '/api/workplace/phone-settings', { data: { ringtone } });

  test('the server accepts exactly the catalogue and refuses anything else; the saved choice comes back', async ({ playwright }) => {
    const r = await playwright.request.newContext(); expect((await r.post(stack.base + '/api/auth/register', { data: { username: 'rt' + rand(), displayName: 'Ring', password: PASSWORD } })).status()).toBe(201);
    for (const id of Object.keys(TONES)) { const ok = await r.put(stack.base + '/api/workplace/phone-settings', { data: { ringtone: id } }); expect(ok.status(), id).toBe(200); expect((await ok.json()).ringtone).toBe(id); }
    expect((await (await r.get(stack.base + '/api/workplace/phone-settings')).json()).ringtone).toBe('lullaby');
    for (const bad of ['siren', 'Samsung', '../x', '', 'classic ']) expect((await r.put(stack.base + '/api/workplace/phone-settings', { data: { ringtone: bad } })).status(), JSON.stringify(bad)).toBe(400);
    await r.dispose();
  });

  test('in Phone settings every tone is listed and its preview plays that tone\'s own notes and waveform; saving sticks', async ({ browser }) => {
    const me = await person(browser, 'Preview'); await me.page.locator('#phSettingsBtn').click(); await me.page.locator('#psNav-audio').click();
    await expect(me.page.locator('#psRing option')).toHaveCount(8); const labels = await me.page.locator('#psRing option').allTextContents(); expect(labels).toEqual(['Classic', 'Soft', 'Chime', 'Marimba', 'Pulse', 'Rise', 'Bell', 'Lullaby']);
    for (const id of ['marimba', 'pulse', 'bell']) {
      await me.page.evaluate(() => { window.__osc.length = 0; }); await me.page.selectOption('#psRing', id); await me.page.locator('#psPlayRing').click();
      await expect.poll(() => me.page.evaluate(() => window.__osc.length)).toBe(TONES[id].length); const got = await me.page.evaluate(() => window.__osc);
      expect(got.map((o) => o.f), id).toEqual(TONES[id]); expect(new Set(got.map((o) => o.type)), id).toEqual(new Set([WAVES[id]]));
    }
    await me.page.selectOption('#psRing', 'marimba'); await me.page.locator('#psSaveAudio').click(); await expect(me.page.locator('#psSaveAudioMsg')).toContainText('Saved');
    expect((await (await me.ctx.request.get(stack.base + '/api/workplace/phone-settings')).json()).ringtone).toBe('marimba'); await me.ctx.close();
  });

  test('a real incoming call rings with the tone the person saved - not a fixed beep - and ringback for the caller is unchanged', async ({ browser }) => {
    test.setTimeout(120000);
    const caller = await person(browser, 'Caller'), callee = await person(browser, 'Callee');
    for (const [tone, expected] of [['rise', TONES.rise], ['pulse', TONES.pulse]]) {
      expect((await put(callee, tone)).status()).toBe(200); await callee.page.reload();                                             // a fresh page load reads the preference
      await expect.poll(() => callee.page.evaluate(() => !!(window.qorllaVoice && window.qorllaVoice.ws && window.qorllaVoice.ws.readyState === 1)), { timeout: 20000 }).toBe(true);
      await callee.page.evaluate(() => { window.__osc.length = 0; }); await caller.page.evaluate(() => { window.__osc.length = 0; });
      await caller.page.locator('#phTab-dial').click(); await caller.page.locator('#qpDialNumber').fill(callee.ext); await expect(caller.page.locator('#phCall')).toBeEnabled(); await caller.page.locator('#phCall').click();
      await expect(callee.page.locator('#voiceIncoming')).toBeVisible({ timeout: 15000 });
      await expect.poll(() => callee.page.evaluate(() => window.__osc.length), { timeout: 10000 }).toBeGreaterThanOrEqual(expected.length);
      const ring = (await callee.page.evaluate(() => window.__osc)).slice(0, expected.length); expect(ring.map((o) => o.f), tone).toEqual(expected); expect(new Set(ring.map((o) => o.type))).toEqual(new Set([WAVES[tone]]));
      expect((await callee.page.evaluate(() => window.__osc)).some((o) => o.f === 880 && tone !== 'classic'), 'the old fixed 880 Hz beep is gone').toBe(false);
      const back = await caller.page.evaluate(() => window.__osc); expect(back.length).toBeGreaterThan(0); expect(back.every((o) => o.f === 440 && o.type === 'sine'), 'ringback is the unchanged soft 440 Hz tone').toBe(true);
      await callee.page.locator('#viDecline').click(); await expect(callee.page.locator('#voiceIncoming')).toBeHidden({ timeout: 10000 });
      await expect.poll(() => caller.page.locator('#phCall').isEnabled(), { timeout: 15000 }).toBe(true);
    }
    await caller.ctx.close(); await callee.ctx.close();
  });
});
