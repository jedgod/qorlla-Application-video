// Phase H backup/restore drill on DISPOSABLE infrastructure (the qcert stack). Procedure:
//   seed -> quiesce -> back up (MAIN PostgreSQL, Meet PostgreSQL, MAIN data volume) -> write post-backup marker -> destroy everything
//   -> restore into fresh containers -> verify host authentication, escrow recoverability, reconciliation, audit continuity.
// Usage: node cert/run-backup-restore.mjs <cert.env>   -> cert/BACKUP_RESTORE_EVIDENCE.json / .md   (no key material is written)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitState } from './lib-git.mjs';
import pg from 'pg';
import { seal } from '../meet-sync/src/store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = process.argv[2];
const ENV = Object.fromEntries(fs.readFileSync(envPath, 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
process.env.QORLLA_VAULT_KEY = ENV.QORLLA_VAULT_KEY;
const MEET = 'http://localhost:3000', MAIN = 'http://localhost:5000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GIT = process.env.GIT_EXE || (fs.existsSync('C:/Program Files/Git/mingw64/bin/git.exe') ? 'C:/Program Files/Git/mingw64/bin/git.exe' : 'git');
const run = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: root, maxBuffer: 1 << 28, ...o });
const docker = (...a) => run('docker', a);
const compose = (...a) => docker('compose', '--env-file', envPath, '-p', 'qcert', ...a);
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
async function waitFor(fn, { timeout = 90000, every = 500, what = 'condition' } = {}) { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { const v = await fn(); if (v) return v; last = v; } catch (e) { last = e.message; } await sleep(every); } throw new Error(`Timed out: ${what} (${JSON.stringify(last)})`); }
const mainSql = (q) => docker('exec', 'qcert-main-db-1', 'psql', '-U', 'qorlla_main', '-d', 'qorlla_main', '-tAc', q).trim();
const MEET_URL = 'postgres://qorlla:qorlla_dev_only@127.0.0.1:25501/qorlla_meet';
let meetDb = new pg.Pool({ connectionString: MEET_URL, max: 3 });
let meetProc = null;
function startMeet(escrowKey = ENV.RECOVERY_ESCROW_KEY) {
  if (meetProc) return; const log = fs.openSync(path.join(root, 'cert', 'meet-restore.log'), 'a');
  meetProc = spawn('node', ['server/index.js'], { cwd: path.join(root, 'qorlla-meet-video'), stdio: ['ignore', log, log], env: { ...process.env, PORT: '3000', DATABASE_URL: ENV.MEET_APP_DB_URL, CORS_ORIGIN: MEET, JWT_SECRET: ENV.JWT_SECRET, QORLLA_BRIDGE_SECRET: ENV.QORLLA_BRIDGE_SECRET, RECOVERY_ESCROW_KEY: escrowKey } });
}
async function stopMeet() { if (!meetProc) return; const p = meetProc; meetProc = null; await new Promise((r) => { p.once('exit', r); p.kill(); setTimeout(r, 3000); }); }
const j = (url, method, body, headers = {}) => fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
const bridge = (m, p, b) => j(MEET + p, m, b, { 'x-qorlla-bridge-secret': ENV.QORLLA_BRIDGE_SECRET });
const claims = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
function openVault(sid) {
  const row = mainSql(`SELECT ciphertext||'|'||iv||'|'||tag FROM qorlla_host_vault WHERE source_id='${sid}'`); if (!row) return null; const [ct, iv, tag] = row.split('|');
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENV.QORLLA_VAULT_KEY, 'base64'), Buffer.from(iv, 'base64')); d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString();
}
const cookie = { v: '' };
const mainReq = async (m, u, b) => { const r = await fetch(MAIN + u, { method: m, headers: { 'content-type': 'application/json', cookie: cookie.v }, body: b === undefined ? undefined : JSON.stringify(b) }); const sc = r.headers.getSetCookie?.() || []; if (sc.length) cookie.v = sc.map((c) => c.split(';')[0]).join('; '); return { status: r.status, data: await r.json().catch(() => ({})) }; };

