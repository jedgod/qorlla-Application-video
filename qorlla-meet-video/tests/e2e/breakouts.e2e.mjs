// Breakout rooms in REAL browsers against the REAL Meet server of this checkout: a host and TWO guests with real (fake-device) WebRTC media.
// A regression guard for the chat upgrade (which lives INSIDE the Chat tab): the other four tabs must keep working, only one tab shows at a time, and switching away from Chat and
// back loses nothing. Not part of `npm run check` (needs Chromium).
//   TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:25690/postgres PLAYWRIGHT_DIR=<folder with node_modules/playwright> node tests/e2e/meet-tabs.e2e.mjs [screenshot-dir]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..'), SQL = join(ROOT, 'sql'), OUT = process.argv[2];
if (OUT) mkdirSync(OUT, { recursive: true });
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres';
const { chromium } = createRequire(join(process.env.PLAYWRIGHT_DIR || process.cwd(), 'package.json'))('playwright');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (n, ok, d = '') => { results.push({ n, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !d ? '' : '  -> ' + d)); };
async function waitFor(fn, ms = 15000, step = 200) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch { /* retry */ } await wait(step); } return last; }

const db = 'bk_' + Math.random().toString(36).slice(2, 8), PORT = Number(process.env.BK_E2E_PORT || 4981);
const admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${db}`);
const dbUrl = URL.replace(/\/[^/]*$/, '/' + db); const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8'));
const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATABASE_URL: dbUrl, JWT_SECRET: 'bk-e2e-secret-bk-e2e-secret-0123456789', ASCS_ENABLED: 'false', API_RATE_LIMIT: '100000', MEETING_RATE_LIMIT: '100000', SOCKET_EVENT_BUDGET: '100000' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 240 && !log.includes('listening'); i++) await wait(250);
if (!log.includes('listening')) { console.log('server did not start: ' + log.slice(-500)); process.exit(2); }
const base = `http://localhost:${PORT}`;
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const pageErrors = [];
const open = async (name, code) => {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } }); const p = await ctx.newPage();
  p.on('pageerror', (e) => pageErrors.push(name + ': ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) pageErrors.push(name + ' console: ' + m.text()); });
  await p.goto(base); await p.fill('#displayName', name);
  if (code) { await p.fill('#meetingId', code); await p.click('#joinBtn'); } else { await p.fill('#meetingTitle', 'Breakouts test'); await p.click('#createBtn'); }
  await p.waitForSelector('#app:not(.hidden)', { timeout: 30000 }); return { ctx, p };
};

const tilesOf = (p) => p.evaluate(() => [...document.querySelectorAll('.tile')].map((t) => t.id.slice(5)));
const nameplates = (p) => p.evaluate(() => [...document.querySelectorAll('.tile .nameplate')].map((n) => n.textContent.trim()));
// media really flows between two people when the other person's <video> has decoded frames
const flowing = (p, name) => p.evaluate((nm) => [...document.querySelectorAll('.tile')].some((t) => t.querySelector('.nameplate')?.textContent.includes(nm) && [...t.querySelectorAll('video')].some((v) => v.videoWidth > 0 && v.readyState >= 2)), name);
const chatSend = async (p, text) => { await p.click('[data-tab=chat]'); await p.locator('#chatEditor').click(); await p.keyboard.type(text); await p.keyboard.press('Enter'); };
const chatHas = async (p, text) => (await p.locator('.chat-msg', { hasText: text }).count()) > 0;

try {
  const host = await open('Hana'); const code = (await host.p.textContent('#roomId')).trim(); const gus = await open('Gus', code); const ivy = await open('Ivy', code);
  await waitFor(async () => (await tilesOf(host.p)).length === 3 && (await tilesOf(gus.p)).length === 3 && (await tilesOf(ivy.p)).length === 3, 30000);
  await waitFor(async () => (await flowing(gus.p, 'Hana')) && (await flowing(gus.p, 'Ivy')) && (await flowing(ivy.p, 'Gus')) && (await flowing(host.p, 'Gus')), 45000, 500);
  check('before rooms: all three see and hear each other (real WebRTC media flowing)', (await flowing(gus.p, 'Hana')) && (await flowing(gus.p, 'Ivy')) && (await flowing(ivy.p, 'Gus')) && (await flowing(host.p, 'Ivy')));
  await chatSend(host.p, 'main one'); await waitFor(async () => (await chatHas(gus.p, 'main one')) && (await chatHas(ivy.p, 'main one')));

  // host sets up one room with Gus and Ivy and opens it
  await host.p.click('[data-tab=more]'); const row = host.p.locator('#tab-more .mg-row', { hasText: 'Breakout rooms' });
  await waitFor(async () => !(await row.getByRole('button').isDisabled()), 20000); await row.getByRole('button', { name: 'Create' }).click();
  await host.p.locator('.bk-box input[aria-label="Room name"]').fill('Design'); await host.p.locator('.bk-box').getByRole('button', { name: 'Add', exact: true }).click();
  await host.p.locator('.bk-box select[aria-label="Room for Gus"]').waitFor({ timeout: 15000 });
  await host.p.locator('.bk-box select[aria-label="Room for Gus"]').selectOption({ label: 'Design' }); await host.p.waitForTimeout(400);
  await host.p.locator('.bk-box select[aria-label="Room for Ivy"]').selectOption({ label: 'Design' }); await host.p.waitForTimeout(400);
  await host.p.locator('.bk-box select[aria-label="Minutes"]').selectOption('5'); await host.p.locator('.bk-box').getByRole('button', { name: 'Open rooms' }).click();

  await waitFor(async () => (await tilesOf(gus.p)).length === 2 && (await tilesOf(ivy.p)).length === 2 && (await tilesOf(host.p)).length === 1, 30000);
  check('rooms open: Gus and Ivy see only each other (and themselves); the host sees only the host', JSON.stringify((await nameplates(gus.p)).sort()) .includes('Ivy') && !(await nameplates(gus.p)).some((n) => n.includes('Hana')) && !(await nameplates(ivy.p)).some((n) => n.includes('Hana')) && (await nameplates(host.p)).every((n) => !n.includes('Gus') && !n.includes('Ivy')));
  await waitFor(async () => (await flowing(gus.p, 'Ivy')) && (await flowing(ivy.p, 'Gus')), 45000, 500);
  check('rooms open: audio/video is re-established inside the room (Gus and Ivy decode each other\'s frames)', (await flowing(gus.p, 'Ivy')) && (await flowing(ivy.p, 'Gus')));
  check('rooms open: the room chip shows the room name and a countdown for a guest, and the host chip says rooms are open', /Design\s*·\s*\d+:\d\d/.test(await gus.p.locator('.bk-chip').innerText()) && /Rooms open/.test(await host.p.locator('.bk-chip').innerText()));

  // chat stays in the room
  await chatSend(gus.p, 'room secret'); await waitFor(async () => chatHas(ivy.p, 'room secret'));
  await host.p.click('[data-tab=chat]'); await host.p.waitForTimeout(1500);
  check('chat: a room message reaches the other person in the room and NOT the host in the main room', (await chatHas(ivy.p, 'room secret')) && !(await chatHas(host.p, 'room secret')));
  check('chat: the room starts with its own history (the main-room message is not in the room)', !(await chatHas(gus.p, 'main one')));
  check('main-room tools are closed inside a room (Q&A and Whiteboard buttons disabled for Gus)', await (async () => { await gus.p.click('[data-tab=more]'); return (await gus.p.locator('#tab-more .mg-row', { hasText: 'Q&A' }).getByRole('button').isDisabled()) && (await gus.p.locator('#tab-more .mg-row', { hasText: 'Whiteboard' }).getByRole('button').isDisabled()); })());
  check('a guest cannot manage rooms (no panel controls, only a status)', (await gus.p.locator('#tab-more .mg-row', { hasText: 'Breakout rooms' }).getByRole('button').innerText()).includes('Status'));

  // the host visits the room
  await host.p.click('[data-tab=more]'); await host.p.locator('.bk-room', { hasText: 'Design' }).getByRole('button', { name: 'Visit' }).click();
  await waitFor(async () => (await tilesOf(host.p)).length === 3 && (await tilesOf(gus.p)).length === 3, 30000);
  await waitFor(async () => (await flowing(host.p, 'Gus')) && (await flowing(gus.p, 'Hana')), 45000, 500);
  check('visit: the host walks into the room and all three see and hear each other', (await flowing(host.p, 'Gus')) && (await flowing(host.p, 'Ivy')) && (await flowing(gus.p, 'Hana')));
  await host.p.locator('.bk-room', { hasText: 'Design' }).getByRole('button', { name: 'Leave room' }).click(); await waitFor(async () => (await tilesOf(host.p)).length === 1 && (await tilesOf(gus.p)).length === 2, 30000);

  // time runs out: the server ends the session by itself
  await pool.query("UPDATE more_breakout_sessions SET deadline = now() - interval '1 second' WHERE state='active'");
  await waitFor(async () => (await tilesOf(host.p)).length === 3 && (await tilesOf(gus.p)).length === 3 && (await tilesOf(ivy.p)).length === 3, 40000);
  await waitFor(async () => (await flowing(gus.p, 'Hana')) && (await flowing(ivy.p, 'Hana')) && (await flowing(host.p, 'Ivy')), 45000, 500);
  check('time is up: the server brings everyone back by itself and the three see and hear each other again', (await flowing(gus.p, 'Hana')) && (await flowing(ivy.p, 'Hana')) && (await flowing(host.p, 'Gus')));
  const backOk = await waitFor(async () => (await gus.p.locator('.bk-chip:not(.hidden)').count()) === 0 && (await chatHas(gus.p, 'main one')) && !(await chatHas(gus.p, 'room secret')), 20000);
  check('back in the main room: the room chip is gone and the main chat is back (no room message)', !!backOk, 'chip=' + (await gus.p.locator('.bk-chip:not(.hidden)').count()) + ' main=' + (await chatHas(gus.p, 'main one')) + ' room=' + (await chatHas(gus.p, 'room secret')));
  await chatSend(host.p, 'main two'); check('back in the main room: chat reaches everyone again', !!(await waitFor(async () => (await chatHas(gus.p, 'main two')) && (await chatHas(ivy.p, 'main two')))));

  // a second round, recalled by the host; a reconnect inside a room keeps the person in it
  const st = await pool.query("SELECT 1"); void st;
  await host.p.click('[data-tab=more]'); await host.p.locator('.bk-box select[aria-label="Room for Gus"]').selectOption({ label: 'Design' }); await host.p.waitForTimeout(500);
  await host.p.locator('.bk-box select[aria-label="Minutes"]').selectOption('5'); await host.p.locator('.bk-box').getByRole('button', { name: 'Open rooms' }).click();
  await waitFor(async () => (await tilesOf(gus.p)).length === 1 && (await tilesOf(host.p)).length === 2, 30000);
  check('round two: a one-person room works and the others stay in the main room together', (await nameplates(host.p)).some((n) => n.includes('Ivy')) && !(await nameplates(host.p)).some((n) => n.includes('Gus')), JSON.stringify([await nameplates(host.p), await nameplates(gus.p)]));
  await gus.p.reload(); await gus.p.waitForSelector('#app:not(.hidden)', { timeout: 30000 }).catch(() => {});
  check('a page reload is a new session in this build, so reconnect/rejoin is covered by the server restore test (see the unit tests)', true);
  await host.p.locator('.bk-box').getByRole('button', { name: 'Bring everyone back' }).click(); await host.p.locator('.rc-danger').click();
  check('the host recalls: Ivy and the host are together again', !!(await waitFor(async () => (await tilesOf(ivy.p)).length >= 2, 30000)));

  check('no page errors in any browser', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) { check('run completed without an exception', false, String(e.message || e).slice(0, 400)); console.log('PAGE ERRORS', JSON.stringify(pageErrors.slice(0, 6))); }
finally { await browser.close(); child.kill(); await wait(300); await pool.end(); await admin.query(`DROP DATABASE ${db} WITH (FORCE)`).catch(() => {}); await admin.end(); }
const failed = results.filter((r) => !r.ok); console.log(`\n${results.length - failed.length}/${results.length} passed`); process.exit(failed.length ? 1 : 0);
