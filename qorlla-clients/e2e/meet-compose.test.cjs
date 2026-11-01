'use strict';
// Qorlla Meet on the ISOLATED compose stack (nginx + main + Workplace Portal + Meet + databases), two real browsers with synthetic camera and microphone:
// waiting room and admission, audio and video in both directions (real RTP counters from getStats), participant list, controls, reconnection, a denied camera, and the host ending the meeting.
// Needs the stack up (`docker compose -p qiso ... up -d`, see deploy/docker-compose.isolated.yml). ISO_BASE defaults to http://localhost:3600. Nothing here touches any other stack.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const h = require('./harness.cjs');
const { chromium } = h;

const BASE = process.env.ISO_BASE || 'http://localhost:3600', skip = process.env.ISO_BASE_OFF ? 'ISO_BASE_OFF is set' : false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (ctx, p, o = {}) => ctx.request.fetch(BASE + p, { ...o, headers: { 'Content-Type': 'application/json', Origin: BASE, ...(o.headers || {}) }, data: o.data === undefined ? undefined : JSON.stringify(o.data) });
const roomUp = (page) => page.waitForFunction(() => document.querySelector('#app') && !document.querySelector('#app').classList.contains('hidden'), null, { timeout: 45000 });
const evidence = {};
async function browser2join() { const g = await newBrowser(); try { await g.page.goto('/meet/'); await g.page.fill('#displayName', 'Late Lou'); await g.page.fill('#meetingId', meeting.id); await g.page.click('#joinBtn'); await sleep(3000); return (await g.page.locator('#landingError').innerText().catch(() => '')) || (await g.page.evaluate(() => document.querySelector('#waiting') && !document.querySelector('#waiting').classList.contains('hidden') ? 'waiting' : 'in-room')); } finally { await g.browser.close(); } }
let hostBrowser, guestBrowser, host, guest, meeting;

async function newBrowser(args = h.FAKE_MEDIA, ctxOpts = h.ctxPermissions()) {
  const browser = await chromium.launch({ args }); const context = await browser.newContext({ ...ctxOpts, baseURL: BASE }); await context.addInitScript(h.RTC_HOOK); return { browser, context, page: await context.newPage() };
}
test.before(async () => {
  if (skip) return; host = await newBrowser(); hostBrowser = host.browser;
  // Meet's own landing page at /meet/ (through the one proxy origin): the host creates a meeting, then turns the waiting room on with Meet's settings API (host token only).
  await host.page.goto('/meet/'); await host.page.fill('#displayName', 'Host Hana'); await host.page.fill('#meetingTitle', 'Compose stack meeting');
  const [resp] = await Promise.all([host.page.waitForResponse((r) => /\/api\/meetings$/.test(r.url()) && r.request().method() === 'POST'), host.page.click('#createBtn')]); const created = await resp.json(); await roomUp(host.page);
  const set = await host.context.request.patch(BASE + '/meet/api/meetings/' + created.meetingId + '/settings', { headers: { Authorization: 'Bearer ' + created.token, 'Content-Type': 'application/json' }, data: JSON.stringify({ waitingRoom: true }) }); assert.equal(set.status(), 200, 'the host turns the waiting room on');
  meeting = { id: created.meetingId };
  assert.match(meeting.id, /^[0-9a-f-]{36}$/); evidence.meetOrigin = new URL(host.page.url()).origin + '/meet/'; evidence.waitingRoomOn = true;
});
test.after(async () => { for (const b of [hostBrowser, guestBrowser]) try { await b.close(); } catch { /* closed */ } console.log('# evidence ' + JSON.stringify(evidence)); });

