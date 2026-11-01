const { test, expect } = require('@playwright/test');
const { BASE, dbq, signUpWithWorkspace } = require('./helpers');

// Sheets and Slides, certified WITHOUT any AI provider: create, edit, save a new version, reload, and read the saved content back from PostgreSQL.
// These were bundled inside the AI test in workspace.spec.js; they are separate here so they pass or fail on their own merits.
// Also proves the other side of the AI rule: with no provider configured the AI actions stay disabled and the API refuses with a stated reason; nothing is created or counted.
test.describe('sheets, slides and the AI switch, with no AI provider', () => {
  test('a sheet is created, edited, saved as version 2, survives a reload and is stored in PostgreSQL', async ({ page, context }) => {
    const me = await signUpWithWorkspace(context, 'sheetuser');
    await page.goto('/app/suite'); await page.selectOption('#doc-form [name=kind]', 'sheet'); await page.fill('#doc-form [name=title]', 'Stock'); await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/\/app\/suite\?doc=/); await page.locator('#add-row').click(); await page.locator('[data-cell="0:0"]').fill('Giraffes'); await page.locator('[data-cell="0:1"]').fill('12'); await page.locator('#save-doc').click(); await expect(page.locator('#doc-version')).toHaveText('version 2');
    await page.reload(); await expect(page.locator('[data-cell="0:0"]')).toHaveValue('Giraffes'); await expect(page.locator('[data-cell="0:1"]')).toHaveValue('12');
    expect(dbq(`SELECT content->'rows'->0->>1 FROM portal.document_versions v JOIN portal.documents d ON d.id=v.document_id WHERE d.title='Stock' AND d.workspace_id='${me.workspaceId}' AND version_no=2`)).toBe('12');
  });
  test('a slide deck is created, edited, saved as version 2, survives a reload and is stored in PostgreSQL', async ({ page, context }) => {
    const me = await signUpWithWorkspace(context, 'slideuser');
    await page.goto('/app/suite'); await page.selectOption('#doc-form [name=kind]', 'slides'); await page.fill('#doc-form [name=title]', 'Pitch'); await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/\/app\/suite\?doc=/); await page.locator('[data-slide="0"] [data-f=title]').fill('Why now'); await page.locator('[data-slide="0"] [data-f=bullets]').fill('Market\nTiming'); await page.locator('#save-doc').click(); await expect(page.locator('#doc-version')).toHaveText('version 2');
    await page.reload(); await expect(page.locator('[data-slide="0"] [data-f=title]')).toHaveValue('Why now'); await expect(page.locator('[data-slide="0"] [data-f=bullets]')).toHaveValue('Market\nTiming');
    expect(dbq(`SELECT content->'slides'->0->>'title' FROM portal.document_versions v JOIN portal.documents d ON d.id=v.document_id WHERE d.title='Pitch' AND d.workspace_id='${me.workspaceId}' AND version_no=2`)).toBe('Why now');
  });
  test('no AI provider: Draft and QorllaMate are disabled in the page, the API refuses with a reason, and nothing is created or counted', async ({ page, context }) => {
    const me = await signUpWithWorkspace(context, 'noaiuser');
    await page.goto('/app/suite'); await page.selectOption('#ai-form [name=kind]', 'doc'); await page.fill('#ai-form [name=prompt]', 'A brief about the pelican launch'); await expect(page.getByRole('button', { name: 'Draft', exact: true })).toBeDisabled();
    await page.goto('/app/mate'); await page.locator('#new-thread').click().catch(() => {}); await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    const csrf = (await context.cookies()).find((c) => c.name === 'qorlla_csrf').value, h = { origin: BASE, 'x-csrf-token': csrf, 'x-workspace-id': me.workspaceId };
    const r = await context.request.post('/api/v1/documents/ai-draft', { data: { kind: 'doc', prompt: 'A brief about the pelican launch', idempotency_key: 'noai-' + Date.now() }, headers: h });
    expect([402, 403, 409, 501, 503]).toContain(r.status()); const body = await r.json().catch(() => ({})); expect(JSON.stringify(body)).toMatch(/AI|provider|configured|unavailable|blocked|disabled/i);
    expect(dbq(`SELECT count(*) FROM portal.documents WHERE workspace_id='${me.workspaceId}' AND title ILIKE '%pelican%'`)).toBe('0');
    expect(dbq(`SELECT count(*) FROM portal.ai_usage_events WHERE workspace_id='${me.workspaceId}'`)).toBe('0');
  });
});
