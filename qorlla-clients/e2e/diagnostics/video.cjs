'use strict';
// Diagnostic only (not part of the suite): why does the Electron client send no video? Logs every getUserMedia call, track stop() and track "ended" event in the client, then sender states.
const path = require('node:path'), fs = require('node:fs'), os = require('node:os');
const { _electron } = require(path.resolve(__dirname, '..', '..', '..', 'node_modules', 'playwright'));
const { MEET, startMain, startHost, joinAsGuest, flowing, sleep, RTC_HOOK } = require('../harness.cjs');
const DESKTOP = path.resolve(__dirname, '..', '..', 'apps', 'desktop'), electronExe = require(path.join(DESKTOP, 'node_modules', 'electron'));
const PROBE = `(() => { window.__log = []; const log = (m) => window.__log.push(Math.round(performance.now()) + ' ' + location.pathname.slice(0, 20) + ' ' + m);
  const g = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => { log('gUM ' + JSON.stringify(c)); try { const st = await g(c); st.getTracks().forEach((t) => { log('  got ' + t.kind + ' ' + t.label); t.addEventListener('ended', () => log('  ENDED ' + t.kind + ' ' + t.label)); }); return st; } catch (e) { log('  gUM ERROR ' + e.name + ' ' + e.message); throw e; } };
  const st = MediaStreamTrack.prototype.stop; MediaStreamTrack.prototype.stop = function () { log('stop() ' + this.kind + ' ' + (new Error().stack.split('\\n')[2] || '').trim().slice(0, 120)); return st.call(this); };
  navigator.mediaDevices.addEventListener('devicechange', () => log('devicechange')); window.addEventListener('pagehide', () => log('pagehide')); })();`;
const senders = (page) => page.evaluate(() => (window.__qpcs || []).map((pc) => ({ state: pc.connectionState, senders: pc.getSenders().map((s) => s.track && { kind: s.track.kind, readyState: s.track.readyState }) })));
(async () => {
  const main = await startMain(5294), userData = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-')); let host, app;
  try {
    host = await startHost(main, { title: 'Debug video' });
    const env = { ...process.env, QORLLA_APP_URL: main.base + '/', QORLLA_MEET_URLS: MEET + '/', QORLLA_DEV_ALLOW_LOCALHOST_HTTP: '1', QORLLA_TEST_FAKE_MEDIA: '1', QORLLA_DEV_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: electronExe, args: [DESKTOP, 'qorlla://join?meeting=' + host.meetingId], env });
    const win = await app.firstWindow(); await win.context().addInitScript(RTC_HOOK); await win.context().addInitScript(PROBE); await win.waitForURL(/prejoin/);
    await joinAsGuest(win, 'Debug Client'); await win.waitForFunction(() => document.querySelectorAll('.tile').length >= 2, null, { timeout: 45000 }); await sleep(6000);
    console.log('CLIENT senders', JSON.stringify(await senders(win)));
    console.log('CLIENT LOG\n' + (await win.evaluate(() => window.__log)).join('\n'));
    console.log('CLIENT visibility', await win.evaluate(() => document.visibilityState + ' focus=' + document.hasFocus()));
  } finally { await app?.close().catch(() => {}); await host?.close(); main.stop(); process.exit(0); }
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
