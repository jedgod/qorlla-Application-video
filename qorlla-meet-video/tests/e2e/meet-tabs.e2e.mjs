// The five tabs of the Meet side panel (Chat, People, Notes, Polls, More) in REAL browsers against the REAL Meet server of this checkout, with a host and a guest.
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

const db = 'tabs_' + Math.random().toString(36).slice(2, 8), PORT = Number(process.env.TABS_E2E_PORT || 4980);
const admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${db}`);
const dbUrl = URL.replace(/\/[^/]*$/, '/' + db); const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8'));
const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATABASE_URL: dbUrl, JWT_SECRET: 'tabs-e2e-secret-tabs-e2e-secret-0123456789', ASCS_ENABLED: 'false', API_RATE_LIMIT: '100000', MEETING_RATE_LIMIT: '100000', SOCKET_EVENT_BUDGET: '100000' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  if (code) { await p.fill('#meetingId', code); await p.click('#joinBtn'); } else { await p.fill('#meetingTitle', 'Five tabs test'); await p.click('#createBtn'); }
  await p.waitForSelector('#app:not(.hidden)', { timeout: 30000 }); return { ctx, p };
};
const tabs = ['chat', 'people', 'notes', 'polls', 'more'];
const visibleTabs = (p) => p.evaluate((ts) => ts.filter((t) => { const e = document.getElementById('tab-' + t); return e && !e.classList.contains('hidden') && e.offsetParent !== null; }), tabs);
const tabButton = (p, t) => p.locator(`.tabs [data-tab=${t}]`);

try {
  const host = await open('Hana'); const code = (await host.p.textContent('#roomId')).trim(); const guest = await open('Gus', code);
  await waitFor(async () => (await host.p.locator('#peopleList .person').count()) >= 2);
  for (const [who, pg_] of [['host', host.p], ['guest', guest.p]]) {
    await pg_.click('[data-tab=chat]').catch(() => {});
    check(`${who}: the panel opens on the Chat tab and only Chat is showing`, JSON.stringify(await visibleTabs(pg_)) === '["chat"]', JSON.stringify(await visibleTabs(pg_)));
  }
  await host.p.locator('#chatEditor').click(); await host.p.keyboard.type('hello before tabs'); await host.p.keyboard.press('Enter');
  check('a chat message is delivered before the tab tour', !!(await waitFor(async () => (await guest.p.locator('.chat-msg', { hasText: 'hello before tabs' }).count()) === 1)));

  // People
  await host.p.click('[data-tab=people]'); await guest.p.click('[data-tab=people]');
  check('People: only the People tab is showing', JSON.stringify(await visibleTabs(host.p)) === '["people"]');
  check('People: the host sees both people by name', (await host.p.locator('#peopleList .person', { hasText: 'Hana' }).count()) === 1 && (await host.p.locator('#peopleList .person', { hasText: 'Gus' }).count()) === 1);
  check('People: the guest sees both people by name', (await guest.p.locator('#peopleList .person', { hasText: 'Hana' }).count()) === 1 && (await guest.p.locator('#peopleList .person', { hasText: 'Gus' }).count()) === 1);
  check('People: the host has controls on the guest that the guest does not have on the host', (await host.p.locator('#peopleList .person', { hasText: 'Gus' }).getByRole('button').count()) > 0 && (await guest.p.locator('#peopleList .person', { hasText: 'Hana' }).getByRole('button').count()) === 0);
  if (OUT) await host.p.screenshot({ path: join(OUT, 'tab-people.png') });

  // Notes
  await host.p.click('[data-tab=notes]'); await guest.p.click('[data-tab=notes]');
  check('Notes: only the Notes tab is showing and it has content for both', JSON.stringify(await visibleTabs(host.p)) === '["notes"]' && JSON.stringify(await visibleTabs(guest.p)) === '["notes"]' && (await host.p.locator('#tab-notes').innerText()).trim().length > 0 && (await guest.p.locator('#tab-notes').innerText()).trim().length > 0, (await host.p.locator('#tab-notes').innerText()).slice(0, 80));
  if (OUT) await host.p.screenshot({ path: join(OUT, 'tab-notes.png') });

  // Polls (a host tool: the guest gets the tab only when the host has switched it on)
  await host.p.click('[data-tab=polls]');
  check('Polls: the host sees the Polls tab with content', JSON.stringify(await visibleTabs(host.p)) === '["polls"]' && (await host.p.locator('#tab-polls').innerText()).trim().length > 0, (await host.p.locator('#tab-polls').innerText()).slice(0, 80));
  check('Polls: the guest has no Polls tab while the host has not allowed polls', (await tabButton(guest.p, 'polls').count()) === 0 || !(await tabButton(guest.p, 'polls').isVisible()));
  if (OUT) await host.p.screenshot({ path: join(OUT, 'tab-polls.png') });

  // More
  await host.p.click('[data-tab=more]'); await guest.p.click('[data-tab=more]');
  check('More: only the More tab is showing and it has content for both', JSON.stringify(await visibleTabs(host.p)) === '["more"]' && JSON.stringify(await visibleTabs(guest.p)) === '["more"]' && (await host.p.locator('#tab-more').innerText()).trim().length > 0 && (await guest.p.locator('#tab-more').innerText()).trim().length > 0);
  if (OUT) await host.p.screenshot({ path: join(OUT, 'tab-more.png') });

  // back to Chat: nothing was lost, and live delivery still works after the tour
  await host.p.click('[data-tab=chat]'); await guest.p.click('[data-tab=chat]');
  check('back on Chat: the earlier message and the composer are intact', JSON.stringify(await visibleTabs(host.p)) === '["chat"]' && (await host.p.locator('.chat-msg', { hasText: 'hello before tabs' }).count()) === 1 && (await host.p.locator('#chatEditor').isVisible()));
  await guest.p.locator('#chatEditor').click(); await guest.p.keyboard.type('after the tab tour'); await guest.p.keyboard.press('Enter');
  check('live chat still works after visiting every tab', !!(await waitFor(async () => (await host.p.locator('.chat-msg', { hasText: 'after the tab tour' }).count()) === 1)));

  // a message that arrives while another tab is showing is there when the person comes back
  await guest.p.click('[data-tab=people]'); await host.p.locator('#chatEditor').click(); await host.p.keyboard.type('sent while you were away'); await host.p.keyboard.press('Enter'); await wait(500);
  await guest.p.click('[data-tab=chat]');
  check('a chat message that arrived while another tab was open is waiting on Chat', (await guest.p.locator('.chat-msg', { hasText: 'sent while you were away' }).count()) === 1);

  // Close button closes the whole panel and the Chat button in the control bar brings it back
  await host.p.click('#chatCloseBtn'); check('the chat Close button closes the side panel', !!(await waitFor(async () => !(await host.p.locator('#panel').isVisible()))));
  await host.p.click('#chatBtn'); check('the Chat button in the control bar reopens the panel on Chat', !!(await waitFor(async () => (await host.p.locator('#panel').isVisible()) && JSON.stringify(await visibleTabs(host.p)) === '["chat"]')));
  check('no JavaScript errors on any page', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) { check('run completed without an exception', false, String(e.message || e).slice(0, 400)); }
finally { await browser.close(); child.kill(); await wait(300); await pool.end(); await admin.query(`DROP DATABASE ${db} WITH (FORCE)`).catch(() => {}); await admin.end(); }
const bad = results.filter((r) => !r.ok); console.log(`\n${results.length - bad.length}/${results.length} passed`); process.exit(bad.length ? 1 : 0);
