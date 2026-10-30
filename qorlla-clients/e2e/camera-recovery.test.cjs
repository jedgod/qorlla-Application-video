'use strict';
// Camera recovery in the Windows (Electron) client. A camera that ENDS by itself (the failure seen intermittently in the Electron 33 client) is simulated in the page, the same way the browser reports it:
// the local video track is stopped and its "ended" event fires with no action from the person. Then, in a real meeting with a Chromium host, the test measures whether video resumes in BOTH directions.
//   QORLLA_TEST_MEET_URL=http://localhost:3310  -> the Meet that is already running (no recovery code): documents the problem (expected: video does NOT resume)
//   QORLLA_TEST_MEET_URL=http://localhost:3311  -> Meet started from this checkout by e2e/start-meet.cjs (with recovery): expected: video resumes
// What this does NOT prove: that a physically removed or crashed real camera is recovered (the loss is simulated at the track level), other browsers, or a loss during screen sharing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { _electron } = require(path.resolve(__dirname, '..', '..', 'node_modules', 'playwright'));
const { MEET, startMain, startHost, joinAsGuest, flowing, sleep, RTC_HOOK } = require('./harness.cjs');
const DESKTOP = path.resolve(__dirname, '..', 'apps', 'desktop');
let electronExe = null; try { electronExe = require(path.join(DESKTOP, 'node_modules', 'electron')); } catch { /* not installed */ }
const skip = electronExe ? false : 'electron is not installed in apps/desktop';
const evidence = { meet: MEET, steps: {} };

async function launch(main, link) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'qorlla-desktop-')); const env = { ...process.env, QORLLA_APP_URL: main.base + '/', QORLLA_MEET_URLS: MEET + '/', QORLLA_DEV_ALLOW_LOCALHOST_HTTP: '1', QORLLA_TEST_FAKE_MEDIA: '1', QORLLA_DEV_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: electronExe, args: [DESKTOP, link], env });
  return { app, close: async () => { await app.close().catch(() => {}); try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* Windows may still hold a log file */ } } };
}
const senderState = (page) => page.evaluate(() => { const pc = (window.__qpcs || [])[0]; const s = pc && pc.getSenders().find((x) => x.track && x.track.kind === 'video'); return s ? { readyState: s.track.readyState, enabled: s.track.enabled, id: s.track.id.slice(0, 8) } : null; });
// the person's own preview is the muted <video> in the meeting grid: its stream is the one the calls send
const LOCAL = "[...document.querySelectorAll('video')].find((v) => v.muted && v.srcObject && v.srcObject.getVideoTracks().length)";
const loseCamera = (page) => page.evaluate(`(() => { const t = ${LOCAL}.srcObject.getVideoTracks()[0]; window.__lostId = t.id.slice(0, 8); t.stop(); t.dispatchEvent(new Event('ended')); return window.__lostId; })()`);
const recoveriesOf = (page) => page.evaluate(() => { const v = document.documentElement.dataset.cameraRecoveries; return v === undefined ? null : Number(v); });
const localTrack = (page) => page.evaluate(`(() => { const t = ${LOCAL}.srcObject.getVideoTracks()[0]; return { enabled: t.enabled, readyState: t.readyState }; })()`);
const camButton = (page) => page.evaluate(() => document.getElementById('camBtn').textContent.trim());

