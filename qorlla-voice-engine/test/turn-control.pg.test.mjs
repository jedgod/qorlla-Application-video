// A3.7.1: media security against a REAL coturn (long-term credentials, Redis user database, admin CLI) and a REAL engine on real PostgreSQL. Nothing about the relay is simulated.
// Needs the disposable containers from scripts/a371-turn-up.sh (coturn on UDP 127.0.0.1:34780, CLI 35766, Redis 36379, relay ports 47300-47330); without them every test here is SKIPPED, never passed.
// What this proves: credential refusal/expiry/scope, that suspension, organization suspension and administrative disable stop relayed packets within a stated budget, that the old credential cannot allocate or refresh afterwards,
// that this survives an engine restart and holds across two engine instances, and that a relay the engine cannot reach produces a critical alert.
// What it does NOT prove: anything across two real networks or physical devices, browsers' behaviour, ICE restart or network switching (see docs/A371_MEDIA_SECURITY.md).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { exportJWK, importSPKI } from 'jose';
import { createClient } from 'redis';
import { isolatedDb, identityProvider, wait } from './helpers.mjs';
import { harness, until } from './harness.mjs';
import { TurnClient, udpPeer } from './turn-client.mjs';
import { createTurnControl, turnCli, parseSessions } from '../src/turn.mjs';
import { signWorkloadJwt } from '../../qorlla-meet-video/server/telephony/number-sync.mjs';

const T = { redis: process.env.A371_REDIS_URL || 'redis://127.0.0.1:36379', host: '127.0.0.1', port: Number(process.env.A371_TURN_PORT || 34780), cliPort: Number(process.env.A371_CLI_PORT || 35766), cliPw: process.env.A371_CLI_PASSWORD || 'clipw', realm: 'qorlla.test', gateway: process.env.A371_DOCKER_GATEWAY || '172.29.88.1' };
const BUDGET_MS = Number(process.env.A371_MEDIA_BUDGET_MS || 3000), ISSUER = 'qorlla-workload', SECRET = 'a371-credential-secret-0123456789abcdef';
const turnEnv = (extra = {}) => ({ TURN_AUTH_MODE: 'userdb', TURN_USERDB_REDIS_URL: T.redis, TURN_REALM: T.realm, TURN_CREDENTIAL_SECRET: SECRET, TURN_CLI_HOST: T.host, TURN_CLI_PORT: String(T.cliPort), TURN_CLI_PASSWORD: T.cliPw, TURN_URLS: `turn:${T.host}:${T.port}`, ...extra });
const evidence = { budgetMs: BUDGET_MS, results: {} };
const tcpUp = (port) => new Promise((ok) => { const s = net.connect(port, '127.0.0.1'); const done = (v) => { s.destroy(); ok(v); }; s.once('connect', () => done(true)); s.once('error', () => done(false)); setTimeout(() => done(false), 1500); });

let up = false, db, idp, h, r, r2, pem, jwksSrv, jwksUrl, rc;
async function workload() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = { ...(await exportJWK(await importSPKI(publicKey.export({ type: 'spki', format: 'pem' }), 'ES256'))), kid: 'w1', alg: 'ES256', use: 'sig' };
  const srv = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); }); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), srv, url: 'http://127.0.0.1:' + srv.address().port + '/jwks.json' };
}
const tok = (sub) => signWorkloadJwt({ privateKeyPem: pem, kid: 'w1', issuer: ISSUER, subject: sub });
const wcall = (rep, method, path, body) => fetch(rep.base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok('svc:admin') }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => ({})) }));
const BASE = (extra = {}) => ({ SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_WORKLOAD_JWKS_URL: jwksUrl, SHIELD_WORKLOAD_ISSUER: ISSUER, SHIELD_WORKLOAD_ALLOWED: 'svc:admin=shield.admin|shield.suspend', ...turnEnv(), ...extra });
const person = async (id, o = {}) => { await wcall(r, 'PUT', '/v1/shield/admin/principals', { accountId: id, verified: true, ...o }); return (await r.admin('POST', '/identities', { accountId: id })).body.identity.extension; };
const ice = async (rep, id) => { const x = await rep.api(id, 'GET', '/v1/voice/ice'); return x.status === 200 ? { ...x.body, status: 200, turn: x.body.iceServers.find((s) => s.username) } : x; };
const client = async (cred) => { const c = new TurnClient({ host: T.host, port: T.port, username: cred.username, password: cred.credential }); await c.bind(); return c; };
const raw = async () => { const c = createClient({ url: T.redis }); await c.connect(); return c; };

