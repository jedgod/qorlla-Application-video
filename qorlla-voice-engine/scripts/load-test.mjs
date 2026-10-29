// Load generator for Qorlla Voice signaling (no media). It plays the identity provider (a JWKS server the engine must be configured to trust), provisions accounts, then runs concurrent call pairs:
//   dial -> ring -> answer -> N relayed SDP/ICE messages -> hang up, repeated. It measures what a user would feel (time to ring, to connect, to relay a signal, to learn the call ended) and what an operator watches
//   (errors, unexpected socket closes, outbox backlog and age before/after).
//   VOICE_ADMIN_SECRET=... node scripts/load-test.mjs --nodes http://10.0.0.1:4600,http://10.0.0.2:4600 --pairs 100 --cycles 5 --signals 20 [--origin https://app.example] [--jwks-port 4650] [--max-p95-ms 1500]
// The engine under test needs VOICE_JWKS_URL pointing at this machine (http://<this host>:<jwks-port>/jwks.json), the same issuer/audience, VOICE_ALLOWED_ORIGIN including --origin, and relaxed
// VOICE_API_RATE_PER_MIN / VOICE_CALL_RATE_PER_MIN (the per-account limits are real and would otherwise reject the load). Exit code 1 when a threshold is breached or any operation failed.
// This measures the SIGNALING plane. Audio (TURN bandwidth, CPU of media relays) must be measured separately; see docs/VOICE_RC2_EVIDENCE_PLAN.md.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const argv = process.argv.slice(2), opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const NODES = opt('nodes', 'http://127.0.0.1:4600').split(',').map((s) => s.trim().replace(/\/+$/, '')), PAIRS = Number(opt('pairs', 20)), CYCLES = Number(opt('cycles', 3)), SIGNALS = Number(opt('signals', 10));
const ORIGIN = opt('origin', 'http://localhost:3000'), JWKS_PORT = Number(opt('jwks-port', 4650)), MAX_P95 = Number(opt('max-p95-ms', 0)), ADMIN = process.env.VOICE_ADMIN_SECRET, THINK = Number(opt('think-ms', 50));
if (!ADMIN || ADMIN.length < 32) { console.error('VOICE_ADMIN_SECRET (>= 32 chars) is required'); process.exit(2); }
const now = () => performance.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { publicKey, privateKey } = await generateKeyPair('ES256'), jwk = { ...(await exportJWK(publicKey)), kid: 'load', alg: 'ES256', use: 'sig' };
const jwks = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); }); await new Promise((r) => jwks.listen(JWKS_PORT, '0.0.0.0', r));
const token = (sub) => new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'load' }).setSubject(sub).setIssuer(process.env.VOICE_JWT_ISSUER || 'qorlla-main').setAudience(process.env.VOICE_JWT_AUDIENCE || 'qorlla-voice').setIssuedAt().setExpirationTime('10m').sign(privateKey);

