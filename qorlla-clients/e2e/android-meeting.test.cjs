'use strict';
// Android client: real meeting participation in an Android EMULATOR (API 36, x86_64) with the app built from apps/mobile.
//   qorlla://join deep link (as the system delivers it) -> real Android camera/microphone permission dialogs -> pre-join page in the app's WebView -> Meet room -> audio and video flowing in BOTH
//   directions with a separate Chromium participant. The WebView is read through Playwright's Android/CDP support (the test build has a debuggable WebView; store builds do not).
// What this does NOT prove: a physical phone, a real camera/microphone (the emulator provides synthetic ones), two different networks, TURN (the emulator reaches this machine over `adb reverse` and NAT),
// other Android versions, a signed release/AAB, Play review, push or calling.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _android } = require(path.resolve(__dirname, '..', '..', 'node_modules', 'playwright'));
const { MEET, startMain, startHost, flowing, sleep, RTC_HOOK } = require('./harness.cjs');

const PKG = 'com.qorlla.mobile', MAIN_PORT = 5293;
const APK = process.env.QORLLA_APK || path.resolve(__dirname, '..', 'apps', 'mobile', 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const OUT = process.env.CLIENTS_EVIDENCE_DIR || path.join(os.tmpdir(), 'qorlla-android-evidence');
const evidence = { platform: null, apk: null, results: {} };
const skip = fs.existsSync(APK) ? false : 'no APK at ' + APK + ' (build with expo prebuild + gradlew assembleRelease; see docs/CLIENT_MEETING_CERTIFICATION.md)';
fs.mkdirSync(OUT, { recursive: true });

const sh = async (device, cmd) => (await device.shell(cmd)).toString();
/** UI text and bounds of the foreground screen (the real accessibility tree, so system dialogs are included). */
async function ui(device) { await device.shell('uiautomator dump /sdcard/ui.xml'); return (await device.shell('cat /sdcard/ui.xml')).toString(); }
const nodes = (xml) => [...xml.matchAll(/<node\b([^>]*)>/g)].map((m) => { const a = {}; for (const kv of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[kv[1]] = kv[2]; return a; });
const centre = (a) => { const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a.bounds || ''); return m && [Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2)]; };
/** Taps the first element whose text, resource id or description matches. An Android "app isn't responding" dialog (a loaded emulator) is answered with Wait so it cannot block the run. */
const TAPPABLE = new Set([PKG, 'com.google.android.permissioncontroller', 'com.android.permissioncontroller', 'android']);
async function tapText(device, re, { timeout = 20000 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const all = nodes(await ui(device));
    if (all.some((a) => /isn.t responding/i.test(a.text || ''))) { const w = all.find((a) => a.text === 'Wait' && a.package === 'android' && centre(a)); if (w) { await device.shell(`input tap ${centre(w).join(' ')}`); evidence.anrDialogsDismissed = (evidence.anrDialogsDismissed || 0) + 1; await sleep(1000); continue; } }
    for (const a of all.filter((n) => TAPPABLE.has(n.package))) { const hit = [a.text, a['resource-id'], a['content-desc']].find((v) => v && re.test(v)); if (hit && centre(a)) { await device.shell(`input tap ${centre(a).join(' ')}`); return hit; } }
    await sleep(700);
  }
  return null;
}
const screenHas = async (device, re, timeout = 15000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (re.test(await ui(device))) return true; await sleep(700); } return false; };
async function prepare(device) {
  // a clean install: Android stops prompting after two denials ("don't ask again"), so each scenario starts from a fresh app with no granted or fixed permissions
  await device.shell(`pm uninstall ${PKG}`).catch(() => {}); await device.installApk(APK);
  await device.shell(`am force-stop ${PKG}`); await device.shell(`pm revoke ${PKG} android.permission.CAMERA`).catch(() => {}); await device.shell(`pm revoke ${PKG} android.permission.RECORD_AUDIO`).catch(() => {});
  await device.shell('input keyevent KEYCODE_WAKEUP');   // wakes the screen only: a locked phone stays locked (the person unlocks it)
}

async function snapshot(device, name) { try { await device.screenshot({ path: path.join(OUT, name + '.png') }); fs.writeFileSync(path.join(OUT, name + '-ui.txt'), nodes(await ui(device)).map((a) => a.text || a['content-desc'] || '').filter(Boolean).join(' | ')); } catch { /* best effort */ } }
let device;
test.before(async () => {
  if (skip) return;
  // Only an EMULATOR is used unless a serial is named explicitly (QORLLA_ANDROID_SERIAL): a phone that happens to be plugged in is never touched implicitly.
  const wanted = process.env.QORLLA_ANDROID_SERIAL, devices = await _android.devices();
  device = devices.find((d) => (wanted ? d.serial() === wanted : d.serial().startsWith('emulator-')));
  if (!device) throw new Error(wanted ? 'device ' + wanted + ' is not attached' : 'no Android emulator is attached (attached: ' + devices.map((d) => d.serial()).join(', ') + '); set QORLLA_ANDROID_SERIAL to use a specific device on purpose');
  evidence.platform = { model: device.model(), serial: device.serial(), android: (await sh(device, 'getprop ro.build.version.release')).trim(), sdk: (await sh(device, 'getprop ro.build.version.sdk')).trim(), abi: (await sh(device, 'getprop ro.product.cpu.abi')).trim(), emulator: /emulator/.test(device.serial()) };
  await device.installApk(APK); evidence.apk = { path: path.basename(APK), bytes: fs.statSync(APK).size };
  // the emulator's localhost -> this machine (a secure context for getUserMedia, and the build's only allowed http origins)
  const { execFileSync } = require('node:child_process'); for (const p of [MAIN_PORT, 3310]) execFileSync('adb', ['-s', device.serial(), 'reverse', `tcp:${p}`, `tcp:${p}`]);
});
test.after(async () => {
  // a real phone is left as it was found: the test app and the port mappings are removed
  if (device && !/^emulator-/.test(device.serial())) { const { execFileSync } = require('node:child_process'); try { await device.shell(`pm uninstall ${PKG}`); evidence.cleanup = { appUninstalled: true }; } catch { evidence.cleanup = { appUninstalled: false }; } for (const p of [MAIN_PORT, 3310]) { try { execFileSync('adb', ['-s', device.serial(), 'reverse', '--remove', `tcp:${p}`]); } catch { /* already gone */ } } }
  if (device) await device.close().catch(() => {}); fs.writeFileSync(path.join(OUT, 'android-evidence.json'), JSON.stringify(evidence, null, 2)); });