before(async () => {
  up = (await tcpUp(36379)) && (await tcpUp(T.cliPort)); if (!up) return;
  db = await isolatedDb(); if (!db) { up = false; return; }
  idp = await identityProvider(); const w = await workload(); pem = w.pem; jwksSrv = w.srv; jwksUrl = w.url; h = harness({ db, idp }); rc = await raw();
  r = await h.replica({ outbox: true, maintenance: true, env: BASE() }); r2 = await h.replica({ outbox: false, maintenance: false, env: BASE() });
});
after(async () => {
  if (process.env.A371_EVIDENCE_FILE) fs.writeFileSync(process.env.A371_EVIDENCE_FILE, JSON.stringify(evidence, null, 2));
  if (h) await h.closeAll(); if (rc) await rc.quit().catch(() => {}); if (idp) await idp.close(); if (jwksSrv) await new Promise((ok) => jwksSrv.close(ok)); if (db) await db.drop();
});
const skip = (t) => { if (!up) t.skip('no coturn/Redis/PostgreSQL containers reachable (run scripts/a371-turn-up.sh)'); return !up; };

test('TURN credential security: anonymous, wrong, tampered, foreign and expired credentials never allocate; credentials are opaque, scoped to one account, short-lived, and the password is never stored', async (t) => {
  if (skip(t)) return;
  const tc = createTurnControl({ env: turnEnv({ TURN_CREDENTIAL_TTL_SECONDS: '5' }) });
  try {
    assert.equal(tc.ttl, 5);
    const a = await tc.issue('acct-a'), b = await tc.issue('acct-b');
    assert.notEqual(a.username, b.username); assert.ok(!a.username.includes('acct-a'), 'the username does not reveal the account'); assert.ok(a.ttl <= 3600);
    // anonymous (no credentials at all) and bad credentials
    const anon = new TurnClient({ host: T.host, port: T.port, username: '', password: '' }); await anon.bind(); const x = await anon.allocate(); assert.equal(x.ok, false, 'anonymous allocation refused'); anon.close();
    for (const [name, u, p] of [['wrong password', a.username, 'wrong'], ['unknown user', 'qdoesnotexist', a.credential], ['tampered username', a.username.slice(0, -1) + (a.username.endsWith('A') ? 'B' : 'A'), a.credential], ['account B password on A', a.username, b.credential]]) {
      const c = new TurnClient({ host: T.host, port: T.port, username: u, password: p }); await c.bind(); const y = await c.allocate(); assert.equal(y.ok, false, name); assert.equal(y.error, 401, name); c.close();
    }
    // Redis holds only coturn's MD5 key, never the password; every key lives only as long as the credential
    const key = `turn/realm/${T.realm}/user/${a.username}/key`, stored = await rc.get(key); assert.match(stored, /^[0-9a-f]{32}$/); assert.notEqual(stored, a.credential);
    const everything = JSON.stringify(await Promise.all((await rc.keys('*')).map(async (k) => [k, await rc.type(k) === 'string' ? await rc.get(k) : await rc.sMembers(k)]))); assert.ok(!everything.includes(a.credential) && !everything.includes(SECRET), 'no password or secret in Redis');
    const ttlLeft = await rc.ttl(key); assert.ok(ttlLeft > 0 && ttlLeft <= 5, 'credential expires by itself: ' + ttlLeft);
    // the good credential works, then expires
    const ok = await client(a); const al = await ok.allocate(); assert.equal(al.ok, true); ok.close(); await wait(5600);
    const late = await client(a); const z = await late.allocate(); assert.equal(z.ok, false, 'expired credential refused'); late.close();
    // reuse: a fresh issue after expiry is a different credential; while valid, an ICE restart gets the same one (no credential multiplication)
    const c1 = await tc.issue('acct-a'), c2 = await tc.issue('acct-a'); assert.notEqual(c1.username, a.username); assert.equal(c2.username, c1.username);
    evidence.results.credentials = { anonymousRefused: true, wrongRefused: true, tamperedRefused: true, foreignRefused: true, expiredRefused: true, passwordNotStored: true };
  } finally { await tc.close(); }
});

