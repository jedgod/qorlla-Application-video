'use strict';
// On-device check against a REAL stack (main + Qorlla Meet + its database), not the Meet-less test server: an invited guest and a signed-in host both land on the Qorlla Meet video page.
// Needs an isolated stack (QORLLA_STACK_APP, QORLLA_STACK_MEET: e.g. DEV_DB_CONTAINER=... MAIN_PORT=3400 MEET_PORT=3500 npm run dev:stack) and an app built for exactly those two origins
// (QORLLA_APP_URL / QORLLA_MEET_URLS with `npm run local-stack:build`). The phone reaches them through `adb reverse`, added here and removed afterwards (existing mappings are never touched).
// The Meet page asks for the camera and microphone, so NO screenshots are taken of it and the host unticks camera and microphone first; only the page's DOM is read.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const SERIAL = process.env.QORLLA_ANDROID_SERIAL, PKG = 'com.qorlla.mobile', APP = process.env.QORLLA_STACK_APP, MEET = process.env.QORLLA_STACK_MEET;
const skip = !SERIAL ? 'set QORLLA_ANDROID_SERIAL to a connected device' : (!APP || !MEET) ? 'set QORLLA_STACK_APP and QORLLA_STACK_MEET (the isolated stack the app was built for)' : false;
const adb = (...a) => spawnSync('adb', ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
const sh = (cmd) => adb('shell', cmd).stdout.trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = (u) => String(new URL(u).port || 80);

function dump() {
  for (let i = 0; i < 4; i += 1) {
    adb('shell', 'uiautomator dump /sdcard/qorlla-ui.xml'); const x = adb('exec-out', 'cat /sdcard/qorlla-ui.xml').stdout;
    if (x && x.includes('<hierarchy')) return [...x.matchAll(/<node ([^>]*?)\/?>/g)].map((m) => { const a = {}; for (const k of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[k[1]] = k[2]; const b = (a.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/); if (b) Object.assign(a, { l: +b[1], t: +b[2], r: +b[3], b: +b[4] }); return a; });
  }
  throw new Error('uiautomator produced no hierarchy');
}
const byId = (nodes, id) => nodes.find((n) => (n['resource-id'] || '') === id || (n['resource-id'] || '').endsWith('/' + id));
async function launch() { adb('shell', 'am force-stop ' + PKG); adb('shell', 'monkey -p ' + PKG + ' -c android.intent.category.LAUNCHER 1'); await sleep(4500); }
const openLink = (link) => adb('shell', `am start -a android.intent.action.VIEW -d "${link}" ${PKG}`);
async function tapId(id) {
  for (let i = 0; i < 12; i += 1) { const n = dump(), t = byId(n, id); if (byId(n, 'welcome-screen') && t && t.t >= 0) { await sleep(600); adb('shell', 'input tap ' + Math.round((t.l + t.r) / 2) + ' ' + Math.round((t.t + t.b) / 2)); return; } await sleep(1000); }
  assert.fail('not on screen: ' + id);
}
async function inWebview(expression) {
  const pid = sh('pidof ' + PKG).split(/\s+/)[0]; assert.ok(pid, 'the app is running'); adb('forward', 'tcp:19222', 'localabstract:webview_devtools_remote_' + pid);
  try {
    let list = null; for (let i = 0; i < 15 && !list; i += 1) { try { list = await (await fetch('http://127.0.0.1:19222/json', { signal: AbortSignal.timeout(3000) })).json(); } catch { await sleep(2000); } }
    const info = (list || []).find((p) => p.type === 'page'); assert.ok(info, 'a WebView page is open');
    const ws = new WebSocket(info.webSocketDebuggerUrl); let out;
    try {
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      const answer = new Promise((r, j) => { const t = setTimeout(() => j(new Error('no answer from the WebView')), 15000); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { clearTimeout(t); r(d); } }; });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true, userGesture: true } }));
      out = await answer;
    } finally { try { ws.close(); } catch { /* already closed */ } }
    if (out.result && out.result.exceptionDetails) { const x = out.result.exceptionDetails; throw new Error('page script failed: ' + ((x.exception && x.exception.description) || x.text)); }
    return { url: info.url, value: out.result && out.result.result ? out.result.result.value : undefined };
  } finally { adb('forward', '--remove', 'tcp:19222'); }
}
async function until(re, ms = 40000) { const t0 = Date.now(); let last = ''; while (Date.now() - t0 < ms) { try { last = (await inWebview('location.href')).url; if (re.test(last)) return last; } catch { /* not up yet */ } await sleep(1500); } throw new Error('never reached ' + re + ' (last: ' + last.replace(/#.*/, '#...') + ')'); }
const json = (r) => JSON.parse(r.value);
const api = async (p, o = {}) => fetch(APP + p, { ...o, headers: { 'Content-Type': 'application/json', Origin: APP, ...(o.headers || {}) } });
// what the Meet page shows, read from its DOM (never a picture of it)
const meetDom = `JSON.stringify({ title: document.title, landing: !!document.getElementById('landing') && !document.getElementById('landing').classList.contains('hidden'), waiting: !!document.getElementById('waiting') && !document.getElementById('waiting').classList.contains('hidden'), room: !!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden'), roomTitle: (document.getElementById('roomTitle') || {}).textContent || '', origin: location.origin, path: location.pathname })`;

let host = null;
async function newHost() {
  const username = 'rs' + Math.random().toString(36).slice(2, 8), password = 'Side-bar-9917!x';
  const reg = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, displayName: 'Stack Host', password }) }); assert.equal(reg.status, 201);
  const cookie = (reg.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  const m = await api('/api/meetings/create', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ topic: 'Real stack meeting' }) }); assert.equal(m.status, 201);
  const id = (await m.json()).meeting.meetingId;
  const st = await api('/api/meetings/' + encodeURIComponent(id) + '/start', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ name: 'Stack Host', mic: false, camera: false }) }); const sd = await st.json();
  return { username, password, cookie, id, digits: id.replace(/\D/g, ''), start: sd };
}
test.before(async () => { if (skip) return; for (const u of [APP, MEET]) adb('reverse', 'tcp:' + port(u), 'tcp:' + port(u)); host = await newHost(); });
test.after(() => { if (skip) return; adb('shell', 'am force-stop ' + PKG); for (const u of [APP, MEET]) adb('reverse', '--remove', 'tcp:' + port(u)); adb('forward', '--remove', 'tcp:19222'); });   // only the two mappings added above are removed

