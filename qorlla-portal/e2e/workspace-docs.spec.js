// Docs is a normal Workspace module: it opens INSIDE the Workspace shell (same sidebar, header, address and breadcrumb trail, like Mail or Notes), not on a separate portal page and
// never in an outside browser. Real browser, real stack (nginx + MAIN + portal + PostgreSQL): run it with the same E2E_* settings as the other specs in this folder.
const { test, expect } = require('@playwright/test');
const { signUpWithWorkspace } = require('./helpers');

const open = async (page, hash = '#home') => { await page.goto('/qorlla.html' + hash); await expect(page.locator('.sidebar')).toBeVisible(); };
const crumbs = (page) => page.locator('#crumbs li:not(.breadcrumb-separator)').allTextContents().then((a) => a.map((t) => t.trim()).filter(Boolean));       // the same extraction the breadcrumb specs use
const docsReady = (page) => expect(page.locator('#docs-views')).toBeVisible({ timeout: 20000 });      // CSS locators reach into the Docs module's open shadow root

test.describe('Docs inside the Workspace', () => {
  test('the sidebar Docs item is a Workspace entry (not a link out) and opens Docs inside the same page, with the same sidebar, header and trail', async ({ page, context }) => {
    await signUpWithWorkspace(context, 'wsdocs'); await open(page);
    const nav = page.locator('.sidebar .nav-item[data-view=docs]'); await expect(nav).toBeVisible(); await expect(page.locator('.sidebar .nav-item[data-href="/app/suite"]')).toHaveCount(0);
    const popups = []; page.on('popup', (p) => popups.push(p.url())); context.on('page', (p) => popups.push(p.url()));
    await nav.click(); await docsReady(page);
    expect(page.url()).toMatch(/\/qorlla\.html#docs$/); expect(page.url()).not.toContain('/app/suite');
    await expect(page.locator('.sidebar')).toBeVisible(); await expect(nav).toHaveAttribute('aria-current', 'page'); await expect(page.locator('#view h1')).toHaveText('Docs');
    await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Docs']);
    expect(popups, 'Docs never opens a new window or an outside browser').toEqual([]);
  });

  test('a document opens in the same page at #docs/<id> (the id is never shown in the trail), Back and Forward walk between the list and the document, and the deep link works', async ({ page, context }) => {
    await signUpWithWorkspace(context, 'wsdocs2'); await open(page, '#docs'); await docsReady(page);
    await page.fill('#doc-form [name=title]', 'Inside the Workspace'); await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.locator('#doc-text')).toBeVisible(); await expect(page).toHaveURL(/qorlla\.html#docs\/[0-9a-f-]{36}$/);
    const id = page.url().split('#docs/')[1]; await expect(page.locator('.sidebar')).toBeVisible();
    await expect.poll(() => crumbs(page)).toEqual(['Workspace', 'Docs', 'Document']); expect((await crumbs(page)).join(' ')).not.toContain(id);
    await page.fill('#doc-text', 'written in the Workspace'); await page.locator('#save-doc').click(); await expect(page.locator('#doc-version')).toHaveText('version 2');
    await page.goBack(); await docsReady(page); await expect(page).toHaveURL(/qorlla\.html#docs$/); await expect(page.locator('#docs .doc-card h3')).toContainText(['Inside the Workspace']);
    await page.goForward(); await expect(page.locator('#doc-text')).toHaveValue('written in the Workspace');
    await page.goto('/qorlla.html#home'); await page.goto('/qorlla.html#docs/' + id); await expect(page.locator('#doc-text')).toHaveValue('written in the Workspace');       // the deep link
    await page.locator('#docs-back').click(); await docsReady(page); await expect(page).toHaveURL(/qorlla\.html#docs$/);
  });

  test('Docs behaves like the other modules: switching away unmounts it, coming back remounts it, and the legacy /app/suite link still works', async ({ page, context }) => {
    await signUpWithWorkspace(context, 'wsdocs3'); await open(page, '#docs'); await docsReady(page);
    await page.locator('.sidebar .nav-item[data-view=mail]').click(); await expect(page).toHaveURL(/#mail$/); await expect(page.locator('.docs-host')).toHaveCount(0);
    await page.locator('.sidebar .nav-item[data-view=docs]').click(); await docsReady(page); await expect(page.locator('.docs-host')).toHaveCount(1);
    await page.goto('/app/suite'); await expect(page.locator('#doc-form')).toBeVisible();                                       // the standalone page is kept for old links
  });

  test('typing and Escape inside Docs belong to Docs: a "?" is typed (no shortcuts dialog), and Escape in the editor or a row menu does not close the page', async ({ page, context }) => {
    await signUpWithWorkspace(context, 'wsdocs4'); await open(page, '#docs'); await docsReady(page);
    await page.fill('#doc-form [name=title]', 'Keys'); await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.locator('#doc-text')).toBeVisible();
    await page.locator('#doc-text').click(); await page.keyboard.type('Is this typed? yes'); await expect(page.locator('#doc-text')).toHaveValue('Is this typed? yes'); await expect(page.locator('dialog[open]')).toHaveCount(0);
    await page.keyboard.press('Escape'); await expect(page.locator('#doc-text')).toBeVisible(); await expect(page).toHaveURL(/#docs\/[0-9a-f-]{36}$/);              // the open document is not thrown away
    page.once('dialog', (d) => d.dismiss()); await page.locator('#docs-back').click(); await expect(page.locator('#doc-text')).toHaveValue('Is this typed? yes');                   // unsaved text: Cancel keeps you in the editor
    page.once('dialog', (d) => d.accept()); await page.locator('#docs-back').click(); await docsReady(page);                                                                      // OK leaves
    await page.locator('#docs .doc-menu summary').first().click(); await expect(page.locator('#docs .doc-menu[open]')).toHaveCount(1);
    await page.keyboard.press('Escape'); await expect(page.locator('#docs .doc-menu[open]')).toHaveCount(0); await expect(page).toHaveURL(/#docs$/);                  // closes the menu only
  });

  test('messages from Docs appear as the Workspace toast, and the row menu opens and closes properly inside the shadow root', async ({ page, context }) => {
    await signUpWithWorkspace(context, 'wsdocs5'); await open(page, '#docs'); await docsReady(page);
    await page.fill('#doc-form [name=title]', 'Toast me'); await page.getByRole('button', { name: 'Create', exact: true }).click(); await expect(page.locator('#doc-text')).toBeVisible(); await page.locator('#docs-back').click(); await docsReady(page);
    await page.locator('#docs .doc-menu summary').first().click(); await expect(page.locator('#docs .doc-menu[open]')).toHaveCount(1);
    await page.locator('#docs [data-act=dup]').first().click(); await expect(page.locator('#toast')).toContainText('private copy');
    await page.locator('#docs .doc-menu summary').first().click(); await expect(page.locator('#docs .doc-menu[open]')).toHaveCount(1); await page.locator('#docs-title').click(); await expect(page.locator('#docs .doc-menu[open]')).toHaveCount(0);
  });

  test('phone width: the Workspace navigation still reaches Docs and nothing scrolls sideways', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 360, height: 740 } }); const page = await context.newPage(); await signUpWithWorkspace(context, 'wsdocs6'); await open(page);
    await page.locator('.sidebar .nav-item[data-view=docs]').click(); await docsReady(page); await expect(page).toHaveURL(/#docs$/);
    expect(await page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1)).toBe(true); await context.close();
  });
});
