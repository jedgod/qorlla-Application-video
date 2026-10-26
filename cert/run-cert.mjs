// Qorlla Meet + MAIN certification runner (C01-C24 + R01-R05).
// Drives the REAL stack: MAIN (Docker, :5000) + sync worker (Docker) + main PostgreSQL (Docker) + Meet (node, :3000)
// + Meet PostgreSQL (Docker), plus Chromium for browser checks. Writes cert/evidence.json and cert/EVIDENCE.md.
// Usage: node cert/run-cert.mjs <path-to-cert.env>    (see cert/README.md)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = process.argv[2];
if (!envFile) throw new Error('Usage: node cert/run-cert.mjs <cert.env>');
const ENV = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

const MAIN = 'http://localhost:5000';
const MEET = 'http://localhost:3000';
const MEET_DB_URL = 'postgres://qorlla:qorlla_dev_only@127.0.0.1:25501/qorlla_meet';
const MAIN_DB_CT = 'qcert-main-db-1';
const WORKER_CT = 'qcert-meet-sync-worker-1';
const MAIN_CT = 'zoom_core_backend_instance';
const BRIDGE = { 'x-qorlla-bridge-secret': ENV.QORLLA_BRIDGE_SECRET, 'content-type': 'application/json' };

const RUN = crypto.randomBytes(3).toString('hex');
// Retry stale keep-alive socket resets (a client-side artifact; the server never saw the request)
const origFetch = globalThis.fetch;
globalThis.fetch = async (...a) => { for (let i = 0; ; i++) { try { return await origFetch(...a); } catch (e) { if (i >= 2 || e.cause?.code !== 'ECONNRESET') throw e; await new Promise((r) => setTimeout(r, 300)); } } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const mainSql = (sql) => docker('exec', MAIN_DB_CT, 'psql', '-U', 'qorlla_main', '-d', 'qorlla_main', '-tAc', sql).trim();
const meetDb = new pg.Pool({ connectionString: MEET_DB_URL });

// ---------- Meet process management ----------
let meetProc = null;
function startMeet() {
  if (meetProc) return;
  const log = fs.openSync(path.join(root, 'cert', 'meet.log'), 'a');
  meetProc = spawn('node', ['server/index.js'], {
    cwd: path.join(root, 'qorlla-meet-video'), stdio: ['ignore', log, log],
    env: { ...process.env, PORT: '3000', DATABASE_URL: MEET_DB_URL, CORS_ORIGIN: 'http://localhost:3000', JWT_SECRET: ENV.JWT_SECRET, QORLLA_BRIDGE_SECRET: ENV.QORLLA_BRIDGE_SECRET, RECOVERY_ESCROW_KEY: ENV.RECOVERY_ESCROW_KEY }
  });
}
async function stopMeet() {
  if (!meetProc) return;
  const p = meetProc; meetProc = null;
  await new Promise((r) => { p.once('exit', r); p.kill(); setTimeout(r, 3000); });
}
async function waitFor(fn, { timeout = 60000, every = 500, what = 'condition' } = {}) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; last = v; } catch (e) { last = e.message; } await sleep(every); }
  throw new Error(`Timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}
const meetReady = () => waitFor(async () => (await fetch(MEET + '/api/health')).ok, { what: 'Meet up' });
const workerStop = () => docker('stop', WORKER_CT);
const workerStart = () => docker('start', WORKER_CT);

// After every check, put shared services back so one failure cannot cascade into later checks.
async function restoreStack() {
  try { if (!meetProc) { startMeet(); await meetReady(); } } catch {}
  try { workerStart(); } catch {}
}
// ---------- evidence ----------
const results = [];
async function check(id, name, fn) {
  const t0 = new Date().toISOString();
  try { const detail = await fn(); results.push({ id, name, status: 'PASS', startedAt: t0, detail: detail ?? '' }); console.log('PASS', id, name); }
  catch (e) { const d = String(e.message || e) + (e.cause ? ' [cause: ' + (e.cause.code || e.cause.message) + ']' : ''); results.push({ id, name, status: 'FAIL', startedAt: t0, detail: d.slice(0, 600) }); console.log('FAIL', id, name, '-', d.slice(0, 300)); await restoreStack(); }
}
const blocked = (id, name, why) => { results.push({ id, name, status: 'NOT RUN', startedAt: new Date().toISOString(), detail: why }); console.log('NOT RUN', id, name); };
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

// ---------- MAIN client (cookie session) ----------
class Main {
  constructor() { this.cookie = ''; }
  async req(method, url, body) {
    const r = await fetch(MAIN + url, { method, headers: { 'content-type': 'application/json', cookie: this.cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie?.() || []; if (sc.length) this.cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  }
  async register() {
    const u = 'cert' + crypto.randomBytes(4).toString('hex');
    const r = await this.req('POST', '/api/auth/register', { username: u, displayName: 'Cert Host', password: 'Cert-Pass-' + crypto.randomBytes(6).toString('hex') + '!9' });
    assert(r.status === 201, 'register failed ' + JSON.stringify(r.data)); this.user = u; this.password = null; return this;
  }
  schedule(extra = {}) { return this.req('POST', '/api/workplace/schedule', { title: 'Cert ' + crypto.randomBytes(3).toString('hex'), date: '2026-12-01', time: '10:00', duration: 30, ...extra }); }
  list() { return this.req('GET', '/api/workplace/schedule').then((r) => r.data); }
  async untilStatus(id, status, timeout = 90000) { return waitFor(async () => (await this.list()).find((s) => s.id === id && s.syncStatus === status), { timeout, what: `${id} ${status}` }); }
}
const bridge = (method, p, body) => fetch(MEET + p, { method, headers: BRIDGE, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
const meetJoin = (idOrCode, body) => fetch(MEET + '/api/meetings/' + encodeURIComponent(idOrCode) + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
const resolveCode = (code) => fetch(MEET + '/api/resolve/' + encodeURIComponent(code)).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
const claims = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const digits = (s) => String(s).replace(/\D/g, '');
function openVault(sourceId) {
  const row = mainSql(`SELECT ciphertext||'|'||iv||'|'||tag FROM qorlla_host_vault WHERE source_id='${sourceId}'`);
  if (!row) return null;
  const [ct, iv, tag] = row.split('|');
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENV.QORLLA_VAULT_KEY, 'base64'), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString();
}

// ---------- git evidence ----------
const GIT = process.env.GIT_EXE || (fs.existsSync('C:/Program Files/Git/mingw64/bin/git.exe') ? 'C:/Program Files/Git/mingw64/bin/git.exe' : 'git');
const git = (...a) => execFileSync(GIT, a, { cwd: root, encoding: 'utf8' }).trim();
const sha = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain').split('\n').filter(Boolean);
const fileHash = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex').slice(0, 16);
const fingerprint = ['workplace.js', 'qorlla.html', 'Dockerfile', 'docker-compose.yml', 'meet-sync/src/worker.mjs', 'meet-sync/src/store.mjs', 'qorlla-meet-video/server/index.js', 'qorlla-meet-video/server/recovery-service.mjs'].map((f) => `${f}:${fileHash(f)}`);

// =====================================================================
const startedAt = new Date().toISOString();
await meetDb.query('SELECT 1');
startMeet(); await meetReady();
docker('start', WORKER_CT); // ensure running
const host = await new Main().register();
let A = null; // primary synced schedule used by several checks

await check('C01', 'New schedule creates a Meet mapping (pending_sync -> synced, DB rows)', async () => {
  const r = await host.schedule({ title: 'Cert primary', passcode: 'cert-passcode-1' });
  assert(r.status === 201, 'create ' + r.status + JSON.stringify(r.data));
  assert(r.data.syncStatus === 'pending_sync', 'not pending at create');
  assert(!JSON.stringify(r.data).includes('hostSecret') && !('passcode' in r.data), 'secret leaked to browser payload');
  A = await host.untilStatus(r.data.id, 'synced');
  const link = await meetDb.query("SELECT m.id,m.meeting_code,m.passcode_hash FROM external_meeting_links l JOIN meetings m ON m.id=l.meeting_id WHERE l.source_id=$1", [A.id]);
  assert(link.rowCount === 1 && link.rows[0].meeting_code === A.meetCode, 'meet row missing/mismatch');
  assert(link.rows[0].passcode_hash?.startsWith('$2'), 'passcode hash not stored in Meet');
  A.uuid = link.rows[0].id;
  return `source=${A.id} code=${A.meetCode} uuid=${A.uuid}`;
});
await check('C02', 'Retry/idempotency: re-registering same sourceId returns same mapping', async () => {
  const r = await bridge('POST', '/api/integrations/scheduled-meetings', { sourceId: A.id, title: 'Cert primary', ownerName: 'Cert Host', legacyCode: digits(A.meetingId) });
  assert(r.status === 200 && r.data.created === false && r.data.meetingId === A.uuid && r.data.meetingCode === A.meetCode, JSON.stringify(r));
  assert(!r.data.hostSecret, 'secret re-issued on retry');
});
await check('C03', 'Legacy (formatted) code resolves to the registered meeting', async () => {
  const r = await resolveCode(A.meetingId); assert(r.status === 200 && r.data.meetingId === A.uuid, JSON.stringify(r)); return A.meetingId;
});
await check('C04', 'Join via UUID and via numeric public code', async () => {
  const a = await meetJoin(A.uuid, { name: 'U', passcode: 'cert-passcode-1' }); const b = await meetJoin(A.meetCode, { name: 'N', passcode: 'cert-passcode-1' });
  assert(a.status === 200 && b.status === 200, `${a.status}/${b.status}`); assert(claims(a.data.token).role === 'guest', 'role');
  const spaced = await meetJoin(A.meetCode.replace(/(\d{3})(\d{4})(\d{5})/, '$1 $2-$3'), { name: 'S', passcode: 'cert-passcode-1' }); assert(spaced.status === 200, 'spaced ' + spaced.status);
});
await check('C14a', 'Passcode enforced server-side (wrong/missing -> 403, correct -> 200)', async () => {
  const w = await meetJoin(A.uuid, { name: 'X', passcode: 'wrong-pass' }); const m = await meetJoin(A.uuid, { name: 'X' });
  assert(w.status === 403 && m.status === 403, `${w.status}/${m.status}`);
});
await check('C05', 'Title/time update propagates to Meet', async () => {
  const r = await host.req('PUT', '/api/workplace/schedule/' + A.id, { title: 'Cert primary EDITED', time: '11:30' });
  assert(r.status === 200, 'put ' + r.status + JSON.stringify(r.data));
  await waitFor(async () => (await meetDb.query('SELECT m.title FROM external_meeting_links l JOIN meetings m ON m.id=l.meeting_id WHERE l.source_id=$1', [A.id])).rows[0]?.title === 'Cert primary EDITED', { what: 'title propagated' });
  const t = await meetDb.query("SELECT scheduled_at FROM external_meeting_links WHERE source_id=$1", [A.id]); assert(t.rows[0].scheduled_at, 'time not set');
  await host.untilStatus(A.id, 'synced');
});
await check('C07', 'Bridge rejects missing/wrong secret (401)', async () => {
  const bad = await fetch(MEET + '/api/integrations/scheduled-meetings/x', { headers: { 'x-qorlla-bridge-secret': 'nope' } });
  const none = await fetch(MEET + '/api/integrations/scheduled-meetings/x');
  const rec = await fetch(MEET + '/api/integrations/scheduled-meetings/x/recover-host', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert(bad.status === 401 && none.status === 401 && rec.status === 401, `${bad.status}/${none.status}/${rec.status}`);
});
await check('C08', 'Legacy-code collision returns 409 and does not remap', async () => {
  const r = await bridge('POST', '/api/integrations/scheduled-meetings', { sourceId: 'collide-' + crypto.randomBytes(3).toString('hex'), title: 'X', ownerName: 'H', legacyCode: digits(A.meetingId) });
  assert(r.status === 409, 'status ' + r.status); const res = await resolveCode(A.meetingId); assert(res.data.meetingId === A.uuid, 'mapping changed');
});
await check('C11', 'Simultaneous registration of one sourceId creates exactly one meeting', async () => {
  const sid = 'conc-' + crypto.randomBytes(3).toString('hex');
  const rs = await Promise.all(Array.from({ length: 12 }, () => bridge('POST', '/api/integrations/scheduled-meetings', { sourceId: sid, title: 'Conc', ownerName: 'H', legacyCode: String(Math.floor(1e10 + Math.random() * 9e10)) })));
  const created = rs.filter((r) => r.status === 201).length; const ids = new Set(rs.map((r) => r.data.meetingId));
  const n = (await meetDb.query('SELECT count(*)::int c FROM external_meeting_links WHERE source_id=$1', [sid])).rows[0].c;
  assert(n === 1 && ids.size === 1 && created === 1, `rows=${n} distinct=${ids.size} created=${created} statuses=${rs.map((r) => r.status)}`);
});
await check('C10', 'Meet restart keeps persisted mapping', async () => {
  await stopMeet(); startMeet(); await meetReady();
  const r = await resolveCode(A.meetingId); assert(r.status === 200 && r.data.meetingId === A.uuid, JSON.stringify(r));
});
await check('C06', 'Cancellation (delete in MAIN) ends the meeting and prevents joining', async () => {
  const r = await host.schedule({ title: 'Cert cancel' }); const S = await host.untilStatus(r.data.id, 'synced');
  const uuid = (await resolveCode(S.meetingId)).data.meetingId; assert(uuid, 'not resolvable before cancel');
  const d = await host.req('DELETE', '/api/workplace/schedule/' + S.id); assert(d.status === 200, 'delete ' + d.status);
  await waitFor(async () => mainSql(`SELECT status FROM qorlla_schedules WHERE source_id='${S.id}'`) === 'cancelled', { what: 'cancelled' });
  const res = await resolveCode(S.meetingId); const j = await meetJoin(uuid, { name: 'late' });
  assert(res.status === 404 && j.status >= 400, `resolve ${res.status} join ${j.status}`);
});
await check('C22', 'Cancel wins over a queued (unprocessed) upsert', async () => {
  workerStop();
  try {
    const r = await host.schedule({ title: 'Race cancel' }); const id = r.data.id; const legacy = r.data.meetingId;
    await host.req('DELETE', '/api/workplace/schedule/' + id);
    assert(mainSql(`SELECT status FROM qorlla_schedules WHERE source_id='${id}'`) === 'cancel_pending', 'not cancel_pending');
    workerStart();
    await waitFor(async () => mainSql(`SELECT status FROM qorlla_schedules WHERE source_id='${id}'`) === 'cancelled', { what: 'cancelled' });
    const res = await resolveCode(legacy); assert(res.status === 404, 'meeting exists after cancel: ' + res.status);
    const meetRow = await meetDb.query("SELECT 1 FROM external_meeting_links WHERE source_id=$1", [id]);
    return `meet link rows after cancel race: ${meetRow.rowCount}`;
  } finally { try { workerStart(); } catch {} }
});
await check('C23', 'Concurrent edits apply in version order (last edit wins)', async () => {
  const r = await host.schedule({ title: 'Edit base' }); const S = await host.untilStatus(r.data.id, 'synced');
  workerStop();
  try { for (const t of ['Edit A', 'Edit B', 'Edit C']) { const p = await host.req('PUT', '/api/workplace/schedule/' + S.id, { title: t }); assert(p.status === 200, 'put ' + p.status); } workerStart();
    await host.untilStatus(S.id, 'synced');
    await waitFor(async () => (await meetDb.query('SELECT m.title FROM external_meeting_links l JOIN meetings m ON m.id=l.meeting_id WHERE l.source_id=$1', [S.id])).rows[0]?.title === 'Edit C', { what: 'final title Edit C' });
  } finally { try { workerStart(); } catch {} }
});
await check('C09', 'MAIN restart while pending: retry completes with same sourceId', async () => {
  workerStop();
  const r = await host.schedule({ title: 'Restart main' }); const id = r.data.id;
  docker('restart', MAIN_CT); await waitFor(async () => (await fetch(MAIN + '/api/health')).ok, { what: 'main up' });
  workerStart();
  const host2 = new Main(); host2.cookie = host.cookie; // session persists in data volume
  await waitFor(async () => mainSql(`SELECT status FROM qorlla_schedules WHERE source_id='${id}'`) === 'synced', { timeout: 90000, what: 'synced after restart' });
  const items = await host2.list(); assert(items.some((s) => s.id === id && s.syncStatus === 'synced'), 'MAIN list does not show synced');
});
await check('C17', 'Meet outage -> schedules stay pending -> automatic recovery', async () => {
  workerStart(); await stopMeet();
  const r = await host.schedule({ title: 'Outage' }); assert(r.status === 201 && r.data.syncStatus === 'pending_sync', 'create during outage: ' + r.status);
  await sleep(12000);
  assert(mainSql(`SELECT status FROM qorlla_schedules WHERE source_id='${r.data.id}'`) === 'pending_sync', 'not pending during outage');
  const attempts = Number(mainSql(`SELECT attempts FROM qorlla_outbox WHERE source_id='${r.data.id}' ORDER BY id DESC LIMIT 1`)); assert(attempts >= 1, 'worker did not attempt');
  startMeet(); await meetReady();
  await waitFor(async () => mainSql(`SELECT status FROM qorlla_schedules WHERE source_id='${r.data.id}'`) === 'synced', { timeout: 150000, every: 3000, what: 'recovery after outage' });
  return `attempts during outage: ${attempts}`;
});
await check('C20', 'Lease expiry: stale leased job is re-claimed and completed (simulated lease state)', async () => {
  workerStop();
  const r = await host.schedule({ title: 'Lease' }); const id = r.data.id;
  mainSql(`UPDATE qorlla_outbox SET status='leased', lease_until=now()-interval '5 minutes', lease_token=gen_random_uuid() WHERE source_id='${id}'`);
  workerStart();
  await waitFor(async () => mainSql(`SELECT status FROM qorlla_schedules WHERE source_id='${id}'`) === 'synced', { what: 'synced after stale lease' });
});
await check('C18', 'Backfill is idempotent (duplicate apply creates no duplicates)', async () => {
  const lines = [{ sourceId: `legacy-bf-${RUN}`, legacyCode: String(Math.floor(1e10 + Math.random() * 9e10)), title: 'Backfilled', ownerName: 'Legacy Host', scheduledAt: '2026-12-05T15:00:00Z' }].map((o) => JSON.stringify(o)).join('\n') + '\n';
  const f = path.join(root, 'cert', 'bf.jsonl'); fs.writeFileSync(f, lines);
  docker('cp', f, WORKER_CT + ':/tmp/bf.jsonl');
  const run = () => docker('exec', WORKER_CT, 'node', 'meet-sync/src/backfill.mjs', '/tmp/bf.jsonl', '--apply');
  run(); run();
  const n = Number(mainSql(`SELECT count(*) FROM qorlla_schedules WHERE source_id='legacy-bf-${RUN}'`)); const o = Number(mainSql(`SELECT count(*) FROM qorlla_outbox WHERE source_id='legacy-bf-${RUN}'`));
  assert(n === 1 && o === 1, `schedules=${n} outbox=${o}`);
  await waitFor(async () => mainSql(`SELECT status FROM qorlla_schedules WHERE source_id='legacy-bf-${RUN}'`) === 'synced', { what: 'backfill synced' });
  const code = mainSql(`SELECT legacy_code FROM qorlla_schedules WHERE source_id='legacy-bf-${RUN}'`); assert((await resolveCode(code)).status === 200, 'legacy code not resolvable'); fs.unlinkSync(f);
});
await check('C19', 'Legacy-code collision in worker -> 409s, ends dead, never mapped to the wrong meeting', async () => {
  // The code is already registered in Meet by a DIFFERENT source (not known to MAIN's own unique index)
  const taken = String(Math.floor(1e10 + Math.random() * 9e10));
  const pre = await bridge('POST', '/api/integrations/scheduled-meetings', { sourceId: 'ext-owner-' + crypto.randomBytes(3).toString('hex'), title: 'Existing owner', ownerName: 'Other', legacyCode: taken });
  assert(pre.status === 201, 'precondition ' + pre.status);
  const f = path.join(root, 'cert', 'bf2.jsonl');
  fs.writeFileSync(f, JSON.stringify({ sourceId: `legacy-col-${RUN}`, legacyCode: taken, title: 'Collider', ownerName: 'Legacy Host', scheduledAt: null }) + '\n');
  docker('cp', f, WORKER_CT + ':/tmp/bf2.jsonl'); docker('exec', WORKER_CT, 'node', 'meet-sync/src/backfill.mjs', '/tmp/bf2.jsonl', '--apply');
  for (let i = 0; i < 16; i++) { // fast-forward exponential backoff (operator-equivalent) until dead
    const st = mainSql(`SELECT status FROM qorlla_outbox WHERE source_id='legacy-col-${RUN}'`); if (st === 'dead') break;
    mainSql(`UPDATE qorlla_outbox SET next_attempt_at=now() WHERE source_id='legacy-col-${RUN}' AND status='pending'`); await sleep(2500);
  }
  const row = mainSql(`SELECT status||'|'||attempts||'|'||coalesce(last_error,'') FROM qorlla_outbox WHERE source_id='legacy-col-${RUN}'`);
  assert(row.startsWith('dead|'), 'not dead: ' + row);
  assert(mainSql(`SELECT status FROM qorlla_schedules WHERE source_id='legacy-col-${RUN}'`) !== 'synced', 'wrongly synced');
  assert((await resolveCode(taken)).data.meetingId === pre.data.meetingId, 'original mapping altered'); fs.unlinkSync(f); return row;
});

// ---------- host recovery (C21, R01-R05) ----------
let Rsrc = null;
await check('C21', 'Crash after Meet commit, before vault write: recovery rotates once, vaults, acks, host login works', async () => {
  const r = await host.schedule({ title: 'Recovery' }); Rsrc = await host.untilStatus(r.data.id, 'synced');
  const first = openVault(Rsrc.id); assert(first, 'no initial vault secret');
  mainSql(`DELETE FROM qorlla_host_vault WHERE source_id='${Rsrc.id}'`); // simulate crash before vault commit
  await host.req('PUT', '/api/workplace/schedule/' + Rsrc.id, { title: 'Recovery edit' });
  await waitFor(async () => openVault(Rsrc.id), { what: 'recovered vault secret' });
  await waitFor(async () => mainSql(`SELECT ack_pending FROM qorlla_host_recovery WHERE source_id='${Rsrc.id}'`) === 'f', { what: 'ack complete' });
  const secret = openVault(Rsrc.id); assert(secret !== first, 'secret not rotated');
  const hostJoin = await meetJoin(Rsrc.meetCode, { name: 'Recovered Host', hostSecret: secret }); assert(hostJoin.status === 200 && claims(hostJoin.data.token).role === 'host', 'new secret does not grant host');
  const oldJoin = await meetJoin(Rsrc.meetCode, { name: 'Old', hostSecret: first });
  assert(oldJoin.status !== 200 || claims(oldJoin.data.token).role !== 'host', 'old secret still grants host');
  const esc = await meetDb.query("SELECT state, encrypted_secret IS NULL AS erased FROM host_recovery_escrow e JOIN external_meeting_links l ON l.meeting_id=e.meeting_id WHERE l.source_id=$1", [Rsrc.id]);
  assert(esc.rows[0].state === 'acknowledged' && esc.rows[0].erased, 'escrow not erased'); Rsrc.secret = secret;
});
const rid = () => 'r-' + crypto.randomBytes(4).toString('hex');
const rec = (id, req) => bridge('POST', `/api/integrations/scheduled-meetings/${id}/recover-host`, { requestId: req });
const ack = (id, req, gen, secret) => bridge('POST', `/api/integrations/scheduled-meetings/${id}/ack-host`, { requestId: req, generation: gen, hostSecret: secret });
const R = rid(); let first;
await check('R01', 'Lost response replays the SAME generation and secret (no second rotation)', async () => {
  first = await rec(Rsrc.id, R); const again = await rec(Rsrc.id, R);
  assert(first.status === 200 && again.status === 200 && again.data.hostSecret === first.data.hostSecret && again.data.generation === first.data.generation, JSON.stringify([first.status, again.status]));
  assert(typeof first.data.generation === 'number', 'generation not numeric'); assert(first.data.generation === Number(mainSql(`SELECT generation FROM qorlla_host_recovery WHERE source_id='${Rsrc.id}'`)) + 1, 'generation increment');
});
await check('R02', 'Unvaulted/unacknowledged recovery leaves escrow PENDING with encrypted secret', async () => {
  const esc = await meetDb.query("SELECT state, encrypted_secret FROM host_recovery_escrow e JOIN external_meeting_links l ON l.meeting_id=e.meeting_id WHERE l.source_id=$1", [Rsrc.id]);
  assert(esc.rows[0].state === 'pending' && esc.rows[0].encrypted_secret && !esc.rows[0].encrypted_secret.includes(first.data.hostSecret), 'escrow state/ciphertext wrong');
});
await check('R04', 'Different request ID while pending -> 409', async () => { const r = await rec(Rsrc.id, rid()); assert(r.status === 409, 'status ' + r.status); });
await check('R03', 'Ack failure (wrong secret) is rejected and retryable; correct ack succeeds', async () => {
  const bad = await ack(Rsrc.id, R, first.data.generation, 'wrong-secret'); assert(bad.status === 409, 'wrong ack ' + bad.status);
  const stillPending = await rec(Rsrc.id, R); assert(stillPending.data.hostSecret === first.data.hostSecret, 'escrow lost after failed ack');
  const good = await ack(Rsrc.id, R, first.data.generation, first.data.hostSecret); assert(good.status === 200, 'good ack ' + good.status);
  const again = await ack(Rsrc.id, R, first.data.generation, first.data.hostSecret); assert(again.status === 409, 'double ack should 409');
});
await check('R05', 'After replay + ack, new credential claims host and the previous credential fails', async () => {
  const n = await meetJoin(Rsrc.meetCode, { name: 'H', hostSecret: first.data.hostSecret }); assert(n.status === 200 && claims(n.data.token).role === 'host', 'new secret not host');
  const o = await meetJoin(Rsrc.meetCode, { name: 'H', hostSecret: Rsrc.secret }); assert(o.status !== 200 || claims(o.data.token).role !== 'host', 'old secret still host');
});

// ---------- C15 + browser checks ----------
await check('C15', '/index.html repaired (served by MAIN), /qorlla.html preserved, 1index.html untouched', async () => {
  const idx = await fetch(MAIN + '/index.html'); const q = await fetch(MAIN + '/qorlla.html'); const root_ = await fetch(MAIN + '/');
  const t = await idx.text(); assert(idx.status === 200 && t.includes('Qorlla · Meetings'), 'index.html ' + idx.status);
  assert(q.status === 200 && root_.status === 200, 'qorlla.html/root');
  assert(fs.existsSync(path.join(root, '1index.html')), '1index.html missing');
  const committed = execFileSync(GIT, ['show', 'HEAD:index.html'], { cwd: root }).toString().replace(/\r/g, '');
  assert(committed.replace(/\r/g, '') === t.replace(/\r/g, ''), 'served index.html differs from committed');
});

const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const newCtx = async (loggedIn) => {
  const ctx = await browser.newContext({ baseURL: MAIN, permissions: ['camera', 'microphone'] });
  if (loggedIn) { const [name, value] = host.cookie.split(';')[0].split('='); await ctx.addCookies(host.cookie.split('; ').map((c) => ({ name: c.slice(0, c.indexOf('=')), value: c.slice(c.indexOf('=') + 1), url: MAIN }))); }
  return ctx;
};
const shots = path.join(root, 'cert', 'screenshots'); fs.mkdirSync(shots, { recursive: true });

await check('C13', 'Camera/mic preferences from MAIN dialog are honoured in Meet', async () => {
  const ctx = await newCtx(false); const page = await ctx.newPage();
  await page.goto('/'); await page.locator('.action-btn[data-act="meet"]').click();
  await page.fill('#nm', 'Pref Host'); await page.fill('#ttl', 'Pref title'); await page.uncheck('#mic'); await page.uncheck('#cam');
  await page.click('#dlgGo'); await page.waitForURL(/localhost:3000/);
  assert(/title=Pref\+title/.test(page.url()) && !/passcode/.test(page.url()), 'url params: ' + page.url());
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
  // #app appears before local media is acquired, so wait for the preference to be applied (bounded)
  const state = await waitFor(async () => { const m = await page.textContent('#micBtn span'); const c = await page.textContent('#camBtn span'); return /Unmute/.test(m) && /Start video/.test(c) ? { m, c } : false; }, { timeout: 15000, what: 'mic/cam muted per preference' });
  const mic = state.m, cam = state.c;
  assert((await page.textContent('#roomTitle')) === 'Pref title', 'title not applied');
  await page.screenshot({ path: path.join(shots, 'C13-prefs.png') });
  // C12: leave returns to MAIN on the same host
  await page.click('#leaveBtn'); await page.waitForURL(/localhost:5000/, { timeout: 15000 });
  await page.screenshot({ path: path.join(shots, 'C12-returned.png') }); await ctx.close();
  return 'left Meet and landed at ' + 'localhost:5000';
});
results.push({ ...results.find((r) => r.id === 'C13'), id: 'C12', name: 'Leave returns to the originating MAIN page (same host)' });

await check('C14', 'Browser: scheduled meeting with passcode prompts in the Meet lobby (wrong -> error, right -> enters)', async () => {
  const ctx = await newCtx(true); const page = await ctx.newPage();
  await page.goto('/'); await page.click('[data-view="schedule"]');
  const card = page.locator('.card.ev', { hasText: 'Cert primary EDITED' }).first(); await card.locator('button', { hasText: 'Join' }).click();
  await page.fill('#nm', 'Passcode Guest'); await page.click('#dlgGo'); await page.waitForURL(/localhost:3000/);
  assert(!/passcode=/.test(page.url()), 'passcode in URL');
  await page.waitForSelector('#joinBtn'); await page.fill('#joinPasscode', 'wrong-pass'); await page.click('#joinBtn');
  await page.waitForFunction(() => document.querySelector('#landingError').textContent.length > 0);
  const err = await page.textContent('#landingError'); assert(/passcode/i.test(err), 'error text: ' + err);
  await page.fill('#joinPasscode', 'cert-passcode-1'); await page.click('#joinBtn'); await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
  await page.screenshot({ path: path.join(shots, 'C14-passcode.png') }); await ctx.close();
});
await check('C24', 'Browser: pending/unregistered meetings show no Join; cancelled meetings are not joinable', async () => {
  workerStop();
  try {
    const r = await host.schedule({ title: 'Pending UI' });
    const ctx = await newCtx(true); const page = await ctx.newPage(); await page.goto('/'); await page.click('[data-view="schedule"]');
    const card = page.locator('.card.ev', { hasText: 'Pending UI' }).first(); await card.waitFor();
    assert((await card.locator('button', { hasText: 'Join' }).count()) === 0, 'Join visible while pending');
    assert(/Setting up/.test(await card.textContent()), 'no pending label');
    await page.screenshot({ path: path.join(shots, 'C24-pending.png') });
    const j = await meetJoin(r.data.meetingId, { name: 'x' }); assert(j.status === 404 || j.status === 400, 'Meet joined an unregistered schedule: ' + j.status);
    await ctx.close();
  } finally { workerStart(); }
});
await check('C16', 'Two browsers: real (fake-device) media between peers, chat, and recovery after network disruption', async () => {
  const c1 = await newCtx(false); const c2 = await newCtx(false); const h = await c1.newPage(); const g = await c2.newPage();
  await h.goto(MEET + '/'); await h.fill('#displayName', 'Alice'); await h.fill('#meetingTitle', 'Two browser'); await h.click('#createBtn'); await h.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
  const code = await waitFor(async () => (await h.textContent('#roomId')).trim(), { what: 'room code' }); assert(/^\d{12}$/.test(code), 'public code not shown: ' + code);
  await g.goto(MEET + '/'); await g.fill('#displayName', 'Bob'); await g.fill('#meetingId', code); await g.click('#joinBtn'); await g.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
  const flowing = (p) => p.evaluate(() => [...document.querySelectorAll('.tile video')].filter((v) => v.srcObject && v.videoWidth > 0 && !v.paused).length);
  await waitFor(async () => (await flowing(h)) >= 2 && (await flowing(g)) >= 2, { timeout: 30000, what: 'remote video flowing on both sides (2 tiles each)' });
  await h.fill('#chatText', 'hello from alice'); await h.press('#chatText', 'Enter'); await waitFor(async () => (await g.textContent('#messages')).includes('hello from alice'), { what: 'chat delivery' });
  await h.screenshot({ path: path.join(shots, 'C16-host.png') }); await g.screenshot({ path: path.join(shots, 'C16-guest.png') });
  // network disruption: guest offline 4s, then back
  await c2.setOffline(true); await sleep(4000); await c2.setOffline(false);
  await g.fill('#chatText', 'back online'); await g.press('#chatText', 'Enter');
  await waitFor(async () => (await h.textContent('#messages')).includes('back online'), { timeout: 40000, what: 'chat after reconnect' });
  const live = await flowing(h); await c1.close(); await c2.close(); return `video tiles flowing on host after disruption: ${live}`;
});
await browser.close();

// =====================================================================
const finished = new Date().toISOString();
await stopMeet(); await meetDb.end();
const order = ['C01','C02','C03','C04','C05','C06','C07','C08','C09','C10','C11','C12','C13','C14','C14a','C15','C16','C17','C18','C19','C20','C21','C22','C23','C24','R01','R02','R03','R04','R05'];
results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const summary = { pass: results.filter((r) => r.status === 'PASS').length, fail: results.filter((r) => r.status === 'FAIL').length, notRun: results.filter((r) => r.status === 'NOT RUN').length };
const evidence = { startedAt, finished, git: { headSha: sha, workingTreeDirty: dirty.length > 0, dirtyFileCount: dirty.length, fingerprint }, stack: { main: 'Docker :5000', worker: 'Docker', mainDb: 'Docker postgres:16', meet: 'node :3000', meetDb: 'Docker postgres:16 :25501' }, summary, results };
fs.writeFileSync(path.join(root, 'cert', 'evidence.json'), JSON.stringify(evidence, null, 2));
const md = [`# Certification evidence`, ``, `- Started: ${startedAt}`, `- Finished: ${finished}`, `- Git HEAD: \`${sha}\` (working tree ${dirty.length ? 'DIRTY: ' + dirty.length + ' changed/untracked paths — commit before treating this SHA as the tested build' : 'clean'})`, `- Tested-file fingerprints (sha256/16): ${fingerprint.join(', ')}`, `- Result: **${summary.pass} passed, ${summary.fail} failed, ${summary.notRun} not run**`, ``, `| ID | Result | Check | Detail |`, `|---|---|---|---|`, ...results.map((r) => `| ${r.id} | ${r.status} | ${r.name} | ${String(r.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`)].join('\n');
fs.writeFileSync(path.join(root, 'cert', 'EVIDENCE.md'), md + '\n');
console.log(JSON.stringify(summary));
process.exit(summary.fail ? 1 : 0);
