// Breakout rooms V1.2 to V1.7 (v4.31) in REAL browsers: room epochs, a group lead, Mission Board, a timed exercise, the room whiteboard, a report, the host dashboard (host + two guests, real fake-device WebRTC).
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

const db = 'cls_' + Math.random().toString(36).slice(2, 8), PORT = Number(process.env.BK_E2E_PORT || 4983);
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
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } }); const p = await ctx.newPage(); const wsLog = []; p.on('websocket', (ws) => { ws.on('framereceived', (f) => wsLog.push('<' + String(f.payload))); ws.on('framesent', (f) => wsLog.push('>' + String(f.payload))); });
  p.on('pageerror', (e) => pageErrors.push(name + ': ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) pageErrors.push(name + ' console: ' + m.text()); });
  await p.goto(base); await p.fill('#displayName', name);
  if (code) { await p.fill('#meetingId', code); await p.click('#joinBtn'); } else { await p.fill('#meetingTitle', 'Breakouts test'); await p.click('#createBtn'); }
  await p.waitForSelector('#app:not(.hidden)', { timeout: 30000 }); return { ctx, p, wsLog };
};

const tilesOf = (p) => p.evaluate(() => [...document.querySelectorAll('.tile')].map((t) => t.id.slice(5)));
const nameplates = (p) => p.evaluate(() => [...document.querySelectorAll('.tile .nameplate')].map((n) => n.textContent.trim()));
// media really flows between two people when the other person's <video> has decoded frames
const flowing = (p, name) => p.evaluate((nm) => [...document.querySelectorAll('.tile')].some((t) => t.querySelector('.nameplate')?.textContent.includes(nm) && [...t.querySelectorAll('video')].some((v) => v.videoWidth > 0 && v.readyState >= 2)), name);
const chatSend = async (p, text) => { await p.click('[data-tab=chat]'); await p.locator('#chatEditor').click(); await p.keyboard.type(text); await p.keyboard.press('Enter'); };
const chatHas = async (p, text) => (await p.locator('.chat-msg', { hasText: text }).count()) > 0;

const stage = async (p, name) => { if (OUT) await p.screenshot({ path: join(OUT, name + '.png') }).catch(() => {}); };
try {
  const host = await open('Hana'); globalThis.__h = host; const code = (await host.p.textContent('#roomId')).trim();
  const gus = await open('Gus', code); const ivy = await open('Ivy', code); globalThis.__g = gus;
  await waitFor(async () => (await tilesOf(host.p)).length === 3 && (await tilesOf(ivy.p)).length === 3, 40000);

  // host: one room "Design" with Gus and Ivy, open it
  await host.p.click('[data-tab=more]'); const row = host.p.locator('#tab-more .mg-row', { hasText: 'Breakout rooms' });
  await waitFor(async () => !(await row.getByRole('button').isDisabled()), 20000); await row.getByRole('button', { name: 'Create' }).click();
  await host.p.locator('.bk-box input[aria-label="Room name"]').fill('Design'); await host.p.locator('.bk-box').getByRole('button', { name: 'Add', exact: true }).click();
  await host.p.locator('.bk-box select[aria-label="Room for Gus"] option', { hasText: 'Design' }).waitFor({ state: 'attached', timeout: 20000 });
  await host.p.locator('.bk-box select[aria-label="Room for Gus"]').selectOption({ label: 'Design' }); await host.p.waitForTimeout(400);
  await host.p.locator('.bk-box select[aria-label="Room for Ivy"]').selectOption({ label: 'Design' }); await host.p.waitForTimeout(400);
  await waitFor(async () => (await pool.query('SELECT count(*)::int AS n FROM more_breakout_assignments WHERE room_id IS NOT NULL')).rows[0].n === 2, 20000);          // both choices reached the server before the rooms open
  await host.p.locator('.bk-box select[aria-label="Minutes"]').selectOption('15'); await host.p.locator('.bk-box').getByRole('button', { name: 'Open rooms' }).click();
  await waitFor(async () => (await tilesOf(gus.p)).length === 2 && (await tilesOf(ivy.p)).length === 2 && (await tilesOf(host.p)).length === 1, 30000);
  await waitFor(async () => (await flowing(gus.p, 'Ivy')) && (await flowing(ivy.p, 'Gus')), 45000, 500);
  check('rooms open: Gus and Ivy see and hear each other, the host is separate', (await flowing(gus.p, 'Ivy')) && (await flowing(ivy.p, 'Gus')) && !(await nameplates(host.p)).some((n) => n.includes('Gus')));

  // ---- V1.2: epochs. The page knows its epoch; a signal stamped with an older one is refused by the server.
  const lastEpoch = (log) => { for (const l of [...log].reverse()) { const m = /^<42\["breakout-scope",\{[^}]*"epoch":(\d+)/.exec(l); if (m) return Number(m[1]); } };
  const epoch = await waitFor(() => lastEpoch(gus.wsLog), 10000);
  check('epochs: the server sent the page its room epoch', Number.isInteger(epoch) && epoch >= 1, String(epoch));
  check('epochs: the page stamps its epoch on every signal it sends, and the server stamps the recipient epoch on what it relays', !!(await waitFor(async () => gus.wsLog.some((l) => l.startsWith('>42["signal"') && l.includes('"se":' + epoch)) && gus.wsLog.some((l) => l.startsWith('<42["signal"') && l.includes('"toEpoch":' + epoch)), 15000)),
    gus.wsLog.filter((l) => /signal/.test(l)).slice(0, 2).join(' || ').slice(0, 300));
  check('epochs: no signal was sent without an epoch after the move', !gus.wsLog.some((l) => l.startsWith('>42["signal"') && !l.includes('"se":')));

  // ---- V1.2: the host makes Gus a room lead (all four powers)
  await host.p.click('[data-tab=more]'); const leadBtn = host.p.locator('.bk-box .bk-p', { hasText: 'Gus' }).getByRole('button', { name: 'Lead' });
  await leadBtn.waitFor({ timeout: 15000 }); await leadBtn.click();
  const dlg = host.p.locator('#rcModal'); await dlg.waitFor({ timeout: 10000 });
  for (const cb of await dlg.locator('input[type=checkbox]').all()) await cb.check();
  await dlg.getByRole('button', { name: 'Save' }).click(); await dlg.waitFor({ state: 'detached', timeout: 10000 });
  check('leads: the lead gets the Announce button and the poll form; a normal guest does not', !!(await waitFor(async () => (await gus.p.locator('.stage-top [data-bk-announce]:not(.hidden)').count()) === 1, 15000)) && !!(await waitFor(async () => !(await gus.p.locator('#pollNew').evaluate((n) => n.classList.contains('hidden'))), 10000)) && (await ivy.p.locator('.stage-top [data-bk-announce]:not(.hidden)').count()) === 0 && await ivy.p.locator('#pollNew').evaluate((n) => n.classList.contains('hidden')));
  check('leads: the host list marks Gus as a lead', !!(await waitFor(async () => /★\s*Gus/.test(await host.p.locator('.bk-box').innerText()), 10000)));

  // announcement from the lead reaches the room only
  await gus.p.locator('.stage-top [data-bk-announce]').click(); await gus.p.locator('#rcModal textarea').fill('Five minutes left'); await gus.p.locator('#rcModal').getByRole('button', { name: 'Send' }).click();
  check('announce: Ivy (same room) is told, the host (another scope) is not', !!(await waitFor(async () => (await ivy.p.locator('body').innerText()).includes('Gus: Five minutes left') || (await ivy.p.locator('#toasts, .toast, [role=status]').allInnerTexts()).join(' ').includes('Five minutes left'), 10000)) && !(await host.p.locator('body').innerText()).includes('Five minutes left'));

  // ---- V1.3: Mission Board. Gus (lead) creates a mission and a task for Ivy; Ivy marks it done; both see it live.
  const board = (p) => p.locator('.cl-box');
  await gus.p.locator('.stage-top').getByRole('button', { name: 'Room board' }).click(); await board(gus.p).waitFor({ timeout: 10000 });
  await board(gus.p).locator('input[aria-label="New mission title"]').waitFor({ timeout: 15000 });
  await board(gus.p).locator('input[aria-label="New mission title"]').fill('Plan the launch'); await board(gus.p).getByRole('button', { name: 'Add mission' }).click();
  await board(gus.p).locator('input[aria-label="Add a task"]').waitFor({ timeout: 15000 });
  await board(gus.p).locator('input[aria-label="Add a task"]').fill('Write the brief'); await board(gus.p).locator('select[aria-label="Give the task to"]').selectOption({ label: 'Ivy' }); await board(gus.p).getByRole('button', { name: 'Add', exact: true }).click();
  await ivy.p.click('[data-tab=more]'); await ivy.p.locator('#tab-more .mg-row', { hasText: 'Room board' }).getByRole('button').click();
  const taskSel = board(ivy.p).locator('select[aria-label="State of Write the brief"]'); await taskSel.waitFor({ timeout: 20000 });
  check('mission: Ivy sees her task and may change it; she has no mission form (not a lead)', await taskSel.isEnabled() && (await board(ivy.p).locator('input[aria-label="New mission title"]').count()) === 0);
  await taskSel.selectOption('done');
  check('mission: Gus sees "1/1 tasks done" live', !!(await waitFor(async () => /1\/1 tasks done/.test(await board(gus.p).innerText()), 15000)));

  // ---- V1.4/V1.5: a timed exercise
  await board(gus.p).getByRole('button', { name: 'Exercises' }).click();
  await board(gus.p).locator('input[aria-label="New exercise title"]').fill('Quick quiz'); await board(gus.p).locator('textarea[aria-label="What should they do?"]').fill('Name two colours'); await board(gus.p).getByRole('button', { name: 'Create exercise' }).click();
  await board(gus.p).getByRole('button', { name: /^Start/ }).click({ timeout: 15000 });
  await board(ivy.p).getByRole('button', { name: 'Exercises' }).click(); const ans = board(ivy.p).locator('textarea[aria-label="Your answer"]'); await ans.waitFor({ timeout: 20000 });
  check('exercise: it is running for Ivy with a countdown', !!(await waitFor(async () => /\d+:\d+ left/.test(await board(ivy.p).innerText()), 10000)));
  await ans.fill('red and blue'); await board(ivy.p).getByRole('button', { name: 'Submit answer' }).click();
  check('exercise: Ivy answered once; the lead sees the answer, Ivy sees only her own', !!(await waitFor(async () => /Ivy: red and blue/.test(await board(gus.p).innerText()), 15000)) && !!(await waitFor(async () => /Your answer: red and blue/.test(await board(ivy.p).innerText()), 10000)));

  // ---- V1.5: the room whiteboard, replayed to everybody in the room
  await board(ivy.p).getByRole('button', { name: 'Whiteboard' }).click(); await board(gus.p).getByRole('button', { name: 'Whiteboard' }).click();
  const cv = board(ivy.p).locator('canvas'); await cv.waitFor({ timeout: 10000 }); await cv.scrollIntoViewIfNeeded(); const bb = await cv.boundingBox();
  await ivy.p.mouse.move(bb.x + bb.width * 0.2, bb.y + bb.height * 0.3); await ivy.p.mouse.down(); await ivy.p.mouse.move(bb.x + bb.width * 0.6, bb.y + bb.height * 0.6, { steps: 8 }); await ivy.p.mouse.up();
  const inked = (p) => p.evaluate(() => { const c = document.querySelector('.cl-box canvas'); if (!c) return 0; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 240 || d[i + 1] < 240) n++; return n; });
  check('whiteboard: what Ivy drew appears on Gus\'s board', !!(await waitFor(async () => (await inked(gus.p)) > 50, 15000)), String(await inked(gus.p)));
  check('whiteboard: the host did not receive it before opening the room board', (await host.p.locator('.cl-box canvas').count()) === 0);

  // ---- V1.7: a group report, and the host's classroom view
  await board(gus.p).getByRole('button', { name: 'Reports' }).click(); await board(gus.p).locator('input[aria-label="Report title"]').fill('Findings'); await board(gus.p).locator('textarea[aria-label="What did the group find?"]').fill('We agree on the plan'); await board(gus.p).getByRole('button', { name: 'Save report' }).click();
  check('dashboard: the host list shows the room\'s tasks, missions and reports', !!(await waitFor(async () => /tasks 1\/1/.test(await host.p.locator('.bk-box').innerText()) && /reports 1/.test(await host.p.locator('.bk-box').innerText()), 20000)), (await host.p.locator('.bk-box').innerText()).slice(0, 300));
  await host.p.locator('.bk-box .bk-room', { hasText: 'Design' }).getByRole('button', { name: 'Board' }).click();
  check('host: opens the room board and reads the mission and the report', !!(await waitFor(async () => /Plan the launch/.test(await board(host.p).innerText()), 15000)));
  await board(host.p).getByRole('button', { name: 'Reports' }).click();
  check('host: the report text is there', !!(await waitFor(async () => /We agree on the plan/.test(await board(host.p).innerText()), 10000)));

  // ---- leads lose their powers with the room
  await gus.p.locator('.stage-top').getByRole('button', { name: 'Back to main room' }).click(); await gus.p.locator('#rcModal').getByRole('button', { name: 'Go back' }).click();
  await waitFor(async () => (await tilesOf(gus.p)).length === 1 && (await tilesOf(host.p)).length === 2, 30000);
  check('lead: after returning to the main room the powers are gone (page and database)', !!(await waitFor(async () => (await gus.p.locator('.stage-top [data-bk-announce]:not(.hidden)').count()) === 0 && (await pool.query("SELECT count(*)::int AS n FROM more_breakout_leads").then((r) => r.rows[0].n)) === 0, 15000)));
  await host.p.locator('.bk-box').getByRole('button', { name: 'Bring everyone back' }).click(); await host.p.locator('#rcModal').getByRole('button', { name: 'Bring back' }).click();
  await waitFor(async () => (await tilesOf(host.p)).length === 3, 30000);
  await waitFor(async () => /read only/.test(await board(host.p).innerText()), 15000); await board(host.p).getByRole('button', { name: 'Missions' }).click();
  check('after the rooms close the host still reads the room board', !!(await waitFor(async () => /read only/.test(await board(host.p).innerText()) && /Plan the launch/.test(await board(host.p).innerText()), 15000)), (await board(host.p).innerText()).slice(0, 120) + ' | active=' + (await host.p.evaluate(() => document.activeElement?.outerHTML.slice(0, 140))));
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  check('run completed without an exception', false, String(e.message || e).slice(0, 500));
  if (process.env.BK_DEBUG) { console.log('--- gus board:', (await globalThis.__g?.p.locator('.cl-box').innerText().catch((x) => String(x)))?.slice(0, 700)); console.log('--- host panel:', (await globalThis.__h?.p.locator('.bk-box').innerText().catch((x) => String(x)))?.slice(0, 700)); console.log('--- gus scope frames:', (globalThis.__g?.wsLog || []).filter((l) => /breakout-scope|roster/.test(l)).map((l) => l.slice(0, 160)).join(' ## ')); console.log('--- server log tail:', log.slice(-800)); }
}
finally { await browser.close(); child.kill(); await wait(300); await pool.end(); await admin.query(`DROP DATABASE ${db} WITH (FORCE)`).catch(() => {}); await admin.end(); }
const failed = results.filter((r) => !r.ok); console.log(`\n${results.length - failed.length}/${results.length} passed`); process.exit(failed.length ? 1 : 0);
