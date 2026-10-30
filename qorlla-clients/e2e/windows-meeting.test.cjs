'use strict';
// Windows (Electron) client: real meeting participation. The installed-app code path is run unpackaged on this Windows machine with fake camera/microphone devices:
//   qorlla://join deep link -> pre-join page inside the shell -> Meet room on its own origin -> audio and video flowing in BOTH directions with a separate Chromium participant.
// What this does NOT prove: a signed installer, SmartScreen, a physical camera/microphone, two different networks or TURN (host and client share this machine/network), other Windows versions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require(path.resolve(__dirname, '..', '..', 'node_modules', 'playwright'));
const { MEET, startMain, startHost, joinAsGuest, flowing, sleep, RTC_HOOK } = require('./harness.cjs');

const DESKTOP = path.resolve(__dirname, '..', 'apps', 'desktop');
let electronExe = null; try { electronExe = require(path.join(DESKTOP, 'node_modules', 'electron')); } catch { /* not installed */ }
const evidence = { platform: process.platform + ' ' + os.release(), electron: null, results: {} };
const skip = electronExe ? false : 'electron is not installed in apps/desktop (npm install)';

// ELECTRON_RUN_AS_NODE (set by some editors/terminals) would start Electron as plain Node with no app object
const cleanEnv = () => { const e = { ...process.env }; delete e.ELECTRON_RUN_AS_NODE; return e; };
async function launch(main, args = [], extraEnv = {}, sharedUserData = null) {
  const userData = sharedUserData || fs.mkdtempSync(path.join(os.tmpdir(), 'qorlla-desktop-'));
  const app = await _electron.launch({ executablePath: electronExe, args: [DESKTOP, ...args], env: { ...cleanEnv(), QORLLA_APP_URL: main.base + '/', QORLLA_MEET_URLS: MEET + '/', QORLLA_DEV_ALLOW_LOCALHOST_HTTP: '1', QORLLA_TEST_FAKE_MEDIA: '1', QORLLA_DEV_USER_DATA: userData, ...extraEnv } });
  return { app, userData, close: async () => { await app.close().catch(() => {}); try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* Windows may still hold a log file for a moment; the folder is in %TEMP% */ } } };
}

test('Windows client joins a real meeting from a qorlla:// link and exchanges audio and video with another participant', { skip, timeout: 240000 }, async () => {
  const main = await startMain(5291); let host, client;
  try {
    host = await startHost(main, { title: 'Windows certification' });
    client = await launch(main, ['qorlla://join?meeting=' + host.meetingId]);
    evidence.electron = await client.app.evaluate(({ app }) => ({ electron: process.versions.electron, chrome: process.versions.chrome, packaged: app.isPackaged }));
    const win = await client.app.firstWindow(); await win.context().addInitScript(RTC_HOOK);                                           // applies to every later document, including the Meet room the pre-join page navigates to
    await win.waitForURL(/\/guest\/meeting\/\d{11}\/prejoin/); assert.equal(new URL(win.url()).origin, new URL(main.base).origin, 'the deep link opened the pre-join page of the configured app, inside the shell');
    await win.waitForFunction(() => !!window.RTCPeerConnection);
    await joinAsGuest(win, 'Windows Client');
    await win.waitForFunction(() => document.querySelectorAll('.tile').length >= 2, null, { timeout: 45000 }); await host.page.waitForFunction(() => document.querySelectorAll('.tile').length >= 2, null, { timeout: 45000 });
    await sleep(4000);                                                                                                  // let the connection settle
    const [fromClient, fromHost] = [await flowing(win), await flowing(host.page)];
    assert.ok(fromClient.ok, 'media flows both ways in the Windows client: ' + JSON.stringify(fromClient.delta));
    assert.ok(fromHost.ok, 'and in the host: ' + JSON.stringify(fromHost.delta));
    assert.ok(fromClient.delta.framesDecoded > 0 && fromHost.delta.framesDecoded > 0, 'video frames are being decoded on both sides');
    evidence.results.participation = { meetingId: 'redacted', windowsClient: fromClient, host: fromHost, meetOrigin: new URL(win.url()).origin };
  } finally { await client?.close(); await host?.close(); main.stop(); }
});

test('the shell refuses everything outside the trusted origins and ignores hostile links', { skip, timeout: 120000 }, async () => {
  const main = await startMain(5292); let client;
  try {
    client = await launch(main, ['qorlla://join?meeting=12345678901&next=https://evil.test']);                         // extra parameter: the link is ignored, the shell opens the app home
    const win = await client.app.firstWindow(); await win.waitForLoadState('domcontentloaded');
    assert.equal(new URL(win.url()).origin, new URL(main.base).origin); assert.ok(!win.url().includes('prejoin'), 'a malformed link never navigates anywhere');
    const loc = (u) => { const x = new URL(u); return x.origin + x.pathname; }; await sleep(1500); const before = win.url();   // the app adds #home after load: compare origin + path
    await win.evaluate(() => { location.href = 'http://example.com/'; }); await sleep(1500); assert.equal(loc(win.url()), loc(before), 'navigation to another origin is blocked');
    await win.evaluate(() => { location.href = 'file:///C:/Windows/win.ini'; }); await sleep(1000); assert.equal(loc(win.url()), loc(before), 'file: is blocked');
    assert.equal(await win.evaluate(() => typeof window.require + typeof window.process + typeof window.electron), 'undefinedundefinedundefined', 'no Node/Electron APIs are exposed to the page');
    evidence.results.containment = { crossOriginBlocked: true, fileBlocked: true, hostileLinkIgnored: true, nodeExposed: false };
    // a second launch with a good link while the first runs is handed to the running instance (single instance), not opened twice
    const second = await launch(main, ['qorlla://join?meeting=12345678901'], {}, client.userData).catch(() => null); await sleep(2500);   // same profile = same single-instance lock
    assert.equal(await client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'one window'); await win.waitForURL(/\/guest\/meeting\/12345678901\/prejoin/, { timeout: 15000 });
    await second?.close().catch(() => {}); evidence.results.singleInstance = true;
  } finally { await client?.close(); main.stop(); }
});

test.after(() => { const f = process.env.CLIENTS_EVIDENCE_FILE; if (f) fs.writeFileSync(f, JSON.stringify(evidence, null, 2)); });