const E = { steps: [], checks: [], timings: {} };
const step = (s) => { E.steps.push({ at: new Date().toISOString(), step: s }); console.log('STEP', s); };
const check = (name, ok, detail) => { E.checks.push({ name, status: ok ? 'PASS' : 'FAIL', detail: String(detail ?? '') }); console.log(ok ? 'PASS' : 'FAIL', name, detail ?? ''); };

startMeet(); await waitFor(async () => (await fetch(MEET + '/api/health')).ok, { what: 'Meet up' });
// ---------- 1. seed ----------
step('seed: user, 5 synced schedules (1 passcode), 1 completed recovery, 2 pending recoveries (escrow pending)');
const reg = await mainReq('POST', '/api/auth/register', { username: 'bk' + crypto.randomBytes(4).toString('hex'), displayName: 'Backup User', password: 'Backup-Pass-' + crypto.randomBytes(5).toString('hex') + '!2' });
assert(reg.status === 201, 'register');
const S = [];
for (let i = 0; i < 6; i++) { const r = await mainReq('POST', '/api/workplace/schedule', { title: 'Restore ' + i, date: '2026-12-15', time: '10:00', duration: 30, passcode: i === 0 ? 'restore-pass-1' : undefined }); assert(r.status === 201, 'sched'); S.push(r.data); }
await waitFor(() => Number(mainSql(`SELECT count(*) FROM qorlla_schedules WHERE status='synced' AND source_id IN (${S.map((s) => `'${s.id}'`).join(',')})`)) === 6, { timeout: 120000, every: 1000, what: 'seed synced' });
const list0 = (await mainReq('GET', '/api/workplace/schedule')).data; const seeded = S.map((s) => { const x = list0.find((i) => i.id === s.id); return { id: s.id, legacy: s.meetingId, meetCode: x.meetCode, secret: openVault(s.id) }; });
for (const s of seeded) assert(s.secret && s.meetCode, 'seed vault/code');
const uuids = {}; for (const s of seeded) uuids[s.id] = (await j(`${MEET}/api/resolve/${encodeURIComponent(s.legacy)}`, 'GET')).data.meetingId;
// completed recovery on #3 (worker acks), pending (un-acked) recoveries on #4 and #5 with the main worker stopped
docker('stop', 'qcert-meet-sync-worker-1');
const inflight = {};
for (const idx of [3, 4, 5]) {
  const sid = seeded[idx].id; const reqId = 'bk-' + crypto.randomBytes(4).toString('hex'); const rec = await bridge('POST', `/api/integrations/scheduled-meetings/${sid}/recover-host`, { requestId: reqId });
  assert(rec.status === 200, 'recover'); const sl = seal(rec.data.hostSecret);
  mainSql(`DELETE FROM qorlla_host_vault WHERE source_id='${sid}'; INSERT INTO qorlla_host_vault(source_id,ciphertext,iv,tag) VALUES('${sid}','${sl.ciphertext}','${sl.iv}','${sl.tag}')`);
  inflight[sid] = { reqId, secret: rec.data.hostSecret, generation: rec.data.generation };
  if (idx === 3) mainSql(`INSERT INTO qorlla_host_recovery(source_id,request_id,generation,ack_pending) VALUES('${sid}','${reqId}',${rec.data.generation},true) ON CONFLICT(source_id) DO UPDATE SET request_id='${reqId}',generation=${rec.data.generation},ack_pending=true,ack_attempts=0,next_ack_at=now()`);
}
docker('start', 'qcert-meet-sync-worker-1');
await waitFor(() => mainSql(`SELECT ack_pending FROM qorlla_host_recovery WHERE source_id='${seeded[3].id}'`) === 'f', { timeout: 60000, what: 'completed recovery acked' });
docker('stop', 'qcert-meet-sync-worker-1'); // quiesced from here
const pre = {
  audit: (await meetDb.query('SELECT count(*)::int c, max(id)::bigint m FROM audit_events')).rows[0],
  escrow: (await meetDb.query('SELECT state,count(*)::int c FROM host_recovery_escrow GROUP BY state ORDER BY state')).rows,
  schedules: list0.length, mappings: Number(mainSql('SELECT count(*) FROM qorlla_schedules'))
};
step('pre-backup state: ' + JSON.stringify({ auditEvents: pre.audit.c, escrow: pre.escrow, schedules: pre.schedules }));