test('suspension ENDS MEDIA: relayed packets flow, the account is suspended, and within the budget no packet is delivered; the old credential can neither allocate nor refresh; restoring needs a NEW credential', async (t) => {
  if (skip(t)) return;
  const ext = await person('sue'); void ext; await person('tom');
  const got = await ice(r, 'sue'); assert.equal(got.status, 200, JSON.stringify(got)); assert.equal(got.iceTransportPolicy, 'all'); assert.ok(got.turn, 'a TURN credential was issued'); assert.ok(!got.turn.username.includes('sue'));
  const cred = { username: got.turn.username, credential: got.turn.credential }, cl = await client(cred), peer = await udpPeer();
  const al = await cl.allocate(); assert.equal(al.ok, true, JSON.stringify(al)); assert.equal((await cl.permit(T.gateway)).ok, true);
  peer.sock.send('before', al.relay.port, '127.0.0.1'); assert.ok(await until(() => cl.data.length >= 1), 'media flows through the relay before suspension'); const flowed = cl.data.length;
  const live = parseSessions((await turnCli(['ps ' + cred.username], { host: T.host, port: T.cliPort, password: T.cliPw }))[0]); assert.ok(live.length >= 1, 'the relay shows the live allocation');
  const t0 = Date.now(); const s = await wcall(r, 'POST', '/v1/shield/admin/principals/sue/suspend'); const done = Date.now() - t0; assert.equal(s.status, 200, JSON.stringify(s.body));
  cl.data.length = 0; for (let i = 0; i < 5; i++) { peer.sock.send('after' + i, al.relay.port, '127.0.0.1'); await wait(80); } await wait(400);
  assert.equal(cl.data.length, 0, 'no relayed packet reaches the suspended account'); assert.ok(done < BUDGET_MS, `suspension returned (credentials revoked, allocations cancelled) in ${done}ms, budget ${BUDGET_MS}ms`);
  assert.equal(parseSessions((await turnCli(['ps ' + cred.username], { host: T.host, port: T.cliPort, password: T.cliPw }))[0]).length, 0, 'the relay has no allocation left');
  assert.deepEqual(await cl.refresh(600), { ok: false, error: 401 }, 'refresh with the old credential refused');
  const again = await client(cred); assert.deepEqual(await again.allocate(), { ok: false, error: 401 }, 'a new allocation with the old credential refused'); again.close();
  assert.equal((await ice(r, 'sue')).status, 403, 'a suspended account is issued no relay credential'); assert.equal((await ice(r2, 'sue')).status, 403, '...on any instance');
  assert.equal((await wcall(r, 'POST', '/v1/shield/admin/principals/sue/restore')).status, 200);
  const back = await ice(r, 'sue'); assert.equal(back.status, 200); assert.notEqual(back.turn.username, cred.username, 'restoring issues a NEW credential');
  const old = await client(cred); assert.equal((await old.allocate()).ok, false, 'the old credential stays dead after restore'); old.close();
  const fresh = await client({ username: back.turn.username, credential: back.turn.credential }); assert.equal((await fresh.allocate()).ok, true, 'the new credential works'); fresh.close(); cl.close(); peer.close();
  evidence.results.suspendEndsMedia = { packetsBeforeSuspend: flowed, packetsAfterSuspend: 0, suspendReturnedMs: done, oldCredentialAllocate: 401, oldCredentialRefresh: 401 };
});

test('organization suspension and administrative disable also end media; a repeat suspension is harmless', async (t) => {
  if (skip(t)) return;
  assert.equal((await wcall(r, 'PUT', '/v1/shield/admin/orgs', { orgId: 'acme' })).status, 200); await person('olga', { orgId: 'acme' }); await person('omar', { orgId: 'acme' }); await person('dina');
  const open = async (id) => { const g = await ice(r, id); assert.equal(g.status, 200); const c = await client({ username: g.turn.username, credential: g.turn.credential }); assert.equal((await c.allocate()).ok, true); return { c, g }; };
  const [o1, o2, d1] = [await open('olga'), await open('omar'), await open('dina')];
  assert.equal((await wcall(r, 'POST', '/v1/shield/admin/orgs/acme/suspend')).status, 200);
  for (const x of [o1, o2]) assert.deepEqual(await x.c.refresh(600), { ok: false, error: 401 }, 'every member of a suspended organization loses its allocation');
  assert.equal((await ice(r, 'olga')).status, 403);
  assert.equal((await r.admin('POST', '/identities/dina/enabled', { enabled: false })).status, 200); assert.deepEqual(await d1.c.refresh(600), { ok: false, error: 401 }, 'administrative disable ends the allocation'); assert.equal((await ice(r, 'dina')).status, 403);
  assert.equal((await wcall(r, 'POST', '/v1/shield/admin/orgs/acme/suspend')).status, 200, 'repeat is harmless'); for (const x of [o1, o2, d1]) x.c.close();
});

