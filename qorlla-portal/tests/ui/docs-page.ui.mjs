// Browser check of the Qorlla Docs page against a THROWAWAY portal + PostgreSQL (nothing here touches the running stack).
// Run:  node tests/ui/docs-page.ui.mjs        (needs Chrome and PostgreSQL at 127.0.0.1:25611, same as the other portal tests)
// It is deliberately not named *.test.mjs, so `npm test` does not launch a browser; the deployed-stack browser specs live in e2e/.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
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
const docsOnPage = (p) => p.locator('#docs .doc-card h3').allTextContents();
const goHome = async (p) => { await p.goto(app.base + '/app/suite'); await p.locator('#docs-views').waitFor(); await until(async () => (await p.locator('#docs-state').textContent()) !== 'Loading documents…'); };

try {
  // ---------------------------------------------------------------- home
  const { ctx, page } = await openAs(H);
  await page.goto(app.base + '/app/suite'); await page.locator('#docs-views [data-view]').first().waitFor();
  check('home: heading, six views, folders panel and the create form are present', (await page.locator('h1').first().textContent()) === 'AI Productivity Suite' && (await page.locator('#docs-views [data-view]').count()) === 6 && (await page.locator('#folder-form').count()) === 1 && (await page.locator('#doc-form [name=kind] option').count()) === 3);
  check('home: an empty workspace shows the empty state for the current view, not a blank page', await until(async () => /No documents yet/.test(await page.locator('#docs-state').textContent())));
  check('home: Recent is the current view (aria-current)', (await page.locator('#docs-views [aria-current=true]').textContent()).includes('Recent'));

  // ---------------------------------------------------------------- create + editor (the flow the existing e2e specs use)
  await page.selectOption('#doc-form [name=kind]', 'doc'); await page.fill('#doc-form [name=title]', 'Launch brief'); await page.getByRole('button', { name: 'Create', exact: true }).click(); await page.waitForURL(/\/app\/suite\?doc=/);
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
  await page.locator('#docs-back').click(); await page.locator('#docs-views').waitFor();
  await page.locator('[data-view=starred]').click(); check('Starred view lists exactly the starred document', await until(async () => JSON.stringify(await docsOnPage(page)) === JSON.stringify(['Launch brief v2'])), JSON.stringify(await docsOnPage(page)));
  await page.locator('[data-view=recent]').click(); await until(async () => (await docsOnPage(page)).length === 1);
  await page.locator(`#docs [data-doc="${docId}"] [data-act=dup]`).click();
  check('Duplicate adds "Copy of …" as a private copy owned by me', await until(async () => (await docsOnPage(page)).some((t) => t.startsWith('Copy of Launch brief v2'))));
  const copy = (await api(H).get('/api/v1/documents?view=mine')).body.find((d) => d.title.startsWith('Copy of')); check('the copy carries the content and is restricted', copy && copy.general_access === 'restricted' && (await api(H).get('/api/v1/documents/' + copy.id)).body.content.text === 'unsaved words');

  await page.fill('#folder-form [name=name]', 'Clients'); await page.getByRole('button', { name: 'Add folder' }).click();
  check('folder: added and listed in the sidebar with a count of 0', await until(async () => /Clients\s*0/.test((await page.locator('#docs-folders').textContent()).replace(/\s+/g, ' '))));
  await page.fill('#folder-form [name=name]', ' clients '); await page.getByRole('button', { name: 'Add folder' }).click(); check('folder: a duplicate name is refused with a clear message', await until(async () => /already have a folder/.test(await notice(page))));
  await page.locator(`#docs [data-doc="${docId}"] select[data-act=move]`).selectOption({ label: 'Clients' });
  await until(async () => (await api(H).get(`/api/v1/documents/${docId}/meta`)).body.folder_id); await page.locator('#docs-folders [data-folder]:not([data-folder=none])').first().click();
  check('move: the document appears under the folder, and the folder count is 1', await until(async () => JSON.stringify(await docsOnPage(page)) === JSON.stringify(['Launch brief v2']) && /Clients\s*1/.test((await page.locator('#docs-folders').textContent()).replace(/\s+/g, ' '))), JSON.stringify(await docsOnPage(page)));
  page.dialogPlan.text = 'Key clients'; await page.locator('[data-act=rename-folder]').first().click(); check('folder: rename (prompt)', await until(async () => /Key clients/.test(await page.locator('#docs-folders').textContent())));
  await page.locator('#docs-folders [data-folder=none]').click(); check('"Not in a folder" excludes the filed document', await until(async () => !(await docsOnPage(page)).includes('Launch brief v2') && (await docsOnPage(page)).length >= 1));
  await page.locator('[data-act=delete-folder]').first().click(); check('folder: deleting keeps the document and it becomes unfiled', await until(async () => (await docsOnPage(page)).includes('Launch brief v2')));

  await page.locator(`#docs [data-doc="${docId}"] [data-act=trash]`).click(); check('trash: the document leaves Recent', await until(async () => !(await docsOnPage(page)).includes('Launch brief v2')));
  await page.locator('[data-view=trash]').click(); check('trash: it is listed in Trash with a Restore button and no Open link', await until(async () => (await docsOnPage(page)).includes('Launch brief v2') && (await page.locator(`#docs [data-doc="${docId}"] [data-act=restore]`).count()) === 1 && (await page.locator(`#docs [data-doc="${docId}"] a`).count()) === 0));
  await page.goto(app.base + '/app/suite?doc=' + docId); check('opening a trashed document explains where it went', await until(async () => /Trash view/.test(await page.locator('#suite-root').textContent())));
  await goHome(page); await page.locator('[data-view=trash]').click(); await page.locator(`#docs [data-doc="${docId}"] [data-act=restore]`).click(); await page.locator('[data-view=recent]').click();
  check('restore: it is back in Recent with its history (version 4)', await until(async () => (await docsOnPage(page)).includes('Launch brief v2')) && (await api(H).get('/api/v1/documents/' + docId)).body.current_version === 4);

  // ---------------------------------------------------------------- search, filter, error state
  await page.fill('#doc-search [name=q]', 'unsaved'); await page.locator('#doc-search').getByRole('button', { name: 'Search' }).click(); check('search: matches content of the saved document', await until(async () => (await docsOnPage(page)).includes('Launch brief v2')));
  await page.fill('#doc-search [name=q]', 'zzzznothing'); await page.locator('#doc-search').getByRole('button', { name: 'Search' }).click(); check('search: no match says so', await until(async () => /No documents match/.test(await page.locator('#docs-state').textContent())));
  await page.fill('#doc-search [name=q]', 'a'); await page.locator('#doc-search').getByRole('button', { name: 'Search' }).click(); check('search: one character is refused with a message', /two characters/.test(await notice(page)));
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
  await goHome(page); await page.selectOption('#doc-form [name=kind]', 'sheet'); await page.fill('#doc-form [name=title]', 'Stock'); await page.getByRole('button', { name: 'Create', exact: true }).click(); await page.waitForURL(/\/app\/suite\?doc=/);
  await page.locator('#add-row').click(); await page.locator('[data-cell="0:0"]').fill('Giraffes'); await page.locator('[data-cell="0:1"]').fill('12'); await page.locator('#save-doc').click();
  check('sheet: add row, type values, Save => version 2 with a number stored as a number', await until(async () => (await page.locator('#doc-version').textContent()) === 'version 2') && (await api(H).get('/api/v1/documents?kind=sheet')).body.length === 1 && JSON.stringify((await api(H).get('/api/v1/documents/' + page.url().split('=')[1])).body.content.rows) === '[["Giraffes",12,null]]');
  check('sheet: the doc-only controls (toolbar, markdown export) are not shown', (await page.locator('[data-tool]').count()) === 0 && (await page.locator('a[href$="export.md"]').count()) === 0 && (await page.locator('a[href$="export.txt"]').count()) === 1);
  await goHome(page); await page.selectOption('#doc-form [name=kind]', 'slides'); await page.fill('#doc-form [name=title]', 'Pitch'); await page.getByRole('button', { name: 'Create', exact: true }).click(); await page.waitForURL(/\/app\/suite\?doc=/);
  await page.locator('[data-slide="0"] [data-f=title]').fill('Why now'); await page.locator('[data-slide="0"] [data-f=bullets]').fill('One\nTwo'); await page.locator('#save-doc').click();
  check('slides: edit and Save => version 2', await until(async () => (await page.locator('#doc-version').textContent()) === 'version 2'));
  await goHome(page); await page.selectOption('#doc-kind', 'sheet'); check('type filter: only sheets', await until(async () => JSON.stringify(await docsOnPage(page)) === JSON.stringify(['Stock'])));

  // ---------------------------------------------------------------- plan limit and phone width
  const b = await main.mint(); const bw = await seedWorkspace(db.pool, b.sub, 'Basic'); const bp = await openAs(b);
  for (let i = 0; i < 5; i++) await api(b).post('/api/v1/documents', { kind: 'doc', title: 'D' + i });
  await bp.page.goto(app.base + '/app/suite'); await bp.page.locator('#doc-form').waitFor(); await bp.page.fill('#doc-form [name=title]', 'Sixth'); await bp.page.getByRole('button', { name: 'Create', exact: true }).click();
  check('plan limit: the sixth document on Basic is refused with the plan message and the form stays usable', await until(async () => /plan allows/i.test(await notice(bp.page))) && (await bp.page.locator('#doc-form button').isEnabled()));
  await bp.ctx.close();
  const phone = await openAs(H, { width: 360, height: 740 }); await phone.page.goto(app.base + '/app/suite'); await phone.page.locator('#docs-views').waitFor(); await sleep(400);
  check('phone width: no horizontal scrolling on the home page', await phone.page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), await phone.page.evaluate(() => document.scrollingElement.scrollWidth + ' > ' + window.innerWidth));
  await phone.page.goto(app.base + '/app/suite?doc=' + docId); await phone.page.locator('#doc-text').waitFor(); await sleep(400);
  check('phone width: no horizontal scrolling in the editor', await phone.page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), await phone.page.evaluate(() => document.scrollingElement.scrollWidth + ' > ' + window.innerWidth));
  await phone.ctx.close();
  check('no script errors, console errors or 5xx responses during the whole run', problems.length === 0, problems.join(' | '));
  await ctx.close();
} catch (e) { check('the run finished without an unexpected exception', false, e.stack || e.message); }
finally { await browser.close(); await app.close(); await main.close(); await db.drop(); }
const pass = results.filter(Boolean).length; console.log(`\nDOCS UI: ${pass} passed, ${results.length - pass} failed, ${results.length} total`); process.exit(pass === results.length ? 0 : 2);
