import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import express from 'express';
import { verifyWorkloadToken, signGatewayToken, gatewayAuth, GatewayAuthError, type GatewayAuthConfig } from '../src/gateway-auth.js';
import { PostgresReplayStore } from '../src/ledger-pg.js';
import { keypair, memoryReplay, listen, closeAllServers } from './support.js';

const kp = keypair(), other = keypair(), ISS = 'qorlla-gateway';
const MEET_SIGNER = path.join(process.env.MEET_SERVER_DIR ?? 'C:/Users/cj_wo/qv-shield/qorlla-meet-video', 'server', 'telephony', 'number-sync.mjs');   // Meet's own signWorkloadJwt
const cfg = (over: Partial<GatewayAuthConfig> = {}): GatewayAuthConfig => ({ keys: { [ISS]: { w1: kp.publicKeyPem } }, subjects: ['svc:phone-gateway'], replay: memoryReplay(), ...over });
const mint = (o: Partial<Parameters<typeof signGatewayToken>[0]> = {}) => signGatewayToken({ privateKeyPem: kp.privateKeyPem, issuer: ISS, subject: 'svc:phone-gateway', ...o });
const refused = async (token: string, c: GatewayAuthConfig, ctx = {}) => { try { await verifyWorkloadToken(token, c, ctx); return 'ACCEPTED'; } catch (e) { return e instanceof GatewayAuthError ? e.reason : 'other:' + (e as Error).message; } };
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

test('a well-formed workload token from a known gateway is accepted once', async () => {
  const c = cfg(), token = mint(); const g = await verifyWorkloadToken(token, c); assert.equal(g.issuer, ISS); assert.equal(g.subject, 'svc:phone-gateway');
  assert.equal(await refused(token, c), 'replayed', 'the same token cannot be used twice');
});
test('every way a token can be wrong is refused, with the reason recorded', async () => {
  const c = cfg(), now = Math.floor(Date.now() / 1000);
  const cases: [string, string][] = [
    ['garbage', 'malformed'], ['', 'malformed'], ['a.b', 'malformed'], ['a.b.c.d', 'malformed'],
    [mint({ audience: 'qorlla-shield' }), 'audience'], [mint({ subject: 'svc:someone-else' }), 'subject'], [mint({ issuer: 'qorlla-unknown' }), 'unknown_issuer_or_kid'], [mint({ kid: 'w9' }), 'unknown_issuer_or_kid'],
    [mint({ now: now - 1000, ttlSeconds: 120 }), 'expired'], [mint({ now: now + 600 }), 'issued_in_future'], [mint({ ttlSeconds: 3600 }), 'ttl_too_long'],
    [signGatewayToken({ privateKeyPem: other.privateKeyPem, issuer: ISS, subject: 'svc:phone-gateway' }), 'signature']
  ];
  for (const [token, reason] of cases) assert.equal(await refused(token, c), reason, reason + ': ' + token.slice(0, 20));
  const good = mint(), [h, p, s] = good.split('.');
  assert.equal(await refused(h + '.' + b64({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: 'svc:phone-gateway', exp: now + 100000 }) + '.' + s, c), 'signature', 'a tampered claim breaks the signature');
  for (const alg of ['none', 'HS256', 'RS256', 'ES384']) assert.equal(await refused(b64({ alg, typ: 'JWT', kid: 'w1' }) + '.' + p + '.' + s, c), 'alg', alg);
  assert.equal(await refused(b64({ alg: 'ES256', typ: 'JWT', kid: 'w1' }) + '.' + b64({ iss: ISS, sub: 'svc:phone-gateway', aud: 'qorlla-phone-join', iat: now, exp: now + 60, jti: 'short' }) + '.' + s, c), 'signature');
});
test('the token is bound to the body: a different body, a missing hash, or a body-bound token on a bodiless call is refused', async () => {
  const body = JSON.stringify({ meetingId: 'ABC12345' }), sha = crypto.createHash('sha256').update(body).digest('base64url');
  assert.equal(await refused(mint({ body }), cfg(), { bodySha256: sha }), 'ACCEPTED');
  assert.equal(await refused(mint({ body }), cfg(), { bodySha256: crypto.createHash('sha256').update('{"meetingId":"OTHER123"}').digest('base64url') }), 'body_binding');
  assert.equal(await refused(mint(), cfg(), { bodySha256: sha }), 'body_binding', 'a token with no body hash cannot authorise a body');
  assert.equal(await refused(mint({ body }), cfg(), {}), 'body_binding', 'a body-bound token is useless without that body');
});
test('mutual TLS binding: the token must carry the thumbprint of the certificate on this connection', async () => {
  const c = cfg({ requireMtls: true });
  assert.equal(await refused(mint({ cnfThumbprint: 'AAAA' }), c, { peerThumbprint: 'AAAA' }), 'ACCEPTED');
  assert.equal(await refused(mint({ cnfThumbprint: 'AAAA' }), c, { peerThumbprint: 'BBBB' }), 'certificate_binding');
  assert.equal(await refused(mint(), c, { peerThumbprint: 'AAAA' }), 'certificate_binding', 'an unbound token is refused when mTLS is required');
  assert.equal(await refused(mint({ cnfThumbprint: 'AAAA' }), c, { peerThumbprint: null }), 'certificate_binding', 'no client certificate on the connection');
});
test('a replay store that is down is a refusal, not a pass', async () => {
  assert.equal(await refused(mint(), cfg({ replay: { firstUse: async () => { throw new Error('db down'); } } })), 'replay_store_unavailable');
});
test('clock skew is bounded in both directions (injected clock)', async () => {
  const now = 1_800_000_000; const c = cfg({ now: () => now * 1000 });
  assert.equal(await refused(mint({ now: now + 25 }), c), 'ACCEPTED', 'within the allowed skew'); assert.equal(await refused(mint({ now: now + 45 }), c), 'issued_in_future');
  assert.equal(await refused(mint({ now: now - 100, ttlSeconds: 60 }), c), 'expired');
});

