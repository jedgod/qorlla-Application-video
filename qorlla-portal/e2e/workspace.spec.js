const { test, expect } = require('@playwright/test');
const { BASE, dbq, signUp, signUpWithWorkspace } = require('./helpers');

// Real browser, real MAIN sign-in, real PostgreSQL. The language model is the repo's labelled TEST DOUBLE (tests/fake-llm.mjs), so the
// QorllaMate test proves our workflow (proposal -> approval -> creation) and NOT the quality or behaviour of a real model.
async function addMember(ownerCtx, ownerCsrf, ws, userId) {
  const r = await ownerCtx.request.post('/api/v1/members', { data: { user_id: String(userId).replace(/^u_/, ''), role: 'member' }, headers: { 'x-csrf-token': ownerCsrf, origin: BASE, 'x-workspace-id': ws } });
  if (r.status() !== 201) throw new Error('add member failed ' + r.status() + ' ' + (await r.text()));
}

test.describe('notes, documents and QorllaMate', () => {
  test('notes are private by default, searchable and filed in notebooks; a colleague in the same workspace sees none of it', async ({ page, browser, context }) => {
    const owner = await signUpWithWorkspace(context, 'notesowner');
    await page.goto('/app/notes'); await expect(page.locator('#note-quota')).toContainText('0 of 20 notes');
    await page.fill('#nb-form [name=name]', 'Ideas'); await page.getByRole('button', { name: 'Create notebook' }).click();
    await expect(page.locator('#note-filter option', { hasText: 'Ideas' })).toHaveCount(1);
    await page.fill('#note-form [name=title]', 'Pelican roadmap'); await page.fill('#note-form [name=body]', 'Secret pelican launch plan');
    await page.selectOption('#note-form [name=notebook_id]', { label: 'Ideas' }); await page.getByRole('button', { name: 'Save Note' }).click();
    await expect(page.locator('#notes')).toContainText('Pelican roadmap'); await expect(page.locator('#notes')).toContainText('only you');
    expect(dbq(`SELECT visibility FROM portal.notes WHERE title='Pelican roadmap' AND workspace_id='${owner.workspaceId}'`)).toBe('private');
    // The page re-renders the whole panel (including the search input) after every search. Mark the current input, search, and wait until that node has
    // been replaced before typing again; otherwise the next fill() can land on an input that is about to disappear and the search never fires.
    const search = async (q) => {
      await page.evaluate(() => { document.querySelector('#note-search').dataset.stale = '1'; });
      await page.fill('#note-search', q); await page.locator('#note-search').press('Enter');
      await expect(page.locator('#note-search')).not.toHaveAttribute('data-stale', '1');
    };
    await search('pelican'); await expect(page.locator('#notes')).toContainText('Pelican roadmap');
    await search('zebra'); await expect(page.locator('#notes')).toContainText('No notes yet');

    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE }); const p2 = await ctx2.newPage();
    const second = await signUp(ctx2, 'colleague'); await addMember(context, owner.csrf, owner.workspaceId, second.user.id);
    await p2.goto('/app/notes'); await expect(p2.locator('#notes')).toContainText('No notes yet'); await expect(p2.locator('body')).not.toContainText('Pelican');
    expect((await ctx2.request.get('/api/v1/notes')).status()).toBe(200);
    expect((await (await ctx2.request.get('/api/v1/notes')).json()).length).toBe(0);
    await ctx2.close();
  });

  test('documents: create, edit with version history and restore, optimistic-concurrency conflict, and sharing as read-only', async ({ page, browser, context }) => {
    const owner = await signUpWithWorkspace(context, 'docowner');
    await page.goto('/app/suite'); await page.selectOption('#doc-form [name=kind]', 'doc'); await page.fill('#doc-form [name=title]', 'Launch brief'); await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/\/app\/suite\?doc=/); await expect(page.locator('#doc-version')).toHaveText('version 1');
    await page.fill('#doc-text', 'First draft about giraffes'); await page.locator('#save-doc').click(); await expect(page.locator('#doc-version')).toHaveText('version 2');
    const docUrl = page.url();
    // a second tab opened at version 2 edits and saves; the first tab is now stale
    const tab2 = await context.newPage(); await tab2.goto(docUrl); await expect(tab2.locator('#doc-version')).toHaveText('version 2');
    await tab2.fill('#doc-text', 'Edited in the second tab'); await tab2.locator('#save-doc').click(); await expect(tab2.locator('#doc-version')).toHaveText('version 3');
    await page.fill('#doc-text', 'Stale overwrite attempt'); await page.locator('#save-doc').click();
    await expect(page.locator('#notice')).toContainText('Someone else saved a newer version');
    expect(dbq(`SELECT current_version FROM portal.documents WHERE title='Launch brief' AND workspace_id='${owner.workspaceId}'`)).toBe('3');
    // restore version 1 as a new version
    await page.reload(); page.once('dialog', (d) => d.accept());
    await page.locator('tr[data-v="1"]').getByRole('button', { name: /Restore/ }).click(); await expect(page.locator('#doc-version')).toHaveText('version 4');
    expect(dbq(`SELECT source FROM portal.document_versions v JOIN portal.documents d ON d.id=v.document_id WHERE d.title='Launch brief' AND d.workspace_id='${owner.workspaceId}' AND version_no=4`)).toBe('restore');
    // sharing: a colleague cannot even see it until shared; then sees it read-only
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE }); const p2 = await ctx2.newPage();
    const second = await signUp(ctx2, 'reader'); await addMember(context, owner.csrf, owner.workspaceId, second.user.id);
    await p2.goto(docUrl); await expect(p2.locator('body')).toContainText('not found, or you do not have access');
    await page.reload(); await page.locator('#share-form [data-user]').first().selectOption('viewer'); await page.getByRole('button', { name: 'Save sharing' }).click(); await expect(page.locator('#notice')).toContainText('Sharing updated');
    await p2.goto(docUrl); await expect(p2.locator('body')).toContainText('you are viewer'); await expect(p2.locator('#save-doc')).toHaveCount(0); await expect(p2.locator('#doc-text')).toBeDisabled();
    expect((await ctx2.request.put('/api/v1/documents/' + docUrl.split('=')[1], { data: { base_version: 4, content: { text: 'hijack' } }, headers: { origin: BASE, 'x-csrf-token': (await ctx2.cookies()).find((c) => c.name === 'qorlla_csrf').value } })).status()).toBe(403);
    await ctx2.close();
  });

  test('sheets and slides edit and persist; AI draft is labelled and private (test-double model)', async ({ page, context }) => {
    const me = await signUpWithWorkspace(context, 'suiteuser');
    await page.goto('/app/suite'); await page.selectOption('#doc-form [name=kind]', 'sheet'); await page.fill('#doc-form [name=title]', 'Stock'); await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/\/app\/suite\?doc=/); await page.locator('#add-row').click(); await page.locator('[data-cell="0:0"]').fill('Giraffes'); await page.locator('[data-cell="0:1"]').fill('12'); await page.locator('#save-doc').click(); await expect(page.locator('#doc-version')).toHaveText('version 2');
    await page.reload(); await expect(page.locator('[data-cell="0:0"]')).toHaveValue('Giraffes'); await expect(page.locator('[data-cell="0:1"]')).toHaveValue('12');
    expect(dbq(`SELECT content->'rows'->0->>1 FROM portal.document_versions v JOIN portal.documents d ON d.id=v.document_id WHERE d.title='Stock' AND d.workspace_id='${me.workspaceId}' AND version_no=2`)).toBe('12');
    await page.goto('/app/suite'); await page.selectOption('#doc-form [name=kind]', 'slides'); await page.fill('#doc-form [name=title]', 'Pitch'); await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/\/app\/suite\?doc=/); await page.locator('[data-slide="0"] [data-f=title]').fill('Why now'); await page.locator('[data-slide="0"] [data-f=bullets]').fill('Market\nTiming'); await page.locator('#save-doc').click(); await expect(page.locator('#doc-version')).toHaveText('version 2');
    await page.goto('/app/suite'); await page.selectOption('#ai-form [name=kind]', 'doc'); await page.fill('#ai-form [name=prompt]', 'A brief about the pelican launch'); await page.getByRole('button', { name: 'Draft', exact: true }).click();
    await page.waitForURL(/\/app\/suite\?doc=/, { timeout: 30000 }); await expect(page.locator('body')).toContainText('drafted by AI'); await expect(page.locator('#doc-text')).toHaveValue(/TEST-DOUBLE/);
    expect(dbq(`SELECT count(*) FROM portal.ai_usage_events WHERE feature='doc_generation' AND workspace_id='${me.workspaceId}'`)).toBe('1');
  });

  test('QorllaMate proposes, the user approves, and only then does the note exist; email stays blocked (test-double model)', async ({ page, context }) => {
    const me = await signUpWithWorkspace(context, 'mateuser');
    await page.goto('/app/mate'); await expect(page.locator('#mate-note')).toContainText('Nothing is created until you approve');
    await page.locator('#new-thread').click(); await page.fill('#mate-form [name=content]', 'Please create a note titled "Offsite agenda" saying "book the venue"'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#mate-log')).toContainText('TEST-DOUBLE REPLY'); const task = page.locator('[data-task]').first(); await expect(task).toContainText('proposed');
    expect(dbq(`SELECT count(*) FROM portal.notes WHERE workspace_id='${me.workspaceId}' AND title='Offsite agenda'`)).toBe('0');
    await task.getByRole('button', { name: 'Approve' }).click(); await expect(page.locator('[data-task]').first()).toContainText('executed');
    expect(dbq(`SELECT source||'/'||visibility FROM portal.notes WHERE workspace_id='${me.workspaceId}' AND title='Offsite agenda'`)).toBe('assistant/private');
    await page.goto('/app/notes'); await expect(page.locator('#notes')).toContainText('Offsite agenda'); await expect(page.locator('#notes')).toContainText('by QorllaMate');
    await page.goto('/app/mate'); await page.locator('button[data-thread]').first().click();
    await page.fill('#mate-form [name=content]', 'Please send an email to boss@example.test about it'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    const mail = page.locator('[data-task]').filter({ hasText: 'external' }); await expect(mail).toContainText('proposed');
    await mail.getByRole('button', { name: 'Approve' }).click(); await expect(page.locator('#notice')).toContainText('no mail provider'); await expect(page.locator('[data-task]').filter({ hasText: 'external' })).toContainText('blocked');
  });
});
