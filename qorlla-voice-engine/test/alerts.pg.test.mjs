// A3.5 durable security alerts: real certificates (openssl), the real mutual-TLS listener, real PostgreSQL, real user and workload credentials.
// Alerts are DERIVED inside PostgreSQL from the append-only shield_events rows (no second event authority); notifications go through a transactional outbox with at-least-once delivery.
// Not proven here: paging a human (the sink is a local test webhook), alert routing/on-call tooling, or retention policy for shield_events.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { exportJWK, importSPKI } from 'jose';
import { isolatedDb, identityProvider } from './helpers.mjs';
import { harness, until, ADMIN } from './harness.mjs';
import { signWorkloadJwt } from '../../qorlla-meet-video/server/telephony/number-sync.mjs';
import { certThumbprint } from '../../qorlla-meet-video/server/telephony/workload-transport.mjs';

const ISSUER = 'qorlla-workload', SECRET = 'w'.repeat(40);
let db, idp, h, r, dir, pki = {}, pem, jwksSrv, jwksUrl, mtlsPort, hook, hookStatus = [500, 200], received = [];       // the receiver fails once, then recovers
const ossl = (...a) => { const x = spawnSync('openssl', a, { encoding: 'utf8' }); if (x.status !== 0) throw new Error('openssl: ' + x.stderr); };
function pkiInit() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalert-')); const f = (n) => path.join(dir, n);
  ossl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', f('ca.key'), '-out', f('ca.crt'), '-subj', '/CN=alert-ca', '-days', '2');
  const leaf = (name, server) => { ossl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', f(name + '.key'), '-out', f(name + '.csr'), '-subj', '/CN=' + name); fs.writeFileSync(f(name + '.ext'), server ? 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' : 'extendedKeyUsage=clientAuth\n'); ossl('x509', '-req', '-in', f(name + '.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f(name + '.crt'), '-days', '2', '-extfile', f(name + '.ext')); };
  leaf('server', true); leaf('good'); leaf('other');
  for (const n of ['ca', 'server', 'good', 'other']) pki[n] = { cert: fs.readFileSync(f(n + '.crt')), key: fs.readFileSync(f(n + '.key')) };
}
async function workload() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = { ...(await exportJWK(await importSPKI(publicKey.export({ type: 'spki', format: 'pem' }), 'ES256'))), kid: 'w1', alg: 'ES256', use: 'sig' };
  const srv = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); }); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), srv, url: 'http://127.0.0.1:' + srv.address().port + '/jwks.json' };
}
const over = (client, token, p, body, method = 'POST') => new Promise((ok) => {
  const req = https.request({ host: '127.0.0.1', port: mtlsPort, path: p, method, ca: pki.ca.cert, ...(client ? { cert: pki[client].cert, key: pki[client].key } : {}), headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, timeout: 8000 }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok({ status: res.statusCode, body: (() => { try { return JSON.parse(d); } catch { return {}; } })() })); });
  req.on('error', (e) => ok({ tlsError: e.code || e.message })); req.end(body === undefined ? undefined : JSON.stringify(body));
});
const tok = (sub, bound, o = {}) => signWorkloadJwt({ privateKeyPem: pem, kid: 'w1', issuer: ISSUER, subject: sub, cnfThumbprint: bound ? certThumbprint(pki[bound].cert) : undefined, ...o });
const good = (sub = 'svc:good') => tok(sub, 'good');
const list = async (q = '?state=active') => (await over('good', good(), '/v1/shield/alerts' + q, undefined, 'GET')).body.alerts || [];
const find = (alerts, kind, f = () => true) => alerts.filter((a) => a.kind === kind && f(a));
const waitAlert = (kind, f) => until(async () => find(await list(), kind, f)[0] || null, 8000);

