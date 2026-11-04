import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dgram from 'node:dgram';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import pg from 'pg';
import { chromium, type Browser, type Page } from 'playwright-core';
import { SyntheticPhone } from './helpers/synthetic-phone.js';
import { sleep } from './support.js';

/**
 * A5 REAL-MEDIA INTEGRATION (isolated, local): the actual Meet server process on PostgreSQL, TWO/THREE real Chromium browsers (fake microphones playing KNOWN tones from WAV files), the A4 gateway as its OWN process, and a
 * synthetic SIP/SRTP phone. The gateway gets its restricted credential through Meet's real authorization flow (PIN -> approval -> media token -> verification credential); nothing is pre-minted.
 *   Chromium A speaks 1000 Hz, Chromium B 1500 Hz, the phone 440 Hz, and Chromium C (a DIFFERENT meeting) 2000 Hz. Audio is judged by decoded samples (Goertzel at the phone, an AnalyserNode in each browser); getStats() is
 *   supporting evidence for transport (ICE, DTLS, SRTP, codec) only.
 * What is NOT real here: the carrier and the telephone (a synthetic SIP phone), the Security Shield (provider mode has none: it is a separate required gate), readiness (a LAB-ONLY stub in the gateway runner), production PKI.
 * Needs: A5_E2E=1, MEET_SERVER_DIR (qorlla-meet-video of the A5 Meet branch), PHONE_JOIN_TEST_DATABASE_URL, and a Chromium installed for playwright-core.
 */
const MEET_DIR = process.env.MEET_SERVER_DIR, URL_ = process.env.PHONE_JOIN_TEST_DATABASE_URL;
const skip = process.env.A5_E2E !== '1' ? 'A5_E2E=1 is not set (heavy: real Chromium)' : !MEET_DIR || !fs.existsSync(path.join(MEET_DIR, 'server', 'index.js')) ? 'MEET_SERVER_DIR is not set' : !URL_ ? 'PHONE_JOIN_TEST_DATABASE_URL is not set' : false;
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', 'v4_7_recording_consent.sql', 'v4_8_collab.sql', 'v4_9_recording_storage.sql', 'v4_10_admission.sql', 'v4_11_history.sql', 'v4_12_limit.sql',
  'v4_13_phone.sql', 'v4_14_telephony.sql', 'v4_15_telephony_features.sql', 'v4_16_number_authority.sql', 'v4_17_shield_identity.sql', 'v4_18_billing_hold.sql', 'v4_19_ai_request.sql', 'v4_20_ai_consent_seq.sql', 'v4_21_handoffs.sql', 'v4_22_host_controls.sql', 'v4_24_phone_lifecycle.sql', 'v4_25_phone_verification_peer.sql'];
const HMAC = 'a5-e2e-hmac-secret-0123456789abcdef', SIP_USER = 'a5trunk', SIP_PASS = 'a5-trunk-' + crypto.randomBytes(6).toString('hex'), BRIDGE = crypto.randomBytes(24).toString('hex'), RUN = crypto.randomBytes(4).toString('hex');
const ROOT = path.join(import.meta.dirname, '..', '..');
let schema = '', admin: pg.Pool; const procs: ChildProcess[] = [], browsers: Browser[] = [], phones: SyntheticPhone[] = []; const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a5e2e-'));
const freePort = () => new Promise<number>((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const eventually = async (cond: () => boolean | Promise<boolean>, ms = 10000, step = 100) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(step); } return cond(); };

/** A mono 16-bit 48 kHz WAV of one sine tone, which Chromium's fake microphone loops. */
function wav(hz: number, seconds = 10): string {
  const rate = 48000, n = rate * seconds, buf = Buffer.alloc(44 + n * 2); buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * hz * i) / rate)), 44 + i * 2); const f = path.join(tmp, `tone${hz}.wav`); fs.writeFileSync(f, buf); return f;
}
const goertzel = (frames: Int16Array[], hz: number) => { if (!frames.length) return 0; const x = new Int16Array(frames.length * 160); frames.forEach((f, i) => x.set(f, i * 160)); const w = (2 * Math.PI * hz) / 8000, c = 2 * Math.cos(w); let a = 0, b = 0; for (const v of x) { const t = v / 32768 + c * a - b; b = a; a = t; } return (a * a + b * b - c * a * b) / ((x.length * x.length) / 4); };

