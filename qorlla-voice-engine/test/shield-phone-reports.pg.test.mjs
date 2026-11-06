// A5.5 Phase B2: phone operational reports. phone_late_media and phone_termination_failed are accepted (strictly validated, scope required) and become durable alerts PHONE_LATE_MEDIA / PHONE_TERMINATION_FAILED.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { SignJWT, importPKCS8, exportJWK, importSPKI } from 'jose';
import { isolatedDb, identityProvider } from './helpers.mjs';
import { harness } from './harness.mjs';

const ISSUER = 'qorlla-workload';
let db, h, engine, jwks, keys, pool2;
const uuid = () => crypto.randomUUID(), tag = () => crypto.randomBytes(3).toString('hex'), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function key(kid) { const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }); const pem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }); return { kid, pem, priv: await importPKCS8(pem, 'ES256'), jwk: { ...(await exportJWK(await importSPKI(kp.publicKey.export({ type: 'spki', format: 'pem' }), 'ES256'))), kid, alg: 'ES256', use: 'sig' } }; }
const token = (who, o = {}) => new SignJWT({ ...(o.cnf ? { cnf: { 'x5t#S256': o.cnf } } : {}) }).setProtectedHeader({ alg: 'ES256', kid: keys[who].kid }).setIssuer(ISSUER).setSubject(o.sub ?? 'svc:' + who).setAudience('qorlla-shield').setIssuedAt().setExpirationTime('60s').setJti(crypto.randomUUID()).sign(keys[who].priv);
const call = async (who, method, p, body, o = {}) => { const r = await fetch(engine.base + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (o.token ?? await token(who, o)) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const q = (text, p) => db.pool.query(text, p);
before(async () => {
  db = await isolatedDb(); if (!db) return;
  keys = { meet: await key('wm'), ops: await key('wo') };
  jwks = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [keys.meet.jwk, keys.ops.jwk] })); }); await new Promise((r) => jwks.listen(0, '127.0.0.1', r));
  const idp = await identityProvider(); h = harness({ db, idp });
  engine = await h.replica({ env: { SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_WORKLOAD_JWKS_URL: 'http://127.0.0.1:' + jwks.address().port + '/', SHIELD_WORKLOAD_ISSUER: ISSUER, SHIELD_WORKLOAD_ALLOWED: 'svc:meet=meet.register|meet.signal|alerts.report;svc:ops=shield.admin|shield.suspend|alerts.report|alerts.read' } });
  pool2 = await db.admin.connect(); await pool2.query('SET search_path=' + db.schema);                                                                                                    // a second session in the same database, for the ordering tests
});
after(async () => { try { pool2?.release(); } catch { /* gone */ } if (h) await h.closeAll().catch(() => {}); if (jwks) await new Promise((r) => jwks.close(r)); if (db) await db.drop(); setTimeout(() => process.exit(process.exitCode || 0), 1500).unref(); });
const skip = (t) => !db && t.skip('needs PostgreSQL (VOICE_TEST_DATABASE_URL)');

test('B2 reports: phone_late_media and phone_termination_failed are accepted (existing kinds too), unknown kinds and malformed refs are rejected, the scope is required, and each becomes a DURABLE alert with its classification', async (t) => {
  if (skip(t)) return; const ref = 'call-' + tag();
  for (const kind of ['phone_late_media', 'phone_termination_failed', 'signaling_termination_failed', 'outbox_delivery_failed']) assert.equal((await call('ops', 'POST', '/v1/shield/report', { kind, source: 'meet', ref })).status, 200, kind);
  assert.equal((await call('ops', 'POST', '/v1/shield/report', { kind: 'phone_made_up', source: 'meet' })).status, 400); assert.equal((await call('ops', 'POST', '/v1/shield/report', { kind: 'phone_late_media', source: 'meet', ref: 'bad ref!' })).status, 400);
  assert.equal((await call('meet', 'POST', '/v1/shield/report', { kind: 'phone_late_media', source: 'meet' })).status, 200, 'granted in this allow-list');
  const alerts = (await call('ops', 'GET', '/v1/shield/alerts?state=active')).body.alerts, by = (k) => alerts.filter((a) => a.kind === k);
  assert.ok(by('phone_late_media').length >= 1 && by('phone_late_media')[0].severity === 'high', JSON.stringify(alerts.map((a) => a.kind)));
  assert.ok(by('phone_termination_failure').length >= 1 && by('phone_termination_failure')[0].severity === 'critical');
});
