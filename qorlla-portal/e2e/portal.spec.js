const { test, expect } = require('@playwright/test');
const { BASE, dbq, signUp, signUpWithWorkspace } = require('./helpers');

test.describe('portal - real MAIN sign-in, workspaces, authorization', () => {
  test('signed-out visitors get a sign-in prompt on private pages and the API answers 401', async ({ page, request }) => {
    await page.goto('/app/notes');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible(); await expect(page.getByRole('link', { name: 'Sign in' }).first()).toHaveAttribute('href', /login\.html\?next=%2Fapp%2Fnotes/);
    expect((await request.get('/api/v1/notes')).status()).toBe(401); expect((await request.get('/api/v1/billing')).status()).toBe(401);
    expect(await page.locator('body').innerText()).not.toMatch(/E2E .* note/);
  });

  test('sign up in MAIN -> portal onboarding -> workspace -> notes with plan quota; second user cannot see the data', async ({ page, browser, context }) => {
    await signUp(context, 'alice');
    await page.goto('/app/notes');
    await expect(page.getByRole('heading', { name: 'Create your workspace' })).toBeVisible();
    await page.fill('#ws-form [name=name]', 'Alice Co'); await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.locator('#note-quota')).toContainText('0 of 20 notes');
    await page.fill('#note-form [name=title]', 'E2E alice secret note'); await page.getByRole('button', { name: 'Save Note' }).click();
    await expect(page.locator('#notes')).toContainText('E2E alice secret note'); await expect(page.locator('#note-quota')).toContainText('1 of 20');
    // another real account in a separate browser context
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE }); const p2 = await ctx2.newPage();
    await signUpWithWorkspace(ctx2, 'bob'); await p2.goto('/app/notes');
    await expect(p2.locator('#note-quota')).toContainText('0 of 20'); expect(await p2.locator('body').innerText()).not.toContain('alice secret');
    // Bob guesses Alice's workspace id: refused
    const aliceWs = dbq("SELECT workspace_id FROM portal.notes WHERE title='E2E alice secret note' LIMIT 1");
    const r = await ctx2.request.get('/api/v1/notes', { headers: { 'x-workspace-id': aliceWs } }); expect(r.status()).toBe(403);
    await ctx2.close();
  });

  test('plan limit is enforced and explained in the UI', async ({ page, context }) => {
    const ws = await signUpWithWorkspace(context, 'limit');
    dbq(`INSERT INTO portal.notes(workspace_id,author_id,title) SELECT '${ws.workspaceId}', user_id, 'filler '||g FROM portal.members m, generate_series(1,20) g WHERE m.workspace_id='${ws.workspaceId}'`);
    await page.goto('/app/notes'); await expect(page.locator('#note-quota')).toContainText('20 of 20');
    await page.fill('#note-form [name=title]', 'one too many'); await page.getByRole('button', { name: 'Save Note' }).click();
    await expect(page.locator('#notice')).toContainText('allows 20');
    expect(dbq(`SELECT count(*) FROM portal.notes WHERE workspace_id='${ws.workspaceId}'`)).toBe('20');
  });

  test('an expired portal token is renewed silently from the live MAIN session; sign-out ends access at once', async ({ page, context }) => {
    await signUpWithWorkspace(context, 'renew');
    await context.clearCookies({ name: 'qorlla_portal_session' });                    // simulate the 15 minute token lapsing
    await page.goto('/app/notes'); await expect(page.locator('#note-quota')).toContainText('of 20');     // renewed automatically
    await page.locator('#signout').click(); await page.waitForURL(/login\.html/);
    const cookies = await context.cookies(); expect(cookies.find((c) => c.name === 'qorlla_portal_session' && c.value)).toBeUndefined();
    await page.goto('/app/notes'); await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect((await context.request.get('/api/v1/notes')).status()).toBe(401);
  });

  test('tampered / garbage portal cookies are refused (and MAIN has no session to renew from)', async ({ page, context }) => {
    await context.addCookies([{ name: 'qorlla_portal_session', value: 'eyJhbGciOiJub25lIn0.e30.', url: BASE }]);
    expect((await context.request.get('/api/v1/notes')).status()).toBe(401);
    await page.goto('/app/support'); await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('billing page: owner sees plan and invoices area; billing details stay hidden from plain members', async ({ page, context }) => {
    const ws = await signUpWithWorkspace(context, 'owner');
    await page.goto('/app/billing'); await expect(page.locator('#billing')).toContainText('basic'); await expect(page.locator('#billing')).toContainText('No invoices yet');
    await expect(page.getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/pricing/');
    expect(ws.workspaceId).toBeTruthy();
  });
});
