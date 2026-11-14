// Browser check of the Portal Chat page (/app/chat) against a THROWAWAY portal + PostgreSQL (nothing here touches the running stack).
// Run:  TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:25690/postgres PLAYWRIGHT_DIR=<folder with node_modules/playwright> node tests/ui/chat-page.ui.mjs [screenshot-dir]
// It is deliberately not named *.test.mjs, so `npm test` does not launch a browser. Two people (an owner and a member) sign in with real portal cookies; the model is a stub behind the real gateway.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, addMember } from '../helpers.mjs';
import { resolveAiConfig } from '../../server/ai/config.mjs';
import { createAiGateway } from '../../server/ai/gateway.mjs';

const { chromium, devices } = createRequire(join(process.env.PLAYWRIGHT_DIR || process.cwd(), 'package.json'))('playwright');
const OUT = process.argv[2]; if (OUT) mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '   <- ' + String(detail).slice(0, 260))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); let last; while (Date.now() - t < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(80); } return false; }

const db = await freshDatabase(); await db.pool.query(db.sql('017_portal_chat.sql')); const main = await startMainStandIn();
const model = { answer: 'They agreed to ship on Friday.', calls: 0 };
const adapter = { id: 'stub', tier: 'local', external: false, model: 'stub', async call() { model.calls++; return { text: JSON.stringify({ answer: model.answer }), model: 'stub', inputTokens: 5, outputTokens: 5 }; } };
const llm = createAiGateway({ config: resolveAiConfig({ QORLLA_AI_ENABLED: 'true', QORLLA_AI_PROVIDER: 'test', QORLLA_AI_TEST_ADAPTER_ENABLED: 'true', QORLLA_ENVIRONMENT: 'test' }), adapters: [adapter], log: { error() {}, warn() {} } });
const names = {};
const cfg = testConfig({ cfg: { rateLimits: { docsWrite: 1e5, docsComment: 1e5, ai: 1e5, draft: 1e5, job: 1e5, call: 1e5, refund: 1e5, webhook: 1e6, chatWrite: 1e5, chatGif: 1e5 } } }, main);
const app = await startApp({ pool: db.pool, cfg, jwks: main.jwks, ai: { llm, directory: { names: async (ids) => Object.fromEntries(ids.map((i) => [i, names[i] || 'Member ' + i.slice(0, 4)])) } } }); cfg.origin = app.base;
const H = await main.mint(), M = await main.mint(); names[H.sub] = 'Hana Host'; names[M.sub] = 'Max Member';
const W = await seedWorkspace(db.pool, H.sub, 'Chat UI Co'); await db.pool.query(`UPDATE portal.subscriptions SET plan_slug='pro',status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [W]); await addMember(db.pool, W, M.sub, 'member');
const api = (s) => app.client(s, { origin: app.base, workspace: W });
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const problems = [];
async function openAs(session, viewport = { width: 1280, height: 1000 }, extra = {}) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true, ...extra }); ctx.setDefaultNavigationTimeout(120000);
  await ctx.addCookies([{ name: 'qorlla_portal_session', value: session.jwt, url: app.base, httpOnly: true }, { name: 'qorlla_csrf', value: session.csrf, url: app.base }]);
  const page = await ctx.newPage(); page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|breadcrumbs|ERR_INTERNET_DISCONNECTED/.test(m.text())) problems.push('console: ' + m.text()); });
  page.on('response', (r) => { if (r.url().includes('/api/v1/') && r.status() >= 500) problems.push('5xx: ' + r.url()); });
  return { ctx, page };
}
const send = async (p, text) => { await p.locator('.chat-editor').click(); await p.keyboard.type(text); await p.keyboard.press('Enter'); };
const msg = (p, text) => p.locator('.chat-msg', { hasText: text }).first();
const more = (p, text) => msg(p, text).getByRole('button', { name: 'More actions' });
const menuItems = async (p) => (await p.getByRole('menu', { name: 'Message actions' }).getByRole('menuitem').allTextContents()).map((t) => t.trim());
const doMore = async (p, text, item) => { await more(p, text).click(); await p.getByRole('menu', { name: 'Message actions' }).getByRole('menuitem', { name: item, exact: true }).click(); };
const reply = (p, text) => msg(p, text).getByRole('button', { name: 'Reply' }).click();

try {
  const { page: ph } = await openAs(H); const { page: pm } = await openAs(M);
  await ph.goto(app.base + '/app/chat'); await pm.goto(app.base + '/app/chat');
  for (const p of [ph, pm]) await p.locator('.chat-conv', { hasText: 'Everyone' }).waitFor();
  check('Chat is in the navigation; the shared "Everyone" conversation (All-on-Board) is listed first and opened', (await ph.locator('h1').first().textContent()) === 'Chat' && (await ph.locator('#side a[href="/app/chat"]').count()) === 1 && (await ph.locator('.chat-title').textContent()) === 'Everyone' && /All-on-Board/.test(await ph.locator('.chat-sub').textContent()) && (await ph.locator('.chat-conv').first().textContent()).includes('Everyone'));
  check('"+ New chat" and a "Who can see your messages?" bar are present', (await ph.getByRole('button', { name: '+ New chat' }).count()) === 1 && (await ph.getByRole('button', { name: /Who can see your messages/ }).count()) === 1);

  // ---- GIF (off) and File menu (cloud sources disabled, no faked connectors)
  const gif = ph.getByRole('button', { name: 'GIF' });
  check('GIF stays visible but disabled with an explanation (the server flag is off)', (await gif.getAttribute('aria-disabled')) === 'true' && /switched off/.test((await gif.getAttribute('title')) || ''));
  await ph.getByRole('button', { name: 'File', exact: true }).click();
  const fileMenu = ph.getByRole('menu', { name: 'Add a file' }); const items = fileMenu.getByRole('menuitem');
  check('the File menu lists Dropbox, Microsoft OneDrive, Google Drive, Box, Microsoft SharePoint and Your computer, all disabled', JSON.stringify((await items.allTextContents()).map((t) => t.trim())) === JSON.stringify(['Dropbox', 'Microsoft OneDrive', 'Google Drive', 'Box', 'Microsoft SharePoint', 'Your computer']) && (await items.evaluateAll((a) => a.every((x) => x.getAttribute('aria-disabled') === 'true'))));
  check('cloud entries say "Not connected: needs provider setup by an administrator"; Your computer explains that attachments need storage and a malware scan', (await items.nth(0).getAttribute('title')) === 'Not connected: needs provider setup by an administrator' && (await items.nth(4).getAttribute('title')) === 'Not connected: needs provider setup by an administrator' && /malware scan/.test((await items.nth(5).getAttribute('title')) || ''));
  await ph.keyboard.press('Escape'); check('Escape closes the menu and focus returns to the File button', (await fileMenu.count()) === 0 && (await ph.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'File');

  // ---- audience popover (server data)
  await ph.getByRole('button', { name: /Who can see your messages/ }).click();
  const pop1 = ph.getByRole('dialog', { name: 'Who can see your messages' }); await pop1.getByText(/Everyone in this workspace \(2 people\)/).waitFor();
  check('"Who can see your messages?" states the audience from server data and that QorllaMate reads a conversation only when asked', /Everyone in this workspace \(2 people\)/.test(await pop1.textContent()) && /only when someone asks it/.test(await pop1.textContent()) && /third-party AI/.test(await pop1.textContent()));
  await ph.keyboard.press('Escape');

  // ---- messages, hover Reply and the More menu
  await send(ph, 'Hello team'); await send(pm, 'Hi Hana');
  check('a message appears for the sender at once and reaches the other person LIVE (no reload)', !!(await until(async () => (await msg(pm, 'Hello team').count()) === 1)) && !!(await until(async () => (await msg(ph, 'Hi Hana').count()) === 1)));
  check('the author is shown by name', (await msg(pm, 'Hello team').locator('strong').textContent()) === 'Hana Host' && (await msg(ph, 'Hello team').locator('strong').textContent()) === 'You');
  await msg(pm, 'Hello team').hover();
  check('Reply sits beside the message on hover (and is a real button, so keyboard and touch reach it)', (await msg(pm, 'Hello team').getByRole('button', { name: 'Reply' }).isVisible()) && (await msg(pm, 'Hello team').locator('.chat-hover').evaluate((e) => getComputedStyle(e).opacity)) === '1');
  await more(pm, 'Hello team').click();
  check('the More menu (someone else\'s message, plain member): Copy, Quote, Bookmark, Create task', JSON.stringify(await menuItems(pm)) === JSON.stringify(['Copy', 'Quote', 'Bookmark', 'Create task']), JSON.stringify(await menuItems(pm)));
  await pm.keyboard.press('Escape');
  await more(ph, 'Hi Hana').click();
  check('the More menu for an owner on someone else\'s message: Copy, Quote, Bookmark, Pin for everyone, Create task, Delete (in that order)', JSON.stringify(await menuItems(ph)) === JSON.stringify(['Copy', 'Quote', 'Bookmark', 'Pin for everyone', 'Create task', 'Delete']), JSON.stringify(await menuItems(ph)));
  await ph.keyboard.press('Escape');
  const mb = more(pm, 'Hello team'); await mb.focus(); await pm.keyboard.press('Enter'); await pm.getByRole('menu', { name: 'Message actions' }).waitFor();
  await pm.keyboard.press('ArrowDown'); const f1 = await pm.evaluate(() => document.activeElement?.textContent); await pm.keyboard.press('Escape');
  check('keyboard: Enter opens the menu, arrows move through it, Escape closes it and returns focus to the button', f1 !== null && (await pm.getByRole('menu', { name: 'Message actions' }).count()) === 0 && (await pm.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'More actions');

  await reply(pm, 'Hello team'); await pm.keyboard.type('Thanks, replying'); await pm.keyboard.press('Enter');
  check('a reply shows who and what it answers, on both pages (the host sees her own message as "You")', !!(await until(async () => (await ph.locator('.chat-replyref', { hasText: 'You: Hello team' }).count()) === 1)) && (await pm.locator('.chat-replyref', { hasText: 'Hana Host: Hello team' }).count()) === 1);
  await doMore(pm, 'Thanks, replying', 'Quote'); await pm.keyboard.type('Quoted answer'); await pm.keyboard.press('Enter');
  check('a quote keeps the original words as a quotation, with the new text below it', !!(await until(async () => (await ph.locator('.chat-body blockquote', { hasText: 'Thanks, replying' }).count()) === 1)) && (await ph.locator('.chat-body blockquote', { hasText: 'Quoted answer' }).count()) === 0);
  await send(pm, 'Teh plan'); await doMore(pm, 'Teh plan', 'Edit'); await pm.keyboard.press('Control+A'); await pm.keyboard.type('The plan'); await pm.keyboard.press('Enter');
  check('editing changes the text for everyone and shows an "edited" indicator', !!(await until(async () => (await msg(ph, 'The plan').locator('.chat-edited').count()) === 1)));
  await more(pm, 'The plan').click(); const own = await menuItems(pm); await pm.keyboard.press('Escape');
  check('the author\'s menu has Edit (after Quote), a plain member never gets Pin', JSON.stringify(own) === JSON.stringify(['Copy', 'Quote', 'Edit', 'Bookmark', 'Create task', 'Delete']), JSON.stringify(own));
  await send(pm, 'delete me'); await doMore(pm, 'delete me', 'Delete');
  check('deleting removes the text for everyone (a tombstone stays)', !!(await until(async () => (await ph.locator('.chat-deleted').count()) === 1)) && (await ph.locator('.chat-msg', { hasText: 'delete me' }).count()) === 0);
  await doMore(pm, 'Hello team', 'Bookmark');
  check('a bookmark is private to its owner; the filter shows only bookmarked messages', !!(await until(async () => (await msg(pm, 'Hello team').locator('[aria-label=Bookmarked]').count()) === 1)) && (await msg(ph, 'Hello team').locator('[aria-label=Bookmarked]').count()) === 0);
  await pm.getByRole('button', { name: 'Show my bookmarks' }).click(); check('bookmark filter', (await pm.locator('.chat-msg:not(.hidden)').count()) === 1); await pm.getByRole('button', { name: 'Show my bookmarks' }).click();
  await doMore(ph, 'Hello team', 'Pin for everyone');
  check('the owner pins a message and everybody sees the pin', !!(await until(async () => (await msg(pm, 'Hello team').locator('[aria-label=Pinned]').count()) === 1)));
  await pm.getByRole('button', { name: /Pinned/ }).click();
  check('the Pinned panel lists the pinned message', !!(await until(async () => (await pm.locator('.chat-pinrow').count()) === 1)) && /Hello team/.test(await pm.locator('.chat-pinrow').textContent()));
  await pm.getByRole('button', { name: /Pinned/ }).click();
  await doMore(pm, 'The plan', 'Create task'); await pm.locator('.chat-taskform input[type=text]').fill('Review the plan'); await pm.getByLabel('Due date').fill('2031-05-01'); await pm.getByLabel('Status').selectOption('done'); await pm.getByLabel('Assignee').selectOption({ label: 'You' }); await pm.getByRole('button', { name: 'Create task', exact: true }).click();
  check('a task is created from the menu with assignee, due date and status', !!(await until(async () => ((await api(M).get('/api/v1/chat/tasks?status=all')).body.tasks || []).some((t) => t.title === 'Review the plan' && t.due_date === '2031-05-01' && t.status === 'done' && t.assignee_id === M.sub))));
  await pm.locator('.chat-search').fill('plan'); check('message search narrows the list on the page', !!(await until(async () => (await pm.locator('.chat-msg:not(.hidden)').count()) === 1))); await pm.locator('.chat-search').fill('');
  const [dl] = await Promise.all([ph.waitForEvent('download', { timeout: 10000 }), ph.getByRole('button', { name: 'Save chat' }).click()]);
  check('Save chat downloads the conversation as a text file', dl.suggestedFilename() === 'everyone.txt');

  // ---- format toolbar: bold, fixed palette colours, fixed sizes, headings; hostile markup is stripped
  await ph.getByRole('button', { name: 'Format', exact: true }).click(); check('the T button opens the format toolbar', await ph.getByRole('toolbar', { name: 'Text formatting' }).isVisible());
  await ph.locator('.chat-editor').click(); await ph.getByRole('button', { name: 'Bold' }).click(); await ph.keyboard.type('Important'); await ph.getByRole('button', { name: 'Bold' }).click(); await ph.keyboard.type(' agenda'); await ph.keyboard.press('Enter');
  check('bold formatting arrives as real bold text', !!(await until(async () => (await pm.locator('.chat-msg b', { hasText: 'Important' }).count()) === 1)));
  await ph.locator('.chat-editor').click(); await ph.getByRole('button', { name: 'Text colour' }).click(); check('the colour menu offers a fixed palette of six swatches', (await ph.getByRole('menu', { name: 'Text colour' }).getByRole('menuitem').count()) === 6);
  await ph.getByRole('menuitem', { name: 'Red', exact: true }).click(); await ph.keyboard.type('Alert'); await ph.keyboard.press('Enter');
  check('a palette colour arrives as a fixed colour class, never as inline CSS', !!(await until(async () => (await pm.locator('.chat-msg .chat-fc-red', { hasText: 'Alert' }).count()) === 1)) && (await pm.locator('.chat-msg [style]').count()) === 0);
  await ph.locator('.chat-editor').click(); await ph.getByRole('button', { name: 'Text size' }).click(); await ph.getByRole('menuitem', { name: 'Large', exact: true }).click(); await ph.keyboard.type('Biggish'); await ph.keyboard.press('Enter');
  check('a size from the fixed set arrives as a fixed size class', !!(await until(async () => (await pm.locator('.chat-msg .chat-fs-lg', { hasText: 'Biggish' }).count()) === 1)));
  await ph.locator('.chat-editor').click(); await ph.getByRole('button', { name: 'Headings' }).click(); await ph.getByRole('menuitem', { name: 'Heading', exact: true }).click(); await ph.keyboard.type('Big title'); await ph.keyboard.press('Enter');
  check('a heading arrives as a heading element', !!(await until(async () => (await pm.locator('.chat-msg h2', { hasText: 'Big title' }).count()) === 1)));
  const before = problems.length; await ph.locator('.chat-editor').click(); await ph.evaluate(() => { document.querySelector('.chat-editor').innerHTML = '<span style="color:red;background:url(x)" onclick="window.__xss=9">styled</span> <font color="#123456" size="7" onmouseover="window.__xss=8">odd</font> <img src=x onerror="window.__xss=7">'; });
  await ph.keyboard.press('Enter');
  check('arbitrary style, colours, sizes, handlers and images typed or pasted into the editor are stripped before they leave the page', !!(await until(async () => (await db.pool.query(`SELECT body_rich FROM portal.chat_messages WHERE body='styled odd'`)).rowCount === 1)) && (await db.pool.query(`SELECT body_rich FROM portal.chat_messages WHERE body='styled odd'`)).rows[0].body_rich === null);
  const csp = problems.splice(before).filter((x) => /Content Security Policy/.test(x));
  check('the page\'s content security policy blocked the inline handlers of that injected markup', csp.length >= 1, 'blocked messages: ' + csp.length);
  const attack = '<img src=x onerror="window.__xss=1"> <script>window.__xss=2</script> <a href="javascript:window.__xss=3">link</a>';
  await send(ph, attack);
  const shown = !!(await until(async () => (await msg(pm, '<img src=x').count()) >= 1)); const parts = { shown, pmEl: await pm.locator('.chat-msg img, .chat-msg script').count(), phEl: await ph.locator('.chat-msg img, .chat-msg script').count(), pmX: await pm.evaluate(() => window.__xss), phX: await ph.evaluate(() => window.__xss) };
  check('typed HTML is shown as text on both pages: no element, nothing ran', shown && parts.pmEl === 0 && parts.phEl === 0 && parts.pmX === undefined && parts.phX === undefined, JSON.stringify(parts));

  await ph.getByRole('button', { name: /Ask QorllaMate/ }).click(); await ph.getByLabel('Your question').fill('What was agreed?'); await ph.getByRole('dialog').getByRole('button', { name: 'Ask' }).click();
  check('QorllaMate answers about the conversation (private model, nothing stored)', !!(await until(async () => /ship on Friday/.test(await ph.locator('.chat-answer').textContent()))) && model.calls === 1 && Number((await db.pool.query('SELECT count(*) FROM portal.chat_ai_requests')).rows[0].count) === 1);
  await ph.keyboard.press('Escape');

  // ---- "+ New chat" with a To: selector; a private conversation reaches only its people
  const outsider = await main.mint(); await addMember(db.pool, W, outsider.sub, 'member'); names[outsider.sub] = 'Olga Outsider'; const { page: po } = await openAs(outsider); await po.goto(app.base + '/app/chat'); await po.locator('.chat-conv', { hasText: 'Everyone' }).waitFor();
  await pm.getByRole('button', { name: '+ New chat' }).click(); await pm.getByLabel('To', { exact: true }).fill('hana');
  check('the To: box filters people by name', (await pm.getByRole('option').count()) === 1);
  await pm.getByRole('option', { name: /Hana Host/ }).click(); check('the chosen person appears as a chip and the button says Start chat', (await pm.locator('.chat-chip').count()) === 1 && (await pm.getByRole('button', { name: 'Start chat' }).isVisible()));
  await pm.getByRole('button', { name: 'Start chat' }).click(); await pm.locator('.chat-title', { hasText: 'Hana Host' }).waitFor(); await send(pm, 'private hello');
  check('a direct message started from the To: selector reaches its other person live and nobody else sees it', !!(await until(async () => (await ph.locator('.chat-conv', { hasText: 'Max Member' }).count()) === 1)) && (await po.locator('.chat-conv', { hasText: 'Hana Host' }).count()) === 0 && (await po.locator('.chat-conv', { hasText: 'Max Member' }).count()) === 0);
  await pm.getByRole('button', { name: /Who can see your messages/ }).click(); const pop2 = pm.getByRole('dialog', { name: 'Who can see your messages' }); await pop2.getByText(/Only these 2 people/).waitFor();
  check('for a private conversation the popover lists exactly its members and says admins outside it cannot read it', /Only these 2 people/.test(await pop2.textContent()) && /Hana Host/.test(await pop2.textContent()) && /cannot read it/.test(await pop2.textContent())); await pm.keyboard.press('Escape');

  // ---- reconnection: the member goes offline, the host posts, the member comes back and receives it (replay) without reloading
  await pm.locator('.chat-conv', { hasText: 'Everyone' }).click(); const memberCtx = pm.context();
  await memberCtx.setOffline(true); await sleep(500); await send(ph, 'sent while you were away'); await sleep(800); await memberCtx.setOffline(false);
  check('after a connection loss the missed message arrives by itself (Last-Event-ID replay)', !!(await until(async () => (await msg(pm, 'sent while you were away').count()) === 1, 20000)));

  if (OUT) { await ph.screenshot({ path: join(OUT, 'portal-chat-desktop.png') }); await ph.getByRole('button', { name: 'File', exact: true }).click(); await ph.screenshot({ path: join(OUT, 'portal-chat-file-menu.png') }); await ph.keyboard.press('Escape'); await more(ph, 'Hi Hana').click(); await ph.screenshot({ path: join(OUT, 'portal-chat-more-menu.png') }); await ph.keyboard.press('Escape'); }
  const { page: pp } = await openAs(M, devices['Pixel 7'].viewport, { userAgent: devices['Pixel 7'].userAgent, isMobile: true, hasTouch: true }); await pp.goto(app.base + '/app/chat'); await pp.locator('.chat-conv', { hasText: 'Everyone' }).waitFor();
  check('on a phone the page does not scroll sideways, the composer is reachable and Reply/More are visible below each message', (await pp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)) && (await pp.locator('.chat-editor').isVisible()) && (await pp.locator('.chat-msg').first().getByRole('button', { name: 'Reply' }).isVisible()));
  if (OUT) await pp.screenshot({ path: join(OUT, 'portal-chat-phone.png'), fullPage: true });
  check('no JavaScript errors, failed requests or server errors on any page', problems.length === 0, problems.slice(0, 3).join(' | '));
} catch (e) { check('run completed without an exception', false, String(e.message || e).slice(0, 400)); }
finally { await browser.close(); await app.close(); await main.close(); await db.drop(); }
const bad = results.filter((r) => !r).length; console.log(`\n${results.length - bad}/${results.length} passed`); process.exit(bad ? 1 : 0);
