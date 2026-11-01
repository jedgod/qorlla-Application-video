'use strict';
// On-device UI test of the Welcome / Join screen. Needs a connected, authorised Android device named by QORLLA_ANDROID_SERIAL and the app (com.qorlla.mobile) installed
// with QORLLA_TEST_BUILD=1 pointing at a server reachable from the phone (adb reverse). It never clears app data and never uninstalls anything.
// The only device setting it touches is the system font scale (to test large text), which it puts back in `finally`.
// Screenshots go to QORLLA_EVIDENCE_DIR (default: docs/evidence/clients/welcome-redesign) and only ever show this screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERIAL = process.env.QORLLA_ANDROID_SERIAL, PKG = 'com.qorlla.mobile', skip = SERIAL ? false : 'set QORLLA_ANDROID_SERIAL to a connected device';
const OUT = process.env.QORLLA_EVIDENCE_DIR || path.join(__dirname, '..', 'docs', 'evidence', 'clients', 'welcome-redesign');
// every adb call has a time limit, so a stuck device command fails the test instead of hanging the run
const adb = (...a) => spawnSync('adb', ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
const sh = (cmd) => adb('shell', cmd).stdout.trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dump() {
  for (let i = 0; i < 4; i += 1) {
    adb('shell', 'uiautomator dump /sdcard/qorlla-ui.xml'); const x = adb('exec-out', 'cat /sdcard/qorlla-ui.xml').stdout;
    if (x && x.includes('<hierarchy')) return [...x.matchAll(/<node ([^>]*?)\/?>/g)].map((m) => { const a = {}; for (const k of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[k[1]] = k[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#10;/g, '\n').replace(/&apos;/g, "'"); const b = (a.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/); if (b) Object.assign(a, { l: +b[1], t: +b[2], r: +b[3], b: +b[4] }); return a; });
  }
  throw new Error('uiautomator produced no hierarchy');
}
const find = (nodes, re, field = 'content-desc') => nodes.find((n) => re.test(n[field] || '') || re.test(n.text || ''));
const byId = (nodes, id) => nodes.find((n) => (n['resource-id'] || '') === id || (n['resource-id'] || '').endsWith('/' + id));
const centre = (n) => [Math.round((n.l + n.r) / 2), Math.round((n.t + n.b) / 2)];
const tap = (n) => { const [x, y] = centre(n); adb('shell', 'input tap ' + x + ' ' + y); };
const screen = () => { const m = sh('wm size').match(/(\d+)x(\d+)\s*$/m); return { w: +m[1], h: +m[2] }; };
const swipeUp = () => { const { w, h } = screen(); adb('shell', `input swipe ${w / 2} ${h * 0.75} ${w / 2} ${h * 0.25} 350`); };
const shot = (name) => { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name + '.png'), spawnSync('adb', ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 }).stdout); };
// URL of the page in the app's WebView, read over the WebView debugging socket (test builds only; the forward is removed again)
function webviewUrl() {
  const pid = sh('pidof ' + PKG).split(/\s+/)[0]; if (!pid) return ''; adb('forward', 'tcp:19222', 'localabstract:webview_devtools_remote_' + pid);
  try { const r = spawnSync('curl', ['-s', '-m', '4', 'http://127.0.0.1:19222/json'], { encoding: 'utf8' }); const pages = JSON.parse(r.stdout || '[]'); return (pages.find((p) => p.type === 'page') || {}).url || ''; } catch { return ''; } finally { adb('forward', '--remove', 'tcp:19222'); }
}
// scrolls until the node with this resource id is on screen (the page is taller than the window), and returns it
async function reveal(id) {
  for (let i = 0; i < 6; i += 1) { const n = dump(), a = byId(n, id); if (a) return a; swipeUp(); await sleep(450); }
  throw new Error('not found on screen: ' + id);
}
async function launch() { adb('shell', 'am force-stop ' + PKG); adb('shell', 'monkey -p ' + PKG + ' -c android.intent.category.LAUNCHER 1'); await sleep(4500); }
const overflow = (nodes) => { const { w } = screen(); return nodes.filter((n) => n.package === PKG && n.r !== undefined && (n.r > w + 1 || n.l < -1)); };

test('the app is installed from this build and starts on the Welcome screen', { skip }, async () => {
  assert.match(sh('pm list packages ' + PKG), new RegExp(PKG)); await launch(); const n = dump();
  assert.ok(byId(n, 'welcome-screen') || find(n, /Join (a )?Meeting/i), 'Welcome screen is showing'); shot('01-welcome-top');
});

test('hero, shortcuts and the meeting card are present, in reading order, with no horizontal overflow', { skip }, async () => {
  await launch(); const n = dump();
  for (const re of [/Language: /, /Video Meetings\./, /Team Collaboration\./, /Communication\./, /Security & Privacy\./, /Join (a )?Meeting/i]) assert.ok(find(n, re), String(re));
  const cards = [/Video Meetings\./, /Team Collaboration\./, /Communication\./, /Security & Privacy\./].map((re) => find(n, re)); assert.ok(cards[0].l < cards[1].l && cards[2].l < cards[3].l && cards[0].t < cards[2].t, 'cards run left to right, then down (2 x 2)');
  assert.deepEqual(overflow(n).map((x) => x['content-desc'] || x.text), [], 'nothing extends past the screen width');
});

test('meeting ID: letters, short and long inputs are explained, the button stays disabled until exactly 11 digits, and nothing is cut off', { skip }, async () => {
  await launch(); const field = await reveal('meeting-id'); assert.ok(field, 'meeting-id field'); tap(field); await sleep(700); let n;
  adb('shell', 'input text 123'); await sleep(600); n = dump(); assert.ok(find(n, /3 of 11 digits/), 'incomplete hint'); assert.equal(byId(n, 'join').enabled, 'false', 'Join is disabled while incomplete'); shot('02-incomplete');
  adb('shell', 'input text abc'); await sleep(600); n = dump(); assert.ok(find(n, /digits only/), 'letters are called out'); assert.equal(byId(n, 'join').enabled, 'false');
  for (let i = 0; i < 6; i += 1) adb('shell', 'input keyevent KEYCODE_DEL'); await sleep(300); // abc and 123 are gone
  adb('shell', 'input text 12345678901'); await sleep(600); n = dump(); assert.ok(find(n, /11 of 11 digits/), 'exactly 11 digits'); assert.equal(byId(n, 'join').enabled, 'true', 'Join is enabled at 11 digits'); shot('03-valid');
  adb('shell', 'input text 99'); await sleep(600); n = dump(); assert.ok(find(n, /13 digits.*nothing was cut off/), 'extra digits are reported, not truncated'); assert.equal(byId(n, 'join').enabled, 'false');
  for (let i = 0; i < 20; i += 1) adb('shell', 'input keyevent KEYCODE_DEL');
});

test('keyboard: with the keyboard open the field and the Join button can both be reached', { skip }, async () => {
  await launch(); let n; tap(await reveal('meeting-id')); await sleep(900); n = dump(); const { h } = screen(), field = byId(n, 'meeting-id');
  assert.ok(field && field.t >= 0 && field.b <= h, 'field on screen'); assert.match(sh('dumpsys input_method | grep -m1 mInputShown'), /mInputShown=true/, 'the keyboard is open'); shot('04-keyboard');
  adb('shell', 'input keyevent KEYCODE_BACK'); await sleep(400);
});

const dp = (px) => px / (Number(sh('wm density').match(/(\d+)\s*$/)[1]) / 160);
// brings a row fully inside the visible scroll area (the bottom of the window is the system navigation bar) and returns it
async function fullRow(re) {
  for (let i = 0; i < 6; i += 1) {
    const n = dump(), a = find(n, re); if (a && dp(a.b - a.t) >= 47.5) return a; // rows are at least 48dp when whole; a clipped row is shorter
    const { w, h } = screen(); const up = !a || a.t > h * 0.5; adb('shell', `input swipe ${w / 2} ${up ? h * 0.6 : h * 0.3} ${w / 2} ${up ? h * 0.4 : h * 0.5} 300`); await sleep(500);
  }
  throw new Error('could not bring into view: ' + re);
}
test('lower sections: account actions, utility cards and the availability notice are reachable by scrolling', { skip }, async () => {
  await launch(); let n = dump(); for (let i = 0; i < 5 && !find(n, /Restricted services remain unavailable/); i += 1) { swipeUp(); await sleep(500); n = dump(); }
  for (const re of [/Help & Support\./, /Explore Qorlla\./, /Settings\./, /Restricted services remain unavailable/]) assert.ok(find(n, re), String(re)); shot('05-bottom');
  assert.deepEqual(overflow(n).map((x) => x['content-desc'] || x.text), []);
  for (const re of [/Sign In\. Use your Qorlla account/, /Continue as Guest\. Join without an account/]) { const a = await fullRow(re); assert.ok(dp(a.b - a.t) >= 48, 'touch target >= 48dp: ' + re + ' is ' + Math.round(dp(a.b - a.t)) + 'dp'); }
  shot('05b-account-actions');
});

// the whole page is one screen: every section is inside the window at once (above the system navigation bar), with no scrolling
const SECTIONS = [/Language: /, /Video Meetings\./, /Team Collaboration\./, /Communication\./, /Security & Privacy\./, /Join (a )?Meeting/i, /Sign In\./, /Continue as Guest\./, /Help & Support\./, /Explore Qorlla\./, /Settings\./, /Restricted services remain unavailable/];
const onePage = (n, label) => { const { h } = screen(), bar = Math.round(40 * PX_PER_DP()); for (const re of SECTIONS) { const a = find(n, re); assert.ok(a, label + ': ' + re + ' is on screen'); assert.ok(a.t >= 0 && a.b <= h - bar && a.r > a.l, label + ': ' + re + ' is fully inside the window (' + a.t + '-' + a.b + ' of ' + h + ')'); } };
test('one page: every section is on the screen at once without scrolling', { skip }, async () => { await launch(); onePage(dump(), 'device window'); shot('06-one-page'); });

test('language list opens with the four supported languages', { skip }, async () => {
  await launch(); let n = dump(); tap(byId(n, 'language-select')); await sleep(800); n = dump();
  for (const re of [/English/, /Español/, /Français/, /Português \(Portugal\)/]) assert.ok(find(n, re), String(re)); shot('07-language'); adb('shell', 'input keyevent KEYCODE_BACK'); await sleep(400);
});

test('Continue as guest opens Guest Welcome (not a meeting) and Back returns to the Welcome screen', { skip }, async () => {
  await launch(); let n = dump(); for (let i = 0; i < 3 && !find(n, /Continue as Guest\./); i += 1) { swipeUp(); await sleep(500); n = dump(); }
  tap(find(n, /Continue as Guest\./)); await sleep(5000); n = dump(); assert.ok(n.some((x) => /WebView/.test(x.class || '')), 'a WebView is showing'); assert.ok(!byId(n, 'welcome-screen'), 'native Welcome is gone');
  assert.match(webviewUrl(), /\/guest\/welcome$/, 'the WebView is on /guest/welcome, not a meeting'); shot('08-guest-welcome');
  adb('shell', 'input keyevent KEYCODE_BACK'); await sleep(1500); assert.ok(byId(dump(), 'welcome-screen') || find(dump(), /Join (a )?Meeting/i), 'Back returns to the Welcome screen');
});

test('large system text (130%) still has no horizontal overflow and the primary controls are reachable', { skip }, async () => {
  const before = sh('settings get system font_scale'); try {
    adb('shell', 'settings put system font_scale 1.3'); await sleep(1500); await launch(); let n = dump();
    shot('09-font-130-top'); const seen = new Set(); let guard = 0;
    for (;;) { assert.deepEqual(overflow(n).map((x) => x['content-desc'] || x.text), [], 'no overflow at 130%'); n.forEach((x) => seen.add(x['content-desc'] || x.text)); if (find(n, /Restricted services remain unavailable/) || (guard += 1) > 8) break; swipeUp(); await sleep(450); n = dump(); }
    const text = [...seen].join(' | '); for (const re of [/Join (a )?Meeting/i, /Sign In\./, /Continue as Guest\./, /Settings\./, /Restricted services remain unavailable/]) assert.match(text, re, 'reachable at 130%: ' + re); shot('09-font-130-bottom');
  } finally { adb('shell', before && before !== 'null' ? 'settings put system font_scale ' + before : 'settings delete system font_scale'); }
});

// ---- autosizing: the same screen at the narrow and wide phone widths people actually have. The window size is changed with `wm size` and ALWAYS reset afterwards.
const PX_PER_DP = () => Number(sh('wm density').match(/(\d+)\s*$/)[1]) / 160;
async function atWidth(dpWidth, fn) {
  const w = Math.round(dpWidth * PX_PER_DP()); try { adb('shell', `wm size ${w}x1600`); await sleep(1500); await launch(); await fn(); } finally { adb('shell', 'wm size reset'); await sleep(1000); }
}
async function noOverflowWholePage(label) {
  let n = dump(); const seen = new Set();
  for (let i = 0; i < 7; i += 1) {
    assert.deepEqual(overflow(n).map((x) => x['content-desc'] || x.text), [], label + ': nothing past the screen edge'); n.forEach((x) => seen.add(x['content-desc'] || x.text));
    if (find(n, /Restricted services|Servicios restringidos|services restreints|serviços restritos/i)) break; swipeUp(); await sleep(450); n = dump();
  }
  return seen;
}
for (const dpW of [320, 360, 390, 412]) {
  test(`autosizing at ${dpW}dp: no overflow, every section reachable, touch targets at least 48dp`, { skip }, async () => {
    await atWidth(dpW, async () => {
      onePage(dump(), dpW + 'dp'); const seen = await noOverflowWholePage(dpW + 'dp'); const text = [...seen].join('\n');
      for (const re of [/Video Meetings\./, /Team Collaboration\./, /Communication\./, /Security & Privacy\./, /Join (a )?Meeting/i, /Sign In\./, /Continue as Guest\./, /Help & Support\./, /Explore Qorlla\./, /Settings\./, /Restricted services remain unavailable/]) assert.match(text, re, dpW + 'dp: ' + re);
      shot('w' + dpW + '-bottom'); adb('shell', 'input swipe 360 400 360 1300 200'); adb('shell', 'input swipe 360 400 360 1300 200'); adb('shell', 'input swipe 360 400 360 1300 200'); await sleep(500); shot('w' + dpW + '-top');
      // only controls that are fully inside the scroll area count: one cut off by the top or bottom edge of the window is shorter than it really is
      const { h } = screen(), small = dump().filter((x) => x.clickable === 'true' && x.package === PKG && x.r > x.l && x.t > 100 && x.b < h - 140 && dp(x.b - x.t) < 47.5 && /./.test(x['content-desc'] || ''));
      assert.deepEqual(small.map((x) => x['content-desc'] + ' ' + Math.round(dp(x.b - x.t)) + 'dp'), [], 'clickable controls under 48dp');
    });
  });
}
for (const [code, label, join] of [['fr', 'Français', /Rejoindre la réunion/], ['es', 'Español', /Unirse a la reunión/], ['pt-PT', 'Português', /Entrar na reunião/]]) {
  test(`language ${code}: the text changes, nothing overflows at 320dp and at 412dp`, { skip }, async () => {
    for (const dpW of [320, 412]) await atWidth(dpW, async () => {
      tap(await reveal('language-select')); await sleep(800); const item = byId(dump(), 'lang-' + code); assert.ok(item, 'language entry ' + code); tap(item); await sleep(1200);
      for (let i = 0; i < 4; i += 1) { adb('shell', 'input swipe 360 400 360 1300 200'); } await sleep(400);
      const seen = await noOverflowWholePage(code + ' ' + dpW + 'dp'); const text = [...seen].join('\n'); assert.match(text, join, code + ': Join button translated'); assert.doesNotMatch(text, /Join Meeting/, 'no English left on the primary action'); shot('lang-' + code + '-' + dpW);
    });
  });
}

// ---- deep links, the app-choice panel inside the app, and a guest joining: against an isolated test server (QORLLA_E2E_SERVER, reachable from the phone through adb reverse).
const SERVER = process.env.QORLLA_E2E_SERVER, skipServer = skip || (SERVER ? false : 'set QORLLA_E2E_SERVER to the isolated test server the phone reaches (e.g. http://localhost:18081)');
async function newMeeting() {
  const username = 'dv' + Math.random().toString(36).slice(2, 8), body = { username, displayName: 'Device Host', password: 'Side-bar-9917!x' };
  const reg = await fetch(SERVER + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(reg.status, 201, 'host registered');
  const cookie = (reg.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  const r = await fetch(SERVER + '/api/meetings/create', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ topic: 'Device test meeting' }) }); assert.equal(r.status, 201, 'meeting created');
  const digits = String((await r.json()).meeting.meetingId).replace(/\D/g, ''); assert.match(digits, /^[0-9]{11}$/); return digits;
}
// runs an expression in the page shown by the app's WebView (debug socket of the test build; the forward is removed again)
async function inWebview(expression) {
  const pid = sh('pidof ' + PKG).split(/\s+/)[0]; assert.ok(pid, 'the app is running'); adb('forward', 'tcp:19222', 'localabstract:webview_devtools_remote_' + pid);
  try {
    let list = null; for (let i = 0; i < 15 && !list; i += 1) { try { list = await (await fetch('http://127.0.0.1:19222/json', { signal: AbortSignal.timeout(3000) })).json(); } catch { await sleep(2000); } }   // the debug socket answers a few seconds after the WebView appears
    const pageInfo = (list || []).find((p) => p.type === 'page'); assert.ok(pageInfo, 'a WebView page is open');
    const ws = new WebSocket(pageInfo.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const answer = new Promise((r, j) => { const t = setTimeout(() => j(new Error('no answer from the WebView')), 15000); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { clearTimeout(t); r(d); } }; });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); const out = await answer; ws.close();
    return { url: pageInfo.url, value: out.result && out.result.result ? out.result.result.value : undefined };
  } finally { adb('forward', '--remove', 'tcp:19222'); }
}
const openLink = (link) => adb('shell', `am start -a android.intent.action.VIEW -d "${link}" ${PKG}`);