test('Windows client: a camera that ends by itself is recovered (patched Meet) or is not (control), measured with real media', { skip, timeout: 600000 }, async () => {
  const main = await startMain(5296); let host, client;
  try {
    host = await startHost(main, { title: 'Camera recovery' }); client = await launch(main, 'qorlla://join?meeting=' + host.meetingId);
    const win = await client.app.firstWindow(); await win.context().addInitScript(RTC_HOOK); await win.waitForURL(/prejoin/); await joinAsGuest(win, 'Recovery Client');
    await win.waitForFunction(() => document.querySelectorAll('.tile').length >= 2, null, { timeout: 45000 }); await host.page.waitForFunction(() => document.querySelectorAll('.tile').length >= 2, null, { timeout: 45000 }); await sleep(5000);
    const hasRecovery = (await recoveriesOf(win)) !== null; evidence.hasRecoveryCode = hasRecovery;
    const before = await flowing(win, 3000); assert.ok(before.ok, 'baseline: media flows both ways before the loss: ' + JSON.stringify(before.delta)); evidence.steps.baseline = before.delta;

    // ---- 1. the camera ends by itself
    const lostId = await loseCamera(win); await sleep(hasRecovery ? 6000 : 3000);
    const sender = await senderState(win), recoveries = await recoveriesOf(win);
    const mine = await flowing(win, 4000), theirs = await flowing(host.page, 4000);
    evidence.steps.afterLoss = { lostTrack: lostId, senderTrack: sender, recoveries, clientVideoOutDelta: mine.delta.videoOut, clientFramesEncodedDelta: mine.delta.framesEncoded, hostVideoInDelta: theirs.delta.videoIn, hostFramesDecodedDelta: theirs.delta.framesDecoded };
    if (hasRecovery) {
      assert.equal(recoveries, 1, 'exactly one recovery'); assert.equal(sender.readyState, 'live', 'the call sends a LIVE camera track again'); assert.notEqual(sender.id, lostId, 'it is a new track');
      assert.ok(mine.delta.videoOut > 0 && mine.delta.framesEncoded > 0, 'the client sends video again: ' + JSON.stringify(mine.delta)); assert.ok(theirs.delta.videoIn > 0 && theirs.delta.framesDecoded > 0, 'and the host receives it: ' + JSON.stringify(theirs.delta));
      assert.ok(mine.delta.audioOut > 0 && mine.delta.audioIn > 0, 'audio was never interrupted');
    } else {
      assert.equal(sender.readyState, 'ended', 'CONTROL: the call is still sending an ENDED track'); assert.equal(mine.delta.videoOut, 0, 'CONTROL: no video is sent after the loss (the problem this change fixes)'); assert.equal(theirs.delta.framesDecoded, 0, 'CONTROL: the host decodes no more frames from the client');
      return;   // nothing else to check on a Meet without recovery
    }

    // ---- 2. turning the camera off and on by hand is NOT a loss
    await win.evaluate(() => document.getElementById('camBtn').click()); await sleep(800); const off = { enabled: (await localTrack(win)).enabled, recoveries: await recoveriesOf(win) };
    await win.evaluate(() => document.getElementById('camBtn').click()); await sleep(800); const on = { enabled: (await localTrack(win)).enabled, recoveries: await recoveriesOf(win) };
    assert.deepEqual([off.enabled, on.enabled, off.recoveries, on.recoveries], [false, true, 1, 1], 'manual off/on changes the track state only; no recovery runs'); evidence.steps.manualToggle = { off, on };

    // ---- 3. the first two attempts fail (device busy): it retries with backoff and succeeds on the third
    await win.evaluate(() => { const g = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); window.__fail = 2; window.__gum = 0; navigator.mediaDevices.getUserMedia = async (c) => { window.__gum++; if (window.__fail-- > 0) throw new DOMException('Device in use', 'NotReadableError'); return g(c); }; });
    const t0 = Date.now(); await loseCamera(win); await win.waitForFunction(() => document.documentElement.dataset.cameraRecoveries === '2', null, { timeout: 30000 }); const took = Date.now() - t0;
    const retried = await win.evaluate(() => ({ attempts: window.__gum, sender: (() => { const s = (window.__qpcs[0].getSenders().find((x) => x.track && x.track.kind === 'video')); return s.track.readyState; })() }));
    assert.equal(retried.attempts, 3, 'two failures then a success'); assert.equal(retried.sender, 'live'); assert.ok(took >= 4000 && took < 20000, 'with a backoff of seconds, not a tight loop: ' + took + ' ms'); evidence.steps.retry = { attempts: retried.attempts, tookMs: took };
    const again = await flowing(win, 3000); assert.ok(again.delta.videoOut > 0, 'video flows after the retry'); await win.evaluate(() => { /* leave the page's gUM as is: the test ends here */ });

    // ---- 4. a person who had turned the camera OFF stays off after a recovery (privacy: the camera must not come back on by itself)
    await win.evaluate(() => document.getElementById('camBtn').click()); await sleep(500); await loseCamera(win); await win.waitForFunction(() => document.documentElement.dataset.cameraRecoveries === '3', null, { timeout: 30000 });
    const stayedOff = { button: await camButton(win), enabled: (await localTrack(win)).enabled }; assert.deepEqual(stayedOff, { button: 'Start video', enabled: false }, 'recovered camera is still switched off'); evidence.steps.staysOff = stayedOff;

    // ---- 5. the camera is GONE (every attempt fails, as when the device vanishes from the list): the retries run out, and when the device comes back (a device-change event) the camera is recovered without anyone touching anything
    await win.evaluate(() => document.getElementById('camBtn').click()); await sleep(500);                       // camera back ON so the recovered track must be live again
    await win.evaluate(() => { window.__fail = 1e9; window.__gum = 0; }); await loseCamera(win); await sleep(36000);   // 6 attempts with a growing backoff take about 31 s
    const gone = { attempts: await win.evaluate(() => window.__gum), recoveries: await recoveriesOf(win), toast: await win.evaluate(() => document.body.innerText.includes('Camera unavailable')) };
    assert.equal(gone.attempts, 6, 'it tried six times and stopped'); assert.equal(gone.recoveries, 3, 'and did not recover while the device was gone');
    await win.evaluate(() => { window.__fail = 0; navigator.mediaDevices.dispatchEvent(new Event('devicechange')); });   // the device is back
    await win.waitForFunction(() => document.documentElement.dataset.cameraRecoveries === '4', null, { timeout: 20000 });
    const back = await flowing(win, 3000); assert.ok(back.delta.videoOut > 0 && back.delta.framesEncoded > 0, 'video flows again after the device returns: ' + JSON.stringify(back.delta)); assert.deepEqual(await localTrack(win), { enabled: true, readyState: 'live' });
    evidence.steps.deviceGone = { ...gone, afterReturn: back.delta };
  } finally { const f = process.env.CLIENTS_EVIDENCE_FILE; if (f) fs.writeFileSync(f, JSON.stringify(evidence, null, 2)); await client?.close(); await host?.close(); main.stop(); }
});
