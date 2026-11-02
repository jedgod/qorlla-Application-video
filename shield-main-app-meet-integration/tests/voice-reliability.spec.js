const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { login, PASSWORD } = require('./support/meet-stack');
const { startVoiceStack } = require('./support/voice-stack');

// Qorlla Voice v1.2-v1.5 with REAL BROWSERS (Chromium, synthetic microphone, real WebRTC): group calls, taking a call over on another device, recovery after a page reload, a dropped signaling socket,
// ICE restart, and the voice engine being killed and restarted in the middle of a call.
// Not proven here: calls across different networks, real microphones/speakers, other browsers, Safari/iOS (see docs/VOICE_ENGINE_V1.md).
const MAIN_PORT = 5285, VOICE_PORT = 5284;

test.describe('Qorlla Voice: reliability and group calls with real browsers', () => {
  test.describe.configure({ mode: 'serial' });
  let stack;
  test.beforeAll(async () => { stack = await startVoiceStack({ mainPort: MAIN_PORT, voicePort: VOICE_PORT, engineEnv: { VOICE_RING_SECONDS: '30' } }); });
  test.afterAll(async () => { if (stack) await stack.stop(); });

  const rand = () => Math.random().toString(36).slice(2, 7);
  async function openPhone(ctx) {
    const page = await ctx.newPage(); await page.goto(stack.base + '/qorlla.html#home'); await expect(async () => { await page.locator('.nav-item[data-view=phone]').click(); await expect(page.locator('#phTab-dial')).toBeVisible({ timeout: 3000 }); }).toPass({ timeout: 30000 });
    await expect.poll(() => page.evaluate(() => !!(window.qorllaVoice && window.qorllaVoice.ws && window.qorllaVoice.ws.readyState === 1)), { timeout: 20000 }).toBe(true);
    await expect(page.locator('#qpMyExt')).toContainText('Your Qorlla extension'); return { page, ext: (await page.locator('#qpMyExt').textContent()).match(/extension: (\d+)/)[1] };
  }
  async function person(browser, name) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] }), u = name.toLowerCase() + rand();
    expect((await ctx.request.post(stack.base + '/api/auth/register', { data: { username: u, displayName: name + ' Test', password: PASSWORD } })).status()).toBe(201);
    return { ctx, name: name + ' Test', username: u, ...(await openPhone(ctx)) };
  }
  const refresh = async (p) => { await p.page.locator('#phTab-join').click(); await p.page.locator('#phTab-dial').click(); };
  async function connectCall(caller, callee) {
    await caller.page.locator('#phTab-dial').click(); await caller.page.locator('#qpDialNumber').fill(callee.ext); await expect(caller.page.locator('#phCall')).toBeEnabled(); await caller.page.locator('#phCall').click();
    await expect(callee.page.locator('#voiceIncoming')).toBeVisible({ timeout: 10000 }); await callee.page.locator('#viAnswer').click();
    for (const p of [caller, callee]) await expect(p.page.locator('#vbStatus')).toContainText('Connected', { timeout: 25000 });
  }
  const stat = (page, field) => page.evaluate((f) => window.qorllaVoice.stats().then((s) => (s ? s[f] : 0)), field);
  async function flowsBothWays(page, label) { await expect.poll(async () => { const s = await page.evaluate(() => window.qorllaVoice.stats()); return s && s.bytesReceived > 3000 && s.bytesSent > 3000 ? 'flowing' : JSON.stringify(s); }, { timeout: 25000, intervals: [500], message: label }).toBe('flowing'); }
  async function grows(page, field, ms = 2500) { const a = await stat(page, field); await page.waitForTimeout(ms); return (await stat(page, field)) > a; }
  const roomBytes = (page) => page.evaluate(() => window.qorllaVoice.roomStats().then((r) => Object.values(r).reduce((n, s) => n + s.bytesReceived, 0)));
  async function roomGrows(page, ms = 2500) { const a = await roomBytes(page); await page.waitForTimeout(ms); return (await roomBytes(page)) > a; }
  const tracks = (page) => page.evaluate(() => { const c = window.qorllaVoice; return [c.stream, c.roomStream].filter(Boolean).flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length; });
  const bad = async (p, sel) => (await new AxeBuilder({ page: p }).include(sel).analyze()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id + ' ' + v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | '));

  test('a group call of three browsers: invite, answer, audio in every direction, one person muted, one leaves, the host ends it for everyone', async ({ browser }) => {
    test.setTimeout(240000);
    const alice = await person(browser, 'Alice'), bob = await person(browser, 'Bob'), carol = await person(browser, 'Carol'); await refresh(alice);
    await expect(alice.page.locator('#qpColleagues')).toContainText('Carol Test', { timeout: 20000 });
    await alice.page.locator('#qpGroupBtn').click(); await expect(alice.page.locator('#qpGroupGo')).toBeDisabled();
    expect(await bad(alice.page, '#qpColleagues'), 'group selection is accessible').toEqual([]);
    await alice.page.getByLabel('Add Bob Test to the group call').check(); await alice.page.getByLabel('Add Carol Test to the group call').check(); await expect(alice.page.locator('#qpGroupGo')).toContainText('(2)');
    expect(await tracks(bob.page)).toBe(0); expect(await tracks(carol.page)).toBe(0);
    await alice.page.locator('#qpGroupGo').click(); await expect(alice.page.locator('#voiceBar')).toBeVisible(); await expect(alice.page.locator('#vbPeer')).toContainText('Group call');
    for (const p of [bob, carol]) { await expect(p.page.locator('#voiceIncoming')).toBeVisible({ timeout: 10000 }); await expect(p.page.locator('#viTitle')).toContainText('group call'); await expect(p.page.locator('#viWho')).toContainText('Alice Test'); expect(await tracks(p.page)).toBe(0); }   // ringing: microphones are off
    await bob.page.locator('#viAnswer').click(); await carol.page.locator('#viAnswer').click();
    for (const p of [alice, bob, carol]) { await expect(p.page.locator('#vbStatus')).toContainText('Connected', { timeout: 40000 }); await expect(p.page.locator('#vbPeer')).toContainText('3 people'); }
    // real media: every member holds two connections, bytes flow both ways on each, over Opus, with sound energy
    for (const [label, p] of [['alice', alice], ['bob', bob], ['carol', carol]]) {
      await expect.poll(async () => { const r = await p.page.evaluate(() => window.qorllaVoice.roomStats()), v = Object.values(r); return v.length === 2 && v.every((s) => s.bytesReceived > 3000 && s.bytesSent > 3000 && s.totalAudioEnergy > 0) ? 'ok' : JSON.stringify(r); }, { timeout: 30000, intervals: [700], message: label + ' hears both others' }).toBe('ok');
      const r = Object.values(await p.page.evaluate(() => window.qorllaVoice.roomStats())); expect(r.every((s) => s.connectionState === 'connected' && String(s.codec).toLowerCase().includes('opus'))).toBe(true);
      expect(await tracks(p.page)).toBe(1);
    }
    expect(await bad(alice.page, '#voiceBar'), 'group call bar').toEqual([]); await expect(alice.page.locator('#vbEndAll')).toBeVisible(); await expect(bob.page.locator('#vbEndAll')).toBeHidden();   // only the host can end it for all
    // carol mutes: alice stops hearing energy from carol but keeps hearing bob
    const ids = { bob: await bob.page.evaluate(() => window.qorllaVoice.me), carol: await carol.page.evaluate(() => window.qorllaVoice.me) };
    const energy = (acct) => alice.page.evaluate((a) => window.qorllaVoice.roomStats().then((r) => r[a].totalAudioEnergy), acct);
    await carol.page.locator('#vbMute').click(); await expect(carol.page.locator('#vbMute')).toHaveAttribute('aria-pressed', 'true'); await alice.page.waitForTimeout(1500);
    const c0 = await energy(ids.carol), b0 = await energy(ids.bob); await alice.page.waitForTimeout(4000); const dc = (await energy(ids.carol)) - c0, db = (await energy(ids.bob)) - b0;
    expect(db, 'bob is still heard').toBeGreaterThan(0); expect(dc, 'carol is silent while muted').toBeLessThan(db * 0.25);
    await carol.page.locator('#vbMute').click();
    // carol leaves: her microphone closes, the others see two people, and the call goes on
    await carol.page.locator('#vbEnd').click(); await expect(carol.page.locator('#voiceBar')).toBeHidden(); await expect.poll(() => tracks(carol.page)).toBe(0);
    await expect(alice.page.locator('#vbPeer')).toContainText('2 people', { timeout: 15000 }); await expect(bob.page.locator('#vbPeer')).toContainText('2 people', { timeout: 15000 }); expect(await roomGrows(bob.page), 'audio keeps flowing between the two who stayed').toBe(true);
    await expect.poll(async () => Object.keys(await alice.page.evaluate(() => window.qorllaVoice.roomStats())).length).toBe(1);
    // the host ends it for everyone
    await alice.page.locator('#vbEndAll').click(); await expect(alice.page.locator('#voiceBar')).toBeHidden(); await expect(bob.page.locator('#voiceBar')).toBeHidden({ timeout: 15000 }); await expect(bob.page.locator('#toast.show')).toContainText('host ended');
    for (const p of [alice, bob, carol]) await expect.poll(() => tracks(p.page)).toBe(0);
    // everybody is free again: a one-to-one call works at once
    await connectCall(alice, bob); await alice.page.locator('#vbEnd').click(); await expect(bob.page.locator('#voiceBar')).toBeHidden({ timeout: 15000 });
    for (const p of [alice, bob, carol]) await p.ctx.close();
  });

  test('a call is taken over by a second device: the first stops at once, the other person continues on a fresh connection, and the old device has no authority left', async ({ browser }) => {
    test.setTimeout(200000);
    const alice = await person(browser, 'Alice'), bob = await person(browser, 'Bob'); await connectCall(alice, bob); await flowsBothWays(alice.page, 'alice'); await flowsBothWays(bob.page, 'bob');
    const old = await alice.page.evaluate(() => ({ id: window.qorllaVoice.callId, gen: window.qorllaVoice.generation, device: window.qorllaVoice.deviceId })); expect(old.gen).toBe(1);
    // alice signs in on a second device
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] }); await login(ctxB, stack.base, alice.username);
    const dev2 = await openPhone(ctxB); await expect(dev2.page.locator('#voiceMove')).toBeVisible({ timeout: 20000 }); await expect(dev2.page.locator('#vmText')).toContainText('in progress on another device');
    expect(await tracks(dev2.page)).toBe(0); expect(await bad(dev2.page, '#voiceMove'), 'the banner is accessible').toEqual([]);                          // seeing the banner does not open the microphone
    await dev2.page.locator('#vmHere').click();
    await expect(dev2.page.locator('#voiceBar')).toBeVisible({ timeout: 20000 }); await expect(dev2.page.locator('#vbStatus')).toContainText('Connected', { timeout: 30000 }); await expect(dev2.page.locator('#voiceMove')).toBeHidden();
    // the first device stopped immediately: no bar, no microphone, no connection
    await expect(alice.page.locator('#voiceBar')).toBeHidden({ timeout: 10000 }); await expect(alice.page.locator('#toast.show')).toContainText('moved to another device'); expect(await tracks(alice.page)).toBe(0);
    expect(await alice.page.evaluate(() => window.qorllaVoice.pc)).toBeNull();
    // audio runs between the NEW device and bob; bob's connection was rebuilt without his doing anything
    await flowsBothWays(dev2.page, 'new device'); expect(await grows(dev2.page, 'bytesReceived')).toBe(true); expect(await grows(bob.page, 'bytesReceived')).toBe(true); expect((await bob.page.evaluate(() => window.qorllaVoice.stats())).connectionState).toBe('connected');
    expect(await dev2.page.evaluate(() => window.qorllaVoice.generation)).toBe(2); await expect(bob.page.locator('#voiceBar')).toBeVisible();
    // the replaced device can neither renew nor fail the call, whatever it tries
    const stale = await alice.page.evaluate(async (o) => { const c = window.qorllaVoice, r = {}; for (const [k, p] of [['refresh', `/calls/${o.id}/device/refresh`], ['fail', `/calls/${o.id}/fail`]]) r[k] = await c.api(p, { method: 'POST', body: JSON.stringify({ deviceId: o.device, generation: o.gen }) }).then(() => 'accepted', (e) => e.code); return r; }, old);
    expect(stale).toEqual({ refresh: 'lease_lost', fail: 'device_not_owner' }); expect(await grows(bob.page, 'bytesReceived')).toBe(true);
    await bob.page.locator('#vbEnd').click(); await expect(dev2.page.locator('#voiceBar')).toBeHidden({ timeout: 15000 }); await expect.poll(() => tracks(dev2.page)).toBe(0);
    await ctxB.close(); await alice.ctx.close(); await bob.ctx.close();
  });

  test('a page reload in the middle of a call recovers by itself: the same device re-claims its seat and the audio comes back', async ({ browser }) => {
    test.setTimeout(160000);
    const alice = await person(browser, 'Alice'), bob = await person(browser, 'Bob'); await connectCall(alice, bob); await flowsBothWays(alice.page, 'alice');
    await alice.page.reload();
    await expect(alice.page.locator('#voiceBar')).toBeVisible({ timeout: 30000 }); await expect(alice.page.locator('#vbStatus')).toContainText('Connected', { timeout: 40000 });
    await flowsBothWays(alice.page, 'alice after reload'); expect(await grows(alice.page, 'bytesReceived')).toBe(true); expect(await grows(bob.page, 'bytesReceived')).toBe(true);
    expect(await alice.page.evaluate(() => window.qorllaVoice.generation)).toBeGreaterThanOrEqual(2);
    await alice.page.locator('#vbEnd').click(); await expect(bob.page.locator('#voiceBar')).toBeHidden({ timeout: 15000 });
    // a callee who reloads while the phone is ringing still gets the call
    await alice.page.locator('#phTab-dial').click(); await alice.page.locator('#qpDialNumber').fill(bob.ext); await alice.page.locator('#phCall').click(); await expect(bob.page.locator('#voiceIncoming')).toBeVisible({ timeout: 10000 });
    await bob.page.reload(); await expect(bob.page.locator('#voiceIncoming')).toBeVisible({ timeout: 30000 }); await bob.page.locator('#viAnswer').click();
    for (const p of [alice, bob]) await expect(p.page.locator('#vbStatus')).toContainText('Connected', { timeout: 30000 });
    await alice.page.locator('#vbEnd').click(); await expect(bob.page.locator('#voiceBar')).toBeHidden({ timeout: 15000 }); await alice.ctx.close(); await bob.ctx.close();
  });

  test('a dropped signaling connection and an ICE restart do not end the call; audio keeps flowing', async ({ browser }) => {
    test.setTimeout(160000);
    const alice = await person(browser, 'Alice'), bob = await person(browser, 'Bob'); await connectCall(alice, bob); await flowsBothWays(alice.page, 'alice'); await flowsBothWays(bob.page, 'bob');
    // 1. the signaling WebSocket dies (a network blip): the UI reconnects, media never stopped
    const before = await alice.page.evaluate(() => { window.__ws0 = window.qorllaVoice.ws; window.qorllaVoice.ws.close(); return 1; }); expect(before).toBe(1);
    expect(await grows(alice.page, 'bytesReceived', 1500)).toBe(true);                                                                                  // media does not depend on signaling
    await expect.poll(() => alice.page.evaluate(() => window.qorllaVoice.ws && window.qorllaVoice.ws !== window.__ws0 && window.qorllaVoice.ws.readyState === 1), { timeout: 30000 }).toBe(true);
    await expect(alice.page.locator('#voiceBar')).toBeVisible();
    // 2. an ICE restart is negotiated over the new socket and the connection comes back
    await alice.page.evaluate(() => { const c = window.qorllaVoice, o = c.onEvent; window.__events = []; c.onEvent = (e) => { window.__events.push(e.type); o(e); }; return c.recover('test'); });
    await expect.poll(() => alice.page.evaluate(() => window.__events.includes('connection_recovering')), { timeout: 10000 }).toBe(true);
    await expect.poll(() => alice.page.evaluate(() => window.qorllaVoice.pc.connectionState + '/' + window.qorllaVoice.restarts), { timeout: 30000 }).toBe('connected/0');
    expect(await grows(alice.page, 'bytesReceived')).toBe(true); expect(await grows(bob.page, 'bytesReceived')).toBe(true);
    // 3. the other side can restart too, and a simultaneous restart by both resolves (the polite peer yields)
    await Promise.all([alice.page.evaluate(() => window.qorllaVoice.recover('both')), bob.page.evaluate(() => window.qorllaVoice.recover('both'))]);
    await expect.poll(async () => (await alice.page.evaluate(() => window.qorllaVoice.pc.connectionState)) + '/' + (await bob.page.evaluate(() => window.qorllaVoice.pc.connectionState)), { timeout: 40000 }).toBe('connected/connected');
    expect(await grows(alice.page, 'bytesReceived')).toBe(true); expect(await grows(bob.page, 'bytesReceived')).toBe(true);
    await alice.page.locator('#vbEnd').click(); await expect(bob.page.locator('#voiceBar')).toBeHidden({ timeout: 15000 }); await alice.ctx.close(); await bob.ctx.close();
  });

  test('the voice engine is killed and restarted in the middle of a call: the call survives, signaling recovers, hang-up still works', async ({ browser }) => {
    test.setTimeout(200000);
    const alice = await person(browser, 'Alice'), bob = await person(browser, 'Bob'); await connectCall(alice, bob); await flowsBothWays(alice.page, 'alice'); await flowsBothWays(bob.page, 'bob');
    const ws = (p) => p.page.evaluate(() => { window.__w = window.__w || window.qorllaVoice.ws; return !!window.qorllaVoice.ws && window.qorllaVoice.ws.readyState === 1 && window.qorllaVoice.ws !== window.__w; });
    for (const p of [alice, bob]) await p.page.evaluate(() => { window.__w = window.qorllaVoice.ws; });
    await stack.restartEngine();                                                                                                                       // the process is killed, then started again
    expect(await grows(alice.page, 'bytesReceived', 1500)).toBe(true);                                                                                  // audio never noticed
    for (const p of [alice, bob]) await expect.poll(() => ws(p), { timeout: 60000, message: 'signaling reconnected' }).toBe(true);
    for (const p of [alice, bob]) await expect(p.page.locator('#voiceBar')).toBeVisible();
    const live = await alice.page.evaluate(() => window.qorllaVoice.api('/calls/live')); expect(live.call.status).toBe('active'); expect(live.lease.valid).toBe(true);
    expect(await grows(bob.page, 'bytesReceived')).toBe(true);
    await bob.page.locator('#vbEnd').click(); await expect(alice.page.locator('#voiceBar')).toBeHidden({ timeout: 20000 });                             // signaling works again: the hang-up reaches the other side
    expect((await alice.page.evaluate(() => window.qorllaVoice.api('/calls/live'))).call).toBeNull();
    await connectCall(alice, bob); await alice.page.locator('#vbEnd').click(); await expect(bob.page.locator('#voiceBar')).toBeHidden({ timeout: 15000 });   // and new calls work
    expect(stack.log.join('')).not.toMatch(/TypeError|ReferenceError|UnhandledPromise/);
    await alice.ctx.close(); await bob.ctx.close();
  });

  test('group call history: each person sees their own record in Recent Calls (completed, declined), with their stays and timeline, and nobody else is named', async ({ browser }) => {
    test.setTimeout(240000);
    const alice = await person(browser, 'Hal'), bob = await person(browser, 'Ida'), carol = await person(browser, 'Jon');; await refresh(alice);   // names no earlier test used, so the colleague list has exactly one of each
    await expect(alice.page.locator('#qpColleagues')).toContainText('Colleagues', { timeout: 20000, ignoreCase: true });
    const many = await alice.page.locator('#qpColSearch').count();                                                                                         // the search box appears once there are more than 8 colleagues (when the whole file runs there are)
    const find = async (q) => { if (many) await alice.page.locator('#qpColSearch').fill(q); };
    await find('Jon Test'); await expect(alice.page.locator('.qp-colleague', { hasText: 'Jon Test' })).toHaveCount(1); await alice.page.locator('#qpGroupBtn').click(); await alice.page.getByLabel('Add Jon Test to the group call').check();
    if (many) { await find('zzz-nobody'); await expect(alice.page.locator('#qpNoColMatch')).toBeVisible(); }
    await find('Ida Test'); await alice.page.getByLabel('Add Ida Test to the group call').check(); await find(''); await alice.page.locator('#qpGroupGo').click();
    await expect(bob.page.locator('#voiceIncoming')).toBeVisible({ timeout: 10000 }); await expect(carol.page.locator('#voiceIncoming')).toBeVisible({ timeout: 10000 });
    await carol.page.locator('#viDecline').click(); await bob.page.locator('#viAnswer').click();
    for (const p of [alice, bob]) await expect(p.page.locator('#vbStatus')).toContainText('Connected', { timeout: 40000 });
    await alice.page.waitForTimeout(2500);                                                                                                              // a measurable stay
    await bob.page.locator('#vbEnd').click(); await expect(bob.page.locator('#voiceBar')).toBeHidden(); await alice.page.locator('#vbEndAll').click(); await expect(alice.page.locator('#voiceBar')).toBeHidden();
    const open = async (p) => { await p.page.locator('#phTab-recent').click(); return p.page.locator('.qp-call-row', { hasText: 'Group call' }).first(); };
    // the host
    const a = await open(alice); await expect(a).toContainText('Host'); await expect(a).toContainText('Completed'); await expect(a).toContainText('Group call'); await expect(a).toContainText('2 people'); await a.click();
    await expect(alice.page.locator('#qpGroupDetail')).toContainText('Group call'); await expect(alice.page.locator('#qpGroupFacts')).toContainText('Host'); await expect(alice.page.locator('#qpGroupFacts')).toContainText('ended by host');
    await expect(alice.page.locator('#qpGroupStays .qp-stay')).toHaveCount(1); await expect(alice.page.locator('#qpGroupTimeline')).toContainText('You joined'); await expect(alice.page.locator('#qpGroupTimeline')).toContainText('You left');
    await expect(alice.page.locator('#qpCallBack')).toHaveCount(0);                                                                                      // a finished group call is not "called back"
    expect(await bad(alice.page, '#recent-calls'), 'recent calls with a group call').toEqual([]); expect(await bad(alice.page, '#qpGroupDetail'), 'group call detail').toEqual([]);
    // a member who stayed for a while, and one who declined
    const b = await open(bob); await expect(b).toContainText('Member'); await expect(b).toContainText('Completed'); await b.click(); await expect(bob.page.locator('#qpGroupStays .qp-stay')).toHaveCount(1); await expect(bob.page.locator('#qpGroupTimeline')).toContainText('You were invited');
    const c = await open(carol); await expect(c).toContainText('Declined'); await c.click(); await expect(carol.page.locator('#qpGroupStays')).toContainText('You did not join this call'); await expect(carol.page.locator('#qpGroupTimeline')).toContainText('You declined');
    // nobody else is named anywhere on carol's screen, and the filters treat group calls as calls
    const text = await carol.page.locator('#recent-calls').innerText(); expect(text).not.toContain(alice.name); expect(text).not.toContain(bob.name);
    await carol.page.locator('#recent-calls [data-f=meeting]').click(); await expect(carol.page.locator('.qp-call-row', { hasText: 'Group call' })).toHaveCount(0); await carol.page.locator('#recent-calls [data-f=calls]').click(); await expect(carol.page.locator('.qp-call-row', { hasText: 'Group call' })).toHaveCount(1);
    // the record comes from the engine, so it is still there after a reload
    await alice.page.reload(); await expect.poll(() => alice.page.evaluate(() => !!(window.qorllaVoice && window.qorllaVoice.ws && window.qorllaVoice.ws.readyState === 1)), { timeout: 30000 }).toBe(true);
    await alice.page.locator('.nav-item[data-view=phone]').click(); await alice.page.locator('#phTab-recent').click(); await expect(alice.page.locator('.qp-call-row', { hasText: 'Group call' }).first()).toContainText('Completed');
    // privacy: the retention policy is stated, deleting needs a second confirmation (Cancel is focused), and deleting my record leaves everyone else's alone
    await expect(alice.page.locator('#qpGroupPolicy')).toContainText('kept for 365 days'); expect(await bad(alice.page, '#qpGroupPrivacy'), 'privacy controls').toEqual([]);
    await carol.page.locator('#phTab-recent').click(); const cr = carol.page.locator('.qp-call-row', { hasText: 'Group call' }).first(); await cr.click();
    await carol.page.locator('#qpGroupDelete').click(); await expect(carol.page.locator('#qpGroupDeleteYesBox')).toBeVisible(); await expect(carol.page.locator('#qpGroupDeleteYesNo')).toBeFocused(); expect(await bad(carol.page, '#qpGroupDeleteYesBox'), 'delete confirmation').toEqual([]);
    await carol.page.locator('#qpGroupDeleteYesNo').click(); await expect(carol.page.locator('#qpGroupDeleteYesBox')).toHaveCount(0); await expect(carol.page.locator('.qp-call-row', { hasText: 'Group call' })).toHaveCount(1);        // cancelling deletes nothing
    await carol.page.locator('#qpGroupDelete').click(); await carol.page.locator('#qpGroupDeleteYes').click(); await expect(carol.page.locator('#toast.show')).toContainText('Deleted');
    await expect(carol.page.locator('.qp-call-row', { hasText: 'Group call' })).toHaveCount(0, { timeout: 15000 }); await expect(carol.page.locator('#qpGroupDetail')).toHaveCount(0);
    await alice.page.locator('#phTab-dial').click(); await alice.page.locator('#phTab-recent').click(); await expect(alice.page.locator('.qp-call-row', { hasText: 'Group call' }).first()).toContainText('Completed');              // alice keeps hers
    await expect(alice.page.locator('#qpGroupClear')).toBeVisible(); await alice.page.locator('#qpGroupClear').click(); await expect(alice.page.locator('#qpGroupClearYesNo')).toBeFocused(); await alice.page.locator('#qpGroupClearYes').click();
    await expect(alice.page.locator('.qp-call-row', { hasText: 'Group call' })).toHaveCount(0, { timeout: 15000 }); await expect(alice.page.locator('#qpGroupClear')).toBeHidden();
    const left = await alice.page.evaluate(() => window.qorllaVoice.groupHistory({ limit: 10 })); expect(left.items.length).toBe(0);
    const bobStill = await bob.page.evaluate(() => window.qorllaVoice.groupHistory({ limit: 10 })); expect(bobStill.items.length).toBe(1);                                                             // bob's record was never touched
    for (const p of [alice, bob, carol]) await p.ctx.close();
  });
});