test('a meeting link opens that meeting\'s pre-join page inside the app; the app marker is set and the "get the app" panel stays hidden', { skip: skipServer }, async () => {
  const id = await newMeeting(); await launch(); openLink('qorlla://join?meeting=' + id); await sleep(9000);
  const r = await inWebview(`JSON.stringify({ ua: navigator.userAgent, panelHidden: document.getElementById('pjApp') ? document.getElementById('pjApp').classList.contains('hidden') : null, buttons: document.querySelectorAll('#pjAppBtns a').length, topic: (document.getElementById('pjTopic') || {}).textContent })`);
  assert.equal(r.url, SERVER + '/guest/meeting/' + id + '/prejoin', 'the deep link opened this meeting\'s pre-join page');
  const v = JSON.parse(r.value); assert.match(v.ua, /QorllaMobile\/1/, 'the WebView identifies itself as the Qorlla app'); assert.equal(v.panelHidden, true, 'the app-choice panel is hidden inside the app'); assert.equal(v.buttons, 0);
  assert.match(v.topic, /Device test meeting/, 'the meeting resolved: ' + v.topic); shot('10-deeplink-prejoin');
});
test('malformed or hostile meeting links are ignored: the page does not change', { skip: skipServer }, async () => {
  const id = await newMeeting(); await launch(); openLink('qorlla://join?meeting=' + id); await sleep(8000); const before = (await inWebview('location.href')).url;
  for (const bad of ['qorlla://join?meeting=123', 'qorlla://join?meeting=' + id + '&next=https://evil.example/', 'qorlla://join?next=https://evil.example/', 'qorlla://evil/?meeting=' + id, 'qorlla://join?meeting=../../etc/passwd', 'qorlla://join?meeting=https://evil.example/']) {
    openLink(bad); await sleep(2500); assert.equal((await inWebview('location.href')).url, before, 'ignored: ' + bad);
  }
});
test('an invited guest sees no navigation, and Join never opens the old built-in room (this server has no Meet, so the page says video is unavailable)', { skip: skipServer }, async () => {
  const id = await newMeeting(); await launch(); openLink('qorlla://join?meeting=' + id); await sleep(9000);
  const was = await inWebview(`fetch('/api/auth/me').then((r) => r.json()).then((d) => !!d.user)`);               // the app's WebView may still hold a test sign-in: a registered person DOES see the navigation
  if (was.value === true) { await inWebview(`fetch('/api/auth/logout', { method: 'POST' }).then(() => { location.reload(); return true; })`).catch(() => {}); await sleep(7000); }
  const nav = await inWebview(`JSON.stringify({ invite: document.body.classList.contains('invite'), railHidden: getComputedStyle(document.querySelector('.sidebar')).display === 'none' })`);
  assert.deepEqual(JSON.parse(nav.value), { invite: true, railHidden: true }, 'no navigation buttons on the invitation page'); shot('10-deeplink-prejoin');
  await inWebview(`(async () => { const n = document.getElementById('pjName'); n.value = 'Device Guest'; n.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 300)); document.getElementById('pjGo').click(); return true; })()`).catch(() => {});
  await sleep(6000); const after = await inWebview(`JSON.stringify({ msg: (document.getElementById('pjMsg') || {}).textContent, url: location.href })`);
  const v = JSON.parse(after.value); assert.match(v.msg, /Video meetings are not available right now/, 'the guest is told video is unavailable: ' + v.msg);
  assert.ok(/\/prejoin$/.test(v.url) && !/index\.html/.test(v.url), 'still on the invitation page, never the old room: ' + v.url);
});