/** How many UDP ports of the gateway's RTP range are currently held by SOMEONE (a bind probe): >0 while a call is up, 0 once it is over. */
const portsHeld = async (lo: number, hi: number) => { let held = 0; for (let p = lo; p <= hi; p += 2) held += await new Promise<number>((res) => { const sk = dgram.createSocket('udp4'); sk.once('error', () => { try { sk.close(); } catch { /* closed */ } res(1); }); sk.bind(p, '127.0.0.1', () => sk.close(() => res(0))); }); return held; };
const leftovers = () => { try { const out = process.platform === 'win32' ? execFileSync('wmic', ['process', 'where', "name='node.exe'", 'get', 'ProcessId,CommandLine', '/format:list'], { encoding: 'utf8' }) : execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }); return out.split(String.fromCharCode(10)).filter((l) => l.includes('--a5-test=' + RUN) && !l.includes('wmic') && !l.includes('ps -eo')); } catch { return []; } };
const evidence: Record<string, unknown> = {}; const saveEvidence = (name: string) => { const d = process.env.A5_EVIDENCE_DIR; if (d) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.json'), JSON.stringify(evidence, null, 2)); } };
const toneTimeline = (p: SyntheticPhone) => { const out: string[] = []; for (let i = 0; i + 10 <= p.received.length; i += 10) { const w = p.received.slice(i, i + 10); const c = goertzel(w, 880), e = goertzel(w, 330); if (c > 0.01) out.push(`${i * 20}ms:cue880`); else if (e > 0.01) out.push(`${i * 20}ms:error330`); } return out.join(' '); };
const REFS = [700, 1250, 1750, 2700, 3200];
/** Ratio of the energy at `hz` to the mean energy at frequencies that carry no tone in this test. >= 30 (15 dB) = present; < 6 = absent. */
const snr = (frames: Int16Array[], hz: number) => goertzel(frames, hz) / (REFS.reduce((a, r) => a + goertzel(frames, r), 0) / REFS.length + 1e-9);
/** A tone is ABSENT if its energy is below an absolute floor (about -60 dBFS) or not meaningfully above the noise. (A ratio of two near-zero numbers is not evidence.) */
const absent = (frames: Int16Array[], hz: number) => goertzel(frames, hz) < 1e-6 || snr(frames, hz) < 6;
test.before(async () => {
  if (skip) return; schema = 'e2e_' + Math.random().toString(36).slice(2, 8); admin = new pg.Pool({ connectionString: URL_ }); await admin.query('CREATE SCHEMA ' + schema);
  const c = await admin.connect(); try { await c.query('SET search_path=' + schema); for (const f of ORDER) await c.query(fs.readFileSync(path.join(MEET_DIR!, 'sql', f), 'utf8')); } finally { c.release(); }
});
test.afterEach(async () => { for (const p of phones.splice(0)) p.close(); for (const b of browsers.splice(0)) await b.close().catch(() => undefined); const ps = procs.splice(0); for (const p of ps) { try { p.kill(); } catch { /* gone */ } } await Promise.all(ps.map((p) => new Promise<void>((r) => { if (p.exitCode !== null || p.signalCode) return r(); p.once('exit', () => r()); setTimeout(r, 8000).unref?.(); })));
  await sleep(300); assert.deepEqual(leftovers(), [], 'no Meet or gateway process of this test survives it'); });
test.after(async () => { if (skip) return; await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function startMeet() {
  const port = await freePort(), { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }), store = fs.mkdtempSync(path.join(tmp, 'rec-'));
  const env = { ...process.env, PORT: String(port), DATABASE_URL: URL_ + (URL_!.includes('?') ? '&' : '?') + 'options=' + encodeURIComponent('-c search_path=' + schema), JWT_SECRET: crypto.randomBytes(32).toString('hex'), QORLLA_BRIDGE_SECRET: BRIDGE, RECOVERY_ESCROW_KEY: crypto.randomBytes(32).toString('base64'),
    RECORDING_MASTER_KEYS: JSON.stringify({ k1: crypto.randomBytes(32).toString('base64') }), RECORDING_ACTIVE_KEY_ID: 'k1', RECORDING_STORE_DIR: store, RECORDING_ADMIN_SECRET: 'x'.repeat(24), NODE_ENV: 'development', PHONE_SWEEP_MS: '500', PHONE_PROVIDER: 'test', PHONE_WEBHOOK_SECRET: HMAC,
    PHONE_PEER_SIGNING_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, PHONE_PEER_KID: 'p1', PHONE_MEDIA_TIMEOUT_MS: '40000', PHONE_MEDIA_STALE_MS: '15000' };
  const child = spawn(process.execPath, ['server/index.js', '--a5-test=' + RUN], { cwd: MEET_DIR!, env, stdio: ['ignore', 'pipe', 'pipe'] }); procs.push(child); let log = ''; child.stdout!.on('data', (d) => (log += d)); child.stderr!.on('data', (d) => (log += d));
  const base = 'http://127.0.0.1:' + port; for (let i = 0; i < 80; i++) { if (await fetch(base + '/api/ready').then((r) => r.ok).catch(() => false)) return { base, log: () => log }; await sleep(250); } throw new Error('Meet did not start: ' + log.slice(-500));
}
async function startGateway(meetBase: string, extraEnv: Record<string, string> = {}) {
  const env = { ...process.env, ...extraEnv, MEET_URL: meetBase, MEET_HMAC_SECRET: HMAC, SIP_USER, SIP_PASSWORD: SIP_PASS, GATEWAY_DATABASE_URL: URL_!, GATEWAY_PG_SCHEMA: 'gw_' + schema, A5_LAB_READINESS: '1', RTP_RANGE: '34000-34300', A5_LOG: '1' };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'a5-gateway-runner.mjs'), '--a5-test=' + RUN], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] }); procs.push(child); let log = '';
  child.stderr!.on('data', (d) => (log += d)); const info = await new Promise<{ sipPort: number }>((resolve, reject) => { let out = ''; const t = setTimeout(() => reject(new Error('gateway did not start: ' + log.slice(-500))), 20000); child.stdout!.on('data', (d) => { out += d; const m = /\{"ready":true[^\n]*\}/.exec(out); if (m) { clearTimeout(t); resolve(JSON.parse(m[0])); } }); child.on('exit', (c) => reject(new Error('gateway exited ' + c + ': ' + log.slice(-500)))); });
  return { child, sipPort: info.sipPort, log: () => log, kill: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
}

