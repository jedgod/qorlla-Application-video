'use strict';
// The Galaxy A03s as the second participant in a real Qorlla Meet meeting on the ISOLATED compose stack (nginx + main + portal + Meet + databases).
// A desktop Chromium (synthetic camera and microphone) is the host; the phone's app opens Meet's page at /meet/ through the one proxy origin (the app's own buttons cannot reach it in this topology, see README).
// Evidence is RTP counters, DOM state and logs. The phone's camera is REAL: no screenshot is taken while it is on; the two screenshots kept are the waiting room, and the room with the camera switched OFF.
// Needs QORLLA_ANDROID_SERIAL, ISO_BASE (default http://localhost:3600) and the app built for that origin (`npm run local-stack:build` with QORLLA_APP_URL / QORLLA_MEET_URLS = that origin).
// Adds one adb reverse (the proxy port), restores the camera permission if the test revokes it, and removes its mapping and forward at the end.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./harness.cjs');

const SERIAL = process.env.QORLLA_ANDROID_SERIAL, PKG = 'com.qorlla.mobile', BASE = process.env.ISO_BASE || 'http://localhost:3600';
const skip = SERIAL ? false : 'set QORLLA_ANDROID_SERIAL to a connected device';
const OUT = process.env.QORLLA_EVIDENCE_DIR || path.join(__dirname, '..', 'docs', 'evidence', 'clients', 'welcome-redesign', 'meet');
const adb = (...a) => spawnSync('adb', ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
const sh = (c) => adb('shell', c).stdout.trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = String(new URL(BASE).port || 80);
const shot = (name) => { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name + '.png'), spawnSync('adb', ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 }).stdout); };
const evidence = {};

