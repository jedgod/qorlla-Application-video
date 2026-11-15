// REAL coturn + REAL Chromium + the REAL Voice Engine admin TURN API (v4.32/v2.0 closure). Not part of `npm test` (needs Chromium and a scratch coturn).
//   docker run -d --name qroom-coturn -p 127.0.0.1:34890:3478/udp -p 127.0.0.1:34890:3478/tcp -p 127.0.0.1:35890:5766 -p 127.0.0.1:49300-49330:49300-49330/udp coturn/coturn:4.6.2 -n --use-auth-secret \
//     --static-auth-secret=scratch-turn-secret-0123456789abcdef0123 --realm=qorlla.test --min-port=49300 --max-port=49330 --fingerprint --no-multicast-peers --cli-ip=0.0.0.0 --cli-password=cli-pw --cli-port=5766 --no-tls --no-dtls
//   VOICE_TEST_DATABASE_URL=postgres://... PLAYWRIGHT_DIR=<folder with node_modules/playwright> node test/turn-meet.real.e2e.mjs
// Proves, on a real relay: credentials issued for a room epoch work; with iceTransportPolicy=relay every candidate is a relay candidate and a data channel carries traffic THROUGH the relay; the relay's own CLI reports
// the allocations and bytes (observe); revoking an epoch cancels that allocation on the relay and traffic stops. It does NOT prove what media contains, Safari/phones, or anything across real networks.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore } from '../src/store.mjs';
import { makeAuthenticator } from '../src/auth.mjs';
import { createVoiceApp } from '../src/app.mjs';
import { isolatedDb, identityProvider } from './helpers.mjs';

