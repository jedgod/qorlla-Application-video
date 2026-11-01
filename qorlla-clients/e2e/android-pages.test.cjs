'use strict';
// On-device check that the NEW pages are the ones the phone app shows: guest pages, the invitation page (no navigation, no old room), sign-in, the six-tab workspace bar with its close button, and "video unavailable" instead of the old built-in room.
// The app under test is the local-stack test build (app http://localhost:3200, Meet http://localhost:3300). The phone's own `adb reverse tcp:3200` is pointed at an isolated test server (QORLLA_E2E_SERVER, default http://localhost:18081) for the run
// and put back to tcp:3200 afterwards, so nothing on the host's port 3200 is used or changed. Needs QORLLA_ANDROID_SERIAL. Test accounts live only on that throw-away server. Screenshots show only these pages (no camera).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERIAL = process.env.QORLLA_ANDROID_SERIAL, PKG = 'com.qorlla.mobile', SERVER = process.env.QORLLA_E2E_SERVER || 'http://localhost:18081', APP = 'http://localhost:3200';
const skip = SERIAL ? false : 'set QORLLA_ANDROID_SERIAL to a connected device';
const OUT = process.env.QORLLA_EVIDENCE_DIR || path.join(__dirname, '..', 'docs', 'evidence', 'clients', 'welcome-redesign', 'pages');
const adb = (...a) => spawnSync('adb', ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
const sh = (cmd) => adb('shell', cmd).stdout.trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name + '.png'), spawnSync('adb', ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 }).stdout); };

function dump() {
  for (let i = 0; i < 4; i += 1) {
    adb('shell', 'uiautomator dump /sdcard/qorlla-ui.xml'); const x = adb('exec-out', 'cat /sdcard/qorlla-ui.xml').stdout;
    if (x && x.includes('<hierarchy')) return [...x.matchAll(/<node ([^>]*?)\/?>/g)].map((m) => { const a = {}; for (const k of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[k[1]] = k[2]; const b = (a.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/); if (b) Object.assign(a, { l: +b[1], t: +b[2], r: +b[3], b: +b[4] }); return a; });
  }
  throw new Error('uiautomator produced no hierarchy');
}
const byId = (nodes, id) => nodes.find((n) => (n['resource-id'] || '') === id || (n['resource-id'] || '').endsWith('/' + id));
const tapNode = (n) => adb('shell', 'input tap ' + Math.round((n.l + n.r) / 2) + ' ' + Math.round((n.t + n.b) / 2));
async function launch() { adb('shell', 'am force-stop ' + PKG); adb('shell', 'monkey -p ' + PKG + ' -c android.intent.category.LAUNCHER 1'); await sleep(4500); }
const openLink = (link) => adb('shell', `am start -a android.intent.action.VIEW -d "${link}" ${PKG}`);
// waits for the native Welcome screen to be drawn (right after a relaunch it is not yet), then taps the control
async function tapId(id) {
  for (let i = 0; i < 12; i += 1) { const n = dump(); const target = byId(n, id); if (byId(n, 'welcome-screen') && target && target.t >= 0) { await sleep(600); tapNode(target); return; } await sleep(1000); }
  assert.fail('not on screen: ' + id);
}

// runs an expression in the page shown by the app's WebView (debug socket of the test build; the forward is removed again)
async function inWebview(expression) {
  const pid = sh('pidof ' + PKG).split(/\s+/)[0]; assert.ok(pid, 'the app is running'); adb('forward', 'tcp:19222', 'localabstract:webview_devtools_remote_' + pid);
  try {
    let list = null; for (let i = 0; i < 15 && !list; i += 1) { try { list = await (await fetch('http://127.0.0.1:19222/json', { signal: AbortSignal.timeout(3000) })).json(); } catch { await sleep(2000); } }
    const info = (list || []).find((p) => p.type === 'page'); assert.ok(info, 'a WebView page is open');
    const ws = new WebSocket(info.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const answer = new Promise((r, j) => { const t = setTimeout(() => j(new Error('no answer from the WebView')), 15000); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { clearTimeout(t); r(d); } }; });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); const out = await answer; ws.close();
    if (out.result && out.result.exceptionDetails) { const x = out.result.exceptionDetails; throw new Error('page script failed: ' + ((x.exception && x.exception.description) || x.text)); }
    return { url: info.url, value: out.result && out.result.result ? out.result.result.value : undefined };
  } finally { adb('forward', '--remove', 'tcp:19222'); }
}
// waits until the WebView is on a page whose URL matches
async function until(re, ms = 30000) { const t0 = Date.now(); let last = ''; while (Date.now() - t0 < ms) { try { last = (await inWebview('location.href')).url; if (re.test(last)) return last; } catch { /* not up yet */ } await sleep(1500); } throw new Error('never reached ' + re + ' (last: ' + last + ')'); }
const json = async (r) => JSON.parse(r.value);