// Recorded in every page BEFORE the app runs: every RTCPeerConnection (so stats and audio can be read), and a way to make one report "failed"/restore it (the app's own recovery then runs for real).
const INIT = `(() => { const pcs = []; const Orig = window.RTCPeerConnection; window.RTCPeerConnection = function (...a) { const pc = new Orig(...a); const idx = pcs.push(pc) - 1; const log = (window.__tl = window.__tl || []); const t0 = performance.now(); const note = (what) => log.push([Math.round(performance.now()), idx, what]);
    const srd = pc.setRemoteDescription.bind(pc); pc.setRemoteDescription = (d) => { note('remote ' + (d && d.type) + ' ufrag=' + ((/a=ice-ufrag:([\x21-\x7e]+)/.exec((d && d.sdp) || '') || [])[1])); return srd(d); };
    const sld = pc.setLocalDescription.bind(pc); pc.setLocalDescription = (d) => { note('local ' + (d && d.type)); return sld(d); };
    pc.addEventListener('connectionstatechange', () => note('conn=' + pc.connectionState)); pc.addEventListener('iceconnectionstatechange', () => note('ice=' + pc.iceConnectionState)); void t0; return pc; }; window.RTCPeerConnection.prototype = Orig.prototype; window.__pcs = pcs; const tl = (window.__tl = window.__tl || []); const note0 = (what) => tl.push([Math.round(performance.now()), -1, what]);
  const OrigWS = window.WebSocket; const KINDS = ['participant-online', 'participant-offline', 'roster', 'signal'], SIG = ['offer', 'answer', 'candidate', 'restart', 'rebuild'];
  const kindOf = (d) => KINDS.find((k) => { const at = d.indexOf('"' + k + '"'); return at >= 0 && at < 14; }), sigOf = (d) => SIG.find((t) => d.indexOf('"type":"' + t + '"') >= 0) || '?';
  window.WebSocket = function (...a) { const ws = new OrigWS(...a); ws.addEventListener('message', (e) => { if (typeof e.data === 'string' && e.data.startsWith('42')) { const k = kindOf(e.data); if (k) note0('ws-in ' + k + (k === 'signal' ? ' ' + sigOf(e.data) : '') + (k === 'participant-online' ? ' ' + e.data.substr(e.data.indexOf('"participantId":"') + 17, 8) : '')); } });
    const send = ws.send.bind(ws); ws.send = (d) => { if (typeof d === 'string' && d.indexOf('"signal"') >= 0 && d.indexOf('"signal"') < 14) note0('ws-out signal ' + sigOf(d)); return send(d); }; return ws; }; Object.assign(window.WebSocket, OrigWS); window.WebSocket.prototype = OrigWS.prototype;
  new MutationObserver((muts) => { for (const mu of muts) for (const n of mu.addedNodes) if (n.id && String(n.id).startsWith('tile-')) note0('tile appeared ' + n.id.slice(0, 13)); }).observe(document, { childList: true, subtree: true });
  window.__force = (i, state) => { const pc = pcs[i]; Object.defineProperty(pc, 'connectionState', { configurable: true, get: () => state }); pc.dispatchEvent(new Event('connectionstatechange')); };
  window.__unforce = (i) => { const pc = pcs[i]; delete pc.connectionState; pc.dispatchEvent(new Event('connectionstatechange')); };
  window.__gatewayIndex = () => pcs.findIndex((pc) => pc.remoteDescription && /PCMU/.test(pc.remoteDescription.sdp) && !/opus/i.test(pc.remoteDescription.sdp) && pc.connectionState !== 'closed');
  window.__peerIndexes = () => pcs.map((pc, i) => ({ i, state: pc.connectionState, gateway: !!(pc.remoteDescription && /PCMU/.test(pc.remoteDescription.sdp) && !/opus/i.test(pc.remoteDescription.sdp)) }));
  window.__stats = async (i) => { const pc = pcs[i]; const out = { state: pc.connectionState, ice: pc.iceConnectionState }; const r = await pc.getStats(); r.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') { out.inPackets = s.packetsReceived; out.inBytes = s.bytesReceived; out.inLost = s.packetsLost; out.jitter = s.jitter; out.energy = s.totalAudioEnergy; out.codecId = s.codecId; } if (s.type === 'outbound-rtp' && s.kind === 'audio') { out.outPackets = s.packetsSent; } if (s.type === 'transport') { out.dtls = s.dtlsState; out.srtp = s.srtpCipher; out.dtlsCipher = s.dtlsCipher; out.selectedPairId = s.selectedCandidatePairId; } if (s.type === 'codec') { out.codecs = (out.codecs || []).concat(s.mimeType); } if (s.type === 'candidate-pair') { (out.pairs = out.pairs || {})[s.id] = s.state; } }); out.pair = out.pairs && out.selectedPairId ? out.pairs[out.selectedPairId] : undefined; return out; };
  window.__listen = async (i, ms) => { const pc = pcs[i]; const track = pc.getReceivers().map((r) => r.track).find((t) => t.kind === 'audio'); if (!track) return null; const ctx = new AudioContext(); await ctx.resume(); const stream = new MediaStream([track]); const el = new Audio(); el.muted = true; el.srcObject = stream; try { await el.play(); } catch (e) {}
    const src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser(); an.fftSize = 16384; src.connect(an); const bins = new Float32Array(an.frequencyBinCount), acc = new Float64Array(bins.length); let n = 0; const end = performance.now() + ms; while (performance.now() < end) { an.getFloatFrequencyData(bins); for (let k = 0; k < bins.length; k++) acc[k] += Math.pow(10, bins[k] / 10); n++; await new Promise((r) => setTimeout(r, 50)); }
    const hzPerBin = ctx.sampleRate / an.fftSize, level = (hz) => { const c = Math.round(hz / hzPerBin); let m = 0; for (let k = c - 3; k <= c + 3; k++) m = Math.max(m, acc[k] / n); return 10 * Math.log10(m + 1e-20); }; const noise = (() => { let s = 0, c = 0; for (let k = Math.round(3000 / hzPerBin); k < Math.round(3600 / hzPerBin); k++) { s += acc[k] / n; c++; } return 10 * Math.log10(s / c + 1e-20); })();
    const r = { samples: n, noise, levels: {} }; for (const hz of [440, 1000, 1500, 2000]) r.levels[hz] = level(hz); ctx.close(); return r; };
})();`;

