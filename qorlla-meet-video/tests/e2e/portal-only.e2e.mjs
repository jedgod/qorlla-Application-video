// Meet without a start or join page of its own (MEET_ALLOW_ANONYMOUS_START=false): the address of Meet sends people to Qorlla Home's Join meeting dialog, the API refuses to start a meeting,
// and when something goes wrong (a used or expired hand-off) the page says so with a way back to Qorlla. With the setting left at its default nothing changes.
//   TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:25690/postgres PLAYWRIGHT_DIR=<folder with node_modules/playwright> node tests/e2e/portal-only.e2e.mjs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..'), SQL = join(ROOT, 'sql');
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres';
const { chromium } = createRequire(join(process.env.PLAYWRIGHT_DIR || process.cwd(), 'package.json'))('playwright');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (n, ok, d = '') => { results.push({ n, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !d ? '' : '  -> ' + d)); };
const PORTAL = 'http://localhost:4999';                                      // a stand-in for Qorlla Home: its address is intercepted in the browser

async function boot(port, extraEnv) {
  const db = 'portalonly_' + Math.random().toString(36).slice(2, 8);
  const admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${db}`);
  const dbUrl = URL.replace(/\/[^/]*$/, '/' + db); const pool = new pg.Pool({ connectionString: dbUrl, max: 2 }); for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8')); await pool.end();
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), DATABASE_URL: dbUrl, JWT_SECRET: 'portal-only-e2e-secret-portal-only-e2e-0123456789', API_RATE_LIMIT: '100000', ...extraEnv } });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 240 && !log.includes('listening'); i++) await wait(250);
  if (!log.includes('listening')) throw new Error('Meet did not start: ' + log.slice(-400));
  return { base: `http://localhost:${port}`, stop: async () => { child.kill(); await wait(300); await admin.query(`DROP DATABASE ${db} WITH (FORCE)`).catch(() => {}); await admin.end(); } };
}
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const homeStandIn = (ctx) => ctx.route(PORTAL + '/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Qorlla Home stand-in</title><h1>Qorlla Home</h1>' }));
const newPage = async (errors) => { const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] }); await homeStandIn(ctx); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message)); return p; };
let po, normal;
try {
  po = await boot(Number(process.env.PORTAL_ONLY_E2E_PORT || 4986), { MEET_ALLOW_ANONYMOUS_START: 'false', MAIN_APP_URL: PORTAL, CORS_ORIGIN: PORTAL });
  check('the config says anonymous start is off', (await (await fetch(po.base + '/api/config')).json()).allowAnonymousStart === false);
  const r = await fetch(po.base + '/api/meetings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x', name: 'Mallory' }) });
  check('the server REFUSES to start a meeting (403): the page is not the only guard', r.status === 403, 'status ' + r.status);
  const html = await (await fetch(po.base + '/')).text();
  check('the start page is served marked as portal-only with the Home address (so no form ever flashes)', /<html[^>]*class="portal-only"[^>]*data-portal="http:\/\/localhost:4999"/.test(html), html.slice(0, 200));
  const errors = [];
  const p = await newPage(errors); await p.goto(po.base + '/'); await p.waitForURL(PORTAL + '/qorlla.html#join', { timeout: 15000 });
  check("opening Meet's address lands on Qorlla Home's Join dialog address", p.url() === PORTAL + '/qorlla.html#join', p.url());
  // a used or expired hand-off: say so, with a way back; do NOT redirect away and show no form
  const p2 = await newPage(errors); await p2.goto(po.base + '/#qh=' + 'A'.repeat(40)); await p2.locator('#portalOnlyNote:not(.hidden)').waitFor({ timeout: 15000 });
  check('a bad hand-off shows a message and a way back to Qorlla (no redirect, no forms)', p2.url().startsWith(po.base) && (await p2.locator('#portalOnlyMsg').innerText()).length > 3 && (await p2.locator('#portalOnlyLink').getAttribute('href')) === PORTAL + '/qorlla.html#join'
    && !(await p2.locator('#createBtn').isVisible()) && !(await p2.locator('#joinBtn').isVisible()) && !(await p2.locator('#meetingTitle').isVisible()));
  check('no JavaScript errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  // default: nothing changes
  normal = await boot(Number(process.env.PORTAL_ONLY_E2E_PORT || 4986) + 1, {});
  const cfg = await (await fetch(normal.base + '/api/config')).json(); check('default: the config allows starting meetings', cfg.allowAnonymousStart === true);
  check('default: the start page is not marked portal-only', !/portal-only/.test(await (await fetch(normal.base + '/')).text()));
  const p3 = await (await browser.newContext({ permissions: ['camera', 'microphone'] })).newPage(); await p3.goto(normal.base);
  await p3.locator('#createBtn').waitFor({ state: 'visible', timeout: 10000 }); check('default: the start and join forms are shown', (await p3.locator('#joinBtn').isVisible()) && (await p3.locator('#meetingTitle').isVisible()));
  await p3.fill('#displayName', 'Stryker'); await p3.click('#createBtn'); await p3.waitForSelector('#app:not(.hidden)', { timeout: 30000 }); check('default: starting a meeting still works', true);
} catch (e) { check('run completed without an exception', false, String(e.message || e).slice(0, 400)); }
finally { await browser.close(); for (const s of [po, normal]) if (s) await s.stop(); }
const bad = results.filter((r) => !r.ok); console.log(`\n${results.length - bad.length}/${results.length} passed`); process.exit(bad.length ? 1 : 0);