test('the suspension holds across an engine restart and across instances: a credential issued by one instance is revoked by another, and a restarted engine still refuses it', async (t) => {
  if (skip(t)) return;
  await person('ivan');
  const g = await ice(r2, 'ivan'); assert.equal(g.status, 200); const cred = { username: g.turn.username, credential: g.turn.credential }, c = await client(cred), peer = await udpPeer(); const al = await c.allocate(); assert.equal(al.ok, true); await c.permit(T.gateway);
  peer.sock.send('x', al.relay.port, '127.0.0.1'); assert.ok(await until(() => c.data.length >= 1));
  assert.equal((await wcall(r, 'POST', '/v1/shield/admin/principals/ivan/suspend')).status, 200, 'instance A suspends what instance B issued');
  c.data.length = 0; peer.sock.send('y', al.relay.port, '127.0.0.1'); await wait(500); assert.equal(c.data.length, 0, 'media stopped');
  await r.stop(); await r2.stop();                                                                                             // both instances die; nothing in memory survives
  const n1 = await h.replica({ outbox: true, maintenance: true, env: BASE() }); r = n1;
  assert.equal((await ice(n1, 'ivan')).status, 403, 'the restarted engine issues nothing to the suspended account');
  const old = await client(cred); assert.equal((await old.allocate()).ok, false, 'the old credential is still dead after the restart'); old.close(); c.close(); peer.close();
  r2 = await h.replica({ outbox: false, maintenance: false, env: BASE() });
  evidence.results.restartAndMultiInstance = { issuedBy: 'instance-B', revokedBy: 'instance-A', afterRestartIssue: 403, afterRestartOldCredential: 401 };
});

test('a relay the engine cannot reach is NOT silent: credentials are still deleted (no new allocation) and a critical media_termination_failure alert is recorded; a bad configuration refuses to start; A3.8 cannot be switched on', async (t) => {
  if (skip(t)) return;
  const broken = await h.replica({ outbox: false, maintenance: false, env: BASE({ TURN_CLI_PORT: '1', TURN_CLI_TIMEOUT_MS: '800' }) });
  await person('nina'); const g = await ice(broken, 'nina'); assert.equal(g.status, 200); const cred = { username: g.turn.username, credential: g.turn.credential };
  assert.equal((await wcall(broken, 'POST', '/v1/shield/admin/principals/nina/suspend')).status, 200, 'the suspension itself still commits');
  const c = await client(cred); assert.equal((await c.allocate()).ok, false, 'no NEW allocation is possible even though live ones could not be cancelled'); c.close();
  const alert = await until(async () => (await db.pool.query("SELECT severity, occurrences FROM shield_alerts WHERE kind='media_termination_failure' AND dedupe_key LIKE '%|nina'")).rows[0]);
  assert.ok(alert, 'alert recorded'); assert.equal(alert.severity, 'critical');
  await assert.rejects(h.replica({ outbox: false, maintenance: false, env: { ...BASE(), TURN_USERDB_REDIS_URL: '' } }), /TURN_AUTH_MODE=userdb needs/);
  await assert.rejects(h.replica({ outbox: false, maintenance: false, env: { ...BASE(), TURN_CREDENTIAL_SECRET: 'short' } }), /at least 32/);
  await assert.rejects(h.replica({ outbox: false, maintenance: false, env: BASE({ VOICE_A38_ENABLED: 'true' }) }), /VOICE_A38_ENABLED=true/);
  await person('zed'); for (const v of [undefined, 'false', 'TRUE']) { const ok = await h.replica({ outbox: false, maintenance: false, env: BASE(v === undefined ? {} : { VOICE_A38_ENABLED: v }) }); assert.equal((await ok.api('zed', 'GET', '/v1/voice/features')).body.countryAlias, false); }
  evidence.results.relayUnreachable = { newAllocationRefused: true, alert: 'media_termination_failure/critical' };
});