// ---------- 2. quiesced backup ----------
const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbackup-'));
const tB0 = Date.now(); step('backup: quiesce MAIN + worker + Meet, dump both databases, archive MAIN data volume');
await stopMeet(); docker('stop', 'zoom_core_backend_instance');
docker('exec', 'cert-meet-db', 'pg_dump', '-U', 'qorlla', '-Fc', '-f', '/tmp/meet.dump', 'qorlla_meet'); docker('cp', 'cert-meet-db:/tmp/meet.dump', path.join(bdir, 'meet.dump'));
docker('exec', 'qcert-main-db-1', 'pg_dump', '-U', 'qorlla_main', '-Fc', '-f', '/tmp/main.dump', 'qorlla_main'); docker('cp', 'qcert-main-db-1:/tmp/main.dump', path.join(bdir, 'main.dump'));
docker('run', '--rm', '-v', 'qcert_workspace-data:/data:ro', '-v', `${bdir.replace(/\\/g, '/')}:/backup`, 'alpine', 'tar', 'czf', '/backup/workspace.tgz', '-C', '/data', '.');
const tB1 = Date.now(); E.timings.backupSeconds = (tB1 - tB0) / 1000;
const files = fs.readdirSync(bdir).map((f) => ({ file: f, bytes: fs.statSync(path.join(bdir, f)).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(bdir, f))).digest('hex') }));
E.backupArtifacts = files;
const keyLeak = ['QORLLA_VAULT_KEY', 'RECOVERY_ESCROW_KEY', 'QORLLA_BRIDGE_SECRET', 'MAIN_DB_PASSWORD'].filter((k) => files.some((f) => fs.readFileSync(path.join(bdir, f.file)).includes(Buffer.from(ENV[k], k.includes('KEY') && !k.includes('SECRET') ? 'utf8' : 'utf8'))));
check('backup artifacts contain no key material or secrets', keyLeak.length === 0, keyLeak.length ? 'FOUND: ' + keyLeak.join(',') : 'checked 4 secrets against all artifacts');
// resume services, then create post-backup data that WILL be lost (measures RPO)
docker('start', 'zoom_core_backend_instance'); await waitFor(async () => (await fetch(MAIN + '/api/health')).ok, { what: 'MAIN resumed' }); docker('start', 'qcert-meet-sync-worker-1'); startMeet(); await waitFor(async () => (await fetch(MEET + '/api/health')).ok, { what: 'Meet resumed' });
const marker = await mainReq('POST', '/api/workplace/schedule', { title: 'POST-BACKUP MARKER', date: '2026-12-16', time: '10:00', duration: 30 }); assert(marker.status === 201, 'marker');
await waitFor(() => mainSql(`SELECT status FROM qorlla_schedules WHERE source_id='${marker.data.id}'`) === 'synced', { what: 'marker synced' });

