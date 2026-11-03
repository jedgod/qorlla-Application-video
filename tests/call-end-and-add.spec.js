const { test, expect } = require('@playwright/test');
const { startVoiceStack } = require('./support/voice-stack');
const { PASSWORD } = require('./support/meet-stack');

// Ending a call and adding people to it. Real main app + real voice engine + real browsers.
//   1. When the caller ends (or cancels) a call, the other side stops ringing - even if its connection was down at that moment.
//   2. A person on a call can add more people; they ring, can join, and everybody can talk to everybody.
const MAIN = 5421, VOICE = 5422;

test.describe('ending a call and adding participants', () => {
  test.describe.configure({ mode: 'serial' });
  let stack; const rand = () => Math.random().toString(36).slice(2, 7);
  test.beforeAll(async () => { stack = await startVoiceStack({ mainPort: MAIN, voicePort: VOICE, engineEnv: { VOICE_RING_SECONDS: '60' } }); });
  test.afterAll(async () => { if (stack) await stack.stop(); });

  // counts every oscillator / media element the page starts, so a test can tell whether a ring is still going
  const spy = () => {
    window.__osc = 0; window.__aud = []; const s = OscillatorNode.prototype.start; OscillatorNode.prototype.start = function (...a) { window.__osc++; return s.apply(this, a); };
    const p = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { if (/ringtones/.test(this.src)) window.__aud.push(this); return p.apply(this, arguments).catch(() => {}); };
  };
  async function person(browser, name) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] }), username = name.toLowerCase() + rand();
    expect((await ctx.request.post(stack.base + '/api/auth/register', { data: { username, displayName: name, password: PASSWORD } })).status()).toBe(201);
    await ctx.addInitScript(spy); const page = await ctx.newPage(); await page.goto(stack.base + '/qorlla.html#home');
    await expect(async () => { await page.locator('.nav-item[data-view=phone]').click(); await expect(page.locator('#phTab-dial')).toBeVisible({ timeout: 3000 }); }).toPass({ timeout: 30000 });
    await expect.poll(() => page.evaluate(() => !!(window.qorllaVoice && window.qorllaVoice.ws && window.qorllaVoice.ws.readyState === 1)), { timeout: 20000 }).toBe(true);
    await expect(page.locator('#qpMyExt')).toContainText('Your Qorlla extension');
    return { ctx, page, username, name, ext: (await page.locator('#qpMyExt').textContent()).match(/extension: (\d+)/)[1] };
  }
  const dial = async (from, ext) => { await from.page.locator('#phTab-dial').click(); await from.page.locator('#qpDialNumber').fill(ext); await expect(from.page.locator('#phCall')).toBeEnabled(); await from.page.locator('#phCall').click(); };
  const ringing = (p) => p.evaluate(() => ({ osc: window.__osc, playing: window.__aud.filter((a) => !a.paused).length }));
  // true while a ring is audible: the oscillator counter still climbs, or a ring file is still playing
  async function stillRinging(p) { const a = await ringing(p); await p.waitForTimeout(2500); const b = await ringing(p); return b.osc > a.osc || b.playing > 0; }

  for (const tone of ['classic', 'lib-a-vivo-lovely-xylophone']) {
    test(`caller cancels while it rings: the callee's dialog goes and the ring stops (${tone})`, async ({ browser }) => {
      test.setTimeout(90000);
      const a = await person(browser, 'Caller'), b = await person(browser, 'Callee');
      expect((await b.ctx.request.put(stack.base + '/api/workplace/phone-settings', { data: { ringtone: tone } })).status()).toBe(200); await b.page.reload();
      await expect.poll(() => b.page.evaluate(() => !!(window.qorllaVoice && window.qorllaVoice.ws && window.qorllaVoice.ws.readyState === 1)), { timeout: 20000 }).toBe(true);
      await dial(a, b.ext); await expect(b.page.locator('#voiceIncoming')).toBeVisible({ timeout: 15000 }); expect(await stillRinging(b.page), 'it rings while the call is pending').toBe(true);
      await a.page.locator('#vbEnd').click();
      await expect(b.page.locator('#voiceIncoming')).toBeHidden({ timeout: 8000 }); expect(await stillRinging(b.page), 'the ring has stopped').toBe(false);
      await a.ctx.close(); await b.ctx.close();
    });
  }

  test('the callee was offline when the caller hung up: coming back online clears the ringing call', async ({ browser }) => {
    test.setTimeout(120000);
    const a = await person(browser, 'Caller'), b = await person(browser, 'Callee');
    await dial(a, b.ext); await expect(b.page.locator('#voiceIncoming')).toBeVisible({ timeout: 15000 });
    await b.ctx.setOffline(true); await b.page.evaluate(() => { try { window.qorllaVoice.ws.close(); } catch (e) { /* already closed */ } });
    await a.page.locator('#vbEnd').click(); await expect(a.page.locator('#vbEnd')).toBeHidden({ timeout: 10000 });
    await b.page.waitForTimeout(1500); await b.ctx.setOffline(false);
    await expect(b.page.locator('#voiceIncoming')).toBeHidden({ timeout: 30000 }); expect(await stillRinging(b.page), 'the ring has stopped').toBe(false);
    await a.ctx.close(); await b.ctx.close();
  });

  test('the caller ends an answered call: the other side ends too', async ({ browser }) => {
    test.setTimeout(90000);
    const a = await person(browser, 'Caller'), b = await person(browser, 'Callee');
    await dial(a, b.ext); await expect(b.page.locator('#voiceIncoming')).toBeVisible({ timeout: 15000 }); await b.page.locator('#viAnswer').click();
    await expect(b.page.locator('#vbEnd')).toBeVisible({ timeout: 15000 }); await expect(a.page.locator('#vbEnd')).toBeVisible();
    await a.page.locator('#vbEnd').click(); await expect(b.page.locator('#vbEnd')).toBeHidden({ timeout: 10000 }); expect(await stillRinging(b.page)).toBe(false);
    await a.ctx.close(); await b.ctx.close();
  });

  test('End pressed before the server has answered the dial: the call that was created is ended, nobody rings', async ({ browser }) => {
    test.setTimeout(90000);
    const a = await person(browser, 'Caller'), b = await person(browser, 'Callee');
    await a.page.route('**/v1/voice/calls', async (route) => { if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 2500)); await route.continue(); });    // a slow network
    await dial(a, b.ext); await expect(a.page.locator('#vbEnd')).toBeVisible(); await a.page.locator('#vbEnd').click(); await expect(a.page.locator('#vbEnd')).toBeHidden();
    await a.page.waitForTimeout(5000);
    expect(await b.page.locator('#voiceIncoming').isVisible(), 'the ring is gone').toBe(false); expect(await stillRinging(b.page)).toBe(false);
    await a.page.unroute('**/v1/voice/calls'); await expect(a.page.locator('#phCall')).toBeEnabled(); await dial(a, b.ext); await expect(b.page.locator('#voiceIncoming')).toBeVisible({ timeout: 15000 });    // and the line is free for the next call
    await a.ctx.close(); await b.ctx.close();
  });

  async function answered(a, b) { await dial(a, b.ext); await expect(b.page.locator('#voiceIncoming')).toBeVisible({ timeout: 15000 }); await b.page.locator('#viAnswer').click(); await expect(b.page.locator('#vbStatus')).toContainText('Connected', { timeout: 20000 }); await expect(a.page.locator('#vbStatus')).toContainText('Connected', { timeout: 20000 }); }
  const addVia = async (p, ext) => { await p.page.locator('#vbAdd').click(); await p.page.locator('#vaExt').fill(ext); await p.page.locator('#vaDo').click(); };

  test('adding a person to a one-to-one call: it becomes a group call, the other party joins by itself, the newcomer rings and joins', async ({ browser }) => {
    test.setTimeout(150000);
    const a = await person(browser, 'Alice'), b = await person(browser, 'Bob'), c = await person(browser, 'Carol');
    await expect(a.page.locator('#vbAdd')).toBeHidden(); await answered(a, b); await expect(a.page.locator('#vbAdd')).toBeVisible();
    await addVia(a, c.ext);
    await expect(c.page.locator('#voiceIncoming')).toBeVisible({ timeout: 15000 });                                                      // the newcomer is rung like any group invitation
    await expect(b.page.locator('#voiceIncoming'), 'Bob is not prompted: he is moved into the group call').toBeHidden();
    await expect(b.page.locator('#vbPeer')).toContainText('Group call', { timeout: 15000 }); await expect(a.page.locator('#vbPeer')).toContainText('Group call', { timeout: 15000 });
    await c.page.locator('#viAnswer').click();
    for (const p of [a, b, c]) await expect(p.page.locator('#vbPeer')).toContainText('3 people', { timeout: 20000 });
    for (const p of [a, b, c]) await expect(p.page.locator('#vbStatus')).toContainText('Connected', { timeout: 30000 });                      // a full mesh: everybody hears everybody
    await expect(a.page.locator('#vbAdd')).toBeVisible();                                                                                  // and more people can be added to a group call
    await a.page.locator('#vbEndAll').click(); for (const p of [a, b, c]) await expect(p.page.locator('#voiceBar')).toBeHidden({ timeout: 15000 });
    await a.ctx.close(); await b.ctx.close(); await c.ctx.close();
  });

  test('adding a fourth person to a group call is an invitation; a wrong extension is refused with a reason', async ({ browser }) => {
    test.setTimeout(150000);
    const a = await person(browser, 'Alice'), b = await person(browser, 'Bob'), c = await person(browser, 'Carol'), d = await person(browser, 'Dave');
    await answered(a, b); await addVia(a, c.ext); await expect(c.page.locator('#voiceIncoming')).toBeVisible({ timeout: 15000 }); await c.page.locator('#viAnswer').click();
    await expect(a.page.locator('#vbPeer')).toContainText('3 people', { timeout: 20000 });
    await a.page.locator('#vbAdd').click(); await a.page.locator('#vaExt').fill('999'); await a.page.locator('#vaDo').click(); await expect(a.page.locator('#vaMsg')).not.toHaveText(/Adding/, { timeout: 10000 }); await expect(a.page.locator('#voiceAdd')).toBeVisible();   // not a real extension
    await a.page.locator('#vaExt').fill(d.ext); await a.page.locator('#vaDo').click(); await expect(d.page.locator('#voiceIncoming')).toBeVisible({ timeout: 15000 });
    await d.page.locator('#viAnswer').click(); for (const p of [a, b, c, d]) await expect(p.page.locator('#vbPeer')).toContainText('4 people', { timeout: 20000 });
    await a.page.locator('#vbEndAll').click(); for (const p of [a, b, c, d]) await expect(p.page.locator('#voiceBar')).toBeHidden({ timeout: 15000 });
    await a.ctx.close(); await b.ctx.close(); await c.ctx.close(); await d.ctx.close();
  });

  test('the server refuses to add to a call that is not answered, to a stranger\'s call, or someone already in it', async ({ browser }) => {
    test.setTimeout(90000);
    const a = await person(browser, 'Alice'), b = await person(browser, 'Bob'), c = await person(browser, 'Carol'), x = await person(browser, 'Mallory');
    await dial(a, b.ext); await expect(b.page.locator('#voiceIncoming')).toBeVisible({ timeout: 15000 });
    const callId = await a.page.evaluate(() => window.qorllaVoice.callId), tryAdd = (p, ext) => p.page.evaluate(async ([id, e]) => { try { await window.qorllaVoice.post('/calls/' + id + '/add', { extension: e, deviceId: window.qorllaVoice.deviceId }); return 'ok'; } catch (err) { return err.code || err.status; } }, [callId, ext]);
    expect(await tryAdd(a, c.ext), 'still ringing').toBe('call_not_active'); await b.page.locator('#viAnswer').click(); await expect(a.page.locator('#vbStatus')).toContainText('Connected', { timeout: 20000 });
    expect(await tryAdd(x, c.ext), 'not a party').toBe('not_found'); expect(await tryAdd(a, b.ext), 'the other party is already in it').toBe('invalid_recipient'); expect(await tryAdd(a, a.ext), 'oneself').toBe('invalid_recipient');
    await a.ctx.close(); await b.ctx.close(); await c.ctx.close(); await x.ctx.close();
  });
});