const { chromium } = createRequire(join(process.env.PLAYWRIGHT_DIR || process.cwd(), 'package.json'))('playwright');
const SECRET = 'scratch-turn-secret-0123456789abcdef0123', ADMIN = 'a'.repeat(40), wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (n, ok, d = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !d ? '' : '  -> ' + d)); };
const db = await isolatedDb(); if (!db) { console.log('no PostgreSQL (set VOICE_TEST_DATABASE_URL)'); process.exit(2); }
const idp = await identityProvider();
const env = { VOICE_JWKS_URL: idp.jwksUrl, VOICE_JWT_ISSUER: 'qorlla-main', VOICE_JWT_AUDIENCE: 'qorlla-voice', VOICE_ALLOWED_ORIGIN: 'https://app.qorlla.test', VOICE_ADMIN_SECRET: ADMIN, TURN_URLS: 'turn:127.0.0.1:34890', TURN_SHARED_SECRET: SECRET, TURN_CLI_HOST: '127.0.0.1', TURN_CLI_PORT: '35890', TURN_CLI_PASSWORD: 'cli-pw' };
const voice = createVoiceApp({ store: createStore(db.pool), db: db.pool, authenticate: makeAuthenticator(env), env, maintenanceMs: 150000 });
const base = 'http://127.0.0.1:' + (await voice.listen(0, '127.0.0.1'));
const admin = async (path, body) => (await fetch(base + '/v1/voice/admin/turn' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-voice-admin-secret': ADMIN }, body: JSON.stringify(body) })).json();
const M = randomUUID(), A = randomUUID(), B = randomUUID(), pr = (p, e) => `meet:${M}:${p}:${e}`;
const browser = await chromium.launch({ args: ['--allow-loopback-in-peer-connection'] });
try {
  const ca = await admin('/meet-credentials', { meetingId: M, participantId: A, epoch: 1 }), cb = await admin('/meet-credentials', { meetingId: M, participantId: B, epoch: 1 });
  check('the Voice Engine issued relay-only credentials naming participant and epoch', ca.iceTransportPolicy === 'relay' && ca.principal === pr(A, 1) && /:meet:/.test(ca.iceServers.find((s) => s.username).username));
  const page = await (await browser.newContext()).newPage(); await page.goto('about:blank');
  // two peer connections in ONE page, relay-only, signaled by hand
  const out = await page.evaluate(async ({ ca, cb }) => {
    const mk = (c) => { const pc = new RTCPeerConnection({ iceServers: c.iceServers.filter((s) => s.username), iceTransportPolicy: c.iceTransportPolicy }); pc.cands = []; pc.onicecandidate = (e) => { if (e.candidate) pc.cands.push(e.candidate.candidate); }; return pc; };
    const a = mk(ca), b = mk(cb); const got = []; let open; const ready = new Promise((r) => (open = r));
    const dc = a.createDataChannel('t'); dc.onopen = open; b.ondatachannel = (e) => { e.channel.onmessage = (m) => got.push(m.data); };
    const gathered = (pc) => new Promise((r) => { if (pc.iceGatheringState === 'complete') r(); else pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && r()); });
    await a.setLocalDescription(await a.createOffer()); await gathered(a); await b.setRemoteDescription(a.localDescription); await b.setLocalDescription(await b.createAnswer()); await gathered(b); await a.setRemoteDescription(b.localDescription);
    await Promise.race([ready, new Promise((_r, no) => setTimeout(() => no(new Error('data channel did not open through the relay')), 15000))]);
    window.__t = { a, b, dc, got }; for (let i = 0; i < 20; i++) dc.send('hello-' + i);
    await new Promise((r) => setTimeout(r, 1500)); return { cands: [...a.cands, ...b.cands], got: got.length, pairA: [...(await a.getStats()).values()].find((s) => s.type === 'candidate-pair' && s.state === 'succeeded')?.localCandidateId };
  }, { ca, cb }).catch((e) => ({ error: String(e.message || e) }));
  check('relay-only: every gathered candidate is a relay candidate (no host/srflx leaked)', !out.error && out.cands.length > 0 && out.cands.every((c) => / typ relay /.test(c)), JSON.stringify(out).slice(0, 300));
  check('a data channel opened and carried 20 messages THROUGH the real relay', !out.error && out.got === 20, JSON.stringify(out).slice(0, 300));
  await wait(500);
  const ob = await admin('/observe', { principals: [pr(A, 1), pr(B, 1)] }); const oa = ob.results[pr(A, 1)];
  check('the relay itself reports the allocation and the bytes it carried (Relay observed)', oa.observed === true && oa.allocations >= 1 && oa.relayedBytes > 0, JSON.stringify(ob).slice(0, 300));
  const rv = await admin('/revoke', { principals: [pr(A, 1)] });
  check('revoking the epoch cancels the live allocation on the relay', rv.results[pr(A, 1)].sessions >= 1 && rv.results[pr(A, 1)].errors.length === 0, JSON.stringify(rv).slice(0, 300));
  await wait(500); const after = (await admin('/observe', { principals: [pr(A, 1), pr(B, 1)] })).results;
  check('after revocation the relay holds nothing for that epoch and still holds the other participant\'s', after[pr(A, 1)].allocations === 0 && after[pr(B, 1)].allocations >= 1, JSON.stringify(after).slice(0, 300));
  const stopped = await page.evaluate(async () => { const { dc, got } = window.__t; const before = got.length; for (let i = 0; i < 10; i++) dc.send('late-' + i); await new Promise((r) => setTimeout(r, 2500)); return got.length - before; });
  check('traffic sent after revocation does not arrive', stopped === 0, 'delivered ' + stopped);
  const ca2 = await admin('/meet-credentials', { meetingId: M, participantId: A, epoch: 2 });
  check('the next epoch gets a fresh credential, so the person can reconnect in the new room', ca2.principal === pr(A, 2) && ca2.iceServers.find((s) => s.username).credential !== ca.iceServers.find((s) => s.username).credential);
} catch (e) { check('run completed without an exception', false, String(e.message || e).slice(0, 400)); }
finally { await browser.close(); await voice.close(); await idp.close(); await db.drop(); }
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`); process.exit(results.every(Boolean) ? 0 : 1);