async function chrome(hz: number): Promise<Browser> {
  const b = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wav(hz), '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection'] }); browsers.push(b); return b;
}
type Who = { page: Page; id: string; meetingId: string; code?: string; token: string; pid: string };
async function openMeeting(b: Browser, base: string, name: string, join?: string): Promise<Who> {
  const ctx = await b.newContext({ permissions: ['microphone', 'camera'] }); await ctx.addInitScript(INIT); const page = await ctx.newPage(); await page.goto(base + '/'); await page.fill('#displayName', name);
  const resp = page.waitForResponse((r) => /\/api\/meetings(\/[0-9a-f-]+\/join)?$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 20000 });
  if (join) { await page.fill('#meetingId', join); await page.click('#joinBtn'); } else await page.click('#createBtn');
  const j = await (await resp).json(); return { page, id: name, meetingId: j.meetingId, code: j.meetingCode, token: j.token, pid: j.participantId };
}
async function seedMeeting(base: string) {
  const id = crypto.randomUUID(), code = String(Math.floor(1e10 + Math.random() * 9e10)), source = 'sched_' + crypto.randomBytes(5).toString('hex');
  await admin.query(`INSERT INTO ${schema}.meetings(id,title,host_secret_hash,meeting_code) VALUES($1,'E2E','x',$2)`, [id, code]); await admin.query(`INSERT INTO ${schema}.external_meeting_links(source_system,source_id,meeting_id) VALUES('qorlla-main',$1,$2)`, [source, id]);
  return { id, code, source, makePin: async () => (await fetch(base + '/api/integrations/scheduled-meetings/' + source + '/phone-access', { method: 'POST', headers: { 'x-qorlla-bridge-secret': BRIDGE, 'content-type': 'application/json' }, body: '{}' })).json() as Promise<{ pin: string }> };
}
const connectedPeers = (p: Page) => p.evaluate(() => (window as any).__peerIndexes());
const dbCall = async (callId: string) => (await admin.query(`SELECT * FROM ${schema}.phone_calls WHERE provider_call_id=$1`, [callId])).rows[0];
const trail = async (id: string) => (await admin.query(`SELECT to_state FROM ${schema}.phone_call_events WHERE call_id=$1 ORDER BY id`, [id])).rows.map((r) => r.to_state);
const cred = async (callRef: string) => (await admin.query(`SELECT * FROM ${schema}.phone_peer_credentials WHERE call_id=$1`, [callRef])).rows[0];
const host = (base: string, token: string, mid: string, p: string, method = 'POST') => fetch(base + '/api/meetings/' + mid + p, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });

/** Dial in with the keypad exactly as a caller would: meeting number, then PIN#. Returns the phone once the INVITE is answered. */
async function dial(gw: { sipPort: number }, code: string, pin: string, hz = 440): Promise<SyntheticPhone> {
  const p = await SyntheticPhone.create({ gateway: { address: '127.0.0.1', port: gw.sipPort }, username: SIP_USER, password: SIP_PASS, number: '+12025550100' }); phones.push(p); const r = await p.invite(); assert.equal(r.status, 200, 'the gateway answered the INVITE');
  // A caller presses keys when the prompt invites it. The gateway plays a cue tone (880 Hz) at the start of EACH entry (meeting number, then PIN); the synthetic caller waits for it, like a person waiting for the prompt.
  const cue = async (from: number, what: string) => assert.ok(await eventually(() => goertzel(p.received.slice(Math.max(from, p.received.length - 12)), 880) > 0.01, 15000, 40), 'the gateway played its prompt tone for the ' + what);
  p.tone(hz); await cue(0, 'meeting number'); const mark = p.received.length; await p.digits(code); await cue(mark, 'PIN'); await p.digits(pin + '#'); return p;
}
const heard = (p: SyntheticPhone, n = 40) => p.received.slice(-n);

