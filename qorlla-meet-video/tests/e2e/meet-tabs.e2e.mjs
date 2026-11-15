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
  // the Create New Poll form: question, type radios, option rows with remove and an n/10 counter, switches, time limit, Save draft / Launch poll
  await host.p.click('#pollNew'); const pf = host.p.locator('#pollFormEl');
  check('Create New Poll: heading, Host editor badge, two option rows 2/10, Single choice selected', (await pf.innerText()).includes('Create New Poll') && (await pf.innerText()).includes('Host editor') && (await pf.locator('.plc-count').innerText()) === '2/10' && await pf.locator('input[name=pk][value=single]').isChecked());
  if (OUT) await host.p.screenshot({ path: join(OUT, 'tab-polls-form.png') });
  await pf.getByRole('button', { name: 'Launch poll' }).click();
  check('Create New Poll: a poll without a question is refused (nothing is created)', (await host.p.locator('#pollList .pl-card').count()) === 0 && await pf.isVisible());
  await pf.locator('#pq').fill('Lunch?'); await pf.getByRole('button', { name: '+ Add option' }).click();
  const opts = pf.locator('.plc-opt'); await opts.nth(0).fill('Pizza'); await opts.nth(1).fill('Salad'); await opts.nth(2).fill('Soup');
  check('Create New Poll: adding an option shows 3/10, removing one shows 2/10', (await pf.locator('.plc-count').innerText()) === '3/10' && (await (async () => { await pf.locator('.plc-x').nth(2).click(); return pf.locator('.plc-count').innerText(); })()) === '2/10');
  await pf.getByRole('button', { name: 'Launch poll' }).click(); await host.p.locator('#pollList .pl-card', { hasText: 'Lunch?' }).waitFor({ timeout: 15000 });
  check('Create New Poll: Launch poll opens the poll and lists it under Active', (await host.p.locator('#pollList .pl-card', { hasText: 'Lunch?' }).innerText()).includes('Pizza') && (await host.p.locator('#pollFormEl').count()) === 0);
  if (OUT) await host.p.screenshot({ path: join(OUT, 'tab-polls.png') });

  // More
  await host.p.click('[data-tab=more]'); await guest.p.click('[data-tab=more]');
  check('More: only the More tab is showing and it has content for both', JSON.stringify(await visibleTabs(host.p)) === '["more"]' && JSON.stringify(await visibleTabs(guest.p)) === '["more"]' && (await host.p.locator('#tab-more').innerText()).trim().length > 0 && (await guest.p.locator('#tab-more').innerText()).trim().length > 0);
  // More tab, REAL tools: Q&A (guest asks, host answers), the server-clock timer, attendance, focus mode
  const qaOpen = async (pg) => { const row = pg.locator('#tab-more .mg-row', { hasText: 'Q&A' }); await row.getByRole('button', { name: /Open|Close/ }).waitFor(); if ((await row.getByRole('button').innerText()).trim() === 'Open') await row.getByRole('button').click(); };
  await host.p.waitForFunction(() => { const b = [...document.querySelectorAll('#tab-more .mg-row')].find((r) => r.textContent.includes('Q&A'))?.querySelector('button'); return b && !b.disabled; }, null, { timeout: 15000 });
  await guest.p.waitForFunction(() => { const b = [...document.querySelectorAll('#tab-more .mg-row')].find((r) => r.textContent.includes('Q&A'))?.querySelector('button'); return b && !b.disabled; }, null, { timeout: 15000 });
  await qaOpen(guest.p); await guest.p.locator('.mg-qform input').fill('Will the recording be shared?'); await guest.p.locator('.mg-qform').getByRole('button', { name: 'Ask' }).click();
  await qaOpen(host.p); await host.p.locator('.mg-q', { hasText: 'Will the recording be shared?' }).waitFor({ timeout: 15000 });
  check('Q&A: a guest question reaches the host live, with the guest name', (await host.p.locator('.mg-q', { hasText: 'Will the recording be shared?' }).innerText()).includes('Gus'));
  check('Q&A: a guest has no answer or hide controls', (await guest.p.locator('.mg-q input').count()) === 0 && (await guest.p.getByRole('button', { name: 'Hide', exact: true }).count()) === 0);
  await host.p.locator('.mg-q', { hasText: 'Will the recording be shared?' }).locator('input').fill('Only to the host.'); await host.p.locator('.mg-q', { hasText: 'Will the recording be shared?' }).getByRole('button', { name: 'Answer' }).click();
  await guest.p.locator('.mg-ans', { hasText: 'Only to the host.' }).waitFor({ timeout: 30000 }); check('Q&A: the host answer reaches the guest live', true);
  // Collaboration: anonymous Q&A, more reactions, and the shared whiteboard (host draws, the guest sees it live; the host can switch guest drawing off)
  await guest.p.locator('.mg-qform input').fill('Is this anonymous?'); await guest.p.locator('#qaAnon').check(); await guest.p.locator('.mg-qform').getByRole('button', { name: 'Ask' }).click();
  await host.p.locator('.mg-q', { hasText: 'Is this anonymous?' }).waitFor({ timeout: 30000 });
  check('Q&A: an anonymous question shows the host who asked, marked as anonymous to others', (await host.p.locator('.mg-q', { hasText: 'Is this anonymous?' }).innerText()).includes('anonymous to others'));
  await host.p.locator('#tab-more').getByRole('button', { name: 'More reactions' }).click(); check('Reactions: the ... button reveals five more reactions', await host.p.locator('#tab-more').getByRole('button', { name: 'React with ✅' }).isVisible());
  await host.p.locator('#tab-more .mg-row', { hasText: 'Whiteboard' }).getByRole('button', { name: 'Open' }).click(); await host.p.locator('.wb-ov:not([hidden]) .wb-cv').waitFor({ timeout: 15000 });
  await guest.p.locator('#tab-more .mg-row', { hasText: 'Whiteboard' }).getByRole('button', { name: 'Open' }).click(); await guest.p.locator('.wb-ov:not([hidden]) .wb-cv').waitFor({ timeout: 15000 });
  const inkAt = (pg) => pg.evaluate(() => { const c = document.querySelector('.wb-cv'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 200 && d[i + 1] < 200) n++; return n; });
  const hb = await host.p.locator('.wb-cv').boundingBox(); await host.p.mouse.move(hb.x + hb.width * .2, hb.y + hb.height * .3); await host.p.mouse.down(); await host.p.mouse.move(hb.x + hb.width * .5, hb.y + hb.height * .6, { steps: 8 }); await host.p.mouse.up();
  await host.p.waitForFunction(() => { const c = document.querySelector('.wb-cv'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 4) if (d[i] < 200 && d[i + 1] < 200) return true; return false; }, null, { timeout: 15000 });
  await guest.p.waitForFunction(() => { const c = document.querySelector('.wb-cv'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 4) if (d[i] < 200 && d[i + 1] < 200) return true; return false; }, null, { timeout: 30000 });
  check('Whiteboard: the host stroke appears on the guest board', (await inkAt(guest.p)) > 50 && (await inkAt(host.p)) > 50);
  check('Whiteboard: the guest cannot clear the board, the host can', (await guest.p.locator('.wb-ov .wb-btn', { hasText: 'Clear all' }).isHidden()) && (await host.p.locator('.wb-ov .wb-btn', { hasText: 'Clear all' }).isVisible()));
  await host.p.locator('#wbAllow').uncheck(); await guest.p.waitForFunction(() => [...document.querySelectorAll('.wb-ov .wb-btn[data-tool]')].every((b) => b.disabled), null, { timeout: 30000 });
  check('Whiteboard: when the host switches drawing off the guest tools are disabled', (await guest.p.locator('.wb-status').innerText()).includes('switched drawing off'));
  await host.p.locator('.wb-ov .wb-btn', { hasText: 'Clear all' }).click(); await host.p.locator('.rc-danger').click(); await guest.p.waitForFunction(() => { const c = document.querySelector('.wb-cv'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 4) if (d[i] < 200 && d[i + 1] < 200) return false; return true; }, null, { timeout: 30000 });
  check('Whiteboard: clearing wipes it for the guest too', true);
  await host.p.locator('.wb-ov').getByRole('button', { name: 'Close whiteboard' }).click(); await guest.p.locator('.wb-ov').getByRole('button', { name: 'Close whiteboard' }).click();
  await host.p.locator('#tab-more .mg-tile', { hasText: 'Timer' }).click(); await host.p.locator('#tab-more select[aria-label="Timer length"]').selectOption('60'); await host.p.getByRole('button', { name: 'Start', exact: true }).click();
  await guest.p.locator('.more-timer-chip:not(.hidden)').waitFor({ timeout: 15000 }); const chip = await guest.p.locator('.more-timer-chip').innerText();
  check('Timer: the host starts it and the guest counts down from the server clock (' + chip.trim() + ')', /\d:\d\d/.test(chip) && /^\D*(0|1):/.test(chip.trim()));
  check('Timer: the guest has no start button', (await guest.p.locator('#tab-more .mg-tile', { hasText: 'Timer' }).count()) === 1 && (await guest.p.getByRole('button', { name: 'Start', exact: true }).count()) === 0);
  await host.p.getByRole('button', { name: 'Stop', exact: true }).click(); await guest.p.locator('.more-timer-chip.hidden').waitFor({ state: 'attached', timeout: 15000 }); check('Timer: Stop clears it for everyone', true);
  await host.p.locator('#tab-more .mg-tile', { hasText: 'Attendance' }).click(); await host.p.locator('.mg-att', { hasText: 'Gus' }).waitFor({ timeout: 15000 });
  check('Attendance: the host sees who is in the meeting (Gus and Hana)', (await host.p.locator('.mg-att', { hasText: 'Hana' }).count()) === 1 && (await host.p.locator('.mg-att', { hasText: 'Gus' }).innerText()).includes('In the meeting'));
  check('Attendance: the guest cannot open the report', await guest.p.locator('#tab-more .mg-tile', { hasText: 'Attendance' }).isDisabled());
  const pt = host.p.locator('#panelToggle'); await host.p.locator('#tab-more .mg-tile', { hasText: 'Focus mode' }).click(); await host.p.waitForTimeout(400);
  check('Focus mode: the side panel steps aside', (await pt.getAttribute('aria-expanded')) === 'false'); await pt.click(); await host.p.waitForTimeout(300);
  // Meeting intelligence: real consent status from Meet; the host asks everyone, people answer, the card shows the counts; transcript and Ask AI stay disabled
  const sumCard = (pg) => pg.locator('#tab-more .mg-card', { hasText: 'AI Summary' });
  await sumCard(host.p).getByRole('button', { name: 'Ask everyone' }).waitFor({ timeout: 15000 });
  check('Intelligence: before anyone is asked the guest sees "not asked yet" and has no controls', (await sumCard(guest.p).innerText()).includes('not asked yet') && (await sumCard(guest.p).getByRole('button').count()) === 0);
  await sumCard(host.p).getByRole('button', { name: 'Ask everyone' }).click(); await sumCard(host.p).locator('.mg-stat', { hasText: 'agreed' }).first().waitFor({ timeout: 15000 });
  await guest.p.locator('#tab-more .mg-card', { hasText: 'AI Summary' }).locator('.mg-stat', { hasText: 'not answered yet' }).waitFor({ timeout: 15000 });
  check('Intelligence: asking everyone shows the host as agreed and the guest as not answered yet', (await sumCard(host.p).innerText()).includes('1 agreed') && (await sumCard(guest.p).innerText()).includes('not answered yet'));
  await guest.p.locator('#ai_summary').check({ timeout: 15000 }); await guest.p.locator('#aiReviewed').check(); await guest.p.getByRole('button', { name: 'Save my choice' }).click();
  await sumCard(host.p).locator('.mg-stat', { hasText: '2 agreed' }).waitFor({ timeout: 30000 }); await guest.p.locator('#tab-more .mg-card', { hasText: 'AI Summary' }).locator('.mg-stat', { hasText: 'You: agreed' }).waitFor({ timeout: 15000 });
  check('Intelligence: when the guest agrees in the consent prompt both cards update live (2 agreed / You: agreed)', true);
  check('Intelligence: Live Transcript and Ask QorllaMate stay disabled (no speech-to-text, no AI gateway)', await host.p.locator('#tab-more .mg-card', { hasText: 'Live Transcript' }).getByRole('switch').isDisabled() && await host.p.locator('#tab-more .mg-card', { hasText: 'Ask QorllaMate' }).getByRole('button').isDisabled());
  check('Disabled tools stay disabled: Shared files, AI', await host.p.locator('#tab-more .mg-row', { hasText: 'Shared files' }).getByRole('button').isDisabled() && await host.p.locator('#tab-more .mg-card', { hasText: 'AI Summary' }).getByRole('button').isDisabled());
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