test('denying camera and microphone shows the recovery message and does not open the meeting', { skip, timeout: 300000 }, async () => {
  const main = await startMain(MAIN_PORT); let host;
  try {
    host = await startHost(main, { title: 'Android permission control' }); await prepare(device);
    await device.shell(`am start -a android.intent.action.VIEW -d "qorlla://join?meeting=${host.meetingId}" ${PKG}`);
    await snapshot(device, 'perm-0-launched'); await sleep(2500); await snapshot(device, 'perm-1-dialog');
    const first = await tapText(device, /permission_deny_button|Don.t allow|Deny/i, { timeout: 30000 }); assert.ok(first, 'the Android permission dialog appeared'); evidence.results.permissionTaps = [first];
    for (let i = 0; i < 2; i++) { await snapshot(device, 'perm-' + (i + 2) + '-before-tap'); const t = await tapText(device, /permission_deny_button|Don.t allow|Deny/i, { timeout: 5000 }); evidence.results.permissionTaps.push(t); }
    await snapshot(device, 'perm-4-after-taps');
    const timeline = []; for (let t = 0; t <= 24; t += 3) { const xml = await ui(device); const top = (await sh(device, 'dumpsys activity activities')).split(String.fromCharCode(10)).find((l) => /topResumedActivity/.test(l)); timeline.push({ t, alert: /Camera and microphone/i.test(xml) && /Join without/i.test(xml), prejoin: /Ready to join|Test microphone and camera/i.test(xml), top: top ? top.trim().slice(0, 110) : null }); await sleep(3000); } evidence.results.recoveryTimeline = timeline;
    assert.ok(await screenHas(device, /Camera and microphone/i), 'the app explains what is missing'); assert.ok(await screenHas(device, /Join without/i), 'and offers to continue without');
    await device.screenshot({ path: path.join(OUT, 'android-permission-denied.png') });
    await tapText(device, /^Cancel$/i, { timeout: 5000 });
    assert.equal((await host.page.locator('.tile').count()), 1, 'nobody else joined: the host is alone in the room');
    evidence.results.permissionDenied = { dialogShown: true, recoveryShown: true, joined: false };
  } catch (e) { await snapshot(device, 'android-failure'); throw e; } finally { await host?.close(); main.stop(); }
});

test('Android app joins a real meeting from a qorlla:// link and exchanges audio and video with another participant', { skip, timeout: 480000 }, async () => {
  const main = await startMain(MAIN_PORT); let host;
  try {
    host = await startHost(main, { title: 'Android certification' }); await prepare(device);
    await device.shell(`am start -a android.intent.action.VIEW -d "qorlla://join?meeting=${host.meetingId}" ${PKG}`);
    for (let i = 0; i < 3; i++) await tapText(device, /permission_allow_foreground_only_button|^While using the app$|^Allow$/i, { timeout: 15000 });   // camera, then microphone (the system asks one at a time)
    const wv = await device.webView({ pkg: PKG }, { timeout: 60000 }); const page = await wv.page(); await page.addInitScript(RTC_HOOK); await page.reload();
    await page.waitForURL(/\/guest\/meeting\/\d{11}\/prejoin/, { timeout: 30000 }); assert.equal(new URL(page.url()).origin, new URL(main.base).origin, 'the deep link opened the pre-join page of the configured app');
    await page.fill('#pjName', 'Android Client'); await page.click('#pjGo');
    await page.waitForURL(/localhost:3310/, { timeout: 45000 }); await page.waitForFunction(() => !document.querySelector('#app').classList.contains('hidden'), null, { timeout: 45000 });
    await page.waitForFunction(() => document.querySelectorAll('.tile').length >= 2, null, { timeout: 60000 }); await host.page.waitForFunction(() => document.querySelectorAll('.tile').length >= 2, null, { timeout: 60000 });
    await sleep(5000);
    const [fromPhone, fromHost] = [await flowing(page, 4000), await flowing(host.page, 4000)];
    await device.screenshot({ path: path.join(OUT, 'android-in-meeting.png') });
    assert.ok(fromPhone.ok, 'media flows both ways in the Android app: ' + JSON.stringify(fromPhone.delta)); assert.ok(fromHost.ok, 'and in the host: ' + JSON.stringify(fromHost.delta));
    assert.ok(fromPhone.delta.framesDecoded > 0 && fromHost.delta.framesDecoded > 0, 'video frames decode on both sides');
    evidence.results.participation = { androidApp: fromPhone, host: fromHost };
    // navigation containment in the real WebView: another origin and a file: URL do not load
    const before = page.url(); await page.evaluate(() => { location.href = 'http://example.com/'; }).catch(() => {}); await sleep(2500); assert.equal(new URL(page.url()).origin, new URL(before).origin, 'a foreign origin is blocked in the app');
    evidence.results.containment = { foreignOriginBlocked: true };
  } catch (e) { await snapshot(device, 'android-failure-participation'); throw e; } finally { await host?.close(); main.stop(); }
});
