'use strict';
// Diagnostic: repeat the permission-denial scenario N times on one device and keep, for every run, the app's own event log ([qorlla-app] lines from a test build), what the screen showed
// over time, and which dialog buttons were tapped. Purpose: find out why the recovery message sometimes disappears and the pre-join page opens by itself.
//   QORLLA_ANDROID_SERIAL=<serial> QORLLA_APK=<arm64 test apk> DENIAL_RUNS=8 node e2e/diagnostics/denial-loop.cjs
const path = require('node:path'), fs = require('node:fs'), { execFileSync } = require('node:child_process');
const { _android } = require(path.resolve(__dirname, '..', '..', '..', 'node_modules', 'playwright'));
const { startMain, startHost, sleep } = require('../harness.cjs');
const PKG = 'com.qorlla.mobile', PORT = 5293, RUNS = Number(process.env.DENIAL_RUNS || 6);
const APK = process.env.QORLLA_APK || path.resolve(__dirname, '..', '..', 'apps', 'mobile', 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const OUT = process.env.CLIENTS_EVIDENCE_DIR || path.join(require('node:os').tmpdir(), 'qorlla-denial-loop'); fs.mkdirSync(OUT, { recursive: true });
const nodes = (xml) => [...xml.matchAll(/<node\b([^>]*)>/g)].map((m) => { const a = {}; for (const kv of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[kv[1]] = kv[2]; return a; });
const centre = (a) => { const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a.bounds || ''); return m && [Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2)]; };
const TAPPABLE = new Set([PKG, 'com.google.android.permissioncontroller', 'com.android.permissioncontroller', 'android']);
(async () => {
  const wanted = process.env.QORLLA_ANDROID_SERIAL, devices = await _android.devices(), device = devices.find((d) => (wanted ? d.serial() === wanted : d.serial().startsWith('emulator-')));
  if (!device) throw new Error('no device: set QORLLA_ANDROID_SERIAL or start an emulator'); const serial = device.serial(), adb = (...a) => execFileSync('adb', ['-s', serial, ...a]).toString();
  const ui = async () => { await device.shell('uiautomator dump /sdcard/ui.xml'); return nodes((await device.shell('cat /sdcard/ui.xml')).toString()); };
  const texts = (all) => all.map((a) => a.text || a['content-desc']).filter(Boolean).join(' | ');
  const tapDeny = async (timeout) => { const end = Date.now() + timeout; while (Date.now() < end) { const all = await ui(); for (const a of all.filter((n) => TAPPABLE.has(n.package))) { const hit = [a.text, a['resource-id']].find((v) => v && /permission_deny_button|Don.t allow/i.test(v)); if (hit && centre(a)) { await device.shell(`input tap ${centre(a).join(' ')}`); return { hit, at: centre(a) }; } } await sleep(500); } return null; };
  const main = await startMain(PORT); const host = await startHost(main, { title: 'Denial loop' }); const results = [];
  try {
    for (let i = 1; i <= RUNS; i++) {
      await device.shell(`pm uninstall ${PKG}`).catch(() => {}); await device.installApk(APK); for (const p of [PORT, 3310]) adb('reverse', `tcp:${p}`, `tcp:${p}`);
      await device.shell('input keyevent KEYCODE_WAKEUP'); await device.shell('logcat -c').catch(() => {});
      const t0 = Date.now(); await device.shell(`am start -a android.intent.action.VIEW -d "qorlla://join?meeting=${host.meetingId}" ${PKG}`);
      const taps = []; for (let k = 0; k < 2; k++) { const t = await tapDeny(k === 0 ? 30000 : 15000); taps.push(t && { hit: t.hit, atMs: Date.now() - t0 }); }
      const timeline = []; for (let s = 0; s <= 20; s += 2) { const all = await ui(), tx = texts(all); timeline.push({ s, alert: /Join without/i.test(tx), dialog: /Allow Qorlla/i.test(tx), prejoin: /Ready to join|Test microphone and camera/i.test(tx), pkgs: [...new Set(all.map((n) => n.package))].filter(Boolean).slice(0, 3).join(',') }); await sleep(2000); }
      const log = (await device.shell('logcat -d -s ReactNativeJS:I')).toString().split('\n').filter((l) => /\[qorlla-app\]/.test(l)).map((l) => l.replace(/^.*\[qorlla-app\]/, '[qorlla-app]').trim());
      const outcome = timeline.every((x) => x.alert && !x.prejoin) ? 'recovery-stable' : timeline.some((x) => x.prejoin) ? 'went-to-prejoin' : 'other';
      results.push({ run: i, outcome, taps, timeline: timeline.map((x) => (x.dialog ? 'D' : x.alert ? 'A' : x.prejoin ? 'P' : '?')).join(''), appLog: log }); console.log(`run ${i}: ${outcome} timeline=${results.at(-1).timeline} taps=${JSON.stringify(taps)}\n   ${log.join('\n   ')}`);
    }
  } finally {
    fs.writeFileSync(path.join(OUT, 'denial-loop.json'), JSON.stringify({ serial: '[redacted]', model: device.model(), runs: RUNS, results }, null, 2));
    if (!/^emulator-/.test(serial)) { try { await device.shell(`pm uninstall ${PKG}`); } catch { /* ignore */ } for (const p of [PORT, 3310]) { try { adb('reverse', '--remove', `tcp:${p}`); } catch { /* gone */ } } }
    await host.close(); main.stop(); await device.close().catch(() => {});
    console.log('outcomes:', JSON.stringify(results.reduce((m, r) => ((m[r.outcome] = (m[r.outcome] || 0) + 1), m), {}))); process.exit(0);
  }
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
