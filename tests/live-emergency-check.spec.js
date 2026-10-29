const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { PASSWORD } = require('./support/meet-stack');

// The emergency-number protection on the REAL running application: the Dial Pad refuses 911 and friends, and an ordinary extension still works. Run with LIVE_BASE=http://localhost:3200 (and LIVE_SHOTS for screenshots).
const BASE = process.env.LIVE_BASE, shots = process.env.LIVE_SHOTS ? path.resolve(process.env.LIVE_SHOTS) : path.resolve(__dirname, '..', '.dev-stack', 'live-check');
test.describe('Live check: emergency numbers on the running application', () => {
  test.skip(!BASE, 'set LIVE_BASE to the running application');
  test('the Dial Pad says Qorlla cannot place emergency calls and will not dial them; an ordinary extension still shows the normal hint', async ({ browser }) => {
    test.setTimeout(90000); fs.mkdirSync(shots, { recursive: true });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] }), u = 'qaemg' + Math.random().toString(36).slice(2, 7);
    expect((await ctx.request.post(BASE + '/api/auth/register', { data: { username: u, displayName: 'QA Emergency ' + u, password: PASSWORD } })).status()).toBe(201);
    const page = await ctx.newPage(); await page.goto(BASE + '/qorlla.html#home');
    await expect(async () => { await page.locator('.nav-item[data-view=phone]').click(); await expect(page.locator('#phTab-dial')).toBeVisible({ timeout: 3000 }); }).toPass({ timeout: 30000 });
    await expect.poll(() => page.evaluate(() => !!(window.qorllaVoice && window.qorllaVoice.ws && window.qorllaVoice.ws.readyState === 1)), { timeout: 30000 }).toBe(true);
    for (const n of ['911', '112', '999', '000', '110', '119']) { await page.locator('#qpDialNumber').fill(n); await expect(page.locator('#qpDialHint')).toContainText('cannot place emergency calls'); await expect(page.locator('#phCall')).toBeDisabled(); }
    await page.locator('#qpDialNumber').fill('911'); await page.screenshot({ path: path.join(shots, '07-emergency-dialpad.png') });
    await page.locator('#qpDialNumber').fill('2000'); await expect(page.locator('#qpDialHint')).not.toContainText('emergency');
    // and the engine, directly: the same numbers cannot be dialled through the API either
    const refused = await page.evaluate(async () => { const out = {}; for (const n of ['911', '112', '999']) out[n] = await window.qorllaVoice.dial(n).then(() => 'dialled', (e) => e.code || e.message); return out; });
    expect(refused).toEqual({ 911: 'invalid_input', 112: 'invalid_input', 999: 'invalid_input' });
    await ctx.close();
  });
});
