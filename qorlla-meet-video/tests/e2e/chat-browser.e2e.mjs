// Meeting chat upgrade in REAL browsers against the REAL Meet server of this checkout: Stryker (host) and Justin (guest). Not part of `npm run check` (needs Chromium).
//   TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:25690/postgres PLAYWRIGHT_DIR=<folder with node_modules/playwright> node tests/e2e/chat-browser.e2e.mjs [screenshot-dir]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..'), SQL = join(ROOT, 'sql'), OUT = process.argv[2];
if (OUT) mkdirSync(OUT, { recursive: true });
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres';
const { chromium, devices } = createRequire(join(process.env.PLAYWRIGHT_DIR || process.cwd(), 'package.json'))('playwright');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (n, ok, d = '') => { results.push({ n, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !d ? '' : '  -> ' + d)); };
async function waitFor(fn, ms = 15000, step = 200) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch { /* retry */ } await wait(step); } return last; }

const db = 'chatui_' + Math.random().toString(36).slice(2, 8), PORT = Number(process.env.CHAT_E2E_PORT || 4979);
const admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${db}`);
const dbUrl = URL.replace(/\/[^/]*$/, '/' + db); const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8'));
const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATABASE_URL: dbUrl, JWT_SECRET: 'chat-e2e-secret-chat-e2e-secret-0123456789', ASCS_ENABLED: 'false', API_RATE_LIMIT: '100000', MEETING_RATE_LIMIT: '100000', SOCKET_EVENT_BUDGET: '100000', MEET_READ_SECRET: 'e2e-read-secret-e2e-read-secret-0123456789' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 240 && !log.includes('listening'); i++) await wait(250);
if (!log.includes('listening')) { console.log('server did not start: ' + log.slice(-500)); process.exit(2); }
const base = `http://localhost:${PORT}`;
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const pageErrors = [];
const open = async (name, join_code, opts = {}) => {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 }, ...opts }); const p = await ctx.newPage();
  p.__auth = null; p.on('request', (r) => { const h = r.headers()['authorization']; if (h) p.__auth = h; });                  // the page's own meeting token, as it sends it (the token is not kept in page storage)
  p.on('pageerror', (e) => pageErrors.push(name + ': ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) pageErrors.push(name + ' console: ' + m.text()); });
  await p.goto(base); await p.fill('#displayName', name);
  if (join_code) { await p.fill('#meetingId', join_code); await p.click('#joinBtn'); } else { await p.fill('#meetingTitle', 'Chat upgrade test'); await p.click('#createBtn'); }
  await p.waitForSelector('#app:not(.hidden)', { timeout: 30000 }); await p.click('[data-tab=chat]').catch(() => {}); return { ctx, p };
};
const msgOf = (p, text) => p.locator('.chat-msg', { hasText: text }).first();
const send = async (p, text, { rich = false } = {}) => { await p.click('#chatEditor'); await p.keyboard.type(text); await p.keyboard.press('Enter'); };
const more = async (p, text, item) => { await msgOf(p, text).getByRole('button', { name: 'More' }).click(); await p.getByRole('menuitem', { name: item }).click(); };

try {
  const s = await open('Stryker'); const code = (await s.p.textContent('#roomId')).trim(); const j = await open('Justin', code);
  check('both are in the meeting with the upgraded chat panel', (await s.p.locator('#chatEditor').count()) === 1 && (await j.p.locator('#chatEditor').count()) === 1);
  check('GIF stays visible but disabled, with a tooltip saying why, while the server has no GIPHY key', (await s.p.locator('#chatGifBtn').isVisible()) && (await s.p.locator('#chatGifBtn').isDisabled()) && /not enabled/.test(await s.p.locator('#chatGifBtn').getAttribute('title')));
  await s.p.click('#chatAttachBtn');
  check('V2.1 file menu: the five cloud sources are listed but DISABLED with the "needs provider setup" tooltip (no connector exists)', JSON.stringify(await s.p.locator('#chatFileMenu [data-cloud]').evaluateAll((bs) => bs.map((b) => [b.dataset.cloud, b.disabled, b.title]))) === JSON.stringify(['Dropbox', 'Microsoft OneDrive', 'Google Drive', 'Box', 'Microsoft SharePoint'].map((n) => [n, true, 'Not connected: needs provider setup by an administrator'])));
  check('V2.1 file menu: "Your computer" is disabled with a tooltip while attachments are switched off on the server', (await s.p.locator('#chatFilePc').isDisabled()) && /not enabled/.test(await s.p.locator('#chatFilePc').getAttribute('title')));
  await s.p.keyboard.press('Escape');
  check('V2.0 header: "Qorlla Meet Chat" with the meeting title as the subtitle, and the More, Pop-out and Close buttons', (await s.p.locator('.chat-titletext strong').textContent()) === 'Qorlla Meet Chat' && (await s.p.locator('#chatSubtitle').textContent()) === 'Chat upgrade test' && (await s.p.locator('#chatSettingsBtn').isVisible()) && (await s.p.locator('#chatPopBtn').isVisible()) && (await s.p.locator('#chatCloseBtn').isVisible()));
  check('V2.1 composer: the format toolbar is hidden until the T button is pressed; the bottom row is T, GIF, File; an icon Send button sits beside the input', (await s.p.locator('#chatFormat.hidden').count()) === 1 && JSON.stringify(await s.p.locator('.chat-actionrow > button').evaluateAll((bs) => bs.map((b) => b.id))) === JSON.stringify(['chatFmtBtn', 'chatGifBtn', 'chatAttachBtn']) && (await s.p.locator('.chat-composerow #chatSend svg').count()) === 1);
  await s.p.click('#chatFmtBtn');
  check('V2.1 composer: the who-can-see-your-messages bar sits above the composer', (await s.p.locator('#chatWhoBtn').innerText()).includes('Who can see your messages?') && (await s.p.locator('#chatFormat').isVisible()));
  check('without a GIPHY key the Content-Security-Policy does not allow any GIPHY host (the allowance exists only when the key is set)', !/giphy/i.test((await fetch(base + '/')).headers.get('content-security-policy') || ''));
  check('V2.0 empty state text is shown before any message', (await s.p.locator('#messages').getAttribute('data-empty')) === 'Meeting messages appear here' && (await s.p.locator('#messages .chat-msg').count()) === 0);

  await send(j.p, 'Hello from Justin');
  check('a plain message reaches the other person live', !!(await waitFor(async () => (await msgOf(s.p, 'Hello from Justin').count()) === 1)));
  check('the author is named and the time is shown', (await msgOf(s.p, 'Hello from Justin').locator('strong').textContent()) === 'Justin' && (await msgOf(s.p, 'Hello from Justin').locator('time').textContent()).length > 3);

  // rich text with the formatting buttons
  await s.p.click('#chatEditor'); await s.p.click('[data-cmd=bold]'); await s.p.keyboard.type('Important'); await s.p.click('[data-cmd=bold]'); await s.p.keyboard.type(' agenda'); await s.p.keyboard.press('Enter');
  check('bold formatting is delivered as real bold text', !!(await waitFor(async () => (await j.p.locator('.chat-msg b', { hasText: 'Important' }).count()) === 1)));
  const richPlain = (await pool.query("SELECT body, body_rich FROM messages WHERE body LIKE 'Important%'")).rows[0];
  check('the database keeps plain text for exports and canonical markup for display', richPlain?.body === 'Important agenda' && richPlain?.body_rich === '<b>Important</b> agenda', JSON.stringify(richPlain));

  // hostile input typed as text is shown literally and never runs
  const evil = '<img src=x onerror="window.__pwn=1"> <script>window.__pwn=2</script>';
  await send(j.p, evil);
  check('typed HTML is shown as literal text on both pages', !!(await waitFor(async () => (await msgOf(s.p, '<img src=x').count()) === 1)) && (await j.p.locator('.chat-msg img').count()) === 0 && (await s.p.locator('.chat-msg img').count()) === 0);
  await wait(500); check('nothing ran: no injected script or image handler fired', (await s.p.evaluate(() => window.__pwn)) === undefined && (await j.p.evaluate(() => window.__pwn)) === undefined);
  // reply
  await msgOf(s.p, 'Hello from Justin').getByRole('button', { name: 'Reply' }).click(); await s.p.keyboard.type('Welcome, Justin'); await s.p.keyboard.press('Enter');
  check('a reply shows who and what it answers, on both pages', !!(await waitFor(async () => (await j.p.locator('.chat-replyref', { hasText: 'Justin: Hello from Justin' }).count()) === 1)));

  // quote
  await more(j.p, 'Welcome, Justin', 'Quote'); await j.p.keyboard.type('Thanks!'); await j.p.keyboard.press('Enter');
  check('a quote keeps the original words as a quotation', !!(await waitFor(async () => (await s.p.locator('.chat-body blockquote', { hasText: 'Welcome, Justin' }).count()) === 1)));
  check('the text typed under a quote is NOT inside the quotation', (await s.p.locator('.chat-body blockquote', { hasText: 'Thanks!' }).count()) === 0 && (await s.p.locator('.chat-msg', { hasText: 'Thanks!' }).count()) === 1);

  // edit
  await send(j.p, 'Teh plan'); await more(j.p, 'Teh plan', 'Edit'); await j.p.keyboard.press('Control+A'); await j.p.keyboard.type('The plan'); await j.p.keyboard.press('Enter');
  check('editing changes the text for everyone and marks it edited', !!(await waitFor(async () => (await s.p.locator('.chat-msg', { hasText: 'The plan' }).locator('.chat-edited:not(.hidden)').count()) === 1)));
  await more(s.p, 'The plan', 'Copy').catch(() => {});
  check("only the author is offered Edit (Stryker does not see it on Justin's message)", (await (async () => { await msgOf(s.p, 'The plan').getByRole('button', { name: 'More' }).click(); const n = await s.p.getByRole('menuitem', { name: 'Edit' }).count(); await s.p.keyboard.press('Escape'); return n; })()) === 0);

  // bookmark (private)
  await more(j.p, 'Hello from Justin', 'Bookmark');
  check('a bookmark is private: the owner sees it, the other person does not', !!(await waitFor(async () => (await msgOf(j.p, 'Hello from Justin').locator('.chat-saved:not(.hidden)').count()) === 1)) && (await msgOf(s.p, 'Hello from Justin').locator('.chat-saved:not(.hidden)').count()) === 0);
  await j.p.click('#chatSaved'); check('the bookmarks filter shows only bookmarked messages', (await j.p.locator('.chat-msg:not(.hidden)').count()) === 1); await j.p.click('#chatSaved');

  // pin (host only)
  await msgOf(j.p, 'Hello from Justin').getByRole('button', { name: 'More' }).click(); const guestPin = await j.p.getByRole('menuitem', { name: /Pin/ }).count(); await j.p.keyboard.press('Escape');
  check('a guest is not offered Pin', guestPin === 0);
  await more(s.p, 'Hello from Justin', 'Pin for everyone');
  check('when the host pins a message everybody sees the pin', !!(await waitFor(async () => (await msgOf(j.p, 'Hello from Justin').locator('.chat-pin:not(.hidden)').count()) === 1)));
  await j.p.click('#chatPinned'); check('the pinned-messages panel lists the pinned message', !!(await waitFor(async () => (await j.p.locator('#chatPinPanel .chat-pinrow', { hasText: 'Hello from Justin' }).count()) === 1))); await j.p.keyboard.press('Escape');

  // task
  await more(s.p, 'The plan', 'Create task'); await s.p.locator('.chat-taskform input[type=text]').fill('Review the plan'); await s.p.locator('.chat-taskform input[type=date]').fill('2030-05-01'); await s.p.getByRole('button', { name: 'Create' }).click();
  check('creating a task from a message shows a task note to everyone', !!(await waitFor(async () => (await j.p.locator('.chat-task', { hasText: 'Review the plan' }).count()) === 1)) && (await j.p.locator('.chat-task', { hasText: 'due 2030-05-01' }).count()) === 1);

  // search
  const total = Number((await pool.query('SELECT count(*) FROM messages')).rows[0].count);
  await j.p.fill('#chatSearch', 'welcome'); check('search narrows the list (the reply and the quote of it)', (await j.p.locator('.chat-msg:not(.hidden)').count()) === 2); await j.p.fill('#chatSearch', 'zzz-no-match'); check('a search with no match hides everything', (await j.p.locator('.chat-msg:not(.hidden)').count()) === 0); await j.p.fill('#chatSearch', '');
  check('clearing the search brings every message back', (await j.p.locator('.chat-msg:not(.hidden)').count()) === total, total + ' messages in the database');

  if (OUT) { await s.p.screenshot({ path: join(OUT, 'chat-desktop.png') }); }
  // phone width
  const pj = await open('Pia', code, { ...devices['Pixel 7'] });
  check('a phone viewer sees the history and the page does not scroll sideways', (await pj.p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)) && !!(await waitFor(async () => (await pj.p.locator('.chat-msg').count()) === total)));
  await pj.p.click('#chatBtn'); await wait(500); if (OUT) await pj.p.screenshot({ path: join(OUT, 'chat-phone.png') });
  check('on the phone the chat panel opens and shows the messages', (await pj.p.locator('.chat-msg:visible').count()) > 0 && (await pj.p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)));

  // ================= v4.26: host policy, private conversations, delete, Save chat, pop-out =================
  const lock = async (p) => p.locator('#chatNewBtn').isDisabled();
  check('with the default policy (group chat) a guest cannot start a private chat', await lock(j.p));
  await s.p.click('#chatSettingsBtn'); check('the host sees the policy options enabled', (await s.p.getByRole('menuitemradio', { name: /Host only/ }).isDisabled()) === false);
  await s.p.keyboard.press('Escape');
  await j.p.click('#chatSettingsBtn'); check('a guest sees the policy options but cannot change them', await j.p.getByRole('menuitemradio', { name: /Host only/ }).isDisabled()); await j.p.keyboard.press('Escape');
  await s.p.click('#chatSettingsBtn'); await s.p.getByRole('menuitemradio', { name: /Everyone, and privately/ }).click();
  check('when the host allows private chats a guest can start one (live, no reload)', !!(await waitFor(async () => !(await lock(j.p)))));

  // Justin starts a private chat with Stryker
  await j.p.click('#chatNewBtn'); await j.p.locator('#chatNewChat label', { hasText: 'Stryker' }).locator('input').check(); await j.p.getByRole('button', { name: 'Start chat' }).click();
  check('the private chat opens for Justin as its own tab', !!(await waitFor(async () => (await j.p.locator('#chatNav .chat-conv[aria-selected=true]', { hasText: 'Stryker' }).count()) === 1)));
  check("Stryker is told, and gets an unread marker on the new private tab", !!(await waitFor(async () => (await s.p.locator('#chatNav .chat-conv', { hasText: 'Justin' }).locator('.chat-unread').count()) === 1)));
  await send(j.p, 'for your eyes only');
  await s.p.locator('#chatNav .chat-conv', { hasText: 'Justin' }).click();
  check('Stryker reads it in the private tab', !!(await waitFor(async () => (await msgOf(s.p, 'for your eyes only').count()) === 1)));
  await send(s.p, 'understood, private reply');
  check('the private conversation works both ways', !!(await waitFor(async () => (await msgOf(j.p, 'understood, private reply').count()) === 1)));
  await wait(600);
  check('a third person never sees the private chat: no tab and nothing in Everyone', (await pj.p.locator('#chatNav .chat-conv:not(.chat-new)').count()) === 1 && (await pj.p.locator('.chat-msg', { hasText: 'for your eyes only' }).count()) === 0);
  await s.p.locator('#chatNav .chat-conv', { hasText: 'Everyone' }).click();
  await waitFor(async () => (await msgOf(s.p, 'Hello from Justin').count()) === 1);
  check('Everyone does not show the private messages', (await s.p.locator('.chat-msg', { hasText: 'for your eyes only' }).count()) === 0);
  const mid = (await pool.query('SELECT id FROM meetings LIMIT 1')).rows[0].id;
  const exp = await (await fetch(`${base}/api/integrations/meetings/${mid}/chat`, { headers: { 'x-qorlla-readonly-secret': 'e2e-read-secret-e2e-read-secret-0123456789' } })).json();
  check('the AI/integration export contains the group chat but NOT the private messages', exp.messages?.length > 3 && !JSON.stringify(exp).includes('for your eyes only') && !JSON.stringify(exp).includes('private reply'), JSON.stringify(exp).slice(0, 200));

  // policy: no one
  await s.p.click('#chatSettingsBtn'); await s.p.getByRole('menuitemradio', { name: 'No one' }).click();
  check('when the host turns chat off the guest composer is disabled with an explanation', !!(await waitFor(async () => (await j.p.locator('#chatSend').isDisabled()) && (await j.p.locator('#chatNotice').textContent()).includes('turned chat off'))));
  check('the host can still chat', (await s.p.locator('#chatSend').isDisabled()) === false);
  await s.p.click('#chatSettingsBtn'); await s.p.getByRole('menuitemradio', { name: /Everyone in the meeting/ }).click();
  await j.p.locator('#chatNav .chat-conv', { hasText: 'Everyone' }).click();
  check('back to group chat: Everyone works again for the guest', !!(await waitFor(async () => !(await j.p.locator('#chatSend').isDisabled()))));

  // delete (two clicks) and "Message deleted" for everybody
  await send(j.p, 'delete me please');
  await waitFor(async () => (await msgOf(s.p, 'delete me please').count()) === 1);
  await msgOf(j.p, 'delete me please').getByRole('button', { name: 'More' }).click(); await j.p.getByRole('menuitem', { name: 'Delete' }).click();
  check('Delete asks for a second click before removing anything', (await msgOf(j.p, 'delete me please').count()) === 1);
  await j.p.getByRole('menuitem', { name: /Click again to delete/ }).click();
  check('after the confirmation both pages show "Message deleted" and the text is gone', !!(await waitFor(async () => (await s.p.locator('.chat-deleted', { hasText: 'Message deleted' }).count()) === 1 && (await j.p.locator('.chat-deleted', { hasText: 'Message deleted' }).count()) === 1 && (await s.p.locator('.chat-msg', { hasText: 'delete me please' }).count()) === 0)));
  check('the deleted text is gone from the database too', Number((await pool.query("SELECT count(*) FROM messages WHERE body LIKE '%delete me please%'")).rows[0].count) === 0);
  await msgOf(s.p, 'Hello from Justin').getByRole('button', { name: 'More' }).click();
  check('the host is offered Delete on somebody else\'s message', (await s.p.getByRole('menuitem', { name: 'Delete' }).count()) === 1); await s.p.keyboard.press('Escape');

  // Save chat
  await s.p.click('#chatSettingsBtn'); const dl = s.p.waitForEvent('download'); await s.p.getByRole('menuitem', { name: 'Save chat' }).click(); const file = await dl;
  const saved = await (async () => { const stream = await file.createReadStream(); let t = ''; for await (const c of stream) t += c; return t; })();
  check('Save chat downloads the conversation as a text file', /^qorlla-chat-\d{4}-\d{2}-\d{2}\.txt$/.test(file.suggestedFilename()) && saved.includes('Justin: Hello from Justin') && saved.includes('Stryker: Welcome, Justin'), saved.slice(0, 200));
  check('the saved file leaves out deleted and private messages', !saved.includes('delete me please') && !saved.includes('for your eyes only'));

  // pop-out: the chat moves to its own window and keeps working
  const popupPromise = s.ctx.waitForEvent('page'); await s.p.click('#chatPopBtn'); const pop = await popupPromise; await pop.waitForLoadState('domcontentloaded').catch(() => {});
  check('the pop-out window holds the live chat (messages, composer) and the page says where it went', !!(await waitFor(async () => (await pop.locator('#chatEditor').count()) === 1 && (await pop.locator('.chat-msg').count()) > 3)) && (await s.p.locator('.chat-away').count()) === 1);
  if (OUT) await pop.screenshot({ path: join(OUT, 'popout-before-send.png') });
  await pop.locator('#chatEditor').click(); await pop.keyboard.type('sent from the pop-out'); await pop.keyboard.press('Enter');
  check('a message sent from the pop-out reaches the other participant', !!(await waitFor(async () => (await msgOf(j.p, 'sent from the pop-out').count()) === 1)));
  await j.p.locator('#chatEditor').click(); await j.p.keyboard.type('reply while popped out'); await j.p.keyboard.press('Enter');
  check('and live messages arrive in the pop-out', !!(await waitFor(async () => (await pop.locator('.chat-msg', { hasText: 'reply while popped out' }).count()) === 1)));
  await pop.close();
  check('closing the pop-out brings the chat back into the meeting panel', !!(await waitFor(async () => (await s.p.locator('#chatEditor').count()) === 1 && (await s.p.locator('.chat-away').count()) === 0)));
  check('the call itself was never interrupted (still two participants)', (await s.p.locator('#peopleList .person').count()) >= 2);


  // ================= V2.0 verification: live policy (host only), pop-out synchronisation, reconnection, participant removal =================
  const setPolicyUi = async (label) => { await s.p.click('#chatSettingsBtn'); await s.p.getByRole('menuitemradio', { name: label }).click(); };
  await setPolicyUi('Host only');
  check('policy "Host only": the guest\'s Everyone composer is disabled with the reason, and New chat stays available (to the host)', !!(await waitFor(async () => (await j.p.locator('#chatSend').isDisabled()) && (await j.p.locator('#chatNotice').textContent()).includes('privately with the host only') && !(await j.p.locator('#chatNewBtn').isDisabled()))));
  await setPolicyUi(/Everyone, and privately/);
  check('policy "Everyone and privately": the guest can write in Everyone again, live', !!(await waitFor(async () => !(await j.p.locator('#chatSend').isDisabled()))));
  await setPolicyUi(/Everyone in the meeting/); await waitFor(async () => (await j.p.locator('#chatNewBtn').isDisabled()));

  // ---- pop-out: both windows are ONE live chat
  let popup = s.ctx.waitForEvent('page'); await s.p.click('#chatPopBtn'); let pw = await popup; await waitFor(async () => (await pw.locator('#chatEditor').count()) === 1);
  await j.p.locator('#chatEditor').click(); await j.p.keyboard.type('sync one'); await j.p.keyboard.press('Enter');
  check('pop-out: a message sent in the main window of the OTHER person shows in the pop-out at once', !!(await waitFor(async () => (await msgOf(pw, 'sync one').count()) === 1)));
  await pw.locator('#chatEditor').click(); await pw.keyboard.type('from popup two'); await pw.keyboard.press('Enter');
  check('pop-out: a message sent from the pop-out shows for the other person', !!(await waitFor(async () => (await msgOf(j.p, 'from popup two').count()) === 1)));
  await more(pw, 'sync one', 'Pin for everyone');
  check('pop-out: pinning from the pop-out shows for everybody', !!(await waitFor(async () => (await msgOf(j.p, 'sync one').locator('.chat-pin:not(.hidden)').count()) === 1)));
  await more(j.p, 'sync one', 'Edit'); await j.p.keyboard.press('Control+A'); await j.p.keyboard.type('sync one EDITED'); await j.p.keyboard.press('Enter');
  check('pop-out: an edit made by the other person arrives in the pop-out, marked edited', !!(await waitFor(async () => (await msgOf(pw, 'sync one EDITED').locator('.chat-edited:not(.hidden)').count()) === 1)));
  await more(j.p, 'sync one EDITED', 'Delete'); await j.p.getByRole('menuitem', { name: /Click again to delete/ }).click();
  check('pop-out: a delete by the other person arrives in the pop-out', !!(await waitFor(async () => (await pw.locator('.chat-deleted', { hasText: 'Message deleted' }).count()) >= 1 && (await msgOf(pw, 'sync one EDITED').count()) === 0)));
  await more(pw, 'from popup two', 'Delete'); await pw.getByRole('menuitem', { name: /Click again to delete/ }).click();
  check('pop-out: a delete made in the pop-out shows for the other person', !!(await waitFor(async () => (await msgOf(j.p, 'from popup two').count()) === 0)));
  const beforeClose = await pw.locator('.chat-msg').count(); await pw.close();
  check('pop-out: closing it returns the same chat to the panel with every message', !!(await waitFor(async () => (await s.p.locator('#chatEditor').count()) === 1 && (await s.p.locator('.chat-msg').count()) === beforeClose)));
  popup = s.ctx.waitForEvent('page'); await s.p.click('#chatPopBtn'); pw = await popup; await waitFor(async () => (await pw.locator('#chatEditor').count()) === 1);
  await j.p.locator('#chatEditor').click(); await j.p.keyboard.type('after reopening'); await j.p.keyboard.press('Enter');
  check('pop-out: reopening it shows the same history and keeps receiving live messages', !!(await waitFor(async () => (await msgOf(pw, 'after reopening').count()) === 1)) && (await pw.locator('.chat-msg').count()) === beforeClose + 1);
  await pw.close(); await waitFor(async () => (await s.p.locator('#chatEditor').count()) === 1);


  // ================= V2.1: hover actions, More menu order, format toolbar (colour, size, lists), who-can-see popover, pinned panel =================
  const hoverOf = (p, text) => msgOf(p, text).locator('.chat-hover');
  const opacityOf = async (loc) => Number(await loc.evaluate((e) => getComputedStyle(e).opacity));
  await s.p.mouse.move(2, 2); await wait(250);
  check('V2.1 hover: Reply and More are hidden until the pointer is over the message', (await opacityOf(hoverOf(s.p, 'Hello from Justin'))) < 0.1);
  await msgOf(s.p, 'Hello from Justin').hover(); await wait(300);
  const hb = await hoverOf(s.p, 'Hello from Justin').boundingBox(), bb = await msgOf(s.p, 'Hello from Justin').locator('.chat-bubble').boundingBox();
  check('V2.1 hover: they appear BESIDE the bubble (to its right) when the pointer is over the message', (await opacityOf(hoverOf(s.p, 'Hello from Justin'))) > 0.9 && hb.x >= bb.x + bb.width - 1 && Math.abs((hb.y + hb.height / 2) - (bb.y + bb.height / 2)) < bb.height);
  await s.p.mouse.move(2, 2); await wait(250);
  await msgOf(s.p, 'Hello from Justin').getByRole('button', { name: 'Reply' }).focus(); await wait(300);
  check('V2.1 hover: they are also reachable and shown by keyboard focus', (await opacityOf(hoverOf(s.p, 'Hello from Justin'))) > 0.9);
  check('V2.1 hover: on a touch phone they are always shown', (await opacityOf(pj.p.locator('.chat-hover').first())) > 0.9);

  const menuOf = async (p, text) => { await msgOf(p, text).getByRole('button', { name: 'More' }).click(); const items = await p.getByRole('menuitem').allTextContents(); const seps = await p.locator('.chat-menu .chat-menusep').count(); await p.keyboard.press('Escape'); return { items: items.map((t) => t.trim()), seps }; };
  const hostMenu = await menuOf(s.p, 'Hello from Justin');
  check('V2.1 More menu (host, on a guest\'s message): Copy, Quote | Bookmark | Unpin/Pin | Create task | Delete, in that order, with separators', JSON.stringify(hostMenu.items.map((t) => t.replace(/^Remove bookmark$/, 'Bookmark').replace(/^Unpin$/, 'Pin for everyone'))) === JSON.stringify(['Copy', 'Quote', 'Bookmark', 'Pin for everyone', 'Create task', 'Delete']) && hostMenu.seps === 4, JSON.stringify(hostMenu));
  const ownMenu = await menuOf(j.p, 'Hello from Justin');
  check('V2.1 More menu (author, a guest): Copy, Quote, Edit | Bookmark | Create task | Delete; no Pin', JSON.stringify(ownMenu.items.map((t) => t.replace(/^Remove bookmark$/, 'Bookmark'))) === JSON.stringify(['Copy', 'Quote', 'Edit', 'Bookmark', 'Create task', 'Delete']) && ownMenu.seps === 3, JSON.stringify(ownMenu));

  // the format toolbar on the guest's page: colour and size are a FIXED palette; they survive a round trip
  if (await j.p.locator('#chatFormat.hidden').count()) await j.p.click('#chatFmtBtn');
  await j.p.locator('#chatEditor').click(); await j.p.keyboard.type('colourful words'); await j.p.keyboard.press('Control+A');
  await j.p.click('#chatColorBtn'); await j.p.locator('#chatFmtPop .chat-swatch[data-c="1"]').click();
  await j.p.click('#chatSizeBtn'); await j.p.locator('#chatFmtPop').getByRole('button', { name: 'Large' }).click();
  await j.p.keyboard.press('Enter');
  check('V2.1 format: a red, large word survives the round trip and is drawn from the fixed palette', !!(await waitFor(async () => (await s.p.locator('.chat-msg span[data-c="1"] span[data-z="2"]', { hasText: 'colourful words' }).count()) === 1)));
  const cw = s.p.locator('.chat-msg span[data-c="1"]').first();
  check('V2.1 format: the colour is the palette red and the size is larger than the surrounding text', (await cw.evaluate((e) => getComputedStyle(e).color)) === 'rgb(248, 113, 113)' && (await s.p.locator('.chat-msg span[data-z="2"]').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize) > parseFloat(getComputedStyle(e.closest('.chat-body')).fontSize))));
  const rr = (await pool.query("SELECT body, body_rich FROM messages WHERE body='colourful words'")).rows[0];
  check('V2.1 format: stored as fixed tags (<c1><z2>) with plain text for exports', rr?.body_rich === '<c1><z2>colourful words</z2></c1>' && rr?.body === 'colourful words', JSON.stringify(rr));
  // somebody who bypasses the page and sends their own markup cannot smuggle styles or handlers through the new tags
  const injected = await j.p.evaluate(async ({ mid, tok }) => (await fetch('/api/meetings/' + mid + '/chat', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ rich: '<c2 style="color:url(javascript:1);position:fixed" onclick="window.__x=1" class="evil">evil</c2> <span style="position:fixed;inset:0" onmouseover="window.__x=2">span</span> <font color="red" size="7">font</font> <z9>nine</z9> <c7>seven</c7>' }) })).status, { mid, tok: (j.p.__auth || '').replace(/^Bearer /, '') });
  const inj = await waitFor(async () => (await s.p.locator('.chat-msg', { hasText: 'evil' }).count()) === 1);
  const evilRow = s.p.locator('.chat-msg', { hasText: 'evil' });
  check('V2.1 format: injected style/onclick/class/font/unknown colour and size tags are stripped (server allowlist), nothing runs', injected === 201 && !!inj && (await evilRow.locator('[style],[onclick],[onmouseover],[class="evil"],font').count()) === 0 && (await evilRow.locator('span[data-c="2"]').count()) === 1 && (await s.p.evaluate(() => window.__x)) === undefined && (await evilRow.locator('.chat-body').innerText()).includes('evil span font nine seven'), (await evilRow.locator('.chat-body').innerText()));
  // lists: Enter starts the next item inside a list, Ctrl+Enter sends
  if (await s.p.locator('#chatFormat.hidden').count()) await s.p.click('#chatFmtBtn');
  await s.p.locator('#chatEditor').click(); await s.p.click('#chatMoreFmtBtn'); await s.p.getByRole('menuitem', { name: 'Bulleted list' }).click();
  await s.p.keyboard.type('alpha item'); await s.p.keyboard.press('Enter'); await s.p.keyboard.type('beta item'); await s.p.keyboard.press('Control+Enter');
  check('V2.1 format: a bulleted list with two items is delivered as a real list', !!(await waitFor(async () => (await j.p.locator('.chat-msg ul li', { hasText: 'alpha item' }).count()) === 1 && (await j.p.locator('.chat-msg ul li', { hasText: 'beta item' }).count()) === 1)));
  check('V2.1 format: the plain text (export/AI) keeps the bullets', (await pool.query("SELECT body FROM messages WHERE body LIKE '%alpha item%'")).rows[0]?.body === '• alpha item\n• beta item');
  check('V2.1 format: the toolbar has Bold, Italic, Underline, Strikethrough, colour, size, link, heading and a more menu, in that order', JSON.stringify(await s.p.locator('#chatFormat > button').evaluateAll((bs) => bs.map((b) => b.id || b.dataset.cmd))) === JSON.stringify(['bold', 'italic', 'underline', 'strikeThrough', 'chatColorBtn', 'chatSizeBtn', 'chatLinkBtn', 'chatHeadBtn', 'chatMoreFmtBtn']));

  // who can see your messages
  await s.p.click('#chatWhoBtn');
  check('V2.1 who can see: Everyone says how many people, from the server', !!(await waitFor(async () => (await s.p.locator('#chatWho').innerText()).includes('Everyone in this meeting (3 people)'))), await s.p.locator('#chatWho').innerText());
  await s.p.keyboard.press('Escape'); await s.p.locator('#chatNav .chat-conv', { hasText: 'Justin' }).click(); await waitFor(async () => (await msgOf(s.p, 'for your eyes only').count()) === 1);
  await s.p.click('#chatWhoBtn');
  const whoText = await waitFor(async () => { const t = await s.p.locator('#chatWho').innerText(); return t.includes('Only you and Justin') ? t : ''; });
  check('V2.1 who can see: a private chat says "Only you and <names>" and that the host cannot read private chats they are not part of', !!whoText && /cannot read private chats they are not part of/.test(whoText), String(whoText));
  await s.p.keyboard.press('Escape'); await s.p.locator('#chatNav .chat-conv', { hasText: 'Everyone' }).click(); await waitFor(async () => (await msgOf(s.p, 'Hello from Justin').count()) === 1);

  // pinned panel with jump-to
  await s.p.click('#chatPinned');
  check('V2.1 pinned panel: lists the pinned message with a "Go to message" button', !!(await waitFor(async () => (await s.p.locator('#chatPinPanel .chat-pinrow', { hasText: 'Hello from Justin' }).count()) === 1)));
  await s.p.locator('#chatPinPanel').getByRole('button', { name: 'Go to message' }).first().click();
  check('V2.1 pinned panel: "Go to message" closes the panel and flashes the message', (await s.p.locator('#chatPinPanel.hidden').count()) === 1 && !!(await waitFor(async () => (await s.p.locator('.chat-msg.chat-flash').count()) >= 1, 3000, 100)));


  // ================= V2.1 composer fixes: placeholder, edit/cancel, link popover, one composer card, ghost actions =================
  const phOf = (p) => p.locator('#chatEditor').evaluate((e) => getComputedStyle(e, '::before').content);
  const isEmpty = async (p) => (await p.locator('#chatEditor').getAttribute('data-empty')) === 'true';
  const placeholderShown = async (p) => (await isEmpty(p)) && /Message everyone/.test(await phOf(p));
  if (await s.p.locator('#chatFormat.hidden').count()) await s.p.click('#chatFmtBtn');
  await s.p.locator('#chatEditor').click();
  check('composer: the "Message everyone..." hint is visible while the editor is empty', await placeholderShown(s.p));
  await s.p.keyboard.type('draft text');
  check('composer: the hint is hidden while there is text', !(await isEmpty(s.p)) && !/Message everyone/.test(await phOf(s.p)));
  await s.p.keyboard.press('Control+A'); await s.p.keyboard.press('Backspace');
  check('composer: after typing and deleting everything the hint is back (a contentEditable keeps a <br>, so :empty cannot be used)', await placeholderShown(s.p));
  await s.p.keyboard.type('to be edited'); await s.p.keyboard.press('Enter'); await waitFor(async () => (await msgOf(s.p, 'to be edited').count()) === 1);
  check('composer: after sending, the hint is back', !!(await waitFor(() => placeholderShown(s.p), 3000, 100)));
  // edit: a preview of the original text, Esc and the X cancel, the hint returns
  await more(s.p, 'to be edited', 'Edit');
  check('edit: the context bar says "Editing:" followed by a one-line preview of the ORIGINAL text', (await s.p.locator('#chatContext').innerText()).replace(/\s+/g, ' ').includes('Editing: to be edited') && (await s.p.locator('#chatEditor').innerText()).trim() === 'to be edited');
  await s.p.keyboard.press('Escape');
  check('edit: Esc cancels it: no context bar, an empty composer with its hint, the message unchanged', (await s.p.locator('#chatContext.hidden').count()) === 1 && (await placeholderShown(s.p)) && (await msgOf(s.p, 'to be edited').count()) === 1);
  await more(s.p, 'to be edited', 'Edit'); await s.p.locator('#chatContext .chat-ctxclose').click();
  check('edit: the X in the context bar cancels it the same way', (await s.p.locator('#chatContext.hidden').count()) === 1 && (await placeholderShown(s.p)));
  // emptying an edit never silently does nothing: it asks whether to delete the message instead
  await s.p.keyboard.type('throwaway message'); await s.p.keyboard.press('Enter'); await waitFor(async () => (await msgOf(s.p, 'throwaway message').count()) === 1);
  await more(s.p, 'throwaway message', 'Edit'); await s.p.keyboard.press('Control+A'); await s.p.keyboard.press('Backspace'); await s.p.keyboard.press('Enter');
  check('edit: emptying the text and pressing Enter asks "Delete it instead?" (and the message is still there)', (await s.p.locator('#chatContext').innerText()).includes('Delete it instead?') && (await msgOf(s.p, 'throwaway message').count()) === 1);
  await s.p.locator('#chatContext').getByRole('button', { name: 'Keep editing' }).click();
  check('edit: "Keep editing" returns to the edit', (await s.p.locator('#chatContext').innerText()).includes('Editing: throwaway message'));
  await s.p.keyboard.press('Control+A'); await s.p.keyboard.press('Backspace'); await s.p.keyboard.press('Enter'); await s.p.locator('#chatContext').getByRole('button', { name: 'Delete message' }).click();
  check('edit: "Delete message" deletes it for everybody and clears the composer', !!(await waitFor(async () => (await s.p.locator('.chat-deleted').count()) >= 1 && (await msgOf(j.p, 'throwaway message').count()) === 0)) && (await s.p.locator('#chatContext.hidden').count()) === 1);

  // link: a small popover anchored to the link button, by keyboard
  await s.p.locator('#chatEditor').click(); await s.p.keyboard.type('see our site'); await s.p.keyboard.press('Control+A'); await s.p.click('#chatLinkBtn');
  const lp = s.p.locator('#chatLinkPop'), lg = await Promise.all([lp.boundingBox(), s.p.locator('#chatLinkBtn').boundingBox()]);
  check('link: opens as a small popover just above the toolbar next to the link button (not a row in the layout), with the address box focused', (await lp.isVisible()) && (await lp.evaluate((e) => getComputedStyle(e).position)) === 'absolute' && lg[0].y + lg[0].height <= lg[1].y + 2 && (await s.p.evaluate(() => document.activeElement?.id)) === 'chatLink');
  await s.p.keyboard.press('Escape');
  check('link: Esc closes it and gives the focus back to the message box', (await s.p.locator('#chatLinkPop.hidden').count()) === 1 && (await s.p.evaluate(() => document.activeElement?.id)) === 'chatEditor');
  await s.p.locator('#chatEditor').click(); await s.p.keyboard.press('Control+A'); await s.p.click('#chatLinkBtn'); await s.p.keyboard.type('not a link'); await s.p.keyboard.press('Enter');
  check('link: an invalid address is refused and the popover stays open', (await s.p.locator('#chatLinkPop.hidden').count()) === 0 && (await s.p.locator('#chatEditor a').count()) === 0);
  await s.p.fill('#chatLink', 'https://example.com/docs'); await s.p.keyboard.press('Enter');
  check('link: Enter adds the link to the selected text and closes the popover', (await s.p.locator('#chatLinkPop.hidden').count()) === 1 && (await s.p.locator('#chatEditor a[href="https://example.com/docs"]', { hasText: 'see our site' }).count()) === 1);
  await s.p.keyboard.press('Enter');
  check('link: the other person receives a safe link (opens in a new tab, no referrer or opener)', !!(await waitFor(async () => (await j.p.locator('.chat-msg a[href="https://example.com/docs"][target="_blank"][rel~="noopener"]', { hasText: 'see our site' }).count()) === 1)));

  // one composer card
  const geo = await s.p.evaluate(() => { const r = (q) => { const b = document.querySelector(q).getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; }; return { who: r('#chatWhoBtn'), card: r('.chat-composercard'), fmt: r('#chatFormat'), ed: r('#chatEditor'), send: r('#chatSend'), act: r('.chat-actionrow'), list: r('#messages') }; });
  check('composer card: the toolbar, input, Send and action row are all inside ONE card, and the audience bar sits directly above it', geo.ed.top >= geo.card.top && geo.send.bottom <= geo.card.bottom && geo.act.bottom <= geo.card.bottom && geo.fmt.top >= geo.card.top && geo.card.top >= geo.who.bottom && geo.card.top - geo.who.bottom <= 12 && geo.card.top >= geo.list.bottom, JSON.stringify(geo));
  check('composer card: the toolbar, input and action row do not touch (8px rhythm) and Send is aligned with the input', geo.ed.top - geo.fmt.bottom >= 6 && geo.act.top - geo.ed.bottom >= 6 && Math.abs(geo.send.bottom - geo.ed.bottom) <= 2 && geo.send.left >= geo.ed.right, JSON.stringify(geo));
  check('message actions are small ghost icon buttons (transparent, not link-blue text) and sit apart from the text', (await s.p.locator('.chat-hover .chat-act').first().evaluate((e) => { const c = getComputedStyle(e); return c.backgroundColor === 'rgba(0, 0, 0, 0)' && c.color !== 'rgb(143, 180, 255)'; })));
  const lineGeo = await pj.p.locator('.chat-line').first().evaluate((l) => ({ b: l.querySelector('.chat-bubble').getBoundingClientRect().bottom, h: l.querySelector('.chat-hover').getBoundingClientRect().top }));
  check('on a touch phone the actions stay BELOW the message bubble', lineGeo.h >= lineGeo.b - 1, JSON.stringify(lineGeo));

  // ---- reconnection: Justin's network drops; messages sent meanwhile must be there afterwards, once each
  await j.ctx.setOffline(true); await wait(3500);
  await s.p.locator('#chatEditor').click(); await s.p.keyboard.type('missed while offline one'); await s.p.keyboard.press('Enter'); await s.p.keyboard.type('missed while offline two'); await s.p.keyboard.press('Enter');
  await wait(500); check('while offline the guest sees neither message', (await j.p.locator('.chat-msg', { hasText: 'missed while offline' }).count()) === 0);
  await j.ctx.setOffline(false);
  check('after the reconnect both missed messages appear, each exactly once', !!(await waitFor(async () => (await j.p.locator('.chat-msg', { hasText: 'missed while offline one' }).count()) === 1 && (await j.p.locator('.chat-msg', { hasText: 'missed while offline two' }).count()) === 1, 45000, 500)));
  const everyoneCount = Number((await pool.query('SELECT count(*) FROM messages WHERE conversation_id IS NULL')).rows[0].count);
  check('after the reconnect the guest shows exactly the stored conversation: no loss, no duplicates', (await j.p.locator('.chat-msg').count()) === everyoneCount, (await j.p.locator('.chat-msg').count()) + ' shown, ' + everyoneCount + ' stored');
  await j.p.locator('#chatEditor').click(); await j.p.keyboard.type('back online'); await j.p.keyboard.press('Enter');
  check('after the reconnect sending works again', !!(await waitFor(async () => (await msgOf(s.p, 'back online').count()) === 1)));

  // ---- participant removal: the Shield session guard / the host writes admission=denied (and closes the socket); the chat must stop at the data level too
  const jpop = j.ctx.waitForEvent('page'); await j.p.click('#chatPopBtn'); const jw = await jpop; await waitFor(async () => (await jw.locator('#chatEditor').count()) === 1);
  const token = (j.p.__auth || '').replace(/^Bearer /, '') || null;
  check('(test setup) the guest\'s own meeting token was found in its page storage', !!token);
  await pool.query("UPDATE participants SET admission='denied' WHERE display_name='Justin'");
  await s.p.locator('#chatEditor').click(); await s.p.keyboard.type('said after the removal'); await s.p.keyboard.press('Enter');
  await waitFor(async () => (await msgOf(s.p, 'said after the removal').count()) === 1); await wait(2500);
  check('a removed guest receives nothing: not in the pop-out window and not in the main window', (await jw.locator('.chat-msg', { hasText: 'said after the removal' }).count()) === 0 && (await j.p.locator('.chat-msg', { hasText: 'said after the removal' }).count()) === 0);
  const probe = await j.p.evaluate(async ({ tok, mid }) => { const h = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }; const r = (x) => x.status; return [r(await fetch('/api/meetings/' + mid + '/chat', { headers: h })), r(await fetch('/api/meetings/' + mid + '/chat', { method: 'POST', headers: h, body: JSON.stringify({ body: 'sneaky' }) })), r(await fetch('/api/meetings/' + mid + '/chat/export', { headers: h })), r(await fetch('/api/meetings/' + mid + '/chat/conversations', { headers: h }))]; }, { tok: token, mid });
  check('and their token can no longer read, post, export or list conversations (all refused)', probe.every((c) => c === 403), JSON.stringify(probe));
  check('nothing the removed guest tried to post was stored', Number((await pool.query("SELECT count(*) FROM messages WHERE body='sneaky'")).rows[0].count) === 0);
  await jw.close().catch(() => {});

  check('no JavaScript errors on any page', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) { check('run completed without an exception', false, String(e.message || e).slice(0, 400)); }
finally { await browser.close(); child.kill(); await wait(300); await pool.end(); await admin.query(`DROP DATABASE ${db} WITH (FORCE)`).catch(() => {}); await admin.end(); }
const bad = results.filter((r) => !r.ok); console.log(`\n${results.length - bad.length}/${results.length} passed`); process.exit(bad.length ? 1 : 0);