// ---------- 3. disaster ----------
const tD = Date.now(); step('DISASTER: destroy MAIN stack + volumes and Meet database container'); E.timings.rpoSeconds = (tD - tB1) / 1000;
await stopMeet(); await meetDb.end();
compose('down', '-v'); docker('rm', '-f', 'cert-meet-db');
// ---------- 4. restore ----------
step('restore: fresh Meet PostgreSQL, fresh MAIN PostgreSQL, MAIN data volume, services');
docker('run', '-d', '--name', 'cert-meet-db', '-e', 'POSTGRES_DB=qorlla_meet', '-e', 'POSTGRES_USER=qorlla', '-e', 'POSTGRES_PASSWORD=qorlla_dev_only', '-p', '127.0.0.1:25501:5432', 'postgres:16-alpine');
compose('up', '-d', 'main-db');
await waitFor(() => { try { docker('exec', 'cert-meet-db', 'pg_isready', '-U', 'qorlla', '-d', 'qorlla_meet'); docker('exec', 'qcert-main-db-1', 'pg_isready', '-U', 'qorlla_main'); return true; } catch { return false; } }, { what: 'databases ready' });
await sleep(3000);
// the dump references the Meet app role in its ACLs, and roles are cluster-level (not in a per-database dump): create it first
docker('cp', path.join(root, 'qorlla-meet-video', 'sql', '005_app_role.sql'), 'cert-meet-db:/tmp/005.sql');
docker('exec', 'cert-meet-db', 'psql', '-v', 'ON_ERROR_STOP=1', '-v', `app_pw=${ENV.MEET_APP_DB_PASSWORD}`, '-q', '-U', 'qorlla', '-d', 'qorlla_meet', '-f', '/tmp/005.sql');
docker('cp', path.join(bdir, 'meet.dump'), 'cert-meet-db:/tmp/meet.dump'); docker('exec', 'cert-meet-db', 'pg_restore', '-U', 'qorlla', '-d', 'qorlla_meet', '--no-owner', '--clean', '--if-exists', '/tmp/meet.dump');
docker('cp', path.join(bdir, 'main.dump'), 'qcert-main-db-1:/tmp/main.dump'); docker('exec', 'qcert-main-db-1', 'pg_restore', '-U', 'qorlla_main', '-d', 'qorlla_main', '--no-owner', '--clean', '--if-exists', '/tmp/main.dump');
docker('volume', 'create', 'qcert_workspace-data');
docker('run', '--rm', '-v', 'qcert_workspace-data:/data', '-v', `${bdir.replace(/\\/g, '/')}:/backup:ro`, 'alpine', 'sh', '-c', 'tar xzf /backup/workspace.tgz -C /data && chown -R 1000:1000 /data');
meetDb = new pg.Pool({ connectionString: MEET_URL, max: 3 });
// roles are cluster-level and are not in a per-database dump: recreate the least-privilege Meet role (grants are in the dump)
docker('cp', path.join(root, 'qorlla-meet-video', 'sql', '005_app_role.sql'), 'cert-meet-db:/tmp/005.sql');
docker('exec', 'cert-meet-db', 'psql', '-v', 'ON_ERROR_STOP=1', '-v', `app_pw=${ENV.MEET_APP_DB_PASSWORD}`, '-q', '-U', 'qorlla', '-d', 'qorlla_meet', '-f', '/tmp/005.sql');
compose('up', '-d', 'workspace-signaling-engine', 'meet-sync-worker'); startMeet();
await waitFor(async () => (await fetch(MAIN + '/api/health')).ok && (await fetch(MEET + '/api/health')).ok, { timeout: 120000, what: 'services healthy' });