test('REAL CHROMIUM + GATEWAY PROCESS + MEET: admission through the real flow, ICE/DTLS/SRTP, A->phone, B->phone, phone->A and B, no self-audio, no cross-meeting leakage, promotion only after Meet validates, clean termination', { skip, timeout: 240000 }, async () => {
  // The meeting is seeded the way the main app creates one for dial-in: an 11-digit code plus an external link. (Meet's OWN UI makes 12-digit codes, which the dial-in contract does not cover: see the report.)
  const meet = await startMeet(), gw = await startGateway(meet.base), seeded = await seedMeeting(meet.base);
  const A = await openMeeting(await chrome(1000), meet.base, 'Alice', seeded.id), B = await openMeeting(await chrome(1500), meet.base, 'Bob', seeded.id), C = await openMeeting(await chrome(2000), meet.base, 'Carol-elsewhere'); A.code = seeded.code;
  assert.equal(A.meetingId, B.meetingId); assert.notEqual(A.meetingId, C.meetingId); await eventually(async () => (await connectedPeers(A.page)).some((x: any) => x.state === 'connected') && (await connectedPeers(B.page)).some((x: any) => x.state === 'connected'), 30000);
  const pinRes = await seeded.makePin(); assert.match(pinRes.pin, /^\d{8}$/, 'a phone PIN was created through the bridge route (as the main app does)'); const phone = await dial(gw, A.code!, pinRes.pin);
  const row = await eventually(async () => !!(await admin.query(`SELECT 1 FROM ${schema}.phone_calls WHERE state='MEDIA_CONNECTED'`)).rowCount, 60000);
  if (!row) { const calls = (await admin.query(`SELECT id, state, status, end_reason, media_verified_at, media_evidence FROM ${schema}.phone_calls`)).rows, ev = (await admin.query(`SELECT call_id, to_state, reason FROM ${schema}.phone_call_events ORDER BY id`)).rows, cr = (await admin.query(`SELECT call_id, consumed_at, promoted_at, revoked_at, revoked_reason FROM ${schema}.phone_peer_credentials`)).rows,
      mt = (await admin.query(`SELECT id, meeting_code, locked, lock_on_host_join, waiting_room, join_before_host, ended_at FROM ${schema}.meetings`)).rows, at = (await admin.query(`SELECT key, failures, locked_until FROM ${schema}.phone_attempts`)).rows, acc = (await admin.query(`SELECT meeting_id, revoked_at, length(pin_hash) AS pin_hash_len FROM ${schema}.meeting_phone_access`)).rows;
    assert.fail(['Meet did not promote the call.', 'calls: ' + JSON.stringify(calls), 'events: ' + JSON.stringify(ev), 'credentials: ' + JSON.stringify(cr), 'meetings: ' + JSON.stringify(mt) + ' (host meeting code ' + A.code + ')', 'attempts: ' + JSON.stringify(at), 'phone access: ' + JSON.stringify(acc), 'phone: received ' + phone.receivedPackets + ' packets, sip responses ' + phone.responses().map((r) => r.status).join(','), 'gateway log tail: ' + gw.log().slice(-1500), 'meet log tail: ' + meet.log().slice(-1200)].join(String.fromCharCode(10))); }
  assert.ok(row, 'Meet promoted the call');
  const call = (await admin.query(`SELECT * FROM ${schema}.phone_calls WHERE meeting_id=$1`, [A.meetingId])).rows[0]; assert.equal(call.state, 'MEDIA_CONNECTED'); assert.equal(call.status, 'connected');
  const heldDuring = await portsHeld(34000, 34300); assert.ok(heldDuring >= 1, 'the gateway holds an RTP port while the call is up (' + heldDuring + ')');
  // admission: credential issued through the real flow, consumed once, promoted, not revoked; the trail shows verification before promotion
  const k = await cred(call.id); assert.ok(k.consumed_at && k.promoted_at && !k.revoked_at, 'credential consumed and promoted'); assert.equal(k.subject, 'provider:test-double'); const t = await trail(call.id); assert.deepEqual(t.slice(-3), ['APPROVED', 'MEDIA_CONNECTING', 'MEDIA_CONNECTED'], t.join('>'));
  assert.ok(new Date(k.consumed_at).getTime() <= new Date(call.connected_at).getTime(), 'the credential was consumed BEFORE the call connected'); const ev = call.media_evidence; assert.equal(ev.codec, 'PCMU'); assert.equal(ev.encrypted, true); assert.ok(ev.inboundPackets >= 25 && ev.outboundPackets >= 25, JSON.stringify(ev));
  // negotiation: ICE, DTLS, SRTP, codec - from BOTH browsers' connection to the gateway
  const gwIdx = async (p: Page) => (await connectedPeers(p)).find((x: any) => x.gateway && x.state === 'connected')?.i as number; await eventually(async () => (await gwIdx(A.page)) !== undefined && (await gwIdx(B.page)) !== undefined, 30000);
  for (const w of [A, B]) { const i = await gwIdx(w.page), s = await w.page.evaluate((n) => (window as any).__stats(n), i); assert.equal(s.state, 'connected', w.id); assert.equal(s.dtls, 'connected', w.id + ' DTLS'); assert.ok(s.srtp, w.id + ' SRTP cipher: ' + s.srtp); assert.ok(s.codecs.some((c: string) => /PCMU/i.test(c)), w.id + ' codec ' + s.codecs); assert.equal(s.pair, 'succeeded', w.id + ' ICE pair'); }
  // audio, judged by DECODED samples. phone -> browsers (440 Hz) in both browsers; browsers -> phone (1000 and 1500 Hz) at the phone; nothing else
  const [la, lb] = await Promise.all([A, B].map(async (w) => w.page.evaluate(([n]) => (window as any).__listen(n, 2500), [await gwIdx(w.page)])));
  for (const [who, l] of [['Alice', la], ['Bob', lb]] as const) { assert.ok(l && l.samples > 20, who + ' listened'); assert.ok(l.levels[440] - l.noise > 25, `${who} hears the phone's 440 Hz (${l.levels[440].toFixed(1)} dB vs noise ${l.noise.toFixed(1)})`); assert.ok(l.levels[2000] - l.noise < 12, `${who} does not hear Carol's 2000 Hz from another meeting`); }
  await sleep(500); const tail = heard(phone, 60), lv = (hz: number) => `${snr(tail, hz).toFixed(1)}x (raw ${goertzel(tail, hz).toExponential(2)})`;
  assert.ok(snr(tail, 1000) >= 30, "the phone hears Alice's 1000 Hz: " + lv(1000)); assert.ok(snr(tail, 1500) >= 30, "the phone hears Bob's 1500 Hz: " + lv(1500)); assert.ok(absent(tail, 440), 'the phone does not hear its own 440 Hz: ' + lv(440));
  assert.ok(absent(tail, 2000), "the phone does not hear Carol's 2000 Hz (other meeting): " + lv(2000));
  const cp = await connectedPeers(C.page); assert.ok(!cp.some((x: any) => x.gateway), 'Carol (other meeting) never had a connection to the gateway'); const carolOwn = await C.page.evaluate(() => (window as any).__pcs.length); assert.equal(carolOwn, 0, 'Carol is alone in her meeting: no peer connections at all');
  Object.assign(evidence, { admission: { callState: call.state, trail: t, credential: { subject: k.subject, consumed_at: k.consumed_at, promoted_at: k.promoted_at, revoked_at: k.revoked_at }, connected_at: call.connected_at, metEvidence: ev }, rtpPortsHeldDuringCall: heldDuring,
    phoneHears: { snr1000: snr(tail, 1000), snr1500: snr(tail, 1500), raw440: goertzel(tail, 440), raw2000: goertzel(tail, 2000) }, browserHearsPhone: { alice: la, bob: lb } });
  // termination: the phone hangs up. The call ends everywhere, the credential is revoked, and the two browsers stay connected to EACH OTHER with audio still flowing
  const abBefore = await A.page.evaluate(async () => { const pcs = (window as any).__pcs; const i = pcs.findIndex((pc: any) => !(pc.remoteDescription && /PCMU/.test(pc.remoteDescription.sdp) && !/opus/i.test(pc.remoteDescription.sdp)) && pc.connectionState === 'connected'); return { i, s: await (window as any).__stats(i) }; });
  phone.bye(); await eventually(async () => (await admin.query(`SELECT state FROM ${schema}.phone_calls WHERE id=$1`, [call.id])).rows[0].state === 'TERMINATED', 20000); assert.equal((await dbCall(call.provider_call_id)).state, 'TERMINATED'); assert.ok((await cred(call.id)).revoked_at, 'credential revoked at termination');
  await eventually(async () => !(await connectedPeers(A.page)).some((x: any) => x.gateway && x.state === 'connected'), 20000); assert.ok(!(await connectedPeers(A.page)).some((x: any) => x.gateway && x.state === 'connected'), "Alice's connection to the gateway is gone"); await sleep(1500);
  const abAfter = await A.page.evaluate((i) => (window as any).__stats(i), abBefore.i); assert.equal(abAfter.state, 'connected', 'Alice and Bob are still connected to each other'); assert.ok(abAfter.inPackets > abBefore.s.inPackets + 20, 'and audio between them is still flowing');
  assert.ok(!/Error|ECONN|unhandled/i.test(meet.log().replace(/\[phone-peer\][^\n]*/g, '')), 'no errors in the Meet log: ' + meet.log().slice(-300)); let heldAfter = await portsHeld(34000, 34300); for (let n = 0; n < 20 && heldAfter > 0; n++) { await sleep(250); heldAfter = await portsHeld(34000, 34300); } assert.equal(heldAfter, 0, "the gateway released the call's RTP port after hang-up");
  Object.assign(evidence, { termination: { finalState: (await dbCall(call.provider_call_id)).state, credentialRevokedAt: (await cred(call.id)).revoked_at, rtpPortsHeldAfterHangup: heldAfter, aliceAndBobStillConnected: abAfter.state, abPacketsBefore: abBefore.s.inPackets, abPacketsAfter: abAfter.inPackets } }); saveEvidence('first-successful-call'); gw.kill();
});

