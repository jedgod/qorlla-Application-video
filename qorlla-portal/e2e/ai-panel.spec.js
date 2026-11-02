const { test, expect } = require('@playwright/test');
const { BASE, dbq, signUp, signUpWithWorkspace } = require('./helpers');

// Qorlla AI Review Panel in a real browser against the real stack and PostgreSQL. The answers come from the labelled deterministic TEST ADAPTER
// (run only when E2E_AI_TEST_PROVIDER=1 against the AI test project), so this proves the review workflow and its safety rules, not the quality of any model.
const needsAi = () => test.skip(!process.env.E2E_AI_TEST_PROVIDER, 'needs the AI test project (E2E_AI_TEST_PROVIDER=1)');
const headers = (csrf, ws) => ({ 'x-csrf-token': csrf, origin: BASE, 'x-workspace-id': ws });
async function addMember(ownerCtx, owner, userId) { const r = await ownerCtx.request.post('/api/v1/members', { data: { user_id: String(userId).replace(/^u_/, ''), role: 'member' }, headers: headers(owner.csrf, owner.workspaceId) }); if (r.status() !== 201) throw new Error('add member failed ' + r.status()); }
async function newDoc(page, kind, title) { await page.goto('/app/suite'); await page.selectOption('#doc-form [name=kind]', kind); await page.fill('#doc-form [name=title]', title); await page.getByRole('button', { name: 'Create', exact: true }).click(); await page.waitForURL(/\/app\/suite\?doc=/); return page.url().split('=')[1]; }
const panel = (page) => page.locator('[data-ai-panel]').first();
const versions = (ws, id) => dbq(`SELECT current_version FROM portal.documents WHERE id='${id}' AND workspace_id='${ws}'`);
const source = (id, v) => dbq(`SELECT source FROM portal.document_versions WHERE document_id='${id}' AND version_no=${v}`);