// ---------- 5. verify ----------
step('verify');
// the pre-disaster browser session must still work (sessions live in the restored volume)
const me = await mainReq('GET', '/api/auth/me'); check('restored MAIN data volume: pre-disaster session still valid', me.data.user?.displayName === 'Backup User', JSON.stringify(me.data.user && { u: me.data.user.username }));
const list1 = (await mainReq('GET', '/api/workplace/schedule')).data;
check('schedules restored consistently (JSON volume and PostgreSQL agree)', seeded.every((s) => { const x = list1.find((i) => i.id === s.id); return x && x.syncStatus === 'synced' && x.meetCode === s.meetCode; }) && !list1.some((i) => i.title === 'POST-BACKUP MARKER') && Number(mainSql(`SELECT count(*) FROM qorlla_schedules WHERE title='POST-BACKUP MARKER' OR source_id='${marker.data.id}'`)) === 0, `restored=${list1.length}, marker absent in both stores`);
let uuidOk = true; for (const s of seeded) { const r = await j(`${MEET}/api/resolve/${encodeURIComponent(s.legacy)}`, 'GET'); if (r.data.meetingId !== uuids[s.id]) uuidOk = false; }
check('legacy codes still resolve to the same meetings', uuidOk, '6 schedules');
// host authentication with vaulted secrets (decrypted with the SAME QORLLA_VAULT_KEY held outside the backups)
let hostOk = true; let firstHostAuthAt = null;
for (const idx of [0, 1, 2]) { const s = seeded[idx]; const sec = openVault(s.id); const jn = await j(`${MEET}/api/meetings/${s.meetCode}/join`, 'POST', { name: 'Restored Host', hostSecret: sec, passcode: undefined }); if (!(jn.status === 200 && claims(jn.data.token).role === 'host' && sec === s.secret)) hostOk = false; else firstHostAuthAt ??= Date.now(); }
check('post-restore host authentication with vaulted secrets', hostOk, 'schedules 0-2');
const done3 = await j(`${MEET}/api/meetings/${seeded[3].meetCode}/join`, 'POST', { name: 'H', hostSecret: openVault(seeded[3].id) }); check('completed recovery (acked pre-backup) host secret still valid', done3.status === 200 && claims(done3.data.token).role === 'host', done3.status);
// pending escrow (#4): replay returns the SAME secret -> encrypted escrow survived and is decryptable with the held key
const pend = inflight[seeded[4].id]; const replay = await bridge('POST', `/api/integrations/scheduled-meetings/${seeded[4].id}/recover-host`, { requestId: pend.reqId });
check('pending encrypted escrow recoverable after restore (same request replays same secret)', replay.status === 200 && replay.data.hostSecret === pend.secret, replay.status);
// key dependency: wrong escrow key must NOT reveal the secret (#5), correct key must
await stopMeet(); startMeet(crypto.randomBytes(32).toString('base64')); await waitFor(async () => (await fetch(MEET + '/api/health')).ok, { what: 'Meet w/ wrong key' });
const wrong = await bridge('POST', `/api/integrations/scheduled-meetings/${seeded[5].id}/recover-host`, { requestId: inflight[seeded[5].id].reqId });
check('wrong RECOVERY_ESCROW_KEY cannot decrypt escrow (fails closed, no secret leaked)', wrong.status >= 500 && !JSON.stringify(wrong.data).includes(inflight[seeded[5].id].secret), 'status ' + wrong.status);
await stopMeet(); startMeet(); await waitFor(async () => (await fetch(MEET + '/api/health')).ok, { what: 'Meet w/ right key' });
const right = await bridge('POST', `/api/integrations/scheduled-meetings/${seeded[5].id}/recover-host`, { requestId: inflight[seeded[5].id].reqId });
check('correct key (from secure backup) recovers the escrow', right.status === 200 && right.data.hostSecret === inflight[seeded[5].id].secret, right.status);
// finish both pending recoveries through the real ack worker
for (const idx of [4, 5]) { const sid = seeded[idx].id; const p = inflight[sid]; mainSql(`INSERT INTO qorlla_host_recovery(source_id,request_id,generation,ack_pending) VALUES('${sid}','${p.reqId}',${p.generation},true) ON CONFLICT(source_id) DO UPDATE SET request_id='${p.reqId}',generation=${p.generation},ack_pending=true,ack_attempts=0,next_ack_at=now(),ack_lease_until=NULL`); }
await waitFor(() => [4, 5].every((i) => mainSql(`SELECT ack_pending FROM qorlla_host_recovery WHERE source_id='${seeded[i].id}'`) === 'f'), { timeout: 90000, every: 1000, what: 'restored worker acks both' });
const pendLeft = (await meetDb.query("SELECT count(*)::int c FROM host_recovery_escrow WHERE state='pending'")).rows[0].c; check('restored sync worker completes outstanding acknowledgments; no escrow left pending', pendLeft === 0, 'pending=' + pendLeft);
E.timings.rtoSeconds = (firstHostAuthAt - tD) / 1000;
// audit continuity
const post = (await meetDb.query('SELECT count(*)::int c, max(id)::bigint m FROM audit_events')).rows[0];
check('audit log preserved and sequence continues (no id reuse)', Number(post.c) >= Number(pre.audit.c) && Number(post.m) > Number(pre.audit.m), `before=${pre.audit.c}/${pre.audit.m} after=${post.c}/${post.m}`);
// reconciliation: edit + create still flow end-to-end
const ed = await mainReq('PUT', '/api/workplace/schedule/' + seeded[0].id, { title: 'Restore 0 EDITED AFTER RESTORE' });
await waitFor(async () => (await meetDb.query('SELECT m.title FROM external_meeting_links l JOIN meetings m ON m.id=l.meeting_id WHERE l.source_id=$1', [seeded[0].id])).rows[0]?.title === 'Restore 0 EDITED AFTER RESTORE', { what: 'edit propagated' });
const nw = await mainReq('POST', '/api/workplace/schedule', { title: 'After restore', date: '2026-12-17', time: '10:00', duration: 30 }); await waitFor(() => mainSql(`SELECT status FROM qorlla_schedules WHERE source_id='${nw.data.id}'`) === 'synced', { what: 'new schedule synced after restore' });
check('schedule reconciliation works after restore (edit + new schedule sync)', ed.status === 200 && nw.status === 201, 'ok');
const dtx = (await fetch(MAIN + '/api/health')).ok; E.timings.restoreCompletedSeconds = (Date.now() - tD) / 1000;
E.objectives = { rtoTargetSeconds: 900, rpoTargetSeconds: 900, rtoMeasuredSeconds: E.timings.rtoSeconds, rpoMeasuredSeconds: E.timings.rpoSeconds, note: 'RPO measured here is only the gap between this drill\'s backup and the simulated disaster. No automated backup schedule exists yet, so the RPO the product can actually guarantee is undefined until one is configured.' };
check('measured RTO within target (900 s)', E.timings.rtoSeconds <= 900, `RTO ${E.timings.rtoSeconds}s`);
await stopMeet(); await meetDb.end();
const sha = run(GIT, ['rev-parse', 'HEAD']).trim(); const failed = E.checks.filter((c) => c.status === 'FAIL').length;
fs.writeFileSync(path.join(root, 'cert', 'BACKUP_RESTORE_EVIDENCE.json'), JSON.stringify({ finished: new Date().toISOString(), git: gitState(root), gitHeadSha: sha, ...E }, null, 2));
fs.writeFileSync(path.join(root, 'cert', 'BACKUP_RESTORE_EVIDENCE.md'), ['# Backup / restore drill', '', `- Git HEAD: \`${sha}\` (branch ${gitState(root).branch}; source tree ${gitState(root).sourceTreeClean ? 'clean' : 'DIRTY: ' + gitState(root).dirtySourcePaths.join(', ')})`, `- Backup duration (quiesced): ${E.timings.backupSeconds}s; RTO measured (disaster -> first successful host authentication): ${E.timings.rtoSeconds}s; backup-to-disaster gap (RPO in this drill): ${E.timings.rpoSeconds}s`, '', '## Artifacts (hashes only; contents not stored)', ...files.map((f) => `- ${f.file}: ${f.bytes} bytes, sha256 ${f.sha256}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...E.checks.map((c) => `| ${c.name} | ${c.status} | ${c.detail.replace(/\|/g, '\\|')} |`), '', '## Steps', ...E.steps.map((s) => `- ${s.at} ${s.step}`), '', `> ${E.objectives.note}`].join('\n') + '\n');
console.log(JSON.stringify({ failed })); process.exit(failed ? 1 : 0);
