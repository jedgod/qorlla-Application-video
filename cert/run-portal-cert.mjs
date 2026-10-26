// Workplace v4.1 certification: portal PostgreSQL/auth/billing suites + the REAL unified deployment (nginx + MAIN + portal + Meet,
// all in Docker, one HTTPS origin) exercised by Chromium. The payment provider is the labelled TEST DOUBLE: the real-provider
// gate is reported separately as BLOCKED. Writes cert/V41_EVIDENCE.json and cert/V41_EVIDENCE.md.
// Usage: node cert/run-portal-cert.mjs        (needs Docker; uses host ports 28080/28081/28443/28444, 25000, 23000, 19500, 25611)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitState } from './lib-git.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: root, maxBuffer: 1 << 28, ...o });
const docker = (...a) => run('docker', a);
const results = [];
const record = (id, name, status, detail = '') => { results.push({ id, name, status, detail: String(detail).slice(0, 800) }); console.log(status, id, name, detail ? '- ' + String(detail).slice(0, 200) : ''); };
async function waitFor(fn, { timeout = 120000, every = 1000, what = 'condition' } = {}) { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { const v = await fn(); if (v) return v; last = v; } catch (e) { last = e.message; } await sleep(every); } throw new Error(`Timed out: ${what} (${JSON.stringify(last)})`); }
async function check(id, name, fn) { try { record(id, name, 'PASS', (await fn()) ?? ''); } catch (e) { record(id, name, 'FAIL', e.message); } }

const P = { http: 28080, meet: 28081, tls: 28443, meetTls: 28444, main: 25000, meetHost: 23000, fake: 19500, pg: 25611 };
const ORIGIN = `https://localhost:${P.tls}`;
const PROJECT = 'qv41';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qv41-'));
const rnd = (n) => crypto.randomBytes(n).toString('hex');
const WEBHOOK_SECRET = 'whsec_' + 'test'.repeat(8);