test.describe('Qorlla AI Review Panel', () => {
  test('the panel offers only Qorlla choices, and without a provider it is visibly unavailable', async ({ page, context }) => {
    await signUpWithWorkspace(context, 'panelfirst'); await newDoc(page, 'doc', 'Panel doc');
    const p = panel(page); await expect(p).toContainText('Qorlla AI'); await expect(p).toContainText('Workspace Assistant');
    const text = await p.innerText(); expect(text).not.toMatch(/openai|chatgpt|gemini|grok|xai|anthropic|claude|aria|test adapter/i);
    if (process.env.E2E_AI_TEST_PROVIDER) { await expect(p.locator('[data-ai-generate]')).toBeEnabled(); await expect(p.locator('[data-ai-model] option')).toHaveText(['Qorlla AI (Automatic)', 'Qorlla AI Private (Local only)']); }
    else { await expect(p.locator('[data-ai-generate]')).toBeDisabled(); await expect(p).toContainText('not available on this server'); await expect(p.locator('[data-ai-model] option[disabled]')).toHaveCount(2); }
  });

  test('preview first: a suggestion changes nothing, can be compared, discarded, and only a confirmed Apply creates an AI-labelled version', async ({ page, context }) => {
    needsAi(); const me = await signUpWithWorkspace(context, 'panelflow'); const id = await newDoc(page, 'doc', 'Review me');
    await page.fill('#doc-text', 'The original paragraph about pelicans.'); await page.locator('#save-doc').click(); await expect(page.locator('#doc-version')).toHaveText('version 2');
    const p = panel(page); await p.locator('[data-ai-task]').selectOption('docs_rewrite'); await p.locator('[data-ai-generate]').click();
    await expect(p.locator('[data-ai-title]')).toHaveText('AI-generated suggestion'); await expect(p.locator('[data-ai-saved]')).toHaveText('No changes have been saved.'); await expect(p.locator('[data-ai-suggestion]')).toContainText('TEST-DOUBLE');
    expect(versions(me.workspaceId, id)).toBe('2'); await expect(page.locator('#doc-text')).toHaveValue('The original paragraph about pelicans.');
    await p.locator('[data-ai-diffbtn]').click(); await expect(p.locator('[data-ai-diff] .ai-del')).toContainText('original paragraph'); await expect(p.locator('[data-ai-diff] .ai-add').first()).toContainText('TEST-DOUBLE');
    await p.locator('[data-ai-discard]').click(); await expect(p.locator('[data-ai-suggestion]')).toHaveCount(0); await expect(page.locator('#notice')).toContainText('discarded'); expect(versions(me.workspaceId, id)).toBe('2');
    await p.locator('[data-ai-generate]').click(); await expect(p.locator('[data-ai-suggestion]')).toBeVisible();
    await p.locator('[data-ai-apply]').click(); await expect(p.locator('[role=alertdialog]')).toContainText('version 3'); expect(versions(me.workspaceId, id)).toBe('2');         // asked first: nothing written yet
    await p.locator('[data-ai-cancel]').click(); await expect(p.locator('[role=alertdialog]')).toHaveCount(0); expect(versions(me.workspaceId, id)).toBe('2');
    await p.locator('[data-ai-regen]').click(); await expect(p.locator('[data-ai-suggestion]')).toBeVisible();
    await p.locator('[data-ai-apply]').click(); await p.locator('[data-ai-confirm]').click();
    await expect(page.locator('#doc-version')).toHaveText('version 3'); await expect(page.locator('#doc-text')).toHaveValue(/TEST-DOUBLE/); await expect(page.locator('#notice')).toContainText('Applied');
    expect(versions(me.workspaceId, id)).toBe('3'); expect(source(id, 3)).toBe('ai'); expect(dbq(`SELECT content->>'text' FROM portal.document_versions WHERE document_id='${id}' AND version_no=2`)).toBe('The original paragraph about pelicans.');
    await expect(page.locator('#doc-side')).toContainText('Qorlla AI suggestion applied');
    expect(dbq(`SELECT count(*) FROM portal.audit_events WHERE workspace_id='${me.workspaceId}' AND action='document.ai_applied' AND object_id='${id}'`)).toBe('1');
  });

  test('a document edited elsewhere after the preview is never overwritten: the panel says so, the Apply button goes away, and Regenerate works from the new version', async ({ page, context }) => {
    needsAi(); const me = await signUpWithWorkspace(context, 'panelconflict'); const id = await newDoc(page, 'doc', 'Conflict doc');
    await page.fill('#doc-text', 'Version two text'); await page.locator('#save-doc').click(); await expect(page.locator('#doc-version')).toHaveText('version 2');
    const p = panel(page); await p.locator('[data-ai-generate]').click(); await expect(p.locator('[data-ai-suggestion]')).toBeVisible();
    const tab2 = await context.newPage(); await tab2.goto(page.url()); await tab2.fill('#doc-text', 'A colleague changed this in the meantime'); await tab2.locator('#save-doc').click(); await expect(tab2.locator('#doc-version')).toHaveText('version 3');
    await p.locator('[data-ai-apply]').click(); await p.locator('[data-ai-confirm]').click();
    await expect(page.locator('#notice')).toContainText('changed after this suggestion was made'); await expect(p.locator('[data-ai-stale]')).toBeVisible(); await expect(p.locator('[data-ai-apply]')).toHaveCount(0);
    expect(versions(me.workspaceId, id)).toBe('3'); expect(dbq(`SELECT content->>'text' FROM portal.document_versions WHERE document_id='${id}' AND version_no=3`)).toBe('A colleague changed this in the meantime');
    await page.reload(); await panel(page).locator('[data-ai-generate]').click(); await panel(page).locator('[data-ai-apply]').click(); await expect(panel(page).locator('[role=alertdialog]')).toContainText('version 4');
  });

  test('a viewer can preview but not apply; revoking access after the preview closes the door', async ({ page, browser, context }) => {
    needsAi(); const owner = await signUpWithWorkspace(context, 'panelowner'); const id = await newDoc(page, 'doc', 'Shared doc');
    await page.fill('#doc-text', 'Shared body'); await page.locator('#save-doc').click(); await expect(page.locator('#doc-version')).toHaveText('version 2');
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE }); const p2 = await ctx2.newPage(); const viewer = await signUp(ctx2, 'panelview'); await addMember(context, owner, viewer.user.id);
    await page.reload(); await page.locator('#share-form [data-user]').first().selectOption('viewer'); await page.getByRole('button', { name: 'Save sharing' }).click(); await expect(page.locator('#notice')).toContainText('Sharing updated');
    await p2.goto(page.url()); const pp = panel(p2); await pp.locator('[data-ai-generate]').click(); await expect(pp.locator('[data-ai-suggestion]')).toBeVisible();
    await pp.locator('[data-ai-apply]').click(); await pp.locator('[data-ai-confirm]').click(); await expect(p2.locator('#notice')).toContainText('view this document but not edit'); expect(versions(owner.workspaceId, id)).toBe('2');
    await pp.locator('[data-ai-regen]').click(); await expect(pp.locator('[data-ai-suggestion]')).toBeVisible();
    await page.reload(); await page.locator('#share-form [data-user]').first().selectOption(''); await page.getByRole('button', { name: 'Save sharing' }).click(); await expect(page.locator('#notice')).toContainText('Sharing updated');
    await pp.locator('[data-ai-apply]').click(); await pp.locator('[data-ai-confirm]').click(); await expect(p2.locator('#notice')).toContainText('no longer exists, or you no longer have access'); expect(versions(owner.workspaceId, id)).toBe('2');
    await ctx2.close();
  });

  test('Sheets get advice only (nothing to apply), Slides can add outline slides, and the private model works when a local model exists', async ({ page, context }) => {
    needsAi(); const me = await signUpWithWorkspace(context, 'panelkinds'); const sheet = await newDoc(page, 'sheet', 'Numbers');
    await page.locator('#add-row').click(); await page.locator('[data-cell="0:0"]').fill('Giraffes'); await page.locator('[data-cell="0:1"]').fill('12'); await page.locator('#save-doc').click(); await expect(page.locator('#doc-version')).toHaveText('version 2');
    let p = panel(page); await p.locator('[data-ai-task]').selectOption('sheets_insights'); await p.locator('[data-ai-generate]').click(); await expect(p.locator('[data-ai-suggestion]')).toContainText('TEST-DOUBLE');
    await expect(p.locator('[data-ai-apply]')).toHaveCount(0); await expect(p.locator('[data-ai-copy]')).toBeVisible(); await expect(p).toContainText('advice, not an edit'); expect(versions(me.workspaceId, sheet)).toBe('2');
    const deck = await newDoc(page, 'slides', 'Deck'); p = panel(page); await p.locator('[data-ai-task]').selectOption('slides_outline'); await p.locator('[data-ai-model]').selectOption('qorlla-ai-private'); await p.locator('[data-ai-generate]').click();
    await expect(p.locator('[data-ai-suggestion]')).toContainText('TEST-DOUBLE'); await p.locator('[data-ai-apply]').click(); await p.locator('[data-ai-confirm]').click(); await expect(page.locator('#doc-version')).toHaveText('version 2');
    expect(dbq(`SELECT jsonb_array_length(content->'slides') FROM portal.document_versions WHERE document_id='${deck}' AND version_no=2`)).toBe('2'); expect(source(deck, 2)).toBe('ai');
  });

  test('a drafted new document appears only after confirmation, and QorllaMate answers as a preview without creating anything', async ({ page, context }) => {
    needsAi(); const me = await signUpWithWorkspace(context, 'panellist'); await page.goto('/app/suite'); const p = page.locator('#draft-ai-host [data-ai-panel]');
    const docs = () => dbq(`SELECT count(*) FROM portal.documents WHERE workspace_id='${me.workspaceId}'`);
    await p.locator('[data-ai-text]').fill('A one page brief about the pelican launch'); await p.locator('[data-ai-generate]').click(); await expect(p.locator('[data-ai-suggestion]')).toContainText('TEST-DOUBLE'); expect(docs()).toBe('0');
    await p.locator('[data-ai-apply]').click(); await expect(p.locator('[role=alertdialog]')).toContainText('new private document'); expect(docs()).toBe('0');
    await p.locator('[data-ai-confirm]').click(); await page.waitForURL(/\/app\/suite\?doc=/); await expect(page.locator('#doc-text')).toHaveValue(/TEST-DOUBLE/); expect(docs()).toBe('1');
    expect(dbq(`SELECT d.title FROM portal.documents d WHERE d.workspace_id='${me.workspaceId}'`)).toContain('A one page brief');
    await page.goto('/app/mate'); const m = page.locator('#mate-ai-host [data-ai-panel]'); await m.locator('[data-ai-text]').fill('Please create a note titled "Panel note" saying "hello"'); await m.locator('[data-ai-generate]').click();
    await expect(m.locator('[data-ai-suggestion]')).toContainText('TEST-DOUBLE REPLY'); await expect(m).toContainText('nothing was created'); await expect(m.locator('[data-ai-apply]')).toHaveCount(0);
    expect(dbq(`SELECT count(*) FROM portal.notes WHERE workspace_id='${me.workspaceId}'`)).toBe('0'); expect(dbq(`SELECT count(*) FROM portal.assistant_tasks WHERE workspace_id='${me.workspaceId}'`)).toBe('0');
  });

  test('citations in the panel: only verified sources are shown, opening one shows the real passage, and once access is withdrawn the same button refuses with the reason', async ({ page, browser, context }) => {
    needsAi(); const owner = await signUpWithWorkspace(context, 'panelcite'); const id = await newDoc(page, 'doc', 'Cited doc');
    await page.fill('#doc-text', 'The pelican launch is planned for Monday morning.\nBudget approved by the board.'); await page.locator('#save-doc').click(); await expect(page.locator('#doc-version')).toHaveText('version 2');
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE }); const p2 = await ctx2.newPage(); const viewer = await signUp(ctx2, 'panelciteview'); await addMember(context, owner, viewer.user.id);
    await page.reload(); await page.locator('#share-form [data-user]').first().selectOption('viewer'); await page.getByRole('button', { name: 'Save sharing' }).click(); await expect(page.locator('#notice')).toContainText('Sharing updated');
    await p2.goto(page.url()); const pp = panel(p2); await pp.locator('[data-ai-task]').selectOption('docs_summarize'); await pp.locator('[data-ai-instr]').fill('FABRICATE sources'); await pp.locator('[data-ai-generate]').click();
    await expect(pp.locator('[data-ai-sources] .cite')).toHaveCount(1); await expect(pp.locator('[data-ai-dropped]')).toContainText('3 references could not be verified and were left out');
    expect(await pp.innerText()).not.toMatch(/nowhere in the source|ZZ99/);
    await pp.locator('[data-ai-sources] .cite').click(); await expect(p2.locator('[data-cite-passage]')).toContainText('The pelican launch'); await expect(p2.locator('[data-cite-meta]')).toContainText('version 2');
    await page.reload(); await page.locator('#share-form [data-user]').first().selectOption(''); await page.getByRole('button', { name: 'Save sharing' }).click(); await expect(page.locator('#notice')).toContainText('Sharing updated');
    await pp.locator('[data-ai-sources] .cite').click(); await expect(p2.locator('[data-cite-refused]')).toContainText('no longer have access'); await expect(p2.locator('[data-cite-passage]')).toHaveCount(0);
    await ctx2.close();
  });

  test('QorllaMate preview names the sources it really used, and a source is re-checked when opened', async ({ page, context }) => {
    needsAi(); const me = await signUpWithWorkspace(context, 'panelmate'); const csrf = (await context.cookies()).find((c) => c.name === 'qorlla_csrf').value; const h = headers(csrf, me.workspaceId);
    const note = await (await context.request.post('/api/v1/notes', { data: { title: 'Okapi roadmap', body: 'okapi budget details for the quarter' }, headers: h })).json();
    await page.goto('/app/mate'); const m = page.locator('#mate-ai-host [data-ai-panel]'); await m.locator('[data-ai-text]').fill('what is the okapi budget'); await m.locator('[data-ai-generate]').click();
    await expect(m.locator('[data-ai-sources] .cite')).toContainText('Okapi roadmap'); await m.locator('[data-ai-sources] .cite').click(); await expect(page.locator('[data-cite-passage]')).toContainText('okapi budget details');
    expect((await context.request.delete('/api/v1/notes/' + note.id, { headers: h })).status()).toBeLessThan(300); await m.locator('[data-ai-sources] .cite').click(); await expect(page.locator('[data-cite-refused]')).toContainText('was deleted');
  });

  test('keyboard and screen-reader basics: labelled controls, a live region, focus moves to the result, and the confirmation is an alert dialog', async ({ page, context }) => {
    needsAi(); await signUpWithWorkspace(context, 'panela11y'); await newDoc(page, 'doc', 'A11y doc'); await page.fill('#doc-text', 'Some words'); await page.locator('#save-doc').click(); await expect(page.locator('#doc-version')).toHaveText('version 2');
    const p = panel(page); await expect(p).toHaveAttribute('aria-labelledby', /doc-ai-h/); await expect(p.locator('[data-ai-preview]')).toHaveAttribute('aria-live', 'polite');
    await p.locator('[data-ai-generate]').focus(); await page.keyboard.press('Enter'); await expect(p.locator('[data-ai-title]')).toBeFocused();
    await p.locator('[data-ai-apply]').focus(); await page.keyboard.press('Enter'); await expect(p.locator('[role=alertdialog]')).toHaveAttribute('aria-labelledby', /doc-ai-c/);
  });
});
