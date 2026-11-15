// Breakout rooms V1.1 (v4.30) in REAL browsers: room-scoped Notes and Polls, Ask for help, Return to the main room; host + two guests in a room + one guest in the main room (real fake-device WebRTC).
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

const db = 'bk11_' + Math.random().toString(36).slice(2, 8), PORT = Number(process.env.BK_E2E_PORT || 4982);
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

const stage = async (p, name) => { if (OUT) await p.screenshot({ path: join(OUT, name + '.png') }).catch(() => {}); };
try {
  const host = await open('Hana'); globalThis.__h = host; if (process.env.BK_HTTP) host.p.on('response', async (r) => { if (/breakouts|\/tools|notes|polls/.test(r.url())) console.log('HTTP', r.request().method(), r.status(), r.url().replace(/.*\/meetings\/[^/]+/, '')); }); const code = (await host.p.textContent('#roomId')).trim();
  await pool.query(`UPDATE meetings SET guest_tools = '{"polls":true}'::jsonb WHERE meeting_code=$1 OR id::text=$1`, [code]);      // the host switched Polls on for guests
  const gus = await open('Gus', code); const ivy = await open('Ivy', code);
  await waitFor(async () => (await tilesOf(host.p)).length === 3 && (await tilesOf(ivy.p)).length === 3, 40000);

  // host: one room "Design" with Gus and Ivy, open it
  await host.p.click('[data-tab=more]'); const row = host.p.locator('#tab-more .mg-row', { hasText: 'Breakout rooms' });
  await waitFor(async () => !(await row.getByRole('button').isDisabled()), 20000); await row.getByRole('button', { name: 'Create' }).click();
  await host.p.locator('.bk-box input[aria-label="Room name"]').fill('Design'); await host.p.locator('.bk-box').getByRole('button', { name: 'Add', exact: true }).click();
  await host.p.locator('.bk-box select[aria-label="Room for Gus"]').waitFor({ timeout: 15000 });
  await host.p.locator('.bk-box select[aria-label="Room for Gus"] option', { hasText: 'Design' }).waitFor({ state: 'attached', timeout: 20000 });
  await host.p.locator('.bk-box select[aria-label="Room for Gus"]').selectOption({ label: 'Design' }); await host.p.waitForTimeout(400);
  await host.p.locator('.bk-box select[aria-label="Room for Ivy"]').selectOption({ label: 'Design' }); await host.p.waitForTimeout(400);
  await host.p.locator('.bk-box select[aria-label="Minutes"]').selectOption('15'); await host.p.locator('.bk-box').getByRole('button', { name: 'Open rooms' }).click();
  await waitFor(async () => (await tilesOf(gus.p)).length === 2 && (await tilesOf(ivy.p)).length === 2 && (await tilesOf(host.p)).length === 1, 30000);
  await waitFor(async () => (await flowing(gus.p, 'Ivy')) && (await flowing(ivy.p, 'Gus')), 45000, 500);
  check('rooms open: Gus and Ivy are together, the host is separate', (await flowing(gus.p, 'Ivy')) && (await flowing(ivy.p, 'Gus')) && !(await nameplates(host.p)).some((n) => n.includes('Gus') || n.includes('Ivy')));
  check('guests in a room see "Ask for help" and "Back to main room"; the host does not', (await gus.p.locator('.stage-top .bk-acts:not(.hidden) [data-bk-help]').count()) === 1 && (await gus.p.locator('.stage-top').getByRole('button', { name: 'Back to main room' }).isVisible()) && (await host.p.locator('.bk-acts').count()) === 0);

  // ---- Notes belong to the room
  await gus.p.click('[data-tab=notes]');
  check('notes: inside a room the tab says it is the room notes, and version history is off', !!(await waitFor(async () => /Room notes\s*·\s*Design/.test(await gus.p.locator('#notesRole').innerText()) && await gus.p.locator('#notesHistory').isDisabled(), 15000)));
  await gus.p.locator('#nNotes textarea').click(); await gus.p.keyboard.type('design room notes'); await waitFor(async () => /Saved/.test(await gus.p.locator('#notesStatus').innerText()), 15000);
  await ivy.p.click('[data-tab=notes]'); await host.p.click('[data-tab=notes]');
  const area = (p) => p.locator('#nNotes textarea').inputValue();
  await waitFor(async () => (await area(ivy.p)).includes('design room notes'), 15000);
  check('notes: Ivy (same room) gets the text live, with the room label', (await area(ivy.p)).includes('design room notes') && !!(await waitFor(async () => /Room notes/.test(await ivy.p.locator('#notesRole').innerText()), 10000)));
  await host.p.waitForTimeout(800);
  check('notes: the host (main room) does not see it', !(await area(host.p)).includes('design room notes') && /Host editor/.test(await host.p.locator('#notesRole').innerText()));
  await host.p.click('[data-tab=more]'); await host.p.locator('.bk-room', { hasText: 'Design' }).getByRole('button', { name: 'Notes' }).click();
  check('notes: the host can read the room notes from the Breakout rooms panel', await waitFor(async () => (await host.p.locator('.nt-preview').innerText()).includes('design room notes'), 10000));
  await host.p.locator('.rc-primary', { hasText: 'Close' }).click();

  // ---- Polls belong to the room
  await host.p.click('[data-tab=polls]'); await host.p.click('#pollNew'); await host.p.locator('#pq').fill('Room poll?');
  await host.p.locator('.plc-opt').nth(0).fill('Yes'); await host.p.locator('.plc-opt').nth(1).fill('No');
  check('polls: while rooms are open the host can choose where a poll goes', (await host.p.locator('#pRoom option').allTextContents()).some((t) => t.includes('Design')));
  await host.p.locator('#pRoom').selectOption({ label: 'Design' }); await host.p.getByRole('button', { name: 'Launch poll' }).click();
  await gus.p.click('[data-tab=polls]');
  check('polls: Gus (in the room) sees it', !!(await waitFor(async () => (await gus.p.locator('#pollList').innerText()).includes('Room poll?'), 15000)));
  check('polls: the host sees it tagged with the room', !!(await waitFor(async () => /Room:\s*Design/.test(await host.p.locator('#pollList').innerText()), 10000)));
  await gus.p.locator('.pl-vote input').first().check(); await gus.p.getByRole('button', { name: 'Submit vote' }).click();
  check('polls: Gus can vote in his room poll', !!(await waitFor(async () => /vote is recorded|Vote recorded/.test(await gus.p.locator('#pollList').innerText()), 10000)));

  // ---- Ask for help
  await ivy.p.locator('.stage-top .bk-acts [data-bk-help]').click();
  check('help: the host is told (the chip counts it) and sees who and where', !!(await waitFor(async () => /1 asking for help/.test(await host.p.locator('.bk-chip').innerText()), 15000)));
  await host.p.click('[data-tab=more]'); const hq = host.p.locator('.bk-help');
  check('help: the host list names Ivy and the room; Gus is not told', await waitFor(async () => (await hq.innerText()).includes('Ivy') && (await hq.innerText()).includes('Design'), 10000) && (await gus.p.locator('.bk-help').count()) === 0);
  check('help: the button changes to "Cancel help request" for Ivy', /Cancel help request/.test(await ivy.p.locator('.stage-top .bk-acts [data-bk-help]').innerText()));
  await stage(host.p, 'help-host');
  await hq.getByRole('button', { name: 'Resolve' }).click();
  check('help: Resolve clears the request and Ivy can ask again later', !!(await waitFor(async () => /Ask for help/.test(await ivy.p.locator('.stage-top .bk-acts [data-bk-help]').innerText()) && (await host.p.locator('.bk-help').count()) === 0, 15000)));

  // ---- Return to the main room
  await gus.p.locator('.stage-top').getByRole('button', { name: 'Back to main room' }).click(); await gus.p.getByRole('button', { name: 'Go back' }).click();
  await waitFor(async () => (await tilesOf(gus.p)).length === 2 && (await tilesOf(ivy.p)).length === 1 && (await tilesOf(host.p)).length === 2, 30000);
  await waitFor(async () => (await flowing(gus.p, 'Hana')) && (await flowing(host.p, 'Gus')), 45000, 500);
  check('return: Gus is back in the main room, sees and hears the host (and the host him); Ivy is alone in the room', (await flowing(gus.p, 'Hana')) && (await flowing(host.p, 'Gus')) && (await tilesOf(ivy.p)).length === 1);
  check('return: Gus has no room buttons any more and his notes are the main notes', (await gus.p.locator('.bk-acts:not(.hidden)').count()) === 0 && !/Room notes/.test(await gus.p.locator('#notesRole').innerText()) && !(await area(gus.p)).includes('design room notes'));
  check('return: the room poll is gone from Gus', !(await gus.p.locator('#pollList').innerText()).includes('Room poll?'));
  check('return: the host list stops saying "connecting" once the page is ready', !!(await waitFor(async () => !(await host.p.locator('.bk-box').innerText()).includes('connecting'), 25000)));
  await stage(host.p, 'return-host');

  // ---- the host recalls: the last person comes back, and room content is no longer the guests' business
  await host.p.locator('.bk-box').getByRole('button', { name: 'Bring everyone back' }).click(); await host.p.locator('.rc-danger').click();
  await waitFor(async () => (await tilesOf(ivy.p)).length === 3, 30000);
  await ivy.p.click('[data-tab=notes]'); await waitFor(async () => !/Room notes/.test(await ivy.p.locator('#notesRole').innerText()), 15000);
  check('recall: Ivy is back with everyone and sees the main notes, not the room notes', (await tilesOf(ivy.p)).length === 3 && !(await area(ivy.p)).includes('design room notes') && !/Room notes/.test(await ivy.p.locator('#notesRole').innerText()));
  check('no page errors in any browser', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  check('run completed without an exception', false, String(e.message || e).slice(0, 400));
  if (process.env.BK_DEBUG) {
    console.log('--- more tab:', await globalThis.__h?.p.evaluate(() => { const b = document.querySelector('.bk-box'); return JSON.stringify({ boxHidden: b && b.hidden, tab: document.getElementById('tab-more').className, rows: [...document.querySelectorAll('#tab-more .mg-row')].map((x) => x.innerText.replace(/\s+/g, ' ')).slice(0, 6) }); }).catch((x) => String(x)));
    console.log('--- rooms in db:', JSON.stringify((await pool.query('SELECT name FROM more_breakout_rooms')).rows));
    console.log('--- server log tail:', log.slice(-600));
  }
}
finally { await browser.close(); child.kill(); await wait(300); await pool.end(); await admin.query(`DROP DATABASE ${db} WITH (FORCE)`).catch(() => {}); await admin.end(); }
const failed = results.filter((r) => !r.ok); console.log(`\n${results.length - failed.length}/${results.length} passed`); process.exit(failed.length ? 1 : 0);