before(async () => {
  db = await isolatedDb(); if (!db) return; pkiInit(); idp = await identityProvider(); const w = await workload(); pem = w.pem; jwksSrv = w.srv; jwksUrl = w.url; h = harness({ db, idp });
  hook = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { received.push({ headers: req.headers, body: b }); const s = hookStatus.length > 1 ? hookStatus.shift() : hookStatus[0]; res.statusCode = s; res.end('{}'); }); }); await new Promise((ok) => hook.listen(0, '127.0.0.1', ok));
  r = await h.replica({ env: { SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true', SHIELD_REQUIRE_MTLS: 'true', SHIELD_WORKLOAD_JWKS_URL: jwksUrl, SHIELD_WORKLOAD_ISSUER: ISSUER,
    SHIELD_WORKLOAD_ALLOWED: 'svc:good=shield.admin|shield.suspend|voice.admin|shield.cert.revoke|alerts.read|alerts.ack|alerts.report;svc:lowly=voice.admin;svc:meet=alerts.report;svc:reader=alerts.read',
    SHIELD_ALERT_INTERVAL_SECONDS: '1', SHIELD_ALERT_ESCALATE_CRITICAL_SECONDS: '2', SHIELD_ALERT_ESCALATE_HIGH_SECONDS: '600', SHIELD_ALERT_REPEAT_SECONDS: '600',
    SHIELD_ALERT_WEBHOOK_URL: 'http://127.0.0.1:' + hook.address().port + '/alerts', SHIELD_ALERT_WEBHOOK_SECRET: SECRET } });
  mtlsPort = await r.voice.listenMtls(0, '127.0.0.1', { key: pki.server.key, cert: pki.server.cert, ca: pki.ca.cert });
});
after(async () => { if (h) await h.closeAll(); if (idp) await idp.close(); if (jwksSrv) await new Promise((ok) => jwksSrv.close(ok)); if (hook) await new Promise((ok) => { hook.close(ok); hook.closeAllConnections?.(); }); if (db) await db.drop(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const skip = (t) => !db && t.skip('no PostgreSQL reachable (or openssl missing)');

test('EVERY required alert is raised, with severity, event ids, workload/tenant context, occurrence count, first/last time, acknowledgement and escalation state', async (t) => {
  if (skip(t)) return;
  // certificate failure at the TLS layer (no client certificate)
  assert.ok((await over(null, good(), '/v1/shield/admin/principals', { accountId: 'x' }, 'PUT')).tlsError); const tls = await waitAlert('certificate_failure');
  assert.ok(tls, 'handshake refusal alerted'); assert.equal(tls.severity, 'medium'); assert.equal(tls.context.ip, '127.0.0.1'); assert.equal(tls.ackState, 'open'); assert.equal(tls.occurrences, 1); assert.match(tls.eventId, /^[0-9]+$/); assert.equal(tls.escalation, 'none');
  // workload-token binding failure: a token bound to certificate A used on certificate B
  assert.equal((await over('other', tok('svc:good', 'good'), '/v1/shield/admin/principals', { accountId: 'x', verified: true }, 'PUT')).status, 401);
  const bind = await waitAlert('workload_token_binding_failure'); assert.equal(bind.severity, 'high'); assert.equal(bind.context.workload, 'svc:good'); assert.equal(bind.escalation, 'pending'); assert.ok(bind.firstAt && bind.lastAt);
  // replay
  const once = tok('svc:good', 'good'); assert.equal((await over('good', once, '/v1/shield/admin/principals', { accountId: 'x', verified: true }, 'PUT')).status, 200); assert.equal((await over('good', once, '/v1/shield/admin/principals', { accountId: 'x', verified: true }, 'PUT')).status, 401);
  const rep = await waitAlert('workload_replay_rejected'); assert.equal(rep.severity, 'high'); assert.equal(rep.context.workload, 'svc:good');
  // revoked certificate used afterwards (critical)
  assert.equal((await over('good', good(), '/v1/shield/admin/certs/revoke', { thumbprint: certThumbprint(pki.other.cert), reason: 'lost laptop' })).status, 200);
  assert.equal((await over('other', tok('svc:good', 'other'), '/v1/shield/admin/principals', { accountId: 'x', verified: true }, 'PUT')).status, 401);
  const rev = await waitAlert('revoked_certificate_attempt'); assert.equal(rev.severity, 'critical'); assert.equal(rev.context.detail.discriminator, certThumbprint(pki.other.cert), 'distinct certificates are distinct incidents'); assert.equal(rev.escalation, 'pending');
  // a workload without the suspension scope tries to suspend (critical); another without general scope is a plain unauthorized workload
  assert.equal((await over('good', tok('svc:lowly', 'good'), '/v1/shield/admin/principals/x/suspend', {})).status, 403); const sus = await waitAlert('unauthorized_suspension_attempt'); assert.equal(sus.severity, 'critical'); assert.equal(sus.context.workload, 'svc:lowly');
  assert.equal((await over('good', tok('svc:lowly', 'good'), '/v1/shield/admin/principals', { accountId: 'x' }, 'PUT')).status, 403); assert.ok(await waitAlert('workload_not_authorized'));
  // cross-tenant call attempt, recorded although the request's own transaction is rolled back
  for (const [id, org] of [['ann', 'orgA'], ['cal', 'orgB'], ['dee', 'orgC']]) { await over('good', good(), '/v1/shield/admin/orgs', { orgId: org }, 'PUT'); await over('good', good(), '/v1/shield/admin/principals', { accountId: id, orgId: org, verified: true }, 'PUT'); }
  await r.admin('POST', '/identities', { accountId: 'ann' }); const ec = (await r.admin('POST', '/identities', { accountId: 'cal' })).body.identity.extension, ed = (await r.admin('POST', '/identities', { accountId: 'dee' })).body.identity.extension;
  assert.equal((await r.dial('ann', ec)).status, 404, 'the caller is told only "no such recipient"');
  const x1 = await waitAlert('cross_tenant_attempt'); assert.equal(x1.severity, 'high'); assert.equal(x1.context.account, 'ann'); assert.equal(x1.context.tenant, 'orgA'); assert.equal(x1.context.detail.discriminator ?? 'to:orgB', 'to:orgB');
  // signaling termination failure and outbox delivery failure reported by Meet / Numbers & Plans (their own workload identity, its own scope)
  assert.equal((await over('good', tok('svc:meet', 'good'), '/v1/shield/report', { kind: 'signaling_termination_failed', source: 'meet', ref: 'meeting-1' })).status, 200); const term = await waitAlert('signaling_termination_failure'); assert.equal(term.severity, 'critical'); assert.equal(term.context.workload, 'svc:meet');
  assert.equal((await over('good', tok('svc:meet', 'good'), '/v1/shield/report', { kind: 'outbox_delivery_failed', source: 'numbers-plans' })).status, 200); assert.ok(await waitAlert('outbox_delivery_failure', (a) => a.context.workload === 'svc:meet'));
  // the engine's own outbox monitor (dead events, lag) feeds the same path
  const ev = await r.voice.shield.evaluateAlerts({ queueStats: async () => ({ dead: 3, pending: 3, oldestSeconds: 9999 }) }); assert.deepEqual(ev.emitted.sort(), ['dead', 'lag']);
  assert.equal((await r.voice.shield.evaluateAlerts({ queueStats: async () => ({ dead: 3, pending: 3, oldestSeconds: 9999 }) })).emitted.length, 0, 'a persistent fault is not re-emitted every cycle');
  assert.equal(find(await list(), 'outbox_delivery_failure', (a) => a.context.account === 'voice-engine').length, 2, 'dead events and lag are distinct incidents');
  // a distinct incident is never merged: the same kind towards ANOTHER tenant is its own alert
  assert.equal((await r.dial('ann', ed)).status, 404); await until(async () => find(await list(), 'cross_tenant_attempt').length === 2, 6000); assert.equal(find(await list(), 'cross_tenant_attempt').length, 2);
});

test('DEDUPLICATION without suppression: repeats are counted, distinct incidents stay separate, an acknowledged alert that recurs is reopened and announced, a resolved one starts a new alert', async (t) => {
  if (skip(t)) return;
  const fire = (sub) => over('good', tok(sub, 'good'), '/v1/shield/admin/principals/x/suspend', {});
  const base = (await list()).find((a) => a.kind === 'unauthorized_suspension_attempt' && a.context.workload === 'svc:lowly'); assert.ok(base); const before = base.occurrences;
  for (let i = 0; i < 4; i++) assert.equal((await fire('svc:lowly')).status, 403);
  const rep = (await list()).find((a) => a.alertId === base.alertId); assert.equal(rep.occurrences, before + 4, 'counted'); assert.ok(BigInt(rep.eventId) > BigInt(rep.firstEventId), 'last event is newer than the first'); assert.ok(new Date(rep.lastAt) >= new Date(rep.firstAt));
  assert.equal(find(await list(), 'unauthorized_suspension_attempt', (a) => a.context.workload === 'svc:lowly').length, 1, 'one alert, not five');
  assert.equal((await fire('svc:reader')).status, 403); assert.equal(find(await list(), 'unauthorized_suspension_attempt').length, 2, 'a different workload is a different incident');
  // acknowledge: recorded with who and when; the evidence is in the append-only log
  const ack = await over('good', good(), `/v1/shield/alerts/${base.alertId}/ack`, { note: 'looking into it' }); assert.equal(ack.status, 200); assert.equal(ack.body.ackState, 'acknowledged'); assert.equal(ack.body.acknowledgedBy, 'svc:good');
  assert.equal((await over('good', good(), `/v1/shield/alerts/${base.alertId}/ack`, {})).status, 409, 'not acknowledged twice');
  assert.ok((await db.pool.query("SELECT 1 FROM shield_events WHERE action='alert.ack' AND actor='svc:good'")).rowCount);
  // it recurs: reopened (not silently absorbed) and announced
  assert.equal((await fire('svc:lowly')).status, 403); const re = (await list()).find((a) => a.alertId === base.alertId); assert.equal(re.ackState, 'open'); assert.equal(re.reopenCount, 1);
  assert.equal((await db.pool.query("SELECT count(*)::int AS c FROM shield_alert_outbox WHERE alert_id=$1 AND kind='reopened'", [base.alertId])).rows[0].c, 1);
  // resolve: history; the next occurrence is a NEW alert
  assert.equal((await over('good', good(), `/v1/shield/alerts/${base.alertId}/resolve`, { note: 'fixed the allow-list' })).body.ackState, 'resolved'); assert.equal((await fire('svc:lowly')).status, 403);
  const fresh = (await list()).find((a) => a.kind === 'unauthorized_suspension_attempt' && a.context.workload === 'svc:lowly'); assert.notEqual(fresh.alertId, base.alertId); assert.equal(fresh.occurrences, 1);
  assert.equal((await list('?state=resolved')).filter((a) => a.alertId === base.alertId).length, 1, 'the resolved alert is kept as history');
  // volume raises severity (and says so once): 50 occurrences of a "high" kind become critical
  for (let i = 0; i < 49; i++) await db.pool.query("INSERT INTO shield_events(actor, action, decision, reason, context) VALUES('svc:noisy','workload.voice.admin','DENY','WORKLOAD_NOT_AUTHORIZED',$1)", [JSON.stringify({ workload: 'svc:noisy' })]); await db.pool.query("INSERT INTO shield_events(actor, action, decision, reason, context) VALUES('svc:noisy','workload.voice.admin','DENY','WORKLOAD_NOT_AUTHORIZED',$1)", [JSON.stringify({ workload: 'svc:noisy' })]);
  const noisy = (await list()).find((a) => a.context.workload === 'svc:noisy'); assert.equal(noisy.occurrences, 50); assert.equal(noisy.severity, 'critical'); assert.equal((await db.pool.query("SELECT count(*)::int AS c FROM shield_alert_outbox WHERE alert_id=$1 AND kind='severity_raised'", [noisy.alertId])).rows[0].c, 1);
  assert.equal((await db.pool.query("SELECT count(*)::int AS c FROM shield_alert_outbox WHERE alert_id=$1", [noisy.alertId])).rows[0].c, 2, '50 events produced 2 notifications (opened, severity raised), not 50');
});

test('ESCALATION and NOTIFICATIONS: an unacknowledged critical alert is escalated; an acknowledged one is not; notifications are delivered at least once with a signature and survive a failing receiver', async (t) => {
  if (skip(t)) return;
  const crit = await waitAlert('revoked_certificate_attempt'); assert.equal(crit.ackState, 'open');
  const escalated = await until(async () => (await list()).find((a) => a.alertId === crit.alertId && a.escalation === 'escalated'), 10000); assert.ok(escalated, 'escalated after the (test) threshold'); assert.ok(escalated.escalatedAt);
  assert.ok((await db.pool.query("SELECT 1 FROM shield_alert_outbox WHERE alert_id=$1 AND kind='escalated'", [crit.alertId])).rowCount, 'an escalation notification exists');
  // acknowledged before the threshold: never escalated
  await over('good', tok('svc:lowly', 'good'), '/v1/shield/admin/orgs/x/suspend', {}); const quiet = (await list()).find((a) => a.kind === 'unauthorized_suspension_attempt' && a.context.workload === 'svc:lowly'); assert.ok(quiet);
  const key = await db.pool.query("INSERT INTO shield_events(actor, action, decision, reason, context) VALUES('svc:quiet','workload.shield.suspend','DENY','WORKLOAD_NOT_AUTHORIZED',$1) RETURNING id", [JSON.stringify({ workload: 'svc:quiet' })]); assert.ok(key.rowCount);
  const q = (await list()).find((a) => a.context.workload === 'svc:quiet'); assert.equal((await over('good', good(), `/v1/shield/alerts/${q.alertId}/ack`, { note: 'known' })).status, 200); await new Promise((ok) => setTimeout(ok, 3500));
  assert.equal((await list('?state=acknowledged')).find((a) => a.alertId === q.alertId).escalation, 'pending', 'acknowledged alerts are not escalated');
  // delivery: the receiver failed first (500) and then recovered; every notification arrives eventually, signed
  const total = (await db.pool.query('SELECT count(*)::int AS c FROM shield_alert_outbox')).rows[0].c;
  assert.ok(await until(async () => (await db.pool.query('SELECT count(*)::int AS c FROM shield_alert_outbox WHERE delivered_at IS NULL')).rows[0].c === 0, 40000), 'all notifications were delivered');
  assert.ok(received.length >= total, 'at least once: ' + received.length + ' deliveries for ' + total + ' notifications'); assert.ok((await db.pool.query('SELECT count(*)::int AS c FROM shield_alert_outbox WHERE attempts >= 2')).rows[0].c >= 1, 'a failed delivery was retried');
  for (const d of received.slice(0, 5)) { const ts = d.headers['x-qorlla-timestamp'], sig = d.headers['x-qorlla-signature']; assert.equal(sig, 'sha256=' + createHmac('sha256', SECRET).update(ts + '.' + d.body).digest('hex'), 'signed'); const p = JSON.parse(d.body); assert.ok(p.notificationId && p.alert.alertId && p.alert.severity && ['opened', 'reopened', 'severity_raised', 'escalated'].includes(p.kind)); assert.ok(!/BEGIN|Bearer|eyJ/.test(d.body), 'no secrets in notifications'); }
  assert.ok(new Set(received.map((d) => JSON.parse(d.body).notificationId)).size >= total, 'receivers can de-duplicate by notificationId');
});

test('ACCESS and INTEGRITY: the alert API needs its own scopes and a bound certificate; reports are limited to known kinds; the evidence stays append-only and free of secrets; metrics expose the counts', async (t) => {
  if (skip(t)) return;
  assert.equal((await over('good', undefined, '/v1/shield/alerts', undefined, 'GET')).status, 401); assert.equal((await over('good', tok('svc:lowly', 'good'), '/v1/shield/alerts', undefined, 'GET')).status, 403, 'a workload without alerts.read');
  assert.equal((await over('good', tok('svc:reader', 'good'), '/v1/shield/alerts', undefined, 'GET')).status, 200, 'alerts.read can read'); const some = (await list())[0];
  assert.equal((await over('good', tok('svc:reader', 'good'), `/v1/shield/alerts/${some.alertId}/ack`, {})).status, 403, 'reading does not allow acknowledging'); assert.equal((await over('good', tok('svc:meet', 'good'), '/v1/shield/alerts', undefined, 'GET')).status, 403, 'reporting does not allow reading');
  assert.equal((await over('good', good(), '/v1/shield/alerts?state=bogus', undefined, 'GET')).status, 400); assert.equal((await over('good', good(), '/v1/shield/alerts/not-a-uuid/ack', {})).status, 400); assert.equal((await over('good', good(), `/v1/shield/alerts/${randomUUID()}/ack`, {})).status, 409);
  assert.equal((await over('good', tok('svc:meet', 'good'), '/v1/shield/report', { kind: 'made_up', source: 'x' })).status, 400, 'only known report kinds'); assert.equal((await over('good', tok('svc:meet', 'good'), '/v1/shield/report', { kind: 'outbox_delivery_failed', source: 'bad source!' })).status, 400);
  assert.equal((await fetch(r.base + '/v1/shield/alerts', { headers: { authorization: 'Bearer ' + await idp.token('ann') } })).status, 401, 'an end-user token is not a workload credential');
  for (const sql of ["UPDATE shield_events SET reason='x'", 'DELETE FROM shield_events', 'TRUNCATE shield_events']) await assert.rejects(db.pool.query(sql), /append-only/);
  const log = JSON.stringify((await db.pool.query('SELECT context, actor, reason FROM shield_events')).rows); assert.ok(!/BEGIN (CERTIFICATE|PRIVATE)|Bearer|eyJ[A-Za-z0-9_-]{20}/.test(log), 'no tokens or key material in the evidence');
  const m = await fetch(r.base + '/v1/voice/admin/metrics?format=prometheus', { headers: { 'x-voice-admin-secret': ADMIN } }).then((x) => x.text()); assert.match(m, /qorlla_shield_alerts_active\{severity="critical"\} [1-9]/); assert.match(m, /qorlla_shield_alert_notifications_pending/); assert.match(m, /qorlla_shield_tls_refusals_dropped_total/);
});
