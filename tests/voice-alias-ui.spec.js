const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PASSWORD } = require('./support/meet-stack');
const { startVoiceStack } = require('./support/voice-stack');

// A3.7: country-aware Qorlla numbers on the Phone page, in real browsers, against the real main app and the real engine (Shield enforcement on, VOICE_COUNTRY_ALIAS_ENABLED=true).
// A Qorlla number is a Qorlla-ONLY alias: it works between Qorlla accounts of the same confirmed country and cannot be called from a phone network. The reserved ranges below are TEST values.
// What this does not prove: any carrier or PSTN behaviour (there is none), other browsers, real devices, or localisation of the new strings.
const MAIN = 5303, VOICE = 5304;
const NS = JSON.stringify({ GB: { prefix: '0770090', length: 11 }, GH: { prefix: '020000', length: 10 } });

test.describe('Qorlla numbers on the Phone page (country-aware internal aliases)', () => {
  test.describe.configure({ mode: 'serial' });
  let stack;
  test.beforeAll(async () => {
    test.setTimeout(150000);
    stack = await startVoiceStack({ mainPort: MAIN, voicePort: VOICE,
      engineEnv: { SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_WORKLOAD_JWKS_URL: 'http://127.0.0.1:' + MAIN + '/.well-known/shield-workload-jwks.json', SHIELD_WORKLOAD_ISSUER: 'qorlla-main-workload', SHIELD_WORKLOAD_ALLOWED: 'svc:main-app=shield.admin|shield.suspend', VOICE_COUNTRY_ALIAS_ENABLED: 'true', VOICE_ALIAS_NAMESPACES: NS },
      mainEnv: { SHIELD_SYNC_URL: 'http://127.0.0.1:' + VOICE, SHIELD_REQUIRE_VERIFIED: 'true', SHIELD_RECONCILE_SECONDS: '2' } });
  });
  test.afterAll(async () => { if (stack) await stack.stop(); });

  const rand = () => Math.random().toString(36).slice(2, 7);
  async function account(browser, name, { verify = true } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] }), u = (name + rand()).toLowerCase();
    const r = await ctx.request.post(stack.base + '/api/auth/register', { data: { username: u, displayName: name + ' Test', password: PASSWORD, email: u + '@example.test' } }); expect(r.status()).toBe(201);
    const id = (await r.json()).user.id;
    if (verify) { const raw = crypto.randomBytes(32).toString('hex'), file = path.join(stack.main.dataDir, 'auth', 'tokens.json'); let list = []; try { list = JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); } catch { /* none yet */ }
      list.push({ hash: crypto.createHash('sha256').update(raw).digest('hex'), userId: id, purpose: 'verify', exp: Date.now() + 3600e3, email: u + '@example.test' }); fs.writeFileSync(file, JSON.stringify(list)); expect((await ctx.request.post(stack.base + '/api/auth/verify', { data: { token: raw } })).status()).toBe(200); }
    return { ctx, id, name: name + ' Test' };
  }
  async function openPhone(ctx) {
    const page = await ctx.newPage(); if (process.env.ALIAS_DEBUG) { page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 200))); page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300))); } await page.goto(stack.base + '/qorlla.html#home');
    await expect(async () => { await page.locator('.nav-item[data-view=phone]').click(); await expect(page.locator('#phTab-dial')).toBeVisible({ timeout: 3000 }); }).toPass({ timeout: 30000 }); return page;
  }
  const connected = (page) => expect.poll(() => page.evaluate(() => !!(window.qorllaVoice && window.qorllaVoice.ws && window.qorllaVoice.ws.readyState === 1)), { timeout: 30000 }).toBe(true);
  async function getNumber(page, countryName) {
    await expect(page.locator('#qpAliasGet')).toBeDisabled(); await page.locator('#qpAliasCountry').selectOption({ label: countryName }); await page.locator('#qpAliasConfirm').check(); await expect(page.locator('#qpAliasGet')).toBeEnabled();
    await page.locator('#qpAliasGet').click(); await expect(page.locator('#qpAliasNumber')).toContainText('Your Qorlla number', { timeout: 15000 }); return (await page.locator('#qpAliasNumber').textContent());
  }

  test('a verified account chooses its country, confirms it, and sees its Qorlla number with the country and a "Qorlla-only" label; it persists across a reload', async ({ browser }) => {
    const a = await account(browser, 'Alice'); const page = await openPhone(a.ctx); await connected(page);
    await expect(page.locator('#qpAliasCountry option')).toHaveText(['United Kingdom', 'Ghana']); await expect(page.locator('#qpAlias')).toContainText('cannot be called from a phone network');
    await expect(page.locator('#qpAliasGet')).toBeDisabled();                                    // nothing happens until the person confirms the country
    const text = await getNumber(page, 'United Kingdom'); expect(text).toMatch(/Your Qorlla number: 07[0-9 ]+ · United Kingdom · Qorlla-only: works for calls between Qorlla accounts, not from phone networks/);
    await expect(page.locator('#qpAliasGet')).toHaveCount(0);                                    // the form is gone: one number per account, no self-service change
    await page.screenshot({ path: path.join(__dirname, '..', 'test-results', 'a37-alias.png') }).catch(() => {});
    await page.reload(); await expect(async () => { await page.locator('.nav-item[data-view=phone]').click(); await expect(page.locator('#qpAliasNumber')).toContainText('United Kingdom', { timeout: 3000 }); }).toPass({ timeout: 30000 });
    expect((await page.evaluate(() => window.qorllaVoice.api('/alias'))).confirmedCountry).toBe('GB');
    await a.ctx.close();
  });

  test('an UNVERIFIED account sees no Qorlla-number form (only the verification message)', async ({ browser }) => {
    const u = await account(browser, 'Newbie', { verify: false }); const page = await openPhone(u.ctx);
    await expect(page.locator('#qpMyExt')).toContainText('Verify your email address'); await expect(page.locator('#qpAliasCountry')).toHaveCount(0); await expect(page.locator('#qpAliasNumber')).toHaveCount(0); await u.ctx.close();
  });

  test('two accounts of the SAME country: dialling the Qorlla number (formatted any way) rings the other account and connects; it is never treated as a phone-network call', async ({ browser }) => {
    test.setTimeout(150000);
    const a = await account(browser, 'Anna'), b = await account(browser, 'Ben'); const pa = await openPhone(a.ctx), pb = await openPhone(b.ctx); await connected(pa); await connected(pb);
    const shown = await getNumber(pa, 'United Kingdom'); await getNumber(pb, 'United Kingdom'); const digits = shown.match(/Your Qorlla number: ([0-9 ]+) ·/)[1].replace(/ /g, ''); expect(digits).toMatch(/^0770090[0-9]{4}$/);
    await pb.locator('#qpDialNumber').fill(digits); await expect(pb.locator('#qpDialHint')).toContainText('Qorlla number: a call to a Qorlla account in your country, never a phone-network call'); await expect(pb.locator('#phCall')).toBeEnabled();
    await pb.locator('#phCall').click(); await expect(pa.locator('#voiceIncoming')).toBeVisible({ timeout: 15000 }); await expect(pa.locator('#viWho')).toContainText(/Ben Test|Extension [0-9]+/); await pa.locator('#viAnswer').click();
    // the caller is identified by name when the directory has loaded, by extension otherwise
    if (process.env.ALIAS_DEBUG) { await pa.waitForTimeout(6000); for (const [n, p] of [['callee', pa], ['caller', pb]]) console.log('[state]', n, JSON.stringify(await p.evaluate(() => ({ callId: window.qorllaVoice.callId, status: document.getElementById('vbStatus').textContent, bar: !document.getElementById('voiceBar').classList.contains('hidden'), incoming: document.getElementById('voiceIncoming').open, toasts: [...document.querySelectorAll('.toast,[role=alert]')].map((x) => x.textContent).slice(0, 5), conn: window.qorllaVoice.pc && window.qorllaVoice.pc.connectionState })))); }
    for (const p of [pa, pb]) await expect(p.locator('#vbStatus')).toContainText('Connected', { timeout: 20000 });
    await pb.locator('#vbEnd').click(); await expect(pb.locator('#voiceBar')).toBeHidden({ timeout: 15000 }); await a.ctx.close(); await b.ctx.close();
  });

  test('a caller from ANOTHER country (or one who never chose a country) cannot reach the number: "no Qorlla user has that number in your country"; "+" numbers are still refused', async ({ browser }) => {
    const a = await account(browser, 'Uma'), c = await account(browser, 'Kofi'), n = await account(browser, 'Nocountry'); const pa = await openPhone(a.ctx), pc = await openPhone(c.ctx), pn = await openPhone(n.ctx); await connected(pa); await connected(pc); await connected(pn);
    const digits = (await getNumber(pa, 'United Kingdom')).match(/Your Qorlla number: ([0-9 ]+) ·/)[1].replace(/ /g, ''); await getNumber(pc, 'Ghana');
    for (const p of [pc, pn]) { await p.locator('#qpDialNumber').fill(digits); await p.locator('#phCall').click(); await expect(p.locator('.toast, #toast, [role=alert]').filter({ hasText: 'No Qorlla user has that number in your country' }).first()).toBeVisible({ timeout: 10000 }); await expect(p.locator('#voiceBar')).toBeHidden(); }
    await expect(pa.locator('#voiceIncoming')).toBeHidden();
    await pc.locator('#qpDialNumber').fill('+13024441516'); await expect(pc.locator('#qpDialHint')).toContainText('Public telephone numbers are not available'); await expect(pc.locator('#phCall')).toBeDisabled();
    await a.ctx.close(); await c.ctx.close(); await n.ctx.close();
  });
});