// ================================================================================================ fault scenarios: each one starts its OWN stack, so a failure points at one cause
type Lab = Awaited<ReturnType<typeof lab>>;
async function lab() {
  const meet = await startMeet(), gw = await startGateway(meet.base), seeded = await seedMeeting(meet.base);
  const A = await openMeeting(await chrome(1000), meet.base, 'Alice', seeded.id), B = await openMeeting(await chrome(1500), meet.base, 'Bob', seeded.id); A.code = seeded.code;
  await eventually(async () => (await connectedPeers(A.page)).some((x: any) => x.state === 'connected') && (await connectedPeers(B.page)).some((x: any) => x.state === 'connected'), 30000);
  const pin = (await seeded.makePin()).pin, phone = await dial(gw, seeded.code, pin);
  const ok = await eventually(async () => !!(await admin.query(`SELECT 1 FROM ${schema}.phone_calls WHERE meeting_id=$1 AND state='MEDIA_CONNECTED'`, [seeded.id])).rowCount, 60000);
  if (!ok) { const calls = (await admin.query(`SELECT id, state, end_reason FROM ${schema}.phone_calls WHERE meeting_id=$1`, [seeded.id])).rows, ev = (await admin.query(`SELECT to_state, reason FROM ${schema}.phone_call_events ORDER BY id`)).rows, cr = (await admin.query(`SELECT consumed_at, promoted_at, revoked_at, revoked_reason FROM ${schema}.phone_peer_credentials`)).rows;
    assert.fail(['the call did not connect.', 'calls: ' + JSON.stringify(calls), 'events: ' + JSON.stringify(ev), 'credentials: ' + JSON.stringify(cr), 'phone: sip ' + phone.responses().map((r) => r.status).join(',') + ', received ' + phone.receivedPackets, 'phone tone timeline (what the gateway played): ' + toneTimeline(phone), 'digits the phone sent: ' + JSON.stringify(phone.digitLog.map((x) => x.d).join('')) + ' (' + phone.digitLog.length + ')', 'gateway log: ' + gw.log().slice(-2500), 'meet log: ' + meet.log().slice(-800), 'alice timeline: ' + JSON.stringify(await A.page.evaluate(() => (window as any).__tl))].join(String.fromCharCode(10))); }
  const call = (await admin.query(`SELECT * FROM ${schema}.phone_calls WHERE meeting_id=$1 ORDER BY created_at`, [seeded.id])).rows[0];
  const gwPc = async (p: Page) => (await connectedPeers(p)).find((x: any) => x.gateway && x.state === 'connected')?.i as number; await eventually(async () => (await gwPc(A.page)) !== undefined && (await gwPc(B.page)) !== undefined, 30000);
  // (A tile for the gateway appears as soon as its OFFER arrives, long before the phone is a participant, so a tile proves nothing: the readiness condition is the participant-online event itself.)
  for (const w of [A, B]) assert.ok(await eventually(() => w.page.evaluate((p8) => ((window as any).__tl || []).some((x: any) => x[2] === 'ws-in participant-online ' + p8), call.participant_id.slice(0, 8)), 20000), w.id + ' received participant-online for the phone (the app only recovers peers that are in its roster)');
  return { meet, gw, seeded, A, B, phone, pin, call, gwPc };
}
const callState = async (id: string) => (await admin.query(`SELECT state, end_reason FROM ${schema}.phone_calls WHERE id=$1`, [id])).rows[0];
const abStats = (L: Lab) => L.A.page.evaluate(async () => { const pcs = (window as any).__pcs; const i = pcs.findIndex((pc: any) => !(pc.remoteDescription && /PCMU/.test(pc.remoteDescription.sdp) && !/opus/i.test(pc.remoteDescription.sdp)) && pc.connectionState === 'connected'); return { i, s: await (window as any).__stats(i) }; });
const gatewayPcsGone = async (L: Lab) => !(await connectedPeers(L.A.page)).some((x: any) => x.gateway && x.state === 'connected') && !(await connectedPeers(L.B.page)).some((x: any) => x.gateway && x.state === 'connected');

