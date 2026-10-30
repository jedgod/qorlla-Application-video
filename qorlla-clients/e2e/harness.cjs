'use strict';
// Shared harness for the installable-client meeting tests. Everything is REAL: the Workplace server (MAIN), the running Qorlla Meet on :3310 and its PostgreSQL, a Chromium host, and the client under test.
// Media proof = real RTP byte counters read from the participants' own RTCPeerConnections (getStats) across two samples; nothing is stubbed.
const path = require('node:path');
const { chromium } = require(path.resolve(__dirname, '..', '..', 'node_modules', 'playwright'));
const { MEET, startMain, organiser } = require(path.resolve(__dirname, '..', '..', 'tests', 'support', 'meet-stack'));

/** Runs before any page script: records every RTCPeerConnection the page creates so the test can read its statistics. */
const RTC_HOOK = `(() => { const O = window.RTCPeerConnection; if (!O || window.__qpcs) return; window.__qpcs = [];
  const W = function (...a) { const pc = new O(...a); window.__qpcs.push(pc); return pc; }; W.prototype = O.prototype; Object.setPrototypeOf(W, O); window.RTCPeerConnection = W; })();`;
/** Evaluated in the page: totals of RTP bytes/frames over all peer connections, plus the nominated candidate pairs (so the path is on record). */
const COLLECT = `(async () => { const o = { pcs: 0, connected: 0, audioIn: 0, videoIn: 0, audioOut: 0, videoOut: 0, framesDecoded: 0, framesEncoded: 0, pairs: [] };
  for (const pc of window.__qpcs || []) { o.pcs++; if (pc.connectionState === 'connected') o.connected++; const rep = await pc.getStats(); const by = {}; rep.forEach((s) => { by[s.id] = s; });
    rep.forEach((s) => { if (s.type === 'inbound-rtp') { if (s.kind === 'audio') o.audioIn += s.bytesReceived || 0; else { o.videoIn += s.bytesReceived || 0; o.framesDecoded += s.framesDecoded || 0; } }
      if (s.type === 'outbound-rtp') { if (s.kind === 'audio') o.audioOut += s.bytesSent || 0; else { o.videoOut += s.bytesSent || 0; o.framesEncoded += s.framesEncoded || 0; } }
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') { const l = by[s.localCandidateId] || {}, r = by[s.remoteCandidateId] || {}; o.pairs.push({ local: l.candidateType, remote: r.candidateType, protocol: l.protocol }); } }); }
  return o; })()`;
const FAKE_MEDIA = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sample(page) { return page.evaluate(COLLECT); }
/** Two samples `ms` apart: every media counter must have grown, in both directions. */
async function flowing(page, ms = 3000) {
  const a = await sample(page); await sleep(ms); const b = await sample(page);
  const d = (k) => b[k] - a[k];
  return { before: a, after: b, delta: { audioIn: d('audioIn'), videoIn: d('videoIn'), audioOut: d('audioOut'), videoOut: d('videoOut'), framesDecoded: d('framesDecoded'), framesEncoded: d('framesEncoded') }, ok: d('audioIn') > 0 && d('videoIn') > 0 && d('audioOut') > 0 && d('videoOut') > 0 && b.connected > 0 };
}
/** A Chromium host (a signed-in organiser) starts a scheduled meeting through the real Workplace UI, waiting room off. Returns what a participant needs to join. */
async function startHost(main, { title = 'Client certification' } = {}) {
  const browser = await chromium.launch({ args: FAKE_MEDIA }); const context = await browser.newContext({ permissions: ['camera', 'microphone'] }); await context.addInitScript(RTC_HOOK);
  const { item } = await organiser(context, main.base, { title }); const page = await context.newPage();
  await page.goto(main.base + '/qorlla.html#home'); await page.locator('.meeting', { hasText: title }).locator('.join-pill').click();
  await page.waitForFunction(() => document.querySelector('#sdPassNote') && document.querySelector('#sdPassNote').textContent !== 'Checking…'); await page.click('#sdWait'); await page.click('#sdGo');
  await page.waitForURL(/localhost:3310/); await page.waitForFunction(() => !document.querySelector('#app').classList.contains('hidden'), null, { timeout: 30000 });
  const digits = String(item.meetingId).replace(/\D/g, ''); if (!/^[0-9]{11}$/.test(digits)) throw new Error('unexpected meeting id format: ' + item.meetingId);
  return { browser, context, page, meetingId: digits, displayId: item.meetingId, close: () => browser.close() };
}
/** Drives the guest pre-join form that the client under test is showing (same page for every client), then waits until the Meet room is up. */
async function joinAsGuest(page, name) {
  await page.waitForSelector('#pjName'); await page.fill('#pjName', name); await page.click('#pjGo');
  await page.waitForURL(/localhost:3310/, { timeout: 30000 }); await page.waitForFunction(() => !document.querySelector('#app').classList.contains('hidden'), null, { timeout: 30000 });
}
module.exports = { MEET, startMain, startHost, joinAsGuest, flowing, sample, sleep, RTC_HOOK, FAKE_MEDIA, chromium };
