// Post-deployment walkthrough of Qorlla Docs INSIDE the Workspace, against a running stack (run it with the same E2E_* settings as the other specs here, for example the local dev stack
// on :4800). It uses throwaway accounts it registers itself; it does not read or use anyone's real credentials. It is one story: the same document is created, autosaved, reloaded,
// commented on, shared, edited concurrently, revoked, trashed, restored and exported, always through the Workspace page the user actually sees.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const { BASE, signUpWithWorkspace, signUp, createDoc } = require('./helpers');

const hdr = (csrf, ws) => ({ 'x-csrf-token': csrf, origin: BASE, 'x-workspace-id': ws });
const open = async (page, hash) => { await page.goto('/qorlla.html' + hash); await expect(page.locator('.sidebar')).toBeVisible(); };
const ready = (page) => expect(page.locator('#docs-views')).toBeVisible({ timeout: 20000 });
const saveSharing = async (page) => { const done = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/permissions$/.test(r.url())); await page.getByRole('button', { name: 'Save sharing' }).click(); expect((await done).status()).toBe(200); };
const status = (page) => page.locator('#doc-status');

test('Docs end to end in the Workspace: create, autosave, reload, comment, share, conflict, revoke, trash, restore, export', async ({ browser }) => {
  test.setTimeout(240000);
  const ctxO = await browser.newContext({ baseURL: BASE, acceptDownloads: true }); const owner = await signUpWithWorkspace(ctxO, 'walkown'); const page = await ctxO.newPage();
  const popups = []; ctxO.on('page', (p) => { if (p !== page) popups.push(p.url()); });

  // 1. create from the New menu, inside the Workspace shell
  await open(page, '#docs'); await ready(page);
  const id = await createDoc(page, 'doc', 'Walkthrough document');
  await expect(page).toHaveURL(new RegExp('qorlla\\.html#docs/' + id + '$')); await expect(page.locator('.sidebar')).toBeVisible(); expect(page.url()).not.toContain('/app/suite');

  // 2. autosave, then a hard reload: the text is still there
  await page.fill('#doc-text', 'Autosaved paragraph one.'); await expect(status(page)).toHaveText('Unsaved changes');
  await expect(status(page)).toHaveText('Saved', { timeout: 15000 });
  await page.reload(); await expect(page.locator('#doc-text')).toHaveValue('Autosaved paragraph one.');
  await page.goBack().catch(() => {}); await open(page, '#docs'); await ready(page);
  await page.locator('#docs .doc-link', { hasText: 'Walkthrough document' }).first().click(); await expect(page.locator('#doc-text')).toHaveValue('Autosaved paragraph one.');     // reopened from the library

  // 3. manual save makes a version; version history lists the autosave entry and the manual one
  await page.fill('#doc-text', 'Autosaved paragraph one.\n\nManual save.'); await page.locator('#save-doc').click(); await expect(status(page)).toHaveText('Saved');
  await expect(page.locator('#doc-side')).toContainText('Version history'); await expect(page.locator('#doc-side tbody tr')).not.toHaveCount(0);
  await expect(page.locator('#doc-side')).toContainText('Autosave');

  // 4. comments
  await page.fill('#comment-form [name=body]', 'First comment'); await page.getByRole('button', { name: 'Add comment' }).click(); await expect(page.locator('#doc-comments')).toContainText('First comment');
  await page.locator('[data-act=resolve-comment]').first().click(); await expect(page.locator('#doc-side')).toContainText('1 resolved');

  // 5. sharing with a workspace member, who then sees it under Shared, read-only
  const ctxM = await browser.newContext({ baseURL: BASE }); const member = await signUp(ctxM, 'walkmem'); const mpage = await ctxM.newPage();
  const uid = String(member.user.id).replace(/^u_/, '');
  const add = await ctxO.request.post('/api/v1/members', { data: { user_id: uid, role: 'member' }, headers: hdr(owner.csrf, owner.workspaceId) }); expect(add.status()).toBe(201);
  await page.reload(); await expect(page.locator('#share-form')).toBeVisible();
  await page.locator(`#share-form [data-user="${uid}"]`).selectOption('viewer'); await saveSharing(page);
  await mpage.goto('/qorlla.html#docs/' + id); await expect(mpage.locator('#doc-text')).toBeVisible({ timeout: 20000 });
  await expect(mpage.locator('#doc-text')).toBeDisabled(); await expect(status(mpage)).toHaveText('Read only'); await expect(mpage.locator('#save-doc')).toHaveCount(0);
  await mpage.goto('/qorlla.html#docs'); await expect(mpage.locator('#docs-views')).toBeVisible({ timeout: 20000 }); await mpage.locator('#docs-views [data-view=shared]').click(); await expect(mpage.locator('#docs .doc-link')).toContainText(['Walkthrough document']);

  // 6. a second editor and a concurrent edit: the stale tab reports a Conflict and loses nothing
  await page.locator(`#share-form [data-user="${uid}"]`).selectOption('editor'); await saveSharing(page);
  await mpage.goto('/qorlla.html#docs/' + id); await expect(mpage.locator('#doc-text')).toBeEnabled({ timeout: 20000 });
  await mpage.fill('#doc-text', 'Autosaved paragraph one.\n\nManual save.\n\nFrom the second editor.'); await mpage.locator('#save-doc').click(); await expect(status(mpage)).toHaveText('Saved');
  await page.fill('#doc-text', 'Autosaved paragraph one.\n\nMy stale edit.');
  await expect(status(page)).toHaveText('Conflict', { timeout: 15000 }); await expect(page.locator('#conflict-banner')).toBeVisible(); await expect(page.locator('#doc-text')).toHaveValue('Autosaved paragraph one.\n\nMy stale edit.');
  const server = await (await ctxO.request.get('/api/v1/documents/' + id, { headers: hdr(owner.csrf, owner.workspaceId) })).json(); expect(server.content.text).toContain('From the second editor.');           // nothing was overwritten
  await page.locator('#conflict-load').click(); await expect(page.locator('#doc-text')).toContainText('From the second editor.', { timeout: 20000 });

  // 7. revocation: the member loses access at once
  await page.locator(`#share-form [data-user="${uid}"]`).selectOption(''); await saveSharing(page);
  await mpage.reload(); await expect(mpage.getByText(/not found, or you do not have access/i)).toBeVisible({ timeout: 20000 });

  // 8. export (web download), with the owner's session
  const dl = page.waitForEvent('download'); await page.locator('[data-export=txt]').click(); const file = await dl; const path = await file.path(); expect(fs.readFileSync(path, 'utf8')).toContain('From the second editor.');

  // 9. trash and restore through the list
  page.once('dialog', (d) => d.accept()); await page.locator('#del-doc').click(); await ready(page);
  await page.locator('#docs-views [data-view=trash]').click(); await expect(page.locator('#docs .docs-row', { hasText: 'Walkthrough document' })).toBeVisible();
  await page.locator('#docs .docs-row', { hasText: 'Walkthrough document' }).getByRole('button', { name: 'Restore' }).click(); await expect(page.locator('#toast')).toContainText('restored');
  await page.locator('#docs-views [data-view=mine]').click(); await expect(page.locator('#docs .doc-link', { hasText: 'Walkthrough document' })).toBeVisible();

  expect(popups, 'Docs never opened another window').toEqual([]); await ctxO.close(); await ctxM.close();
});
