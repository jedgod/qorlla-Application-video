'use strict';
// Diagnostic control (not part of the suite): the SAME guest join with a plain Chromium guest (no Electron). Does the Meet web client itself send video as a guest?
const { startMain, startHost, joinAsGuest, flowing, sleep, RTC_HOOK, FAKE_MEDIA, chromium } = require('../harness.cjs');
(async () => {
  const main = await startMain(5295); let host, gb;
  try {
    host = await startHost(main, { title: 'Control' });
    gb = await chromium.launch({ args: FAKE_MEDIA }); const ctx = await gb.newContext({ permissions: ['camera', 'microphone'] }); await ctx.addInitScript(RTC_HOOK); const page = await ctx.newPage();
    await page.goto(main.base + '/guest/meeting/' + host.meetingId + '/prejoin'); await joinAsGuest(page, 'Control Guest');
    await page.waitForFunction(() => document.querySelectorAll('.tile').length >= 2, null, { timeout: 45000 }); await host.page.waitForFunction(() => document.querySelectorAll('.tile').length >= 2, null, { timeout: 45000 }); await sleep(8000);
    const tracks = await page.evaluate(() => (window.__qpcs || []).map((pc) => pc.getSenders().map((s) => s.track && s.track.kind + ':' + s.track.readyState)));
    const g = await flowing(page, 3000), h = await flowing(host.page, 3000);
    console.log('GUEST tracks', JSON.stringify(tracks)); console.log('GUEST delta', JSON.stringify(g.delta)); console.log('HOST delta', JSON.stringify(h.delta));
    console.log('GUEST prefs/storage', await page.evaluate(() => JSON.stringify(Object.keys(sessionStorage))));
  } finally { await gb?.close(); await host?.close(); main.stop(); process.exit(0); }
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
