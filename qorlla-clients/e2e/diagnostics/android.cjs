'use strict';
// Diagnostic only: attach to the app's WebView on the emulator, click Join on the pre-join page and report what the page says and where it navigates.
const path = require('node:path'), { execFileSync } = require('node:child_process');
const { _android } = require(path.resolve(__dirname, '..', '..', '..', 'node_modules', 'playwright'));
const { startMain, startHost, sleep, RTC_HOOK } = require('../harness.cjs');
const PKG = 'com.qorlla.mobile', APK = path.resolve(__dirname, '..', '..', 'apps', 'mobile', 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
(async () => {
  const device = (await _android.devices()).find((d) => d.serial().startsWith('emulator-')); if (!device) throw new Error('no emulator');
  const serial = device.serial(); const adb = (...a) => execFileSync('adb', ['-s', serial, ...a]).toString();
  const main = await startMain(5293); let host;
  try {
    host = await startHost(main, { title: 'Debug android' });
    await device.shell(`pm uninstall ${PKG}`).catch(() => {}); await device.installApk(APK);
    for (const p of [5293, 3310]) adb('reverse', `tcp:${p}`, `tcp:${p}`);
    await device.shell(`pm grant ${PKG} android.permission.CAMERA`); await device.shell(`pm grant ${PKG} android.permission.RECORD_AUDIO`);   // diagnostic shortcut: the dialogs are covered by the real test
    await device.shell('input keyevent KEYCODE_WAKEUP'); await device.shell(`am start -a android.intent.action.VIEW -d "qorlla://join?meeting=${host.meetingId}" ${PKG}`);
    const wv = await device.webView({ pkg: PKG }, { timeout: 60000 }); const page = await wv.page(); console.log('webview url', page.url());
    page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 200))); page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200))); page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log('[navigated]', f.url().replace(/#.*/, '#…')); });
    page.on('requestfailed', (r) => console.log('[requestfailed]', r.url().slice(0, 120), r.failure() && r.failure().errorText));
    await page.waitForSelector('#pjName', { timeout: 30000 }); console.log('prejoin ready; secure=', await page.evaluate(() => window.isSecureContext + ' origin=' + location.origin + ' md=' + !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)));
    const top = () => adb('shell', 'dumpsys', 'activity', 'activities').split(/\r?\n/).find((l) => /topResumedActivity/.test(l)).trim().slice(0, 140);
    console.log('before: visibility=', await page.evaluate(() => document.visibilityState + ' focus=' + document.hasFocus()), '| top:', top());
    await page.evaluate(() => { const of = window.fetch; window.fetch = async (...a) => { const r = await of(...a); r.clone().text().then((t) => { window.__resp = (window.__resp || '') + ' || ' + String(a[0]).slice(0, 60) + ' -> ' + (() => { try { const j = JSON.parse(t); return 'meet.url=' + (j.meet && j.meet.url ? String(j.meet.url).replace(/#.*/, '#…') : '(none)') + ' keys=' + Object.keys(j).join(','); } catch { return t.slice(0, 120); } })(); }); return r; }; document.getElementById('pjName').value = 'Android Debug'; document.getElementById('pjName').dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('pjGo').click(); }); await sleep(15000);
    console.log('after: visibility=', await page.evaluate(() => document.visibilityState), '| top:', top());
    console.log('after click url', page.url().replace(/#.*/, '#…')); console.log('responses:', await page.evaluate(() => window.__resp)); console.log('pjMsg:', await page.evaluate(() => (document.getElementById('pjMsg') || {}).textContent));
    console.log('top activity', adb('shell', 'dumpsys', 'activity', 'activities').split('\n').find((l) => /topResumedActivity/.test(l)).trim().slice(0, 120));
  } finally { await host?.close(); main.stop(); await device.close().catch(() => {}); process.exit(0); }
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
