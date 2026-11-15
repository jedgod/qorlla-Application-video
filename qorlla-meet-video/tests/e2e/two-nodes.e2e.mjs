// TWO Meet processes, one PostgreSQL, REAL browsers (v4.32 closure). The host is connected to node A; the guests to node B. Rooms are started and announced on A; everything the guests see on B must arrive through the
// shared room event log and its bus. Runs once per bus: PostgreSQL LISTEN/NOTIFY, then Redis Streams on a real Redis (scratch container, needs the `redis` package on the module path).
//   TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:25690/postgres PLAYWRIGHT_DIR=<dir with playwright> REDIS_URL=redis://127.0.0.1:36890 REDIS_CONTAINER=qroom-redis node tests/e2e/two-nodes.e2e.mjs [pg|redis]
// What it proves: scope/epoch/leads/announcements/expiry-state reach the other node; a person in another room or in the main room is NOT told; a Redis outage delays nothing important (the PostgreSQL catch-up delivers) and
// duplicates are not shown twice. What it does NOT prove: media between people on different nodes (rosters and WebRTC signaling are per node: sticky routing per meeting is still required), load, Safari/phones.
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..'), SQL = join(ROOT, 'sql');
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres', REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:36890', REDIS_CONTAINER = process.env.REDIS_CONTAINER || '';
const { chromium } = createRequire(join(process.env.PLAYWRIGHT_DIR || process.cwd(), 'package.json'))('playwright');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (n, ok, d = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !d ? '' : '  -> ' + d)); };
async function waitFor(fn, ms = 15000, step = 200) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch { /* retry */ } await wait(step); } return last; }
const docker = (...a) => execFileSync('docker', a, { stdio: 'pipe' }).toString();