let account = null;
async function makeAccount() {
  const username = 'pg' + Math.random().toString(36).slice(2, 8), password = 'Side-bar-9917!x';
  const reg = await fetch(SERVER + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, displayName: 'Pages Test', password }) }); assert.equal(reg.status, 201, 'test account registered');
  const cookie = (reg.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  const m = await fetch(SERVER + '/api/meetings/create', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ topic: 'Pages test meeting' }) }); assert.equal(m.status, 201);
  return { username, password, meetingId: String((await m.json()).meeting.meetingId).replace(/\D/g, '') };
}

test.before(async () => {
  if (skip) return; adb('reverse', 'tcp:3200', 'tcp:' + new URL(SERVER).port);                         // the phone's own 3200 mapping (added by local-stack:reverse) now reaches the isolated server
  assert.match(adb('reverse', '--list').stdout, /tcp:3200 tcp:\d+/); account = await makeAccount();
});
test.after(() => { if (skip) return; adb('reverse', 'tcp:3200', 'tcp:3200'); adb('forward', '--remove', 'tcp:19222'); });   // back to the plain mapping

test('the installed app is the local-stack build: it loads its pages from localhost:3200', { skip }, async () => {
  assert.match(sh('pm list packages ' + PKG), new RegExp(PKG)); await launch(); assert.ok(byId(dump(), 'welcome-screen'), 'native Welcome screen'); shot('p01-welcome');
  await tapId('guest'); const url = await until(/\/guest\/welcome$/); assert.equal(url, APP + '/guest/welcome', 'the app origin is 3200');
});
test('guest pages: Welcome keeps its navigation; Explore and Help are the new guest pages', { skip }, async () => {
  await launch(); await tapId('guest'); await until(/\/guest\/welcome$/);
  const w = await json(await inWebview(`JSON.stringify({ rail: getComputedStyle(document.querySelector('.sidebar')).display !== 'none', invite: document.body.classList.contains('invite'), h1: (document.querySelector('.view:not(.hidden) h1') || {}).textContent })`));
  assert.equal(w.rail, true, 'guest Welcome has its navigation'); assert.equal(w.invite, false); shot('p02-guest-welcome');
  await launch(); await tapId('util-learn'); await until(/\/guest\/explore$/); const e = await json(await inWebview(`JSON.stringify({ h1: (document.querySelector('.view:not(.hidden) h1') || {}).textContent })`)); assert.match(e.h1, /Explore Qorlla/); shot('p03-explore');
  await launch(); await tapId('util-help'); await until(/\/guest\/help$/); const h = await json(await inWebview(`JSON.stringify({ h1: (document.querySelector('.view:not(.hidden) h1') || {}).textContent })`)); assert.match(h.h1, /Help/); shot('p04-help');
});
test('invitation page (meeting link): no navigation, app marker, no "get the app" panel, and Join never opens the old built-in room', { skip }, async () => {
  await launch(); openLink('qorlla://join?meeting=' + account.meetingId); await until(new RegExp('/guest/meeting/' + account.meetingId + '/prejoin$'));
  await inWebview(`fetch('/api/auth/logout', { method: 'POST' }).then(() => true)`).catch(() => {}); await inWebview('location.reload(); true').catch(() => {}); await sleep(7000);
  const v = await json(await inWebview(`JSON.stringify({ invite: document.body.classList.contains('invite'), railHidden: getComputedStyle(document.querySelector('.sidebar')).display === 'none', ua: navigator.userAgent, panelHidden: document.getElementById('pjApp').classList.contains('hidden'), topic: document.getElementById('pjTopic').textContent })`));
  assert.equal(v.invite, true); assert.equal(v.railHidden, true, 'no navigation buttons for an invited guest'); assert.match(v.ua, /QorllaMobile\/1/); assert.equal(v.panelHidden, true); assert.match(v.topic, /Pages test meeting/); shot('p05-invitation');
  await inWebview(`(async () => { const n = document.getElementById('pjName'); n.value = 'Pages Guest'; n.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 300)); document.getElementById('pjGo').click(); return true; })()`).catch(() => {});
  await sleep(6000); const after = await json(await inWebview(`JSON.stringify({ msg: document.getElementById('pjMsg').textContent, url: location.href })`));
  assert.match(after.msg, /Video meetings are not available right now/, 'with no Meet behind this server the guest is told so'); assert.ok(!/index\.html/.test(after.url) && /\/prejoin$/.test(after.url), 'never the old room: ' + after.url); shot('p06-video-unavailable');
});
test('signed in: the workspace has the six-tab bar, More lists the moved pages, and the close button goes back', { skip }, async () => {
  await launch(); await tapId('guest'); await until(/\/guest\/welcome$/);
  const login = await inWebview(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ${JSON.stringify(account.username)}, password: ${JSON.stringify(account.password)} }) }).then((r) => r.status)`); assert.equal(login.value, 200, 'signed in'); await inWebview(`location.href = '/qorlla.html#home'; true`).catch(() => {}); await until(/\/qorlla\.html#home$/);
  await sleep(3000); const bar = await json(await inWebview(`JSON.stringify((() => { const sb = document.querySelector('.sidebar'), items = [...sb.querySelectorAll('.nav-item')].filter((e) => getComputedStyle(e).display !== 'none').sort((a, b) => Number(getComputedStyle(a).order) - Number(getComputedStyle(b).order)); const r = sb.getBoundingClientRect(); return { labels: items.map((e) => e.textContent.trim().replace(/\\s+\\d+$/, '')), scrolls: sb.scrollWidth > sb.clientWidth + 1, pageScroll: document.documentElement.scrollWidth > innerWidth, bottomInside: r.bottom <= innerHeight + 1, single: document.documentElement.getAttribute('data-single-tab') }; })())`));
  assert.deepEqual(bar.labels, ['Home', 'Chat', 'Phone', 'Docs', 'Clips', 'More']); assert.equal(bar.scrolls, false, 'the tab bar does not scroll'); assert.equal(bar.pageScroll, false); assert.equal(bar.bottomInside, true); assert.equal(bar.single, 'holder', 'the one-tab guard is active'); shot('p07-workspace-tabbar');
  await inWebview(`document.querySelector('.nav-item[data-view=more]').click(); true`); await sleep(2500);
  const more = await json(await inWebview(`JSON.stringify({ hash: location.hash, close: getComputedStyle(document.getElementById('viewClose')).display !== 'none', topbar: getComputedStyle(document.querySelector('.topbar')).display !== 'none', tiles: ['schedule', 'calendar', 'mail', 'board', 'notes', 'history', 'settings'].map((k) => !!document.querySelector('.tile[data-key=' + k + ']')) })`));
  assert.equal(more.hash, '#more'); assert.equal(more.close, true, 'close button on the page'); assert.equal(more.topbar, false); assert.deepEqual(more.tiles, [true, true, true, true, true, true, true]); shot('p08-more');
  await inWebview(`document.querySelector('.tile[data-key=notes]').click(); true`); await sleep(2000); assert.match((await inWebview('location.hash')).value, /#notes$/);
  await inWebview(`document.getElementById('viewClose').click(); true`); await sleep(1500); assert.equal((await inWebview('location.hash')).value, '#more', 'X goes back to the page it was opened from');
  await inWebview(`document.getElementById('viewClose').click(); true`); await sleep(1500); assert.equal((await inWebview('location.hash')).value, '#home'); shot('p09-back-home');
});
test('signed in on the phone app: starting a meeting says video is unavailable instead of opening the old room', { skip }, async () => {
  const before = (await inWebview('location.href')).url; assert.match(before, /\/qorlla\.html#home$/);
  const r = await json(await inWebview(`(async () => { document.querySelector('[data-act=meet]').click(); for (let i = 0; i < 80 && !(document.querySelector('dialog.sd[open]') && !document.getElementById('sdGo').disabled && document.getElementById('sdId').textContent.trim()); i += 1) await new Promise((x) => setTimeout(x, 250)); document.getElementById('sdGo').click(); for (let i = 0; i < 48 && !/Video meetings are not available/.test((document.getElementById('toast') || {}).textContent || ''); i += 1) await new Promise((x) => setTimeout(x, 250)); return JSON.stringify({ toast: (document.getElementById('toast') || {}).textContent, url: location.href, dialog: [...document.querySelectorAll('dialog[open] .msg, dialog[open] .err, dialog[open] [role=alert], #sdErr, #sdMsg')].map((e) => e.textContent.trim()).filter(Boolean).slice(0, 4), sdGo: (document.getElementById('sdGo') || {}).textContent, sdGoDisabled: (document.getElementById('sdGo') || {}).disabled, sdErr: (document.getElementById('sdErr') || {}).textContent, passNote: (document.getElementById('sdPassNote') || {}).textContent, idLabel: (document.getElementById('sdId') || {}).textContent }); })()`));
  shot('p10-start-unavailable');
  assert.match(r.toast || '', /Video meetings are not available right now/, 'state: ' + JSON.stringify(r)); assert.ok(!/index\.html/.test(r.url), 'never the old room: ' + r.url);
});
