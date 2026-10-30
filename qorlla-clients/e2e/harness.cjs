'use strict';
// Shared harness for the installable-client meeting tests. Everything is REAL: the Workplace server (MAIN), the running Qorlla Meet on :3310 and its PostgreSQL, a Chromium host, and the client under test.
// Media proof = real RTP byte counters read from the participants' own RTCPeerConnections (getStats) across two samples; nothing is stubbed.
const path = require('node:path');
const { chromium } = require(path.resolve(__dirname, '..', '..', 'node_modules', 'playwright'));
const { MEET, startMain, organiser } = require(path.resolve(__dirname, '..', '..', 'tests', 'support', 'meet-stack'));

/** Runs before any page script: records every RTCPeerConnection the page creates so the test can read its statistics. */
const RTC_HOOK = `(() => { const O = window.RTCPeerConnection; if (!O || window.__qpcs) return; window.__qpcs = []; window.__qlog = [];
  const W = function (...a) { try { const c = a[0] || {}; (window.__qcfg = window.__qcfg || []).push({ policy: c.iceTransportPolicy || 'all', servers: (c.iceServers || []).map((x) => ({ urls: [].concat(x.urls).map((u) => String(u).split('?')[0]), expires: x.username ? String(x.username).split(':')[0] : null, hasCredential: !!x.credential })) }); } catch (e) { /* never break the page */ } const pc = new O(...a); const n = window.__qpcs.push(pc); window.__qlog.push([Date.now(), 'created', n]);
    pc.addEventListener('connectionstatechange', () => window.__qlog.push([Date.now(), 'connection#' + n, pc.connectionState])); pc.addEventListener('iceconnectionstatechange', () => window.__qlog.push([Date.now(), 'ice#' + n, pc.iceConnectionState])); pc.addEventListener('icecandidateerror', (e) => window.__qlog.push([Date.now(), 'ice-error#' + n, String(e.errorCode) + ' ' + String(e.url || '').split('?')[0]])); return pc; };
  W.prototype = O.prototype; Object.setPrototypeOf(W, O); window.RTCPeerConnection = W; })();`;