test('format compatibility: a token minted by Meet\'s own signWorkloadJwt is verified (when the Meet source is available)', { skip: !fs.existsSync(MEET_SIGNER) ? 'Meet source not found (set MEET_SERVER_DIR to the qorlla-meet-video directory)' : false }, async () => {
  const file = MEET_SIGNER;
  const meet: any = await import(/* @vite-ignore */ 'file:///' + file.replace(/\\/g, '/').replace(/^\/+/, ''));
  const token = meet.signWorkloadJwt({ privateKeyPem: kp.privateKeyPem, kid: 'w1', issuer: ISS, subject: 'svc:phone-gateway', audience: 'qorlla-phone-join' });
  const g = await verifyWorkloadToken(token, cfg()); assert.equal(g.subject, 'svc:phone-gateway');
});

test('middleware: GET needs a valid token; the admission POST also needs the body hash; replays, tampering and oversize are refused, and the real reason is only logged', async () => {
  const reasons: string[] = [], { authenticateGateway, verifyWebhook } = gatewayAuth(cfg({ onReject: (r) => reasons.push(r) }));
  const app = express(); app.get('/g', authenticateGateway, (req, res) => res.json({ who: (req as any).gateway.subject })); app.post('/p', verifyWebhook, express.json(), (req, res) => res.json({ got: req.body, gw: (req as any).gateway.issuer }));
  const s = await listen(app); const body = JSON.stringify({ meetingId: 'ABC12345', callId: 'call_12345678' });
  const post = (token: string | null, b = body) => fetch(s.url + '/p', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: b });
  assert.equal((await fetch(s.url + '/g')).status, 401); assert.equal((await fetch(s.url + '/g', { headers: { authorization: 'Bearer ' + mint() } })).status, 200);
  const t = mint({ body }); const ok = await post(t); assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { got: { meetingId: 'ABC12345', callId: 'call_12345678' }, gw: ISS });
  assert.equal((await post(t)).status, 401, 'replayed token'); assert.equal((await post(mint({ body }), body.replace('ABC12345', 'XYZ12345'))).status, 401, 'tampered body');
  assert.equal((await post(mint())).status, 401, 'token without a body hash'); assert.equal((await post(null)).status, 401); assert.equal((await post(mint({ body: 'x'.repeat(9000) }), 'x'.repeat(9000))).status, 413);
  const notJson = '{oops'; assert.equal((await post(mint({ body: notJson }), notJson)).status, 400);
  const r = await post(mint(), body); assert.deepEqual(await r.json(), { code: 'AUTH_REQUIRED' }); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(reasons.includes('replayed') && reasons.includes('body_binding') && reasons.includes('malformed'), reasons.join(','));
  await s.close();
});

const DB_URL = process.env.PHONE_JOIN_TEST_DATABASE_URL;
test('replay store on PostgreSQL: three replicas verifying the SAME captured token - exactly one accepts it', { skip: DB_URL ? false : 'PHONE_JOIN_TEST_DATABASE_URL is not set' }, async () => {
  const schema = 'pj_gw_' + Math.random().toString(36).slice(2, 8), admin = new pg.Pool({ connectionString: DB_URL }); await admin.query('CREATE SCHEMA ' + schema);
  const c = await admin.connect(); try { await c.query('SET search_path=' + schema); await c.query(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'sql', '001_phone_join.sql'), 'utf8')); } finally { c.release(); }
  const pools = [1, 2, 3].map(() => new pg.Pool({ connectionString: DB_URL, options: '-c search_path=' + schema }));
  try {
    const token = mint(), results = await Promise.all(pools.flatMap((p) => [1, 2].map(() => refused(token, cfg({ replay: new PostgresReplayStore(p) })))));
    assert.equal(results.filter((r) => r === 'ACCEPTED').length, 1); assert.equal(results.filter((r) => r === 'replayed').length, 5);
  } finally { for (const p of pools) await p.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); }
});
test.after(closeAllServers);
