// Smoke test for the two-node staging compose (deploy/docker-compose.staging.yml). It plays the identity provider (a JWKS server the containers fetch), then checks across the two nodes:
// strict readiness (database, password-protected Redis, outbox lag), a call that rings on the OTHER node, signaling relayed between nodes, replay from the other node, and device fencing.
//   node scripts/staging-smoke.mjs http://127.0.0.1:4601 http://127.0.0.1:4602          env: VOICE_ADMIN_SECRET, JWKS_PORT (4650), VOICE_ALLOWED_ORIGIN
// It proves the deployment wiring (image, roles, Redis auth, migrations, replicas). It does not replace the QVE gates.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const [A, B] = process.argv.slice(2); if (!A || !B) { console.error('usage: staging-smoke.mjs <nodeA url> <nodeB url>'); process.exit(2); }
const ADMIN = process.env.VOICE_ADMIN_SECRET, ORIGIN = process.env.VOICE_ALLOWED_ORIGIN || 'http://localhost:3000', JWKS_PORT = Number(process.env.JWKS_PORT || 4650);
if (!ADMIN || ADMIN.length < 32) { console.error('VOICE_ADMIN_SECRET (>= 32 chars) is required'); process.exit(2); }
const { publicKey, privateKey } = await generateKeyPair('ES256'), jwk = { ...(await exportJWK(publicKey)), kid: 'smoke', alg: 'ES256', use: 'sig' };
const jwks = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); }); await new Promise((r) => jwks.listen(JWKS_PORT, '0.0.0.0', r));
const token = (sub) => new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'smoke' }).setSubject(sub).setIssuer(process.env.VOICE_JWT_ISSUER || 'qorlla-main').setAudience(process.env.VOICE_JWT_AUDIENCE || 'qorlla-voice').setIssuedAt().setExpirationTime('5m').sign(privateKey);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(50); } return null; };
const api = async (base, who, method, path, body) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', origin: ORIGIN, authorization: 'Bearer ' + await token(who) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const admin = (base, method, path, body) => fetch(base + '/v1/voice/admin' + path, { method, headers: { 'content-type': 'application/json', 'x-voice-admin-secret': ADMIN }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
async function socket(base, who, deviceId) {
  const t = (await api(base, who, 'POST', '/v1/voice/ws-ticket', { deviceId })).body.ticket, inbox = [];
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/v1/voice/ws', ['qorlla.voice.v1', 'ticket.' + t], { origin: ORIGIN }); ws.on('message', (m) => inbox.push(JSON.parse(m.toString())));
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); ws.once('unexpected-response', (_q, r) => rej(new Error('http_' + r.statusCode))); });
  return { ws, inbox, of: (type, pred = () => true) => inbox.filter((m) => m.type === type && pred(m)) };
}
let failed = 0; const check = (name, ok, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); if (!ok) failed++; };
const SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n', tag = randomUUID().slice(0, 6), alice = 'smoke-alice-' + tag, bob = 'smoke-bob-' + tag, dAlice = randomUUID(), dBob = randomUUID(), dAlice2 = randomUUID();
try {
  for (const [n, base] of [['A', A], ['B', B]]) {
    const rd = await until(async () => { const r = await fetch(base + '/v1/voice/operational/readiness').then(async (x) => ({ s: x.status, b: await x.json() })).catch(() => null); return r && r.s === 200 ? r : null; }, 30000);
    check(`node ${n}: strict readiness (database, authenticated Redis, outbox lag)`, !!rd && rd.b.ready && rd.b.redis === 'up', JSON.stringify(rd));
  }
  const ea = (await admin(A, 'POST', '/identities', { accountId: alice })).body.identity, eb = (await admin(B, 'POST', '/identities', { accountId: bob })).body.identity; check('identities provisioned through different nodes share one database', !!ea && !!eb && ea.extension !== eb.extension);
  const sa = await socket(A, alice, dAlice), sb = await socket(B, bob, dBob);                                                // alice on node A, bob on node B
  const call = await api(A, alice, 'POST', '/v1/voice/calls', { extension: eb.extension, idempotencyKey: 'smoke-' + randomUUID(), deviceId: dAlice }); check('call created on node A', call.status === 201, JSON.stringify(call));
  const inc = await until(() => sb.of('incoming')[0]); check('the call rings on node B (outbox -> authenticated Redis -> node B)', !!inc && inc.call.id === call.body.call.id && !!inc.eventId);
  const ans = await api(B, bob, 'POST', `/v1/voice/calls/${call.body.call.id}/answer`, { deviceId: dBob }); check('answered on node B', ans.status === 200);
  check('node A learns the call is active', !!(await until(() => sa.of('state', (m) => m.call.status === 'active')[0])));
  sa.ws.send(JSON.stringify({ type: 'offer', callId: call.body.call.id, generation: 1, sdp: SDP })); check('SDP relayed A -> B', !!(await until(() => sb.of('offer')[0])));
  sb.ws.send(JSON.stringify({ type: 'answer', callId: call.body.call.id, generation: 1, sdp: SDP })); check('SDP relayed B -> A', !!(await until(() => sa.of('answer')[0])));
  const claim = await api(B, alice, 'POST', `/v1/voice/calls/${call.body.call.id}/device`, { deviceId: dAlice2 }); check('device takeover decided on node B', claim.status === 200 && claim.body.generation === 2);
  check('the replaced device on node A is told', !!(await until(() => sa.of('device_revoked')[0])));
  const n = sb.of('offer').length; sa.ws.send(JSON.stringify({ type: 'offer', callId: call.body.call.id, generation: 1, sdp: SDP })); await sleep(500); check('the replaced device can no longer signal (fenced on both nodes)', sb.of('offer').length === n);
  const rep = await api(B, alice, 'GET', '/v1/voice/events?after=0'); check('events replay from the OTHER node', rep.status === 200 && rep.body.events.some((e) => e.kind === 'state'));
  check('the call ends cleanly', (await api(A, bob, 'POST', `/v1/voice/calls/${call.body.call.id}/end`, {})).status === 200);
  const m = await admin(A, 'GET', '/metrics'); check('operator metrics answer', m.status === 200 && m.body.bus === 'up', JSON.stringify(m.body)); sa.ws.close(); sb.ws.close();
} catch (e) { console.error('smoke error:', e.message); failed++; } finally { jwks.close(); }
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall staging smoke checks passed (deployment wiring only: not a certification)'); process.exit(failed ? 1 : 0);