const m = { dial_api: [], ring: [], answer_api: [], connected: [], signal: [], end_api: [], end_seen: [] }, errors = {}, err = (k) => { errors[k] = (errors[k] || 0) + 1; };
async function api(base, who, method, path, body) { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', origin: ORIGIN, authorization: 'Bearer ' + await token(who) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }
const admin = (base, path, body) => fetch(base + '/v1/voice/admin' + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-voice-admin-secret': ADMIN }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
async function client(base, who) {
  const deviceId = randomUUID(), t = await api(base, who, 'POST', '/v1/voice/ws-ticket', { deviceId }); if (!t.body.ticket) { err('ticket_' + t.status); throw new Error('ticket'); }
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/v1/voice/ws', ['qorlla.voice.v1', 'ticket.' + t.body.ticket], { origin: ORIGIN }), waiters = [], c = { ws, who, deviceId, base, closed: false };
  ws.on('message', (raw) => { const msg = JSON.parse(raw.toString()), at = now(); for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.res({ msg, at }); } });
  ws.on('close', () => { c.closed = true; }); await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); ws.once('unexpected-response', (_q, r) => rej(new Error('http_' + r.statusCode))); });
  c.wait = (pred, ms = 8000) => new Promise((res, rej) => { const w = { pred, res }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error('timeout')); } }, ms); });
  return c;
}
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10; };
async function pair(i) {
  const a = 'load-a-' + i, b = 'load-b-' + i, ba = NODES[i % NODES.length], bb = NODES[(i + 1) % NODES.length];                    // caller and callee on different nodes when there are two
  let ca, cb; try { [ca, cb] = await Promise.all([client(ba, a), client(bb, b)]); } catch { err('connect'); return; }
  const ext = (await admin(bb, '/identities?ids=' + b)).body.identities?.[0]?.extension;
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    try {
      const incoming = cb.wait((x) => x.type === 'incoming'), t0 = now(), d = await api(ba, a, 'POST', '/v1/voice/calls', { extension: ext, idempotencyKey: randomUUID(), deviceId: ca.deviceId }); m.dial_api.push(now() - t0);
      if (d.status !== 201) { err('dial_' + d.status); await sleep(THINK); continue; }
      const id = d.body.call.id, inc = await incoming; m.ring.push(inc.at - t0);
      const active = ca.wait((x) => x.type === 'state' && x.call.id === id && x.call.status === 'active'), t1 = now(), ans = await api(bb, b, 'POST', `/v1/voice/calls/${id}/answer`, { deviceId: cb.deviceId }); m.answer_api.push(now() - t1);
      if (ans.status !== 200) { err('answer_' + ans.status); continue; } m.connected.push((await active).at - t1);
      for (let s = 0; s < SIGNALS; s++) {
        const got = cb.wait((x) => x.type === 'offer' && x.callId === id), sent = now(); ca.ws.send(JSON.stringify({ type: 'offer', callId: id, generation: d.body.generation, sdp: 'v=0\r\ns=load\r\n' })); m.signal.push((await got).at - sent);
      }
      const ended = cb.wait((x) => x.type === 'state' && x.call.id === id && x.call.status === 'ended'), t2 = now(), e = await api(ba, a, 'POST', `/v1/voice/calls/${id}/end`, {}); m.end_api.push(now() - t2); if (e.status !== 200) err('end_' + e.status); m.end_seen.push((await ended).at - t2);
    } catch (e) { err(String(e.message).slice(0, 30)); }
    await sleep(Math.random() * THINK * 2);
  }
  if (ca.closed || cb.closed) err('socket_closed_unexpectedly'); ca.ws.close(); cb.ws.close();
}
const snap = async () => Promise.all(NODES.map(async (n) => (await admin(n, '/metrics')).body.outbox));
console.log(`provisioning ${PAIRS * 2} accounts on ${NODES.length} node(s)...`);
for (let k = 0; k < PAIRS; k += 25) await Promise.all(Array.from({ length: Math.min(25, PAIRS - k) }, async (_, j) => { await admin(NODES[0], '/identities', { accountId: 'load-a-' + (k + j) }); await admin(NODES[0], '/identities', { accountId: 'load-b-' + (k + j) }); }));
const before = await snap(), started = now();
await Promise.all(Array.from({ length: PAIRS }, (_, i) => pair(i)));
const seconds = (now() - started) / 1000; await sleep(1500); const after = await snap();
const summary = { nodes: NODES.length, pairs: PAIRS, cycles: CYCLES, signalsPerCall: SIGNALS, durationSeconds: Math.round(seconds * 10) / 10, callsCompleted: m.end_seen.length, callsPerSecond: Math.round((m.end_seen.length / seconds) * 10) / 10, signalsRelayed: m.signal.length,
  latencyMs: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { n: v.length, p50: pct(v, 0.5), p95: pct(v, 0.95), p99: pct(v, 0.99), max: pct(v, 1) }])), errors, outboxBefore: before, outboxAfter: after };
console.log(JSON.stringify(summary, null, 2)); jwks.close();
const totalErrors = Object.values(errors).reduce((x, y) => x + y, 0), slow = MAX_P95 && Object.entries(summary.latencyMs).filter(([, v]) => v.p95 > MAX_P95).map(([k]) => k);
if (totalErrors) console.error(`FAIL: ${totalErrors} operation(s) failed`); if (slow && slow.length) console.error(`FAIL: p95 above ${MAX_P95} ms for ${slow.join(', ')}`);
process.exit(totalErrors || (slow && slow.length) ? 1 : 0);