test('FAULT 1 - real ICE restart: a browser that reports its gateway connection as failed triggers the APP own recovery; the gateway re-offers with NEW ICE credentials, the connection recovers, the call stays connected and audio keeps flowing both ways', { skip, timeout: 240000 }, async () => {
  const L = await lab(), i = await L.gwPc(L.A.page); const ufrag = () => L.A.page.evaluate((n) => /a=ice-ufrag:(\S+)/.exec((window as any).__pcs[n].remoteDescription.sdp)?.[1], i); const before = await ufrag(); assert.ok(before);
  await L.A.page.evaluate((n) => (window as any).__force(n, 'failed'), i);                                    // the app's connectionstatechange handler runs recoverPeer: it asks the offerer (the gateway) to restart ICE
  const changed = await eventually(async () => (await ufrag()) !== before, 20000); if (!changed) assert.fail('the gateway did not re-offer after the browser asked (ufrag still ' + before + '); browser timeline (ms, pc, event): ' + JSON.stringify(await L.A.page.evaluate(() => (window as any).__tl)) + ' | gateway log: ' + L.gw.log().slice(-2500) + ' | meet log: ' + L.meet.log().slice(-600));
  await L.A.page.evaluate((n) => (window as any).__unforce(n), i); assert.ok(await eventually(async () => (await L.A.page.evaluate((n) => (window as any).__pcs[n].connectionState, i)) === 'connected', 25000), 'the connection recovered');
  assert.equal((await callState(L.call.id)).state, 'MEDIA_CONNECTED', 'the call stayed connected through the restart');
  const tRestart = Date.now(), from = L.phone.received.length; let recoveredMs = -1; for (let n = 0; n < 60 && recoveredMs < 0; n++) { await sleep(500); if (snr(L.phone.received.slice(Math.max(from, L.phone.received.length - 40)), 1000) >= 30) recoveredMs = Date.now() - tRestart; }
  const tail = L.phone.received.slice(-60), listen = await L.A.page.evaluate((n) => (window as any).__listen(n, 2000), i);
  if (recoveredMs < 0) assert.fail('after the restart the phone NEVER heard Alice again within 30 s; timeline (ms, pc, event): ' + JSON.stringify(await L.A.page.evaluate(() => (window as any).__tl)) + ' | stats ' + JSON.stringify(await L.A.page.evaluate((n) => (window as any).__stats(n), i)) + ' | call ' + JSON.stringify(await callState(L.call.id)));
  assert.ok(snr(tail, 1000) >= 30, 'after the restart the phone still hears Alice (' + snr(tail, 1000).toFixed(1) + 'x)'); assert.ok(listen.levels[440] - listen.noise > 25, 'after the restart Alice still hears the phone (' + (listen.levels[440] - listen.noise).toFixed(1) + ' dB above noise)');
  evidence.iceRestart = { audioRecoveredMs: recoveredMs, ufragBefore: before, ufragAfter: await ufrag(), snr1000AfterRestart: snr(tail, 1000), aliceHearsPhoneDbAboveNoise: listen.levels[440] - listen.noise, callState: 'MEDIA_CONNECTED' }; saveEvidence('fault-1-ice-restart');
});