function dump() {
  for (let i = 0; i < 4; i += 1) { adb('shell', 'uiautomator dump /sdcard/qorlla-ui.xml'); const x = adb('exec-out', 'cat /sdcard/qorlla-ui.xml').stdout;
    if (x && x.includes('<hierarchy')) return [...x.matchAll(/<node ([^>]*?)\/?>/g)].map((m) => { const a = {}; for (const k of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[k[1]] = k[2]; const b = (a.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/); if (b) Object.assign(a, { l: +b[1], t: +b[2], r: +b[3], b: +b[4] }); return a; }); }
  throw new Error('uiautomator produced no hierarchy');
}
const byId = (n, id) => n.find((x) => (x['resource-id'] || '') === id || (x['resource-id'] || '').endsWith('/' + id));
async function launch() { adb('shell', 'am force-stop ' + PKG); adb('shell', 'monkey -p ' + PKG + ' -c android.intent.category.LAUNCHER 1'); await sleep(4500); }
async function tapGuest() { for (let i = 0; i < 12; i += 1) { const n = dump(), t = byId(n, 'guest'); if (byId(n, 'welcome-screen') && t && t.t >= 0) { await sleep(600); adb('shell', 'input tap ' + Math.round((t.l + t.r) / 2) + ' ' + Math.round((t.t + t.b) / 2)); return; } await sleep(1000); } assert.fail('Welcome screen not ready'); }

// ONE long-lived DevTools session on the phone's WebView page: the RTC hook is installed for every new document, so the Meet page's peer connections can be read.
class Cdp {
  async open() {
    const pid = sh('pidof ' + PKG).split(/\s+/)[0]; assert.ok(pid, 'the app is running'); adb('forward', 'tcp:19222', 'localabstract:webview_devtools_remote_' + pid);
    let list = null; for (let i = 0; i < 15 && !list; i += 1) { try { list = await (await fetch('http://127.0.0.1:19222/json', { signal: AbortSignal.timeout(3000) })).json(); } catch { await sleep(2000); } }
    const info = (list || []).find((p) => p.type === 'page'); assert.ok(info, 'a WebView page is open'); this.ws = new WebSocket(info.webSocketDebuggerUrl); this.id = 0; this.wait = new Map();
    this.ws.onmessage = (m) => { const d = JSON.parse(m.data); const w = this.wait.get(d.id); if (w) { this.wait.delete(d.id); w(d); } }; await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    await this.send('Page.enable'); await this.send('Network.enable'); await this.send('Page.addScriptToEvaluateOnNewDocument', { source: h.RTC_HOOK });
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { const t = setTimeout(() => { this.wait.delete(id); reject(new Error('no answer to ' + method)); }, 20000); this.wait.set(id, (d) => { clearTimeout(t); resolve(d.result || d); }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async js(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error('page script failed: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text)); return r.result ? r.result.value : undefined; }
  close() { try { this.ws.close(); } catch { /* closed */ } adb('forward', '--remove', 'tcp:19222'); }
}
const phoneFlowing = async (c, ms = 4000) => { const a = JSON.parse(await c.js(`${h.COLLECT}.then(JSON.stringify)`)); await sleep(ms); const b = JSON.parse(await c.js(`${h.COLLECT}.then(JSON.stringify)`)); const d = (k) => b[k] - a[k]; return { delta: { audioIn: d('audioIn'), videoIn: d('videoIn'), audioOut: d('audioOut'), videoOut: d('videoOut'), framesDecoded: d('framesDecoded'), framesEncoded: d('framesEncoded') }, connected: b.connected, pcs: b.pcs }; };
async function untilJs(c, expr, ms = 45000) { const t0 = Date.now(); let last; while (Date.now() - t0 < ms) { try { last = await c.js(expr); if (last) return last; } catch { /* the page is loading */ } await sleep(1500); } throw new Error('condition never became true: ' + expr.slice(0, 80)); }

let hostB, host, cdp, meeting, g2, hostToken;
test.before(async () => {
  if (skip) return; adb('reverse', 'tcp:' + port, 'tcp:' + port);
  hostB = await h.chromium.launch({ args: h.FAKE_MEDIA }); const ctx = await hostB.newContext({ ...h.ctxPermissions(), baseURL: BASE }); await ctx.addInitScript(h.RTC_HOOK); host = { ctx, page: await ctx.newPage() };
  await host.page.goto('/meet/'); await host.page.fill('#displayName', 'Host Hana'); await host.page.fill('#meetingTitle', 'Phone meeting');
  const [resp] = await Promise.all([host.page.waitForResponse((r) => /\/api\/meetings$/.test(r.url()) && r.request().method() === 'POST'), host.page.click('#createBtn')]); const created = await resp.json();
  await host.page.waitForFunction(() => !document.querySelector('#app').classList.contains('hidden'), null, { timeout: 45000 });
  assert.equal((await ctx.request.patch(BASE + '/meet/api/meetings/' + created.meetingId + '/settings', { headers: { Authorization: 'Bearer ' + created.token, 'Content-Type': 'application/json' }, data: JSON.stringify({ waitingRoom: true }) })).status(), 200);
  meeting = { id: created.meetingId }; hostToken = created.token; evidence.waitingRoomOn = true;
  await launch(); await tapGuest(); cdp = new Cdp(); await cdp.open();
});
test.after(async () => {
  if (skip) return; try { cdp && cdp.close(); } catch { /* closed */ } try { g2 && (await g2.close()); } catch { /* closed */ } try { hostB && (await hostB.close()); } catch { /* closed */ }
  adb('shell', 'pm grant ' + PKG + ' android.permission.CAMERA'); adb('shell', 'pm grant ' + PKG + ' android.permission.RECORD_AUDIO'); adb('shell', 'am force-stop ' + PKG); adb('reverse', '--remove', 'tcp:' + port);
  fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'android-meet-evidence.json'), JSON.stringify(evidence, null, 2)); console.log('# evidence ' + JSON.stringify(evidence));
});

test('phone: joins Meet through the proxy origin, waits in the waiting room, and the host admits it', { skip }, async () => {
  await cdp.js(`location.href = '/meet/'; true`).catch(() => {}); await untilJs(cdp, `!!document.getElementById('joinBtn') && !!document.getElementById('displayName')`);
  const origin = await cdp.js('location.origin'); assert.equal(origin, BASE, 'Meet is served from the one proxy origin'); evidence.phoneOrigin = origin;
  await cdp.js(`(() => { document.getElementById('displayName').value = 'Phone Guest'; document.getElementById('meetingId').value = ${JSON.stringify(meeting.id)}; document.getElementById('joinBtn').click(); return true; })()`);
  try { await untilJs(cdp, `!!document.getElementById('waiting') && !document.getElementById('waiting').classList.contains('hidden')`); }
  catch (e) { const d = await cdp.js(`JSON.stringify({ landingHidden: document.getElementById('landing').classList.contains('hidden'), waitingHidden: document.getElementById('waiting').classList.contains('hidden'), appHidden: document.getElementById('app').classList.contains('hidden'), err: (document.getElementById('landingError') || {}).textContent, status: (document.getElementById('status') || {}).textContent, waitingMsg: (document.getElementById('waitingMsg') || {}).textContent, text: document.body.innerText.slice(0, 300) })`).catch((x) => String(x)); evidence.phoneJoinDiag = d; throw new Error(e.message + ' | phone page: ' + d); }
  evidence.phoneWaitingRoom = true; await sleep(800); shot('m1-waiting-room');
  assert.equal(await cdp.js(`document.getElementById('app').classList.contains('hidden')`), true, 'not in the room before admission');
  await host.page.click('#peopleBtn'); await host.page.getByRole('button', { name: 'Admit Phone Guest' }).click({ timeout: 30000 });
  await untilJs(cdp, `!document.getElementById('app').classList.contains('hidden')`); evidence.phoneAdmitted = true;
});
test('phone: audio and video flow in both directions (real RTP counters on the phone and on the host)', { skip }, async () => {
  await sleep(5000); const p = await phoneFlowing(cdp, 4000), hh = await h.flowing(host.page, 4000); evidence.phoneMedia = p.delta; evidence.hostSeesPhone = hh.delta; evidence.phonePeerConnections = p.pcs;
  assert.ok(p.delta.audioIn > 0 && p.delta.videoIn > 0 && p.delta.audioOut > 0 && p.delta.videoOut > 0, 'phone: audio and video in and out ' + JSON.stringify(p.delta)); assert.ok(p.delta.framesDecoded > 0 && p.delta.framesEncoded > 0, 'phone decodes and encodes video');
  assert.ok(hh.delta.audioIn > 0 && hh.delta.videoIn > 0, 'the host receives the phone\'s audio and video ' + JSON.stringify(hh.delta));
});
test('phone: microphone and camera controls, participant list and meeting controls fit and work on the 411 dp screen', { skip }, async () => {
  const fit = JSON.parse(await cdp.js(`JSON.stringify((() => { const ids = ['micBtn', 'camBtn', 'shareBtn', 'handBtn', 'peopleBtn', 'chatBtn', 'moreCtl', 'leaveBtn']; const out = {}; for (const id of ids) { const e = document.getElementById(id); if (!e) { out[id] = null; continue; } const r = e.getBoundingClientRect(); const vis = getComputedStyle(e).display !== 'none' && r.width > 0; out[id] = { visible: vis, inside: r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, w: Math.round(r.width), h: Math.round(r.height) }; } return { innerWidth, scrolls: document.documentElement.scrollWidth > innerWidth, controls: out }; })())`));
  evidence.phoneControls = fit; assert.equal(fit.scrolls, false, 'no horizontal scroll'); for (const id of ['micBtn', 'camBtn', 'peopleBtn', 'leaveBtn']) assert.ok(fit.controls[id] && fit.controls[id].visible, id + ' is visible');
  const hidden = Object.entries(fit.controls).filter(([, v]) => v && v.visible && !v.inside).map(([k]) => k); evidence.controlsOutsideScreen = hidden;
  const mic0 = await cdp.js(`document.getElementById('micBtn').getAttribute('aria-pressed')`); await cdp.js(`document.getElementById('micBtn').click(); true`); await sleep(800); const mic1 = await cdp.js(`document.getElementById('micBtn').getAttribute('aria-pressed')`); assert.notEqual(mic0, mic1, 'the microphone control toggles'); await cdp.js(`document.getElementById('micBtn').click(); true`);
  const cam0 = await cdp.js(`document.getElementById('camBtn').getAttribute('aria-pressed')`); await cdp.js(`document.getElementById('camBtn').click(); true`); await sleep(1500); const cam1 = await cdp.js(`document.getElementById('camBtn').getAttribute('aria-pressed')`); assert.notEqual(cam0, cam1, 'the camera control toggles');
  evidence.toggles = { mic: [mic0, mic1], camera: [cam0, cam1] };
  await cdp.js(`document.getElementById('peopleBtn').click(); true`); await sleep(1000); const people = await cdp.js(`document.getElementById('peopleList').innerText`); assert.match(people, /Host Hana/); assert.match(people, /Phone Guest/); evidence.phoneParticipants = people.split('\n').filter(Boolean).slice(0, 6);
  const camOffNow = await cdp.js(`document.getElementById('camBtn').getAttribute('aria-pressed')`); evidence.cameraStateWhenPhotographed = camOffNow;
  // the camera is OFF here (toggled above): safe to photograph the room with the participant list
  await sleep(500); shot('m2-room-camera-off-people');
  await cdp.js(`document.getElementById('camBtn').click(); true`); await sleep(1500);
});
// a desktop participant joins through Meet's own landing page; returns { ctx, page }
async function desktopGuest(name) { const ctx = await hostB.newContext({ ...h.ctxPermissions(), baseURL: BASE }); const page = await ctx.newPage(); await page.goto('/meet/'); await page.fill('#displayName', name); await page.fill('#meetingId', meeting.id); await page.click('#joinBtn'); await page.waitForSelector('#waiting:not(.hidden)', { timeout: 30000 }); return { ctx, page }; }
const openPeople = async () => { if (!(await host.page.locator('#peopleList').isVisible().catch(() => false))) await host.page.click('#peopleBtn'); };
const phonePeople = async () => (await cdp.js(`document.getElementById('peopleList').innerText`)).split(String.fromCharCode(10)).map((x) => x.trim()).filter(Boolean);
test('phone: participant management - an admitted participant appears in the list on the phone and leaves it again; a denied one never appears', { skip }, async () => {
  const dana = await desktopGuest('Guest Dana'); await openPeople(); await host.page.getByRole('button', { name: 'Admit Guest Dana' }).click({ timeout: 30000 });
  await untilJs(cdp, `document.getElementById('peopleList').innerText.includes('Guest Dana')`); evidence.phoneSeesAdmitted = await phonePeople();
  await dana.page.click('#leaveBtn').catch(() => {}); await dana.ctx.close(); await untilJs(cdp, `!document.getElementById('peopleList').innerText.includes('Guest Dana')`); evidence.phoneSeesLeft = await phonePeople();
  const eve = await desktopGuest('Guest Eve'); await openPeople(); await host.page.getByRole('button', { name: 'Deny Guest Eve' }).click({ timeout: 30000 }); await sleep(3000);
  const seen = (await phonePeople()).join('|'); evidence.phoneAfterDeny = seen; assert.ok(!seen.includes('Guest Eve'), 'a denied participant never appears on the phone: ' + seen); evidence.deniedGuestPageShows = (await eve.page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 160))); await eve.ctx.close();
});
test('phone: recording consent - the request from the host reaches the phone, the dialog fits the screen, and agreeing is recorded (no capture is started)', { skip }, async () => {
  await host.page.click('#recordBtn'); await host.page.fill('#rc_purpose', 'Phone consent check'); await host.page.fill('#rc_recipients', 'The team'); await host.page.selectOption('#rc_days', '30'); await host.page.fill('#rc_privacyContact', 'privacy@example.com'); await host.page.getByRole('button', { name: 'Send request' }).click();
  await untilJs(cdp, `!!document.getElementById('rcModal')`); const m = JSON.parse(await cdp.js(`JSON.stringify((() => { const d = document.getElementById('rcModal'); const r = d.getBoundingClientRect(); const agree = [...d.querySelectorAll('button')].find((b) => /^agree$/i.test(b.textContent.trim())); const a = agree && agree.getBoundingClientRect(); return { text: d.innerText.replace(/\\s+/g, ' ').slice(0, 260), fits: r.left >= 0 && r.right <= innerWidth + 1, agreeInside: !!a && a.bottom <= innerHeight + 1 && a.right <= innerWidth + 1, agreeH: a ? Math.round(a.height) : 0, boxes: ['rcVideo', 'rcAudio', 'rcReviewed'].map((id) => !!d.querySelector('#' + id)) }; })())`)); evidence.phoneConsentDialog = m;
  assert.deepEqual(m.boxes, [true, true, true], 'the consent choices are shown on the phone'); assert.match(m.text, /record/i); assert.equal(m.fits, true, 'the dialog fits the width'); assert.equal(m.agreeInside, true, 'the Agree button is reachable on screen');
  await cdp.js(`(() => { const d = document.getElementById('rcModal'); for (const id of ['rcVideo', 'rcAudio', 'rcReviewed']) { const c = d.querySelector('#' + id); if (!c.checked) c.click(); } [...d.querySelectorAll('button')].find((b) => /^agree$/i.test(b.textContent.trim())).click(); return true; })()`);
  await untilJs(cdp, `!document.getElementById('rcModal')`); let status = ''; for (let i = 0; i < 15 && status !== 'ready'; i += 1) { await sleep(1500); const r = await host.ctx.request.get(BASE + "/meet/api/v1/meetings/" + meeting.id + '/recording', { headers: { Authorization: 'Bearer ' + hostToken } }); status = ((await r.json().catch(() => ({}))) || {}).status; }
  evidence.recordingStatusAfterPhoneAgreed = status; assert.equal(status, 'ready', 'with everyone consenting the recording is ready to start'); assert.equal(evidence.recordingStatusAfterPhoneAgreed, 'ready');
  // the consent request stays pending (ready, not started) until the meeting ends; the host's page is left with no dialog open
});
test('phone: a network outage and return - media flows again', { skip }, async () => {
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await sleep(7000); await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  let ok = false, last = null; for (let i = 0; i < 12 && !ok; i += 1) { await sleep(3000); try { last = await phoneFlowing(cdp, 3000); ok = last.delta.audioIn > 0 && last.delta.videoIn > 0; } catch { /* reconnecting */ } }
  evidence.phoneReconnect = last ? { ok, delta: last.delta } : { ok: false }; assert.ok(ok, 'media flows again on the phone: ' + JSON.stringify(last && last.delta));
  const log = await cdp.js(`JSON.stringify((window.__qlog || []).filter((e) => /^(connection|ice)#/.test(e[1])).map((e) => e[1] + ':' + e[2]).slice(-12))`); evidence.phoneConnectionLog = JSON.parse(log);
});
test('phone: with the camera permission revoked, Meet still opens and says the camera is unavailable (the permission is restored afterwards)', { skip }, async () => {
  cdp.close(); adb('shell', 'pm revoke ' + PKG + ' android.permission.CAMERA'); await sleep(1500);
  try {
    await launch(); await tapGuest(); const c2 = new Cdp(); await c2.open(); g2 = c2;
    await c2.js(`location.href = '/meet/'; true`).catch(() => {}); await untilJs(c2, `!!document.getElementById('joinBtn')`);
    await c2.js(`(() => { document.getElementById('displayName').value = 'Phone Guest 2'; document.getElementById('meetingId').value = ${JSON.stringify(meeting.id)}; document.getElementById('joinBtn').click(); return true; })()`);
    await untilJs(c2, `!!document.getElementById('waiting') && !document.getElementById('waiting').classList.contains('hidden')`); const admit2 = host.page.getByRole('button', { name: 'Admit Phone Guest 2' }); if (!(await admit2.isVisible().catch(() => false))) await host.page.click('#peopleBtn'); await admit2.click({ timeout: 30000 });   // the panel may already be open from the first test
    await untilJs(c2, `!document.getElementById('app').classList.contains('hidden')`);
    // With the camera permission revoked, Android asks the person. Answer it like a person would: Don't allow.
    let asked = false; for (let i = 0; i < 12 && !asked; i += 1) { const n = dump(); const deny = n.find((x) => /permission_deny|deny_button/i.test(x['resource-id'] || '') || /^(Don.t allow|Deny)$/i.test(x.text || '')); if (deny) { asked = true; evidence.androidPermissionDialog = { package: deny.package, text: (n.find((x) => /permission_message/i.test(x['resource-id'] || '')) || {}).text || '' }; adb('shell', 'input tap ' + Math.round((deny.l + deny.r) / 2) + ' ' + Math.round((deny.t + deny.b) / 2)); } else await sleep(1000); }
    evidence.androidAskedForCamera = asked; await sleep(4000);
    const s = JSON.parse(await c2.js(`JSON.stringify({ toast: (document.getElementById('toast') || {}).textContent || '', status: (document.getElementById('status') || {}).textContent || '' })`)); evidence.phoneCameraRevoked = s;
    assert.match(JSON.stringify(s), /camera|microphone|media|permission|unavailable/i, 'the person is told: ' + JSON.stringify(s));
  } finally { adb('shell', 'pm grant ' + PKG + ' android.permission.CAMERA'); }
});
test('phone: the host ends the meeting and the phone leaves the room', { skip }, async () => {
  await host.page.click('#endBtn'); await host.page.locator('#rcModal').getByRole('button', { name: 'End for all' }).click({ timeout: 15000 });
  const c = g2; await untilJs(c, `document.getElementById('app').classList.contains('hidden')`, 40000); evidence.phoneRemovedWhenEnded = true;
});