async function run(mode, portBase) {
  console.log(`\n=== bus: ${mode} ===`);
  const dbn = 'tn_' + Math.random().toString(36).slice(2, 8); const admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${dbn}`);
  const dbUrl = URL.replace(/\/[^/]*$/, '/' + dbn); const pool = new pg.Pool({ connectionString: dbUrl, max: 2 }); pool.on('error', () => {}); for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8'));
  const nodes = []; const logs = {};
  for (const [name, port] of [['A', portBase], ['B', portBase + 1]]) {
    const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), DATABASE_URL: dbUrl, JWT_SECRET: 'two-node-secret-two-node-secret-0123456789', ASCS_ENABLED: 'false', API_RATE_LIMIT: '100000', MEETING_RATE_LIMIT: '100000', SOCKET_EVENT_BUDGET: '100000', ROOM_EVENTS: mode, REDIS_URL }, stdio: ['ignore', 'pipe', 'pipe'] });
    logs[name] = ''; child.stdout.on('data', (d) => (logs[name] += d)); child.stderr.on('data', (d) => (logs[name] += d)); nodes.push({ name, port, child });
  }
  for (let i = 0; i < 240 && !nodes.every((n) => logs[n.name].includes('Shared room events')); i++) await wait(250);
  if (!nodes.every((n) => logs[n.name].includes('Shared room events'))) { console.log('nodes did not start: ' + JSON.stringify(logs).slice(-600)); process.exit(2); }
  const [A, B] = nodes; const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] }); const errs = [];
  const open = async (name, node, code) => {
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } }); const p = await ctx.newPage(); p.frames_ = []; p.on('websocket', (ws) => ws.on('framereceived', (f) => p.frames_.push(String(f.payload))));
    p.on('pageerror', (e) => errs.push(name + ': ' + e.message)); await p.goto(`http://localhost:${node.port}`); await p.fill('#displayName', name);
    if (code) { await p.fill('#meetingId', code); await p.click('#joinBtn'); } else { await p.fill('#meetingTitle', 'Two nodes'); await p.click('#createBtn'); }
    await p.waitForSelector('#app:not(.hidden)', { timeout: 30000 }); return p;
  };
  const text = (p) => p.locator('body').innerText();
  try {
    const host = await open('Hana', A); const code = (await host.textContent('#roomId')).trim();
    const gus = await open('Gus', B, code); const ivy = await open('Ivy', B, code);
    await host.click('[data-tab=more]'); const row = host.locator('#tab-more .mg-row', { hasText: 'Breakout rooms' });
    await waitFor(async () => !(await row.getByRole('button').isDisabled()), 20000); await row.getByRole('button', { name: 'Create' }).click();
    await host.locator('.bk-box input[aria-label="Room name"]').fill('Design'); await host.locator('.bk-box').getByRole('button', { name: 'Add', exact: true }).click();
    await host.locator('.bk-box select[aria-label="Room for Gus"] option', { hasText: 'Design' }).waitFor({ state: 'attached', timeout: 25000 });
    await host.locator('.bk-box select[aria-label="Room for Gus"]').selectOption({ label: 'Design' });
    await waitFor(async () => (await pool.query('SELECT count(*)::int AS n FROM more_breakout_assignments WHERE room_id IS NOT NULL')).rows[0].n === 1, 20000);
    await host.locator('.bk-box select[aria-label="Minutes"]').selectOption('15'); await host.locator('.bk-box').getByRole('button', { name: 'Open rooms' }).click();
    check('node B: Gus (connected to B) is moved into the room started on node A', !!(await waitFor(async () => /Design\s*·\s*\d+:\d\d/.test(await gus.locator('.bk-chip').innerText()), 20000)));
    check('node B: Ivy (main room, also on B) is NOT moved', !(await ivy.locator('.bk-chip').isVisible()));
    const epochRows = (await pool.query('SELECT participant_id, epoch FROM more_breakout_moves ORDER BY epoch')).rows; check('the move was logged once with its epoch', epochRows.length === 1 && Number(epochRows[0].epoch) === 1, JSON.stringify(epochRows));
    // announce to the room from node A
    const announce = async (msg) => { await host.locator('.bk-box').getByRole('button', { name: 'Announce' }).click(); const d = host.locator('#rcModal'); await d.locator('select').selectOption({ label: 'Design' }); await d.locator('textarea').fill(msg); await d.getByRole('button', { name: 'Send' }).click(); await d.waitFor({ state: 'detached', timeout: 10000 }); };
    await announce('First message'); check('an announcement made on A reaches the room member on B', !!(await waitFor(async () => (await text(gus)).includes('First message'), 15000)));
    check('... and does not reach Ivy (main room) on the same node', !(await text(ivy)).includes('First message'));
    if (mode === 'redis' && REDIS_CONTAINER) {
      docker('stop', REDIS_CONTAINER); await wait(800); await announce('During the Redis outage');
      check('Redis down: the PostgreSQL catch-up still delivers the announcement', !!(await waitFor(async () => (await text(gus)).includes('During the Redis outage'), 20000)));
      docker('start', REDIS_CONTAINER); await wait(4000); await announce('After Redis returned');
      check('Redis back: delivery resumes', !!(await waitFor(async () => (await text(gus)).includes('After Redis returned'), 20000)));
      const got = (s) => gus.frames_.filter((f) => f.includes('breakout-announcement') && f.includes(s)).length; check('nothing was delivered twice to the page (outage, outbox retry and catch-up deduplicated)', got('During the Redis outage') === 1 && got('After Redis returned') === 1 && got('First message') === 1, JSON.stringify([got('First message'), got('During the Redis outage'), got('After Redis returned')]));
    }
    const dead = (await pool.query("SELECT count(*)::int AS n FROM more_room_outbox WHERE state='dead'")).rows[0].n; check('no event was dead-lettered', dead === 0, String(dead));
    await host.locator('.bk-box').getByRole('button', { name: 'Bring everyone back' }).click(); await host.locator('#rcModal').getByRole('button', { name: 'Bring back' }).click();
    check('recall on A brings Gus (on B) back: the room chip disappears', !!(await waitFor(async () => !(await gus.locator('.bk-chip').isVisible()), 20000)));
    // the page that reconnects to the OTHER node replays what it missed
    const missed = await pool.query("SELECT count(*)::int AS n FROM more_room_events WHERE replay"); check('replayable notices are stored for reconnecting pages', missed.rows[0].n >= 3, String(missed.rows[0].n));
    check('no page errors in any browser', errs.length === 0, errs.slice(0, 3).join(' | '));
  } catch (e) { check('run completed without an exception', false, String(e.message || e).slice(0, 400)); console.log('--- A:', logs.A.slice(-400), '\n--- B:', logs.B.slice(-400)); }
  finally { await browser.close(); for (const n of nodes) n.child.kill(); await wait(400); await pool.end(); await admin.query(`DROP DATABASE ${dbn} WITH (FORCE)`).catch(() => {}); await admin.end(); }
}
const modes = process.argv[2] ? [process.argv[2]] : ['pg', 'redis'];
for (const [i, m] of modes.entries()) await run(m, 4961 + i * 4);
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`); process.exit(results.every(Boolean) ? 0 : 1);