test('FAULT 2 - gateway process killed mid-call: Meet ends the call and revokes the credential, the browsers stay connected to EACH OTHER, the gateway pcs go away, and a restarted gateway admits a NEW call without duplicate participants or media legs', { skip, timeout: 280000 }, async () => {
  const L = await lab(), ab = await abStats(L); L.gw.kill();
  assert.ok(await eventually(async () => (await callState(L.call.id)).state === 'TERMINATED', 25000), 'Meet noticed the lost gateway and ended the call'); const st = await callState(L.call.id); assert.equal(st.end_reason, 'gateway_signaling_lost');
  const k = (await admin.query(`SELECT revoked_at, revoked_reason FROM ${schema}.phone_peer_credentials WHERE call_id=$1`, [L.call.id])).rows[0]; assert.ok(k.revoked_at, 'credential revoked: ' + k.revoked_reason);
  assert.ok(await eventually(() => gatewayPcsGone(L), 25000), 'the browsers connections to the dead gateway are gone'); await sleep(1500); const after = await L.A.page.evaluate((n) => (window as any).__stats(n), ab.i);
  assert.equal(after.state, 'connected', 'Alice and Bob remain connected to each other'); assert.ok(after.inPackets > ab.s.inPackets + 20, 'and audio between them keeps flowing');
  const orphan = (await admin.query(`SELECT call_id, state FROM gw_${schema}.phone_join_calls`)).rows; evidence.gatewayLedgerAfterKill = orphan;       // what the killed gateway left in ITS ledger (reported, not asserted: see the report)
  const gw2 = await startGateway(L.meet.base, { A5_REAPER: '1' }), phone2 = await dial(gw2, L.seeded.code, (await L.seeded.makePin()).pin); assert.ok(await eventually(async () => (await admin.query(`SELECT 1 FROM ${schema}.phone_calls WHERE meeting_id=$1 AND state='MEDIA_CONNECTED'`, [L.seeded.id])).rowCount === 1, 60000), 'a restarted gateway admitted a new call');
  const calls = (await admin.query(`SELECT id, state FROM ${schema}.phone_calls WHERE meeting_id=$1 ORDER BY created_at`, [L.seeded.id])).rows; assert.deepEqual(calls.map((c: any) => c.state), ['TERMINATED', 'MEDIA_CONNECTED']);
  const openSessions = async () => (await admin.query(`SELECT count(*)::int n FROM ${schema}.participant_sessions s JOIN ${schema}.participants p ON p.id=s.participant_id WHERE p.kind='phone' AND s.meeting_id=$1 AND s.disconnected_at IS NULL`, [L.seeded.id])).rows[0].n;
  assert.ok(await eventually(async () => (await openSessions()) === 1, 10000), 'the new caller is present (its session opens just after the state move)'); await sleep(1500); assert.equal(await openSessions(), 1, 'exactly one phone participant is present (no duplicate)');
  assert.ok(await eventually(async () => (await connectedPeers(L.A.page)).filter((x: any) => x.gateway && x.state === 'connected').length === 1, 30000), 'Alice has exactly one connection to a gateway'); void phone2;
  const killedId = (orphan as { call_id: string }[])[0]?.call_id; const ledgerRow = async () => (await admin.query(`SELECT state FROM gw_${schema}.phone_join_calls WHERE call_id=$1`, [killedId])).rows[0];
  const cleaned = await eventually(async () => { const r = await ledgerRow(); return !r || ['failed', 'ended'].includes(r.state); }, 60000); evidence.orphanCleanup = { killedCallLedgerStateBefore: (orphan as { state: string }[])[0]?.state, afterRestartReaper: (await ledgerRow())?.state ?? 'released (row gone)' };
  assert.ok(cleaned, 'the restarted gateway reaped the dead gateway claim (ledger state: ' + JSON.stringify(await ledgerRow()) + ')');
  saveEvidence('fault-2-gateway-killed');
});

test('FAULT 3 - Meet-side revocation (the PIN is revoked): the call is ended, the credential revoked, the gateway hangs the caller up, the browsers drop the gateway, and no audio reaches the phone afterwards', { skip, timeout: 240000 }, async () => {
  const L = await lab(); const r = await fetch(L.meet.base + '/api/integrations/scheduled-meetings/' + L.seeded.source + '/phone-access', { method: 'DELETE', headers: { 'x-qorlla-bridge-secret': BRIDGE } }); assert.equal(r.status, 200);
  assert.ok(await eventually(async () => (await callState(L.call.id)).state === 'TERMINATED', 20000), 'Meet ended the call'); assert.equal((await callState(L.call.id)).end_reason, 'pin_revoked');
  assert.ok((await admin.query(`SELECT revoked_at FROM ${schema}.phone_peer_credentials WHERE call_id=$1`, [L.call.id])).rows[0].revoked_at, 'credential revoked');
  assert.ok(await eventually(() => L.phone.requests('BYE').length >= 1, 15000), 'the gateway (told to terminate by Meet) hung the caller up'); assert.ok(await eventually(() => gatewayPcsGone(L), 25000), 'both browsers dropped the gateway');
  await sleep(1000); const n0 = L.phone.receivedPackets; await sleep(1500); assert.ok(L.phone.receivedPackets - n0 <= 3, 'no audio reaches the phone after the revocation (' + (L.phone.receivedPackets - n0) + ' stray packets)');
  evidence.revocation = { endReason: 'pin_revoked', byeReceived: true }; saveEvidence('fault-3-revocation');
});

test('FAULT 4 - keep-alive rejection: when the telephone stops sending audio, the gateway keep-alive evidence no longer verifies and MEET ends the call (media_unverified) before the gateway own inactivity timeout', { skip, timeout: 240000 }, async () => {
  const L = await lab(); L.phone.stopTone();
  assert.ok(await eventually(async () => (await callState(L.call.id)).state === 'TERMINATED', 30000), 'the call ended'); const st = await callState(L.call.id);
  assert.equal(st.end_reason, 'media_unverified', 'Meet rejected the keep-alive evidence (the gateway own inactivity timeout is 8 s and would have said something else): ' + st.end_reason);
  assert.ok(await eventually(() => gatewayPcsGone(L), 25000), 'the browsers dropped the gateway'); evidence.keepAliveRejection = { endReason: st.end_reason }; saveEvidence('fault-4-keepalive-rejection');
});