// ------------------------------------------------------------------ 1. portal suites (PostgreSQL, auth, billing, migrations, MAIN contract)
const pgName = 'qv41-test-pg';
try { docker('rm', '-f', pgName); } catch {}
docker('run', '-d', '--name', pgName, '-e', 'POSTGRES_PASSWORD=postgres', '-p', `127.0.0.1:${P.pg}:5432`, 'postgres:16-alpine');
await waitFor(() => { try { docker('exec', pgName, 'pg_isready', '-U', 'postgres'); return true; } catch { return false; } }, { what: 'test postgres' }); await sleep(2500);
{
  const r = spawnSync('node', ['--test', '--test-concurrency=1', '--test-reporter=tap', 'tests/auth.test.mjs', 'tests/billing.test.mjs', 'tests/entitlements.test.mjs', 'tests/migrations.test.mjs', 'tests/contract-main.test.mjs'], { cwd: path.join(root, 'qorlla-portal'), encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, TEST_DATABASE_ADMIN_URL: `postgres://postgres:postgres@127.0.0.1:${P.pg}/postgres` } });
  fs.writeFileSync(path.join(root, 'cert', 'portal-unit.tap'), r.stdout);
  const tests = [...r.stdout.matchAll(/^\s*(ok|not ok) \d+ - (.+?)(?: # .*)?$/gm)].filter((m) => !/^\S.*\.test\.mjs$/.test(m[2]));
  const leaf = tests.filter((m) => !m[2].includes('authentication & authorization') || true);
  const pass = Number((/^# pass (\d+)/m.exec(r.stdout) || [])[1] || 0), fail = Number((/^# fail (\d+)/m.exec(r.stdout) || [])[1] || 0);
  record('U-ALL', 'portal node:test suites (auth, billing lifecycle, entitlements, sales, migrations/rollback, real-MAIN contract)', fail === 0 && pass > 40 ? 'PASS' : 'FAIL', `${pass} passed, ${fail} failed`);
  if (fail) record('U-FAIL', 'failing tests', 'FAIL', [...r.stdout.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]).join(' | '));
}
try { docker('rm', '-f', pgName); } catch {}

// ------------------------------------------------------------------ 2. unified deployment
const certDir = path.join(scratch, 'certs'); fs.mkdirSync(certDir);
run('docker', ['run', '--rm', '-v', `${certDir.replace(/\\/g, '/')}:/out`, 'alpine/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '/out/server.key', '-out', '/out/server.pem', '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
const env = {
  MAIN_DB_PASSWORD: rnd(12), QORLLA_APP_DB_PASSWORD: rnd(12), PORTAL_DB_PASSWORD: rnd(12), MEET_DB_PASSWORD: rnd(12), MEET_APP_DB_PASSWORD: rnd(12),
  QORLLA_BRIDGE_SECRET: rnd(24), PORTAL_INTROSPECTION_SECRET: rnd(24), MEET_JWT_SECRET: rnd(24), RECOVERY_ESCROW_KEY: crypto.randomBytes(32).toString('base64'), QORLLA_VAULT_KEY: crypto.randomBytes(32).toString('base64'),
  PUBLIC_ORIGIN: ORIGIN, PUBLIC_URL: ORIGIN, MEET_PUBLIC_URL: ORIGIN + '/meet/',
  PROXY_MAIN_PORT: P.http, PROXY_MEET_PORT: P.meet, PROXY_MAIN_TLS_PORT: P.tls, PROXY_MEET_TLS_PORT: P.meetTls,
  PROXY_TLS_CONF: './deploy/nginx/tls.conf', PROXY_HTTP_CONF: './deploy/nginx/http-redirect.conf', PROXY_CERT_DIR: certDir.replace(/\\/g, '/'),
  MAIN_HOST_PORT: P.main, MEET_HOST_PORT: P.meetHost,
  BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_API_BASE: `http://host.docker.internal:${P.fake}`
};
const envFile = path.join(scratch, 'v41.env'); fs.writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
// e2e-only override: the portal must talk to the local provider test double, which production mode refuses (NODE_ENV=production pins api.stripe.com)
const override = path.join(scratch, 'compose.e2e.yml');
fs.writeFileSync(override, `services:\n  qorlla-portal:\n    extra_hosts:\n      - "host.docker.internal:host-gateway"\n    environment:\n      - NODE_ENV=staging\n      - AUTH_REQUIRE_INTROSPECTION=true\n      - STRIPE_API_BASE=\${STRIPE_API_BASE}\n`);
const compose = (...a) => docker('compose', '--env-file', envFile, '-p', PROJECT, '-f', 'docker-compose.yml', '-f', override.replace(/\\/g, '/'), ...a);
try { compose('down', '-v'); } catch {}
const fake = spawn('node', ['qorlla-portal/tests/fake-stripe.mjs', String(P.fake)], { cwd: root, stdio: 'ignore' });
await check('D01', 'docker compose config is valid and every long-running service has a restart policy', async () => {
  const cfg = JSON.parse(compose('config', '--format', 'json')); const svc = cfg.services;
  const missing = Object.entries(svc).filter(([, v]) => v.restart !== 'always').map(([k]) => k); if (missing.length) throw new Error('no restart policy: ' + missing);
  return `${Object.keys(svc).length} services: ${Object.keys(svc).join(', ')}`;
});
await check('D02', 'unified stack builds and every service becomes healthy (main, portal, meet, databases, nginx)', async () => {
  compose('up', '-d', '--build', '--wait', '--wait-timeout', '300');
  const ps = JSON.parse('[' + compose('ps', '--format', 'json').trim().split('\n').join(',') + ']');
  const bad = ps.filter((c) => !['healthy', ''].includes(c.Health) || c.State !== 'running'); if (bad.length) throw new Error(bad.map((c) => `${c.Service}:${c.State}/${c.Health}`).join(','));
  return ps.map((c) => `${c.Service}=${c.Health || c.State}`).join(' ');
});
await check('D03', 'single HTTPS entry point: only nginx listens on public interfaces; app services bind loopback or nothing', async () => {
  const ps = JSON.parse('[' + compose('ps', '--format', 'json').trim().split('\n').join(',') + ']');
  const exposed = []; for (const c of ps) for (const p of (c.Publishers || [])) if (p.PublishedPort && p.URL !== '127.0.0.1' && c.Service !== 'dashboard-client-proxy') exposed.push(`${c.Service}:${p.PublishedPort}@${p.URL}`);
  if (exposed.length) throw new Error('publicly published: ' + exposed.join(', '));
  return 'only dashboard-client-proxy (nginx) is published on 0.0.0.0';
});
await check('D04', 'containers run unprivileged; structured JSON logs from portal and nginx; no secrets in logs', async () => {
  for (const svc of ['qorlla-portal', 'meet', 'workspace-signaling-engine']) { const uid = compose('exec', '-T', svc, 'id', '-u').trim(); if (uid === '0') throw new Error(svc + ' runs as root'); }
  await fetch(`${ORIGIN}/api/v1/health`).catch(() => {}); await sleep(500);
  const portalLog = compose('logs', '--no-log-prefix', 'qorlla-portal').trim().split('\n').filter((l) => l.startsWith('{')); if (!portalLog.length) throw new Error('portal wrote no JSON log lines');
  portalLog.forEach((l) => JSON.parse(l)); const nginxLog = compose('logs', '--no-log-prefix', 'dashboard-client-proxy').split('\n').filter((l) => l.startsWith('{"ts"')); if (!nginxLog.length) throw new Error('nginx wrote no JSON access lines');
  nginxLog.forEach((l) => JSON.parse(l));
  const all = compose('logs', '--no-log-prefix'); for (const k of ['PORTAL_INTROSPECTION_SECRET', 'QORLLA_BRIDGE_SECRET', 'MEET_JWT_SECRET', 'RECOVERY_ESCROW_KEY', 'QORLLA_VAULT_KEY', 'MAIN_DB_PASSWORD', 'PORTAL_DB_PASSWORD']) if (all.includes(env[k])) throw new Error('secret in logs: ' + k);
  return `${portalLog.length} portal and ${nginxLog.length} nginx JSON lines parsed`;
});
await check('D05', 'least-privilege roles: portal role can only touch the portal schema', async () => {
  const q = (user, sql) => compose('exec', '-T', 'main-db', 'psql', '-U', user, '-d', 'qorlla_main', '-tAc', sql).trim();
  if (q('qorlla_portal_app', 'SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname=current_user') !== 'f') throw new Error('privileged');
  for (const bad of ['SELECT 1 FROM public.qorlla_schedules LIMIT 1', 'DROP TABLE portal.notes', 'CREATE TABLE portal.x(i int)', 'DELETE FROM portal.invoices']) { let blocked = false; try { q('qorlla_portal_app', bad); } catch { blocked = true; } if (!blocked) throw new Error('allowed: ' + bad); }
  q('qorlla_portal_app', 'SELECT count(*) FROM portal.plans');
});
await check('D06', 'portal fails closed (503) while authentication is not operational, and answers 401 once configured', async () => {
  const r = await fetch(`${ORIGIN}/api/v1/notes`); if (r.status !== 401) throw new Error('expected 401 got ' + r.status);
  // configuration check on a throwaway process: no issuer/JWKS => 503
  const out = spawnSync('node', ['-e', `import('./qorlla-portal/server/config.mjs').then(async ({loadConfig})=>{const {createApp}=await import('./qorlla-portal/server/app.mjs');const cfg=loadConfig({NODE_ENV:'production',DATABASE_URL:'x'});const {app}=createApp({pool:{query:async()=>({rows:[]})},cfg,jwks:null});const s=app.listen(0,async()=>{const r=await fetch('http://127.0.0.1:'+s.address().port+'/api/v1/notes',{headers:{cookie:'qorlla_portal_session=x'}});console.log(r.status+' '+JSON.stringify(cfg.authProblems));s.close()})})`], { cwd: root, encoding: 'utf8' });
  if (!out.stdout.startsWith('503')) throw new Error('unconfigured portal answered ' + out.stdout + out.stderr); return out.stdout.trim();
});

// ------------------------------------------------------------------ 3. browser E2E against the unified origin
{
  const cfgFile = path.join(root, 'qorlla-portal', 'e2e', 'playwright.config.cjs'); const json = path.join(root, 'cert', 'e2e-results.json');
  const r = spawnSync('npx', ['playwright', 'test', '-c', cfgFile], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 1 << 28, env: { ...process.env, E2E_BASE: ORIGIN, E2E_DB_CONTAINER: `${PROJECT}-main-db-1`, E2E_FAKE_STRIPE_URL: `http://127.0.0.1:${P.fake}`, E2E_JSON: json, NO_COLOR: '1', NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
  fs.writeFileSync(path.join(root, 'cert', 'e2e-output.txt'), (r.stdout || '') + (r.stderr || ''));
  let counts = { passed: 0, failed: 0, skipped: 0, titles: [] };
  try { const j = JSON.parse(fs.readFileSync(json, 'utf8')); const walk = (s) => { (s.specs || []).forEach((sp) => sp.tests.forEach((t) => { const st = t.results?.[t.results.length - 1]?.status; counts[st === 'passed' ? 'passed' : st === 'skipped' ? 'skipped' : 'failed']++; counts.titles.push((st === 'passed' ? 'ok ' : 'FAIL ') + sp.title); })); (s.suites || []).forEach(walk); }; (j.suites || []).forEach(walk); } catch (e) { counts.error = e.message; }
  record('E2E', 'browser E2E: pricing, checkout/webhook, portal auth, navigation, mobile, Meet under /meet/', counts.failed === 0 && counts.passed >= 20 ? 'PASS' : 'FAIL', `${counts.passed} passed, ${counts.failed} failed${counts.error ? ' (' + counts.error + ')' : ''}`);
  for (const t of counts.titles.filter((x) => x.startsWith('FAIL'))) record('E2E-FAIL', t, 'FAIL');
  results.find((x) => x.id === 'E2E').titles = counts.titles;
}

try { fake.kill(); } catch {}
await check('D07', 'restart resilience: portal and nginx restart cleanly and the site keeps serving', async () => {
  compose('restart', 'qorlla-portal'); compose('restart', 'dashboard-client-proxy');
  await waitFor(async () => (await fetch(`${ORIGIN}/api/v1/health`)).status === 200 && (await fetch(`${ORIGIN}/pricing/`)).status === 200, { timeout: 90000, what: 'site back after restart' });
});
const state = gitState(root);
const summary = { pass: results.filter((r) => r.status === 'PASS').length, fail: results.filter((r) => r.status === 'FAIL').length };
const evidence = { finished: new Date().toISOString(), git: state, ports: P, note: 'Payment provider = local TEST DOUBLE; real-provider verification is BLOCKED (no account/keys, no authorization to collect payments).', summary, results };
fs.writeFileSync(path.join(root, 'cert', 'V41_EVIDENCE.json'), JSON.stringify(evidence, null, 2));
fs.writeFileSync(path.join(root, 'cert', 'V41_EVIDENCE.md'), ['# Workplace v4.1 certification evidence', '', `- Git HEAD: \`${state.headSha}\` (branch ${state.branch}; source tree ${state.sourceTreeClean ? 'clean' : 'DIRTY: ' + state.dirtySourcePaths.join(', ')})`, `- Result: **${summary.pass} passed, ${summary.fail} failed**`, `- ${evidence.note}`, '', '| ID | Result | Check | Detail |', '|---|---|---|---|', ...results.map((r) => `| ${r.id} | ${r.status} | ${r.name} | ${String(r.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`), '', '## Browser E2E test titles', ...(results.find((r) => r.id === 'E2E')?.titles || []).map((t) => '- ' + t)].join('\n') + '\n');
if (!process.env.KEEP_STACK) { try { compose('down', '-v'); } catch {} }
console.log(JSON.stringify(summary)); process.exit(summary.fail ? 1 : 0);
