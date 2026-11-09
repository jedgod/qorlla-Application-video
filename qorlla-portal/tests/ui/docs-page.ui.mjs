// Browser check of the Qorlla Docs page against a THROWAWAY portal + PostgreSQL (nothing here touches the running stack).
// Run:  node tests/ui/docs-page.ui.mjs        (needs Chrome and PostgreSQL at 127.0.0.1:25611, same as the other portal tests)
// It is deliberately not named *.test.mjs, so `npm test` does not launch a browser; the deployed-stack browser specs live in e2e/.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, addMember } from '../helpers.mjs';
const { chromium } = createRequire(import.meta.url)('../../../node_modules/playwright-core');

const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '   <- ' + String(detail).slice(0, 260))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); let last; while (Date.now() - t < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(80); } return false; }

const db = await freshDatabase(); const main = await startMainStandIn();
const cfg = testConfig({}, main); const app = await startApp({ pool: db.pool, cfg, jwks: main.jwks }); cfg.origin = app.base;     // the browser's own origin passes the CSRF origin check
const H = await main.mint(); const M = await main.mint();
const W = await seedWorkspace(db.pool, H.sub, 'UI Co'); await db.pool.query(`UPDATE portal.subscriptions SET plan_slug='pro',status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [W]); await addMember(db.pool, W, M.sub, 'member');
const api = (s) => app.client(s, { origin: app.base });                                  // the API helper must present the same origin the browser does
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const problems = [];
async function openAs(session, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport }); await ctx.addCookies([{ name: 'qorlla_portal_session', value: session.jwt, url: app.base, httpOnly: true }, { name: 'qorlla_csrf', value: session.csrf, url: app.base }]);
  const page = await ctx.newPage(); page.dialogLog = []; page.dialogPlan = { accept: true, text: undefined };
  page.on('dialog', async (d) => { page.dialogLog.push(d.type() + ':' + d.message()); if (page.dialogPlan.accept) await d.accept(page.dialogPlan.text); else await d.dismiss(); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|breadcrumbs/.test(m.text())) problems.push('console: ' + m.text()); });
  page.on('response', (r) => { if (r.url().includes('/api/v1/') && r.status() >= 500) problems.push('5xx: ' + r.url()); });
  return { ctx, page };
}
const notice = (p) => p.locator('#notice').textContent();
const menu = (p, id) => p.locator(`#docs [data-doc="${id}"] .doc-menu summary`).click();          // a row's actions live in its "⋯" menu
const docsOnPage = (p) => p.locator('#docs .doc-card h3').allTextContents();
const goHome = async (p) => { await p.goto(app.base + '/app/suite'); await p.locator('#docs-views').waitFor(); await until(async () => (await p.locator('#docs-state').textContent()) !== 'Loading documents…'); };
const createDoc = async (p, kind, title) => { await p.locator('#new-doc').click(); await p.locator(`#new-menu [data-new=${kind}]`).click(); await p.waitForURL(/\/app\/suite\?doc=/); await p.locator('#doc-title').waitFor(); if (title) { await p.fill('#doc-title', title); await p.locator('#doc-title').blur(); await until(async () => /Renamed/.test(await notice(p))); } return p.url().split('=')[1]; };

try {
  // ---------------------------------------------------------------- home
  const { ctx, page } = await openAs(H);
  await page.goto(app.base + '/app/suite'); await page.locator('#docs-views [data-view]').first().waitFor();
  check('home: heading, seven views, folders panel and the compact New menu (Document/Sheet/Slides/Folder) are present', (await page.locator('h1').first().textContent()) === 'Qorlla Docs' && (await page.locator('#docs-views [data-view]').count()) === 7 && (await page.locator('#folder-form').count()) === 1 && (await page.locator('#new-menu [role=menuitem]').count()) === 4 && (await page.locator('#doc-form').count()) === 0);
  check('home: an empty workspace shows the empty state for the current view, not a blank page', await until(async () => /No documents yet/.test(await page.locator('#docs-state').textContent())));
  check('home: Home is the current view (aria-current)', (await page.locator('#docs-views [aria-current=true]').textContent()).includes('Home'));

  // ---------------------------------------------------------------- create + editor (the flow the existing e2e specs use)
  await createDoc(page, 'doc', 'Launch brief');
  const docId = page.url().split('=')[1];
  check('create: lands on /app/suite?doc=<id> exactly (other flows split the URL on "=")', /^[0-9a-f-]{36}$/.test(docId), page.url());
  await page.locator('#doc-text').waitFor(); check('editor: starts at version 1, "Saved", with a markdown toolbar of 7 tools and a word count', (await page.locator('#doc-version').textContent()) === 'version 1' && (await page.locator('#doc-status').textContent()) === 'Saved' && (await page.locator('[data-tool]').count()) === 7 && (await page.locator('#doc-count').textContent()) === '0 words');
  await page.fill('#doc-text', 'plan'); await page.locator('#doc-text').selectText(); await page.locator('[data-tool=bold]').click();
  check('toolbar: Bold wraps the selection in **…**', (await page.inputValue('#doc-text')) === '**plan**', await page.inputValue('#doc-text'));
  check('editing marks the page "Unsaved changes"', (await page.locator('#doc-status').textContent()) === 'Unsaved changes');
  await page.fill('#doc-text', 'Intro line\nsecond line'); await page.locator('#doc-text').click(); await page.keyboard.press('Control+A'); await page.locator('[data-tool=bullets]').click();
  check('toolbar: List prefixes every selected line', (await page.inputValue('#doc-text')) === '- Intro line\n- second line', await page.inputValue('#doc-text'));
  const attack = '# Title\n\n<img src=x onerror="window.__xss=1"> and <script>window.__xss=2</script>\n\n**bold** *it* `code` [x](javascript:alert(1))\n\n- one\n- two\n\n1. a\n2. b\n\n> quote\n\n```\n<b>raw</b>\n```';
  await page.fill('#doc-text', attack); await page.locator('#toggle-preview').click(); await sleep(300);
  const html = await page.locator('#doc-preview').innerHTML();
  check('preview: renders headings, bold, italic, code, lists, quote and code fences', ['<h2>Title</h2>', '<strong>bold</strong>', '<em>it</em>', '<code>code</code>', '<ul>', '<ol>', '<blockquote>quote</blockquote>', '<pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>'].every((s) => html.includes(s)), html.slice(0, 400));
  check('preview: typed HTML is shown as text and never becomes elements; nothing ran; javascript: links are not turned into links', (await page.locator('#doc-preview img, #doc-preview script, #doc-preview a').count()) === 0 && (await page.evaluate(() => window.__xss)) === undefined && html.includes('&lt;img'));
  check('preview: the toolbar is disabled while previewing and the editor is hidden; Edit brings it back', (await page.locator('[data-tool=bold]').isDisabled()) && !(await page.locator('#doc-text').isVisible()));
  await page.locator('#toggle-preview').click(); check('preview off: the text is back, untouched', (await page.locator('#doc-text').isVisible()) && (await page.inputValue('#doc-text')) === attack);

  await page.fill('#doc-text', 'The original paragraph about pelicans.'); await page.locator('#save-doc').click();
  check('Save: version 2 and the status says Saved', await until(async () => (await page.locator('#doc-version').textContent()) === 'version 2' && (await page.locator('#doc-status').textContent()) === 'Saved'));
  const stored = (await api(H).get('/api/v1/documents/' + docId)).body; check('Save: the stored content keeps the live format {format:"markdown", text} (QorllaMate, search and AI read this)', stored.content.format === 'markdown' && stored.content.text === 'The original paragraph about pelicans.' && stored.current_version === 2, JSON.stringify(stored.content));
  await page.fill('#doc-text', 'Edited with the keyboard shortcut'); await page.locator('#doc-text').press('Control+s');
  check('Ctrl+S saves (version 3)', await until(async () => (await page.locator('#doc-version').textContent()) === 'version 3'));
  await page.fill('#doc-title', 'Launch brief v2'); await page.locator('#doc-title').dispatchEvent('change');
  check('rename: saved at once without creating a version', await until(async () => (await api(H).get('/api/v1/documents/' + docId)).body.title === 'Launch brief v2') && (await api(H).get('/api/v1/documents/' + docId)).body.current_version === 3);
  check('search follows the rename', (await api(H).get('/api/v1/search?q=launch')).body.some((x) => x.id === docId));

  // ---------------------------------------------------------------- unsaved-changes guard
  await page.fill('#doc-text', 'unsaved words'); page.dialogPlan.accept = false; await page.locator('#docs-back').click(); await sleep(300);
  check('leaving with unsaved edits asks first; Cancel keeps you in the editor with the text', page.dialogLog.some((l) => /unsaved changes/i.test(l)) && /doc=/.test(page.url()) && (await page.inputValue('#doc-text')) === 'unsaved words');
  page.dialogPlan.accept = true; await page.locator('#save-doc').click(); await until(async () => (await page.locator('#doc-version').textContent()) === 'version 4');

  // ---------------------------------------------------------------- star, duplicate, folders, trash from the home page
  await page.locator('#doc-star').click(); check('star in the editor is stored for me', await until(async () => (await api(H).get(`/api/v1/documents/${docId}/meta`)).body.starred === true));
  check('star in the editor: the button flips to "★ Starred" (aria-pressed true) and no error text appears', await until(async () => (await page.locator('#doc-star').getAttribute('aria-pressed')) === 'true' && (await page.locator('#doc-star').textContent()) === '★ Starred') && !/Cannot read|undefined|null/.test(await notice(page)), await notice(page));
  await page.locator('#doc-star').click(); check('star in the editor: a second click turns it off again (button and stored value)', await until(async () => (await page.locator('#doc-star').getAttribute('aria-pressed')) === 'false' && (await page.locator('#doc-star').textContent()) === '☆ Star' && (await api(H).get(`/api/v1/documents/${docId}/meta`)).body.starred === false) && !/Cannot read/.test(await notice(page)));
  await page.locator('#doc-star').click(); await until(async () => (await page.locator('#doc-star').getAttribute('aria-pressed')) === 'true');
  await page.locator('#docs-back').click(); await page.locator('#docs-views').waitFor();
  await page.locator('[data-view=starred]').click(); check('Starred view lists exactly the starred document', await until(async () => JSON.stringify(await docsOnPage(page)) === JSON.stringify(['Launch brief v2'])), JSON.stringify(await docsOnPage(page)));
  await page.locator('[data-view=recent]').click(); await until(async () => (await docsOnPage(page)).length === 1);
  await menu(page, docId); await page.locator(`#docs [data-doc="${docId}"] [data-act=dup]`).click();
  check('Duplicate adds "Copy of …" as a private copy owned by me', await until(async () => (await docsOnPage(page)).some((t) => t.startsWith('Copy of Launch brief v2'))));
  const copy = (await api(H).get('/api/v1/documents?view=mine')).body.find((d) => d.title.startsWith('Copy of')); check('the copy carries the content and is restricted', copy && copy.general_access === 'restricted' && (await api(H).get('/api/v1/documents/' + copy.id)).body.content.text === 'unsaved words');

  await page.locator('.docs-manage summary').click(); await page.fill('#folder-form [name=name]', 'Clients'); await page.getByRole('button', { name: 'Add folder' }).click();
  check('folder: added and listed in the folder dropdown with a count of 0', await until(async () => /Clients \(0\)/.test(await (await page.locator('#folder-select').evaluate((s) => [...s.options].map((o) => o.textContent).join('|'))))));
  await page.fill('#folder-form [name=name]', ' clients '); await page.getByRole('button', { name: 'Add folder' }).click(); check('folder: a duplicate name is refused with a clear message', await until(async () => /already have a folder/.test(await notice(page))));
  await menu(page, docId); await page.locator(`#docs [data-doc="${docId}"] select[data-act=move]`).selectOption({ label: 'Clients' });
  await until(async () => (await api(H).get(`/api/v1/documents/${docId}/meta`)).body.folder_id); await page.locator('#folder-select').selectOption({ label: 'Clients (1)' }).catch(async () => { await page.locator('#folder-select').selectOption({ index: 2 }); });
  check('move: the document appears under the folder, and the folder count is 1', await until(async () => JSON.stringify(await docsOnPage(page)) === JSON.stringify(['Launch brief v2']) && /Clients \(1\)/.test(await (await page.locator('#folder-select').evaluate((s) => [...s.options].map((o) => o.textContent).join('|'))))), JSON.stringify(await docsOnPage(page)));
  page.dialogPlan.text = 'Key clients'; await page.locator('[data-act=rename-folder]').first().click(); check('folder: rename (prompt)', await until(async () => /Key clients/.test(await (await page.locator('#folder-select').evaluate((s) => [...s.options].map((o) => o.textContent).join('|'))))));
  await page.locator('#folder-select').selectOption('none'); check('"Not in a folder" excludes the filed document', await until(async () => !(await docsOnPage(page)).includes('Launch brief v2') && (await docsOnPage(page)).length >= 1));
  await page.locator('[data-act=delete-folder]').first().click(); check('folder: deleting keeps the document and it becomes unfiled', await until(async () => (await docsOnPage(page)).includes('Launch brief v2')));

  await menu(page, docId); await page.locator(`#docs [data-doc="${docId}"] [data-act=trash]`).click(); check('trash: the document leaves Recent', await until(async () => !(await docsOnPage(page)).includes('Launch brief v2')));
  await page.locator('[data-view=trash]').click(); check('trash: it is listed in Trash with a Restore button and no Open link', await until(async () => (await docsOnPage(page)).includes('Launch brief v2') && (await page.locator(`#docs [data-doc="${docId}"] [data-act=restore]`).count()) === 1 && (await page.locator(`#docs [data-doc="${docId}"] a`).count()) === 0));
  await page.goto(app.base + '/app/suite?doc=' + docId); check('opening a trashed document explains where it went', await until(async () => /Trash view/.test(await page.locator('#suite-root').textContent())));
  await goHome(page); await page.locator('[data-view=trash]').click(); await page.locator(`#docs [data-doc="${docId}"] [data-act=restore]`).click(); await page.locator('[data-view=recent]').click();
  check('restore: it is back in Recent with its history (version 4)', await until(async () => (await docsOnPage(page)).includes('Launch brief v2')) && (await api(H).get('/api/v1/documents/' + docId)).body.current_version === 4);

  // ---------------------------------------------------------------- search, filter, error state
  await page.fill('#doc-search [name=q]', 'unsaved'); await page.press('#doc-search [name=q]', 'Enter'); check('search: matches content of the saved document', await until(async () => (await docsOnPage(page)).includes('Launch brief v2')));
  await page.fill('#doc-search [name=q]', 'zzzznothing'); await page.press('#doc-search [name=q]', 'Enter'); check('search: no match says so', await until(async () => /No documents match/.test(await page.locator('#docs-state').textContent())));
  await page.fill('#doc-search [name=q]', 'a'); await page.press('#doc-search [name=q]', 'Enter'); check('search: one character is refused with a message', /two characters/.test(await notice(page)));
  await page.fill('#doc-search [name=q]', ''); check('search: clearing the box restores the list', await until(async () => (await docsOnPage(page)).includes('Launch brief v2')));
  let fail = true; await page.route('**/api/v1/documents?*', (r) => (fail ? r.abort() : r.continue())); await page.locator('[data-view=mine]').click();
  check('error state: a failed load shows the problem and a Try again button', await until(async () => /Could not load documents/.test(await page.locator('#docs-state').textContent())));
  fail = false; await page.locator('#docs-retry').click(); check('error state: Try again recovers', await until(async () => (await docsOnPage(page)).includes('Launch brief v2')));
  await page.unroute('**/api/v1/documents?*');

  // ---------------------------------------------------------------- comments, sharing, a read-only viewer, export
  await page.goto(app.base + '/app/suite?doc=' + docId); await page.locator('#comment-form').waitFor();
  await page.fill('#comment-form [name=body]', '<b>Please</b> check the figures'); await page.getByRole('button', { name: 'Add comment' }).click();
  check('comment: added and shown as plain text (markup not interpreted)', await until(async () => (await page.locator('#doc-comments li').first().textContent()).includes('<b>Please</b> check the figures') && (await page.locator('#doc-comments li b').count()) === 0));
  check('comment: shown as "You"', (await page.locator('#doc-comments li strong').first().textContent()) === 'You');
  await page.locator('[data-act=resolve-comment]').click(); check('comment: Resolve moves it under "resolved"', await until(async () => /1 resolved/.test(await page.locator('#doc-side').textContent()) && /No open comments/.test(await page.locator('#doc-comments').textContent())));
  check('export: .txt and .md download the saved text with a safe filename', await (async () => { const t = await ctx.request.get(app.base + `/api/v1/documents/${docId}/export.txt`); const m = await ctx.request.get(app.base + `/api/v1/documents/${docId}/export.md`); return (await t.text()) === 'unsaved words' && /filename="Launch_brief_v2\.txt"/.test(t.headers()['content-disposition']) && m.status() === 200; })());
  await page.reload(); await page.locator('#share-form').waitFor(); await page.locator('#share-form [data-user]').first().selectOption('viewer'); await page.getByRole('button', { name: 'Save sharing' }).click(); check('sharing: saved from the page', await until(async () => /Sharing updated/.test(await notice(page))));
  const viewer = await openAs(M); await viewer.page.goto(app.base + '/app/suite?doc=' + docId); await viewer.page.locator('#doc-text').waitFor();
  check('viewer: read only: text, title, toolbar and Save are disabled/absent, comments cannot be added, but star, duplicate and export are available', (await viewer.page.locator('#doc-text').isDisabled()) && (await viewer.page.locator('#doc-title').isDisabled()) && (await viewer.page.locator('[data-tool=bold]').isDisabled()) && (await viewer.page.locator('#save-doc').count()) === 0 && (await viewer.page.locator('#comment-form').count()) === 0 && (await viewer.page.locator('#doc-star').count()) === 1 && (await viewer.page.locator('#doc-dup').count()) === 1 && (await viewer.page.locator('#doc-folder, #del-doc, #share-form').count()) === 0);
  await goHome(viewer.page); await viewer.page.locator('[data-view=shared]').click(); check('viewer: the document shows under "Shared with me" with their role, without owner-only actions', await until(async () => (await docsOnPage(viewer.page)).includes('Launch brief v2') && (await viewer.page.locator(`#docs [data-doc="${docId}"] [data-act=trash], #docs [data-doc="${docId}"] select`).count()) === 0));
  await viewer.page.locator('[data-view=trash]').click(); check('viewer: someone else\'s trash is not visible', await until(async () => (await docsOnPage(viewer.page)).length === 0));
  await viewer.ctx.close();

  // ---------------------------------------------------------------- sheets and slides still work on the new page
  await goHome(page); await createDoc(page, 'sheet', 'Stock');
  await page.locator('#add-row').click(); await page.locator('[data-cell="0:0"]').fill('Giraffes'); await page.locator('[data-cell="0:1"]').fill('12'); await page.locator('#save-doc').click();
  check('sheet: add row, type values, Save => version 2 with a number stored as a number', await until(async () => (await page.locator('#doc-version').textContent()) === 'version 2') && (await api(H).get('/api/v1/documents?kind=sheet')).body.length === 1 && JSON.stringify((await api(H).get('/api/v1/documents/' + page.url().split('=')[1])).body.content.rows) === '[["Giraffes",12,null]]');
  check('sheet: the doc-only controls (toolbar, markdown export) are not shown', (await page.locator('[data-tool]').count()) === 0 && (await page.locator('[data-export=md]').count()) === 0 && (await page.locator('[data-export=txt]').count()) === 1);
  await goHome(page); await createDoc(page, 'slides', 'Pitch');
  await page.locator('[data-slide="0"] [data-f=title]').fill('Why now'); await page.locator('[data-slide="0"] [data-f=bullets]').fill('One\nTwo'); await page.locator('#save-doc').click();
  check('slides: edit and Save => version 2', await until(async () => (await page.locator('#doc-version').textContent()) === 'version 2'));
  await goHome(page); await page.selectOption('#doc-kind', 'sheet'); check('type filter: only sheets', await until(async () => JSON.stringify(await docsOnPage(page)) === JSON.stringify(['Stock'])));

  // ---------------------------------------------------------------- release layout: list first, one AI area, contrast, phone menu, paging, drafts, export
  {
    const o = await openAs(H, { width: 1280, height: 900 }); const p = o.page; await goHome(p);
    const box = async (sel) => p.locator(sel).first().boundingBox(); const bs = [await box('#docs-views'), await box('#doc-search'), await box('#docs')]; const ys = bs.map((b) => Math.round(b.y)); const aside = await box('.docs-aside');
    check('layout: tabs, then search/filter/New, then the document library (top to bottom); creation and AI sit in a smaller column BESIDE the library at desktop width', ys.every((y, i) => i === 0 || ys[i - 1] < y) && aside.x > bs[2].x + bs[2].width - 4 && aside.width < bs[2].width, ys.join(' < ') + ' aside.x=' + aside.x);
    check('AI: ONE collapsible AI assistance area with a single "turned off" notice, no form, no external-provider text, and a disabled "Draft with AI" button', (await p.locator('.docs-ai').count()) === 1 && (await p.locator('#docs-ai summary h2').textContent()) === 'AI assistance' && (await p.locator('#docs-ai .docs-notice').count()) === 1 && /approved private model/.test(await p.locator('#docs-ai .docs-notice').textContent()) && (await p.locator('#ai-form').count()) === 0 && (await p.locator('#docs-ai summary').click(), await p.getByRole('button', { name: 'Draft with AI' }).isDisabled()));
    const ratio = await p.evaluate(() => { const lum = (r, g, b) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0); const e = document.querySelector('.hero .eyebrow'); const [r, g, b] = getComputedStyle(e).color.match(/\d+/g).map(Number); const l1 = lum(r, g, b), l2 = lum(0x0b, 0x56, 0xc9); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); });
    check('contrast: the "QORLLA WORKPLACE" line on the hero is at least 4.5:1 against the hero\'s darkest blue (was blue on blue)', ratio >= 4.5, String(ratio));
    await p.locator('#new-doc').click(); check('+ New opens a menu with four items (aria-haspopup, expanded), and Escape closes it and returns focus to the button', (await p.locator('#new-doc').getAttribute('aria-expanded')) === 'true' && (await p.locator('#new-menu [role=menuitem]').allTextContents()).map((x) => x.trim()).join() === 'Document,Sheet,Slides,Folder' && (await p.keyboard.press('Escape'), await until(async () => (await p.locator('#new-menu').isHidden()) && (await p.evaluate(() => document.activeElement?.id)) === 'new-doc')));
    await o.ctx.close();

    const m = await openAs(H, { width: 360, height: 740 }); const mp = m.page; await goHome(mp); const tog = mp.locator('#menu-toggle');
    check('phone menu: a visible toggle with an accessible name, collapsed by default, controlling the navigation', (await tog.isVisible()) && (await tog.getAttribute('aria-label')) === 'Open navigation menu' && (await tog.getAttribute('aria-expanded')) === 'false' && (await tog.getAttribute('aria-controls')) === 'side-nav');
    check('phone menu: the closed rail still gives every link a hover title', (await mp.locator('aside a[title]').count()) >= 3);
    await tog.click(); check('phone menu: opening shows readable labels (not icons only); the name flips to Close and aria-expanded is true', await until(async () => (await mp.locator('aside.open').count()) === 1) && (await tog.getAttribute('aria-expanded')) === 'true' && (await tog.getAttribute('aria-label')) === 'Close navigation menu' && (await mp.locator('aside a').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize))) >= 14);
    await mp.keyboard.press('Escape'); check('phone menu: Escape closes it and focus returns to the toggle', await until(async () => (await mp.locator('aside.open').count()) === 0) && (await mp.evaluate(() => document.activeElement?.id)) === 'menu-toggle');
    await tog.click(); await mp.mouse.click(355, 400); check('phone menu: tapping outside closes it', await until(async () => (await mp.locator('aside.open').count()) === 0));
    await tog.click(); await mp.setViewportSize({ width: 1280, height: 800 }); check('phone menu: growing the window to desktop width closes it', await until(async () => (await mp.locator('aside.open').count()) === 0));
    await m.ctx.close();
  }
  {
    const pg = await main.mint(); const pgw = await seedWorkspace(db.pool, pg.sub, 'Pagination'); await db.pool.query(`UPDATE portal.subscriptions SET plan_slug='business',status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [pgw]);
    await db.pool.query(`INSERT INTO portal.documents(workspace_id,owner_id,kind,title,current_version,search_text,updated_at) SELECT $1,$2,'doc','Paged '||lpad(g::text,3,'0'),1,'',now()-(g*interval '1 minute') FROM generate_series(1,120) g`, [pgw, pg.sub]);
    const o = await openAs(pg); const p = o.page; await goHome(p);
    check('paging: Home shows the 8 most recent documents and "View all recent documents", not Load more', await until(async () => (await docsOnPage(p)).length === 8) && (await p.locator('#docs-viewall').isVisible()) && (await p.locator('#docs-more').isHidden()));
    await p.locator('#docs-viewall').click(); check('paging: Recent shows 50, says more is available and offers Load more', await until(async () => (await docsOnPage(p)).length === 50) && (await p.locator('#docs-more').isVisible()) && /Showing 50 documents \(more available\)/.test(await p.locator('#docs-count').textContent()));
    await p.locator('#docs-more').click(); check('paging: Load more appends the next 50 (100 shown, still more)', await until(async () => (await docsOnPage(p)).length === 100) && await p.locator('#docs-more').isVisible());
    await p.locator('#docs-more').click(); const all = await until(async () => { const t = await docsOnPage(p); return t.length === 120 ? t : false; });
    check('paging: the last page shows all 120 once each, newest first, and Load more disappears', all && new Set(all).size === 120 && all[0] === 'Paged 001' && all[119] === 'Paged 120' && (await p.locator('#docs-more').isHidden()) && /Showing 120 documents$/.test(await p.locator('#docs-count').textContent()), all && all.length);
    await o.ctx.close();
  }
  {
    const dd = (await api(H).post('/api/v1/documents', { kind: 'doc', title: 'Draft recovery' })).body; const dp = await openAs(H); const p = dp.page;
    await p.goto(app.base + '/app/suite?doc=' + dd.id); await p.locator('#doc-text').waitFor(); await p.fill('#doc-text', 'words that were never saved'); await sleep(900); await p.reload(); await p.locator('#doc-text').waitFor();
    check('draft recovery: unsaved text is offered back after a refresh, with Restore and Discard (the saved text is still shown meanwhile)', (await p.locator('#draft-banner').isVisible()) && (await p.locator('#draft-restore').count()) === 1 && (await p.inputValue('#doc-text')) === '');
    await p.locator('#draft-restore').click(); check('draft recovery: Restore puts the text back, marks the page unsaved and removes the banner', (await p.inputValue('#doc-text')) === 'words that were never saved' && (await p.locator('#doc-status').textContent()) === 'Unsaved changes' && (await p.locator('#draft-banner').count()) === 0);
    await p.locator('#save-doc').click(); await until(async () => (await p.locator('#doc-version').textContent()) === 'version 2'); await sleep(900); await p.reload(); await p.locator('#doc-text').waitFor();
    check('draft recovery: after Save there is nothing left to recover', (await p.locator('#draft-banner').count()) === 0);
    await p.fill('#doc-text', 'my edit on version two'); await sleep(900); await api(H).put(`/api/v1/documents/${dd.id}`, { base_version: 2, content: { format: 'markdown', text: 'someone else wrote this' } }); await p.reload(); await p.locator('#doc-text').waitFor();
    check('draft recovery: if the document changed meanwhile the draft is shown for copying and can NOT be restored over the newer version', (await p.locator('#draft-banner').isVisible()) && (await p.locator('#draft-restore').count()) === 0 && /changed since/.test(await p.locator('#draft-banner').textContent()) && (await p.inputValue('#doc-text')) === 'someone else wrote this' && (await p.locator('#draft-banner textarea').inputValue()) === 'my edit on version two');
    await p.locator('#draft-discard').click(); await p.reload(); await p.locator('#doc-text').waitFor(); check('draft recovery: Discard removes it for good', (await p.locator('#draft-banner').count()) === 0);

    const [dl] = await Promise.all([p.waitForEvent('download'), p.locator('[data-export=md]').click()]);
    check('export (web): a normal browser download with a safe .md filename and the saved text', /^[A-Za-z0-9._-]+\.md$/.test(dl.suggestedFilename()) && (await fs.promises.readFile(await dl.path(), 'utf8')) === 'someone else wrote this', dl.suggestedFilename());
    await dp.ctx.close();

    const ds = await openAs(H); const sp = ds.page; let downloaded = false; sp.on('download', () => { downloaded = true; });
    await sp.addInitScript(() => { window.__saved = []; window.qorllaDesktop = { saveDocsExport: async (a) => { window.__saved.push(a); return { saved: true }; } }; });
    await sp.goto(app.base + '/app/suite?doc=' + dd.id); await sp.locator('#doc-text').waitFor(); await sp.locator('[data-export=txt]').click(); await sleep(700);
    const got = await sp.evaluate(() => window.__saved);
    check('export (desktop app): with the native Save As bridge present the page hands over the filename and text, shows "Export saved." and triggers no browser download', got.length === 1 && /\.txt$/.test(got[0].filename) && got[0].text === 'someone else wrote this' && !downloaded && /Export saved/.test(await notice(sp)), JSON.stringify(got).slice(0, 120));
    await ds.ctx.close();

    await api(H).put(`/api/v1/documents/${dd.id}/permissions`, { general_access: 'restricted', users: [{ user_id: M.sub, role: 'viewer' }] });
    const vx = await openAs(M); await vx.page.goto(app.base + '/app/suite?doc=' + dd.id); await vx.page.locator('#doc-text').waitFor();
    await api(H).put(`/api/v1/documents/${dd.id}/permissions`, { general_access: 'restricted', users: [] }); await vx.page.locator('[data-export=md]').click();
    check('export: a viewer whose access was just removed is refused with a clear message and gets no file', await until(async () => /no longer have access/.test(await notice(vx.page))));
    await vx.ctx.close();
  }
  {
    const np = await openAs(H); const p = np.page;
    for (const kind of ['doc', 'sheet', 'slides']) {
      const nd = (await api(H).post('/api/v1/documents', { kind, title: 'Untouched ' + kind })).body; await p.goto(app.base + '/app/suite?doc=' + nd.id); await p.locator('#save-doc').waitFor(); p.dialogLog.length = 0;
      await p.locator('#docs-back').click(); await p.locator('#docs-views').waitFor();
      check(`an untouched ${kind} (never edited) is left without any "unsaved changes" question (the stored key order must not make it look edited)`, p.dialogLog.length === 0 && /\/app\/suite$/.test(p.url()), p.dialogLog.join('|'));
    }
    await np.ctx.close();
  }
  // ---------------------------------------------------------------- plan limit and phone width
  const b = await main.mint(); const bw = await seedWorkspace(db.pool, b.sub, 'Basic'); const bp = await openAs(b);
  for (let i = 0; i < 5; i++) await api(b).post('/api/v1/documents', { kind: 'doc', title: 'D' + i });
  await bp.page.goto(app.base + '/app/suite'); await bp.page.locator('#new-doc').waitFor(); await bp.page.locator('#new-doc').click(); await bp.page.locator('#new-menu [data-new=doc]').click();
  check('plan limit: the sixth document on Basic is refused with the plan message and the New button stays usable', await until(async () => /plan allows/i.test(await notice(bp.page))) && (await bp.page.locator('#new-doc').isEnabled()));
  await bp.ctx.close();
  const phone = await openAs(H, { width: 360, height: 740 }); await phone.page.goto(app.base + '/app/suite'); await phone.page.locator('#docs-views').waitFor(); await sleep(400);
  check('phone width: no horizontal scrolling on the home page', await phone.page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), await phone.page.evaluate(() => document.scrollingElement.scrollWidth + ' > ' + window.innerWidth));
  await phone.page.goto(app.base + '/app/suite?doc=' + docId); await phone.page.locator('#doc-text').waitFor(); await sleep(400);
  check('phone width: no horizontal scrolling in the editor', await phone.page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), await phone.page.evaluate(() => document.scrollingElement.scrollWidth + ' > ' + window.innerWidth));
  await phone.ctx.close();
  // ---------------------------------------------------------------- how saving fails, and what survives
  const fm = (await api(H).post('/api/v1/documents', { kind: 'doc', title: 'Failure modes' })).body; const putUrl = '**/api/v1/documents/' + fm.id;
  await page.goto(app.base + '/app/suite?doc=' + fm.id); await page.locator('#doc-text').waitFor();
  await page.fill('#doc-text', 'draft one'); let blockPut = true; await page.route(putUrl, (r) => (blockPut && r.request().method() === 'PUT' ? r.abort() : r.continue()));
  await page.locator('#save-doc').click();
  check('save: a network failure says "Not saved", keeps the typed text, leaves Save usable and writes nothing', await until(async () => (await page.locator('#doc-status').textContent()) === 'Not saved') && (await page.inputValue('#doc-text')) === 'draft one' && (await page.locator('#save-doc').isEnabled()) && (await api(H).get(`/api/v1/documents/${fm.id}`)).body.current_version === 1);
  blockPut = false; await page.locator('#save-doc').click(); check('save: retrying once the network is back saves it (version 2)', await until(async () => (await page.locator('#doc-version').textContent()) === 'version 2' && (await page.locator('#doc-status').textContent()) === 'Saved'));
  await page.unroute(putUrl);
  const tab2 = await ctx.newPage(); await tab2.goto(app.base + '/app/suite?doc=' + fm.id); await tab2.locator('#doc-text').waitFor(); await tab2.fill('#doc-text', 'written in the other tab'); await tab2.locator('#save-doc').click(); await until(async () => (await tab2.locator('#doc-version').textContent()) === 'version 3');
  await tab2.close(); await page.bringToFront();
  await page.fill('#doc-text', 'my competing edit'); await page.locator('#save-doc').click();
  check('conflict: a stale save is refused with the explanation, the typed text stays in the page and the other tab\'s version is untouched', await until(async () => /Someone else saved a newer version/.test(await notice(page))) && (await page.inputValue('#doc-text')) === 'my competing edit' && (await page.locator('#doc-status').textContent()) === 'Conflict' && (await page.locator('#conflict-banner').isVisible()) && (await api(H).get(`/api/v1/documents/${fm.id}`)).body.content.text === 'written in the other tab');
  await page.reload(); await page.locator('#doc-text').waitFor();
  check('refresh: what was saved is back after a reload; unsaved typing is not kept (there is no local draft recovery or autosave)', (await page.inputValue('#doc-text')) === 'written in the other tab' && (await page.locator('#doc-version').textContent()) === 'version 3');
  let dupFail = true; await page.route('**/api/v1/documents/' + fm.id + '/duplicate', (r) => (dupFail ? r.abort() : r.continue()));
  await page.locator('#doc-dup').click(); check('duplicate in the editor: a failed request re-enables the button and shows an error without a script exception', await until(async () => (await page.locator('#doc-dup').isEnabled()) && (await notice(page)).length > 0) && !/Cannot read/.test(await notice(page)), await notice(page));
  dupFail = false; await page.locator('#doc-dup').click(); check('duplicate in the editor: opens the new private copy', await until(async () => /doc=/.test(page.url()) && !page.url().endsWith(fm.id) && (await page.locator('#doc-title').inputValue()) === 'Copy of Failure modes'));
  await page.unroute('**/api/v1/documents/' + fm.id + '/duplicate');
  await api(H).put(`/api/v1/documents/${fm.id}/permissions`, { general_access: 'restricted', users: [{ user_id: M.sub, role: 'editor' }] });
  const ed = await openAs(M); await ed.page.goto(app.base + '/app/suite?doc=' + fm.id); await ed.page.locator('#doc-text').waitFor(); await ed.page.fill('#doc-text', 'editor typing');
  await api(H).put(`/api/v1/documents/${fm.id}/permissions`, { general_access: 'restricted', users: [{ user_id: M.sub, role: 'viewer' }] });
  await ed.page.locator('#save-doc').click();
  check('revocation: an editor demoted to viewer while typing cannot save (clear message, nothing written)', await until(async () => /view but not edit/.test(await notice(ed.page))) && (await ed.page.locator('#doc-status').textContent()) === 'Not saved' && (await api(H).get(`/api/v1/documents/${fm.id}`)).body.current_version === 3);
  await api(H).put(`/api/v1/documents/${fm.id}/permissions`, { general_access: 'restricted', users: [] });
  await ed.page.locator('#save-doc').click(); check('revocation: once access is removed entirely, saving is refused and nothing is written', await until(async () => /not found|permission|Document/i.test(await notice(ed.page))) && (await api(H).get(`/api/v1/documents/${fm.id}`)).body.current_version === 3);
  await ed.page.reload(); check('revocation: a reload shows "not found, or you do not have access" without leaking the document', await until(async () => /not found, or you do not have access/.test(await ed.page.locator('#suite-root').textContent())) && !(await ed.page.content()).includes('written in the other tab'));
  await ed.ctx.close();
  await db.pool.query(`DELETE FROM portal.entitlements WHERE plan_slug='pro' AND feature='documents.comments'`);
  await page.goto(app.base + '/app/suite?doc=' + fm.id); await page.locator('#doc-side').waitFor(); await until(async () => /Comments/.test(await page.locator('#doc-side').textContent()));
  check('comments entitlement: without it the page shows "not included in your plan" instead of the form, and the server refuses a direct call', (await page.locator('#comment-form').count()) === 0 && /not included in your plan/.test(await page.locator('#doc-side').textContent()) && (await api(H).post(`/api/v1/documents/${fm.id}/comments`, { body: 'x' })).status === 403);
  await db.pool.query(`INSERT INTO portal.entitlements(plan_slug,feature,quota,description) VALUES('pro','documents.comments',NULL,'Document comments') ON CONFLICT DO NOTHING`);

  // ---------------------------------------------------------------- the shared min-width:0 change: does any portal page overflow with it that did not without it?
  const pagesToTry = ['/app/', '/app/notes', '/app/mate', '/app/suite', '/app/suite?doc=' + docId, '/app/billing', '/app/team', '/app/phone', '/app/receptionist']; const regress = []; const preexisting = []; let measured = 0;
  const overflowAt = async (path, width, strip) => {
    const c = await browser.newContext({ viewport: { width, height: 800 } }); await c.addCookies([{ name: 'qorlla_portal_session', value: H.jwt, url: app.base, httpOnly: true }, { name: 'qorlla_csrf', value: H.csrf, url: app.base }]);
    const p = await c.newPage(); if (strip) await p.route('**/app/assets/styles.css', async (r) => { const resp = await r.fetch(); r.fulfill({ response: resp, body: (await resp.text()).replace('.layout>main.docs-page{min-width:0}', '') }); });
    await p.goto(app.base + path); await p.locator('main').first().waitFor(); await sleep(1500);
    let w = -1, same = 0; for (let i = 0; i < 20 && same < 3; i++) { const now = await p.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth); same = now === w ? same + 1 : 0; w = now; await sleep(400); }   // measure only once the page has finished rendering (three equal readings)
    await c.close(); return w;
  };
  for (const path of pagesToTry) for (const width of [360, 768, 1280]) { const withRule = await overflowAt(path, width, false); const without = await overflowAt(path, width, true); measured++; if (withRule > 1 && withRule <= without + 1) preexisting.push(`${path}@${width}: ${withRule}px`); if (withRule > 1 && withRule > without + 1) regress.push(`${path}@${width}: ${withRule}px with the rule, ${without}px without`); }
  console.log('(info) pages that overflow at that width with or without the rule (not caused by it): ' + (preexisting.join(' | ') || 'none'));
  check(`min-width:0: none of ${pagesToTry.length} portal pages x 3 widths (${measured} measurements) overflows more with the rule than without it`, regress.length === 0, regress.join(' | '));

  check('no script errors, console errors or 5xx responses during the whole run', problems.length === 0, problems.join(' | '));
  await ctx.close();


  // ---------------------------------------------------------------- Library management and autosave
  {
    const o = await openAs(H, { width: 1280, height: 900 }); const p = o.page; const mk = async (title, extra = {}) => (await api(H).post('/api/v1/documents', { kind: 'doc', title, ...extra })).body;
    await mk('Bulk Charlie'); await mk('Bulk alpha'); await mk('Bulk Bravo');
    await goHome(p); await p.fill('#doc-search [name=q]', 'Bulk'); await p.press('#doc-search [name=q]', 'Enter'); await until(async () => (await docsOnPage(p)).length === 3);
    await p.locator('#doc-sort').selectOption('title:asc'); check('sort: Name A-Z orders the library case-insensitively (server side)', await until(async () => JSON.stringify(await docsOnPage(p)) === JSON.stringify(['Bulk alpha', 'Bulk Bravo', 'Bulk Charlie'])), JSON.stringify(await docsOnPage(p)));
    await p.locator('#doc-sort').selectOption('title:desc'); check('sort: Name Z-A reverses it', await until(async () => JSON.stringify(await docsOnPage(p)) === JSON.stringify(['Bulk Charlie', 'Bulk Bravo', 'Bulk alpha'])));
    await p.locator('#doc-sort').selectOption('title:asc'); await until(async () => (await docsOnPage(p))[0] === 'Bulk alpha');
    await p.locator('#layout-grid').click(); check('layout: grid view shows the same documents as cards and hides the table header', (await p.locator('#docs').getAttribute('data-layout')) === 'grid' && (await p.locator('#layout-grid').getAttribute('aria-pressed')) === 'true' && (await p.locator('.docs-tablehead').isHidden()) && (await docsOnPage(p)).length === 3);
    await p.locator('#layout-list').click(); check('layout: list view restores the table header', (await p.locator('#docs').getAttribute('data-layout')) === 'list' && (await p.locator('.docs-tablehead').isVisible()));
    check('the "Create new" card steps aside once the library has documents', await p.locator('.docs-quick').isHidden());
    await p.locator('#docs [data-pick]').nth(0).check(); await p.locator('#docs [data-pick]').nth(1).check();
    check('selection: two rows selected show the bulk bar with the count, and the header checkbox is mixed', (await p.locator('#docs-bulk').isVisible()) && /2 selected/.test(await p.locator('#bulk-count').textContent()) && (await p.locator('#pick-all').evaluate((e) => e.indeterminate)));
    await p.locator('[data-bulk=star]').click(); check('bulk: Star stars exactly the selected documents (server confirms) and clears the selection', await until(async () => { const l = (await api(H).get('/api/v1/documents?view=starred&q=Bulk')).body.map((d) => d.title).sort(); return JSON.stringify(l) === JSON.stringify(['Bulk Bravo', 'Bulk alpha']); }) && await until(async () => await p.locator('#docs-bulk').isHidden()));
    await p.locator('#pick-all').check(); check('selection: the header checkbox selects every document shown', /3 selected/.test(await p.locator('#bulk-count').textContent()));
    p.dialogPlan.accept = true; await p.locator('[data-bulk=trash]').click();
    check('bulk: Move to trash (after confirming) trashes all selected documents', await until(async () => (await api(H).get('/api/v1/documents?view=trash&q=Bulk')).body.length === 3));
    await p.fill('#doc-search [name=q]', ''); await p.locator('#docs-views [data-view=trash]').click(); await until(async () => (await docsOnPage(p)).length >= 3); await p.locator('#docs [data-pick]').first().check();
    check('bulk: in the Trash view the bar offers Restore (not Move to trash)', (await p.locator('[data-bulk=restore]').isVisible()) && (await p.locator('[data-bulk=trash]').isHidden())); await p.locator('[data-bulk=restore]').click();
    check('bulk: Restore brings the document back', await until(async () => (await api(H).get('/api/v1/documents?view=trash&q=Bulk')).body.length === 2));
    const S = await mk('Shared status doc'); await api(H).put(`/api/v1/documents/${S.id}/permissions`, { general_access: 'restricted', users: [{ user_id: M.sub, role: 'viewer' }] });
    await p.locator('#docs-views [data-view=mine]').click(); await p.fill('#doc-search [name=q]', 'Shared status'); await p.press('#doc-search [name=q]', 'Enter');
    check('sharing status: a row says who it is shared with (real data, not invented)', await until(async () => /Shared with 1 person/.test(await p.locator('#docs').textContent())));
    await o.ctx.close();

    // ---- autosave and save states in the editor
    const E1 = await mk('Autosave me'); const e = await openAs(H); const ep = e.page; await ep.goto(app.base + '/app/suite?doc=' + E1.id); await ep.locator('#doc-text').waitFor();
    const status = () => ep.locator('#doc-status').textContent(); const ver = async () => (await api(H).get(`/api/v1/documents/${E1.id}`)).body;
    await ep.fill('#doc-text', 'first words'); check('autosave: typing shows "Unsaved changes" with a data-state', (await status()) === 'Unsaved changes' && (await ep.locator('#doc-status').getAttribute('data-state')) === 'unsaved');
    check('autosave: a few seconds after the last keystroke it saves by itself ("Saved", last-saved time shown) without pressing Save', await until(async () => (await status()) === 'Saved' && /last saved/.test(await ep.locator('#doc-saved-at').textContent()), 12000) && (await ver()).content.text === 'first words');
    const v1 = (await ver()).current_version; await ep.fill('#doc-text', 'first words, and more'); await until(async () => (await ver()).content.text === 'first words, and more', 12000);
    check('autosave: further autosaves fold into ONE history entry (the version number does not climb on every pause)', (await ver()).current_version === v1 && (await ep.locator('#doc-version').textContent()) === 'version ' + v1);
    await ep.fill('#doc-text', 'manual text'); await ep.locator('#save-doc').click(); check('a manual Save always makes a new version', await until(async () => (await ver()).current_version === v1 + 1 && (await status()) === 'Saved'));
    let blockPut = true; await ep.route('**/api/v1/documents/' + E1.id, (r) => (blockPut && r.request().method() === 'PUT' ? r.abort() : r.continue()));
    await ep.fill('#doc-text', 'typed while offline'); check('autosave failure: the page says "Not saved", keeps the text and the Save button is usable', await until(async () => (await status()) === 'Not saved', 12000) && (await ep.inputValue('#doc-text')) === 'typed while offline' && (await ep.locator('#save-doc').isEnabled()));
    blockPut = false; await ep.locator('#save-doc').click(); check('autosave failure: once the network is back the text is saved', await until(async () => (await ver()).content.text === 'typed while offline' && (await status()) === 'Saved'));
    await ep.unroute('**/api/v1/documents/' + E1.id);
    const cur = (await ver()).current_version; await api(H).put(`/api/v1/documents/${E1.id}`, { base_version: cur, content: { format: 'markdown', text: 'written by someone else' } });
    await ep.fill('#doc-text', 'my edits made on an old copy');
    check('conflict: autosave detects it, shows "Conflict" and the explanation, and keeps my text on the page', await until(async () => (await status()) === 'Conflict' && (await ep.locator('#conflict-banner').isVisible()), 12000) && (await ep.inputValue('#doc-text')) === 'my edits made on an old copy');
    check('conflict: the other person\'s version was NOT overwritten', (await ver()).content.text === 'written by someone else');
    await ep.locator('#conflict-copy').click(); await ep.waitForURL((u) => u.search.includes('doc=') && !u.search.includes(E1.id), { timeout: 8000 });
    const copyId = ep.url().split('=')[1]; const copy = (await api(H).get(`/api/v1/documents/${copyId}`)).body;
    check('conflict: "Save my changes as a new document" keeps my text in a copy, and the original still holds the other person\'s text', copy.content.text === 'my edits made on an old copy' && /my changes/.test(copy.title) && (await ver()).content.text === 'written by someone else');
    await e.ctx.close();
  }
  // ---------------------------------------------------------------- Production UI refinement checks
  {
    const SHOTS = process.env.DOCS_SHOTS_DIR;
    const o = await openAs(H, { width: 1280, height: 900 }); const p = o.page; await goHome(p);
    const before = (await api(H).get('/api/v1/documents?limit=200')).body.length;
    await p.locator('#new-doc').click(); await p.locator('#new-menu [data-new=doc]').dblclick();
    await p.waitForURL(/\/app\/suite\?doc=/); await sleep(600);
    const after = (await api(H).get('/api/v1/documents?limit=200')).body.length;
    check('New > Document opens an untitled document immediately, and a double-click creates exactly ONE', after === before + 1 && (await p.locator('#doc-title').inputValue()) === 'Untitled document', `before ${before} after ${after}`);
    await goHome(p);
    await p.route('**/api/v1/documents', (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }) : r.continue()));
    await p.locator('#new-doc').click(); await p.locator('#new-menu [data-new=sheet]').click();
    check('creation failure: a meaningful message, no navigation, and the New button is usable again', await until(async () => (await notice(p)).trim().length >= 4) && /app\/suite$/.test(p.url()) && (await p.locator('#new-doc').isEnabled()) && !(await p.locator('#new-doc').getAttribute('aria-busy')), 'notice=[' + (await notice(p)) + '] url=' + p.url());
    await p.unroute('**/api/v1/documents');
    await p.locator('#docs-views [data-view=templates]').click();
    check('Templates: polished empty state with a next action (no invented sample documents)', await until(async () => (await p.locator('#docs-state .docs-empty').count()) === 1 && (await p.locator('#docs-state .docs-empty button').count()) >= 1 && (await p.locator('#docs .doc-card').count()) === 0));
    await p.locator('#docs-views [data-view=home]').click();
    await p.fill('#doc-search [name=q]', 'zzzznothing'); await p.waitForTimeout(900);
    check('search is live (debounced): typing alone filters, no button needed', await until(async () => /No documents match/.test(await p.locator('#docs-state').textContent())));
    const tabbed = []; await p.locator('#doc-search [name=q]').focus(); for (let i = 0; i < 2; i++) { await p.keyboard.press('Tab'); tabbed.push(await p.evaluate(() => { const e = document.activeElement; return e && (e.id || e.getAttribute('aria-label') || e.tagName); })); }
    check('keyboard: Tab reaches the search, filter and New controls in order', tabbed[0] === 'doc-kind' && tabbed[1] === 'new-doc', tabbed.join());
    const sizes = await p.evaluate(() => ['#doc-search [name=q]', '#doc-kind', '#new-doc'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().height)));
    check('controls are at least 44px tall', sizes.every((h) => h >= 44), sizes.join());
    await o.ctx.close();
    for (const w of [360, 390, 768, 1280, 1440]) {
      const r = await openAs(H, { width: w, height: 900 }); const q = r.page; await goHome(q);
      const ovHome = await q.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
      const stacked = await q.evaluate(() => { const a = document.querySelector('.docs-aside').getBoundingClientRect(), l = document.querySelector('.docs-library').getBoundingClientRect(); return a.top >= l.bottom - 2; });
      if (SHOTS) await q.screenshot({ path: `${SHOTS}/home-${w}.png`, fullPage: true });
      await q.goto(app.base + '/app/suite?doc=' + docId); await q.locator('#doc-text').waitFor(); const ovEd = await q.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
      if (SHOTS) await q.screenshot({ path: `${SHOTS}/editor-${w}.png`, fullPage: true });
      check(`${w}px: Docs home and the editor do not scroll sideways, and the side column ${w >= 1100 ? 'sits beside' : 'stacks under'} the library`, ovHome <= 1 && ovEd <= 1 && (w >= 1100 ? !stacked : stacked), `home ${ovHome} editor ${ovEd} stacked ${stacked}`);
      await r.ctx.close();
    }
  }
} catch (e) { check('the run finished without an unexpected exception', false, e.stack || e.message); }
finally { await browser.close(); await app.close(); await main.close(); await db.drop(); }
const pass = results.filter(Boolean).length; console.log(`\nDOCS UI: ${pass} passed, ${results.length - pass} failed, ${results.length} total`); process.exit(pass === results.length ? 0 : 2);