/** Evaluated in the page: totals of RTP bytes/frames over all peer connections, plus the nominated candidate pairs (so the path is on record). */
const COLLECT = `(async () => { const o = { pcs: 0, connected: 0, audioIn: 0, videoIn: 0, audioOut: 0, videoOut: 0, framesDecoded: 0, framesEncoded: 0, packetsLost: 0, packetsReceived: 0, jitterMsMax: 0, pairs: [] };
  for (const pc of window.__qpcs || []) { o.pcs++; if (pc.connectionState === 'connected') o.connected++; const rep = await pc.getStats(); const by = {}; rep.forEach((s) => { by[s.id] = s; });
    rep.forEach((s) => { if (s.type === 'inbound-rtp') { o.packetsLost += s.packetsLost || 0; o.packetsReceived += s.packetsReceived || 0; o.jitterMsMax = Math.max(o.jitterMsMax, Math.round((s.jitter || 0) * 1000)); if (s.kind === 'audio') o.audioIn += s.bytesReceived || 0; else { o.videoIn += s.bytesReceived || 0; o.framesDecoded += s.framesDecoded || 0; } }
      if (s.type === 'outbound-rtp') { if (s.kind === 'audio') o.audioOut += s.bytesSent || 0; else { o.videoOut += s.bytesSent || 0; o.framesEncoded += s.framesEncoded || 0; } }
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') { const l = by[s.localCandidateId] || {}, r = by[s.remoteCandidateId] || {}; o.pairs.push({ local: l.candidateType, remote: r.candidateType, protocol: l.protocol, relayProtocol: l.relayProtocol, rttMs: s.currentRoundTripTime === undefined ? null : Math.round(s.currentRoundTripTime * 1000) }); } }); }
  return o; })()`;
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c);
const MEET_RE = new RegExp(escapeRe(MEET.replace(/^https?:\/\//, '')));   // matches the Meet host:port wherever it runs
const FAKE_MEDIA = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
/** Playwright context permissions for camera/microphone. QORLLA_TEST_NO_CTX_PERMISSIONS=1 omits them (the fake-media flags already auto-accept the prompt): with the grant, Chromium enumerates every network interface and a LOOPBACK relay yields no candidates, so loopback relay tests need this off. */
const ctxPermissions = () => (process.env.QORLLA_TEST_NO_CTX_PERMISSIONS === '1' ? {} : { permissions: ['camera', 'microphone'] });
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
  const browser = await chromium.launch({ args: FAKE_MEDIA }); const context = await browser.newContext(ctxPermissions()); await context.addInitScript(RTC_HOOK);
  const { item } = await organiser(context, main.base, { title }); const page = await context.newPage();
  await page.goto(main.base + '/qorlla.html#home'); await page.locator('.meeting', { hasText: title }).locator('.join-pill').click();
  await page.waitForFunction(() => document.querySelector('#sdPassNote') && document.querySelector('#sdPassNote').textContent !== 'Checking…'); await page.click('#sdWait'); await page.click('#sdGo');
  await page.waitForURL(MEET_RE); await page.waitForFunction(() => !document.querySelector('#app').classList.contains('hidden'), null, { timeout: 30000 });
  const digits = String(item.meetingId).replace(/\D/g, ''); if (!/^[0-9]{11}$/.test(digits)) throw new Error('unexpected meeting id format: ' + item.meetingId);
  return { browser, context, page, meetingId: digits, displayId: item.meetingId, close: () => browser.close() };
}
/** Drives the guest pre-join form that the client under test is showing (same page for every client), then waits until the Meet room is up. */
async function joinAsGuest(page, name) {
  await page.waitForSelector('#pjName'); await page.fill('#pjName', name); await page.click('#pjGo');
  await page.waitForURL(MEET_RE, { timeout: 30000 }); await page.waitForFunction(() => !document.querySelector('#app').classList.contains('hidden'), null, { timeout: 30000 });
}
/**
 * Long-meeting stability. Every `intervalS` seconds both participants' counters are read; an interval is GOOD when audio and video both flowed in BOTH directions on BOTH sides and a connection was up.
 * `extra()` adds client-specific resource readings (memory, battery). Connection-state history comes from the RTC hook's event log, so a drop that recovers between two samples is still seen.
 */
async function stability({ client, host, minutes, intervalS = 30, extra = async () => ({}), log = () => {} }) {
  const samples = [], t0 = Date.now(), end = t0 + minutes * 60000; let prev = { c: await sample(client), h: await sample(host) };
  while (Date.now() < end) {
    await sleep(Math.min(intervalS * 1000, Math.max(0, end - Date.now()))); const cur = { c: await sample(client), h: await sample(host) };
    const dl = (a, b) => ({ audioIn: b.audioIn - a.audioIn, videoIn: b.videoIn - a.videoIn, audioOut: b.audioOut - a.audioOut, videoOut: b.videoOut - a.videoOut, framesDecoded: b.framesDecoded - a.framesDecoded, framesEncoded: b.framesEncoded - a.framesEncoded });
    const c = dl(prev.c, cur.c), h = dl(prev.h, cur.h), flows = (x) => x.audioIn > 0 && x.audioOut > 0 && x.videoIn > 0 && x.videoOut > 0;
    const s = { tMin: +((Date.now() - t0) / 60000).toFixed(2), client: c, host: h, connected: [cur.c.connected, cur.h.connected], good: flows(c) && flows(h) && cur.c.connected > 0 && cur.h.connected > 0, extra: await extra() }; samples.push(s); log(s); prev = cur;
  }
  return { samples, clientEvents: await client.evaluate(() => window.__qlog || []), hostEvents: await host.evaluate(() => window.__qlog || []) };
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
/** The numbers the report quotes. `bad` = any connection or ICE state other than connected/completed/checking/new after the first connection. */
function summarize(r) {
  const states = (ev) => ev.filter((e) => /^(connection|ice)#/.test(e[1])).map((e) => e[2]), badStates = (ev) => states(ev).filter((x) => ['failed', 'disconnected', 'closed'].includes(x));
  const created = (ev) => ev.filter((e) => e[1] === 'created').length, good = r.samples.filter((s) => s.good).length;
  return { intervals: r.samples.length, goodIntervals: good, goodPercent: r.samples.length ? +(100 * good / r.samples.length).toFixed(1) : null,
    clientConnectionsCreated: created(r.clientEvents), hostConnectionsCreated: created(r.hostEvents), clientBadStates: badStates(r.clientEvents), hostBadStates: badStates(r.hostEvents),
    medianPerInterval: { clientVideoOut: median(r.samples.map((s) => s.client.videoOut)), clientVideoIn: median(r.samples.map((s) => s.client.videoIn)), clientFramesEncoded: median(r.samples.map((s) => s.client.framesEncoded)), clientFramesDecoded: median(r.samples.map((s) => s.client.framesDecoded)) },
    lowestVideoOutInAnInterval: r.samples.length ? Math.min(...r.samples.map((s) => s.client.videoOut)) : null };
}
module.exports = { ctxPermissions, MEET, MEET_RE, startMain, startHost, joinAsGuest, flowing, sample, sleep, stability, summarize, RTC_HOOK, FAKE_MEDIA, chromium };