test('a guest follows the invitation, waits in the waiting room, and the host admits them', { skip }, async () => {
  guest = await newBrowser(); guestBrowser = guest.browser;
  await guest.page.goto('/meet/'); await guest.page.fill('#displayName', 'Guest Gil'); await guest.page.fill('#meetingId', meeting.id); await guest.page.click('#joinBtn');
  await guest.page.waitForSelector('#waiting:not(.hidden)', { timeout: 30000 });
  evidence.waitingRoomShown = true; assert.equal(await guest.page.evaluate(() => document.querySelector('#app').classList.contains('hidden')), true, 'the guest is NOT in the room yet');
  await host.page.click('#peopleBtn'); await host.page.getByRole('button', { name: 'Admit Guest Gil' }).click({ timeout: 30000 });
  await roomUp(guest.page); evidence.admitted = true;
});
test('audio and video flow in both directions between the two participants (real RTP counters)', { skip }, async () => {
  await sleep(4000); const g = await h.flowing(guest.page, 4000), hh = await h.flowing(host.page, 4000);
  evidence.guestMedia = g.delta; evidence.hostMedia = hh.delta; evidence.paths = [...(g.after.pairs || []), ...(hh.after.pairs || [])].map((p) => p.local + '>' + p.remote + '/' + p.protocol);
  assert.ok(g.delta.audioIn > 0 && g.delta.videoIn > 0 && g.delta.audioOut > 0 && g.delta.videoOut > 0, 'guest: audio and video in and out ' + JSON.stringify(g.delta));
  assert.ok(hh.delta.audioIn > 0 && hh.delta.videoIn > 0 && hh.delta.audioOut > 0 && hh.delta.videoOut > 0, 'host: audio and video in and out ' + JSON.stringify(hh.delta));
  assert.ok(g.delta.framesDecoded > 0 && hh.delta.framesDecoded > 0, 'video frames are being decoded on both sides');
});
test('the participant list names both people on both sides, and the meeting controls work', { skip }, async () => {
  await guest.page.click('#peopleBtn'); for (const p of [host.page, guest.page]) { const t = await p.locator('#peopleList').innerText(); assert.match(t, /Host Hana/); assert.match(t, /Guest Gil/); }
  evidence.participants = (await host.page.locator('#peopleList').innerText()).split('\n').filter(Boolean).slice(0, 6);
  for (const id of ['#micBtn', '#camBtn']) { const before = await guest.page.getAttribute(id, 'aria-pressed'); await guest.page.click(id); await sleep(500); const after = await guest.page.getAttribute(id, 'aria-pressed'); assert.notEqual(before, after, id + ' toggles'); await guest.page.click(id); await sleep(300); }
  for (const id of ['#micBtn', '#camBtn', '#shareBtn', '#handBtn', '#peopleBtn', '#chatBtn', '#leaveBtn']) assert.equal(await guest.page.locator(id).count(), 1, id + ' exists');
  await guest.page.click('#chatBtn'); await guest.page.fill('#chatText', 'hello from the guest'); await guest.page.press('#chatText', 'Enter'); await host.page.click('#chatBtn');
  await host.page.waitForFunction(() => /hello from the guest/.test(document.querySelector('#messages').innerText), null, { timeout: 15000 }); evidence.chat = 'delivered';
});
test('reconnection: the guest loses the network for a few seconds and media flows again', { skip }, async () => {
  await guest.context.setOffline(true); await sleep(6000); await guest.context.setOffline(false);
  let ok = false, last = null; for (let i = 0; i < 12 && !ok; i += 1) { await sleep(3000); try { last = await h.flowing(guest.page, 3000); ok = last.delta.audioIn > 0 && last.delta.videoIn > 0; } catch { /* page is reconnecting */ } }
  evidence.reconnect = last ? { ok, delta: last.delta } : { ok: false }; assert.ok(ok, 'media flows again after the network returns: ' + JSON.stringify(last && last.delta));
});
test('permission handling: a guest whose camera is denied still gets into the room, and is told', { skip }, async () => {
  const g2 = await newBrowser(['--use-fake-device-for-media-stream'], { permissions: [] });
  try {
    await g2.context.grantPermissions(['microphone']); await g2.page.goto('/meet/'); await g2.page.fill('#displayName', 'Guest Dana'); await g2.page.fill('#meetingId', meeting.id); await g2.page.click('#joinBtn');
    await g2.page.waitForSelector('#waiting:not(.hidden)', { timeout: 30000 });
    await host.page.click('#peopleBtn'); await host.page.getByRole('button', { name: 'Admit Guest Dana' }).click({ timeout: 30000 }); await roomUp(g2.page); await sleep(3000);
    const state = await g2.page.evaluate(() => ({ cam: document.querySelector('#camBtn').getAttribute('aria-pressed'), toast: (document.querySelector('#toast') || {}).textContent || '', status: (document.querySelector('#status') || {}).textContent || '', announcer: (document.querySelector('#announcer') || {}).textContent || '' }));
    evidence.deniedCamera = state; assert.ok(await g2.page.locator('#app:not(.hidden)').count(), 'the room is open'); assert.match(JSON.stringify(state), /camera|permission|denied|blocked|unavailable|off/i, 'the person is told about the camera: ' + JSON.stringify(state));
  } finally { await g2.browser.close(); }
});
test('termination: the host ends the meeting for everyone, the guest is removed, and the meeting cannot be joined again', { skip }, async () => {
  await host.page.click('#endBtn'); await host.page.locator('#rcModal').getByRole('button', { name: 'End for all' }).click({ timeout: 15000 });
  await guest.page.waitForFunction(() => document.querySelector('#app').classList.contains('hidden'), null, { timeout: 30000 }); evidence.guestRemoved = true;
  const late = await browser2join(); evidence.joinAfterEnd = late; assert.ok(late && late !== 'waiting' && late !== 'in-room', 'an ended meeting cannot be joined again: ' + JSON.stringify(late));
});