test('the real stack hands out the Qorlla Meet video page (not the old room) to the host and to a guest', { skip }, async () => {
  assert.equal(host.start.mode, 'meet', 'starting a meeting returns the Meet page'); assert.ok(host.start.url.startsWith(MEET + '/'), 'the host URL is on the Meet origin');
  const g = await (await api('/api/guest/sessions', { method: 'POST', body: JSON.stringify({ meetingId: host.id, displayName: 'API Guest' }) })).json(); assert.ok(g.meet && g.meet.url.startsWith(MEET + '/'), 'the guest URL is on the Meet origin'); assert.ok(!/index\.html/.test(g.meet.url));
});
test('on the phone: an invited guest follows the meeting link and lands on the Qorlla Meet page (no navigation, no old room)', { skip }, async () => {
  await launch(); openLink('qorlla://join?meeting=' + host.digits); await until(new RegExp('/guest/meeting/' + host.digits + '/prejoin$'));
  await inWebview(`fetch('/api/auth/logout', { method: 'POST' }).then(() => { location.reload(); return true; })`).catch(() => {}); await sleep(7000);
  const pre = json(await inWebview(`JSON.stringify({ topic: document.getElementById('pjTopic').textContent, railHidden: getComputedStyle(document.querySelector('.sidebar')).display === 'none', panelHidden: document.getElementById('pjApp').classList.contains('hidden') })`));
  assert.match(pre.topic, /Real stack meeting/); assert.equal(pre.railHidden, true); assert.equal(pre.panelHidden, true);
  await inWebview(`(async () => { const n = document.getElementById('pjName'); n.value = 'Phone Guest'; n.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 300)); document.getElementById('pjGo').click(); return true; })()`).catch(() => {});
  const url = await until(new RegExp('^' + MEET.replace(/[.]/g, '\\.') + '/'), 45000); assert.ok(!/index\.html/.test(url)); await sleep(6000);
  const m = json(await inWebview(meetDom)); assert.match(m.title, /Qorlla Meet/, 'the Qorlla Meet page: ' + m.title); assert.equal(m.origin, MEET); assert.ok(m.landing || m.waiting || m.room, 'one of the Meet screens is showing: ' + JSON.stringify(m));
  console.log('# Meet page for the guest: ' + JSON.stringify({ title: m.title, landing: m.landing, waiting: m.waiting, room: m.room }));
});
test('on the phone: a signed-in host starts a meeting and lands on the Qorlla Meet page, with camera and microphone off', { skip }, async () => {
  await launch(); await tapId('guest'); await until(/\/guest\/welcome$/);
  const login = await inWebview(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ${JSON.stringify(host.username)}, password: ${JSON.stringify(host.password)} }) }).then((r) => r.status)`); assert.equal(login.value, 200);
  await inWebview(`location.href = '/qorlla.html#home'; true`).catch(() => {}); await until(/\/qorlla\.html#home$/); await sleep(2500);
  await inWebview(`(async () => { document.querySelector('[data-act=meet]').click(); for (let i = 0; i < 80 && !(document.querySelector('dialog.sd[open]') && !document.getElementById('sdGo').disabled && document.getElementById('sdId').textContent.trim()); i += 1) await new Promise((x) => setTimeout(x, 250)); document.getElementById('sdMic').checked = false; document.getElementById('sdCam').checked = false; document.getElementById('sdGo').click(); return true; })()`).catch(() => {});
  const url = await until(new RegExp('^' + MEET.replace(/[.]/g, '\\.') + '/'), 45000); assert.ok(!/index\.html/.test(url)); assert.match(url, /mic=false/); assert.match(url, /camera=false/, 'camera and microphone were off for the host'); await sleep(6000);
  const m = json(await inWebview(meetDom)); assert.match(m.title, /Qorlla Meet/); assert.equal(m.origin, MEET); assert.ok(m.landing || m.waiting || m.room, JSON.stringify(m));
  console.log('# Meet page for the host: ' + JSON.stringify({ title: m.title, landing: m.landing, waiting: m.waiting, room: m.room, roomTitle: m.roomTitle }));
});
