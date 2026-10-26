const { test, expect } = require('@playwright/test');
const { BASE, dbq, fakeJson, signUp, signUpWithWorkspace, providerPays } = require('./helpers');

// Payment provider = tests/fake-stripe.mjs (TEST DOUBLE) running beside the unified stack. These tests prove our UI, authorization and
// state handling end to end in a real browser against real PostgreSQL. They do NOT prove that a real Stripe account accepts the calls.
async function paidWorkspace(context, label, { plan = 'pro', interval = 'month', seats = 1 } = {}) {
  const ws = await signUpWithWorkspace(context, label);
  const r = await context.request.post('/api/v1/billing/checkout', { data: { plan, interval, seats }, headers: { 'x-csrf-token': ws.csrf, origin: BASE, 'x-workspace-id': ws.workspaceId } });
  if (r.status() !== 201) throw new Error('checkout failed ' + r.status() + ' ' + (await r.text()));
  const body = await r.json(); const unit = body.unit_amount_cents;
  const reqs = await fakeJson('/__control/requests'); const create = reqs.filter((x) => x.path === '/v1/checkout/sessions').at(-1); const checkoutId = create.form['metadata[checkout_id]'];
  const paid = await providerPays({ checkoutId, workspaceId: ws.workspaceId, unitAmount: unit, interval, quantity: seats }); if (paid.status !== 200) throw new Error('webhook failed ' + paid.status);
  return { ...ws, unit };
}
const adminLogin = async (context) => {
  const r = await context.request.post('/api/auth/login', { data: { username: process.env.E2E_ADMIN_USER, password: process.env.E2E_ADMIN_PASS } });
  if (!r.ok()) throw new Error('admin login failed ' + r.status());
  return (await context.cookies()).find((c) => c.name === 'qorlla_csrf').value;
};

test.describe('plan changes, usage and the platform console', () => {
  test('upgrade now, schedule a downgrade, cancel it; usage panel says no pay-as-you-go prices exist', async ({ page, context }) => {
    const ws = await paidWorkspace(context, 'changer');
    await page.goto('/app/billing');
    await expect(page.locator('#plan-change')).toContainText('Change plan');
    await expect(page.locator('#usage-panel')).toContainText('Pay-as-you-go prices have not been published');
    // preview then upgrade to Business: effective immediately, proration shown as an estimate
    await page.selectOption('#change-form [name=plan]', 'business'); await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.locator('#change-preview')).toContainText('Upgrade'); await expect(page.locator('#change-preview')).toContainText('takes effect now'); await expect(page.locator('#change-preview')).toContainText('provider calculates the final amount');
    page.once('dialog', (d) => d.accept()); await page.getByRole('button', { name: 'Change plan', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('Your plan has been updated');
    await expect(page.locator('body')).toContainText('business'); expect(dbq(`SELECT plan_slug FROM portal.workspace_effective_plan WHERE workspace_id='${ws.workspaceId}'`)).toBe('business');
    expect(dbq(`SELECT status FROM portal.plan_changes WHERE workspace_id='${ws.workspaceId}' ORDER BY created_at DESC LIMIT 1`)).toBe('applied');
    // downgrade is scheduled, not applied
    await page.selectOption('#change-form [name=plan]', 'pro'); page.once('dialog', (d) => d.accept()); await page.getByRole('button', { name: 'Change plan', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('scheduled for the end of the current period'); await expect(page.locator('#pending-change')).toContainText('scheduled');
    expect(dbq(`SELECT plan_slug FROM portal.workspace_effective_plan WHERE workspace_id='${ws.workspaceId}'`)).toBe('business');
    await page.locator('#cancel-change').click(); await expect(page.locator('#notice')).toContainText('Scheduled change cancelled'); await expect(page.locator('#pending-change')).toHaveCount(0);
    expect(dbq(`SELECT status FROM portal.plan_changes WHERE workspace_id='${ws.workspaceId}' ORDER BY created_at DESC LIMIT 1`)).toBe('cancelled');
  });

  test('the platform console is invisible to ordinary users and works for the configured admin: overview, health, refund, sales workflow, kill switch', async ({ page, browser, context }) => {
    // ordinary user: no menu entry, page says not found, API answers 404
    await signUpWithWorkspace(context, 'ordinary'); await page.goto('/app/admin'); await expect(page.locator('#admin-root')).toContainText('Not found'); await expect(page.locator('#side')).not.toContainText('Platform admin');
    expect((await context.request.get('/api/v1/admin/billing/overview')).status()).toBe(404);

    // a customer pays; a visitor sends an Enterprise inquiry
    const customerCtx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE }); const customer = await paidWorkspace(customerCtx, 'payer', { plan: 'pro', interval: 'month', seats: 2 });
    const lead = await fetch(BASE + '/api/v1/sales-inquiries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Grace Hopper', email: 'grace@navy.example.test', company: 'Compilers Inc', message: 'Enterprise SSO for 900 seats - platform e2e', plan_interest: 'enterprise' }) }); expect(lead.status).toBeLessThan(300);

    const adminCtx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE }); const ap = await adminCtx.newPage(); const csrf = await adminLogin(adminCtx);
    await ap.goto('/app/admin'); await expect(ap.locator('#side')).toContainText('Platform admin'); await expect(ap.locator('#adm-mrr')).toContainText('$');
    await ap.goto('/app/admin?tab=health'); await expect(ap.getByRole('heading', { name: /Status:/ })).toBeVisible();

    // refund part of the customer's invoice
    await ap.goto('/app/admin?tab=invoices'); const row = ap.locator('tr[data-invoice]').filter({ hasText: 'paid' }).first(); await expect(row).toBeVisible();
    const inv = dbq(`SELECT id FROM portal.invoices WHERE workspace_id='${customer.workspaceId}' LIMIT 1`);
    await ap.locator(`tr[data-invoice="${inv}"] [data-act=refund]`).click(); await ap.fill('#refund-form [name=amount]', '500'); await ap.fill('#refund-form [name=reason]', 'goodwill credit (e2e)'); await ap.getByRole('button', { name: 'Refund', exact: true }).click();
    await expect(ap.locator('#notice')).toContainText('Refund issued');
    expect(dbq(`SELECT amount_refunded_cents||'/'||status FROM portal.invoices WHERE id='${inv}'`)).toBe('500/partially_refunded');
    expect(dbq(`SELECT count(*) FROM portal.platform_audit WHERE action='billing.refund' AND object_id='${inv}'`)).toBe('1');

    // sales workflow
    await ap.goto('/app/admin?tab=sales'); const leadRow = ap.locator('tr[data-lead]').filter({ hasText: 'Grace Hopper' }).first(); await expect(leadRow).toContainText('new'); await leadRow.getByRole('link', { name: /Open/ }).click();
    await ap.getByRole('button', { name: 'Mark contacted' }).click(); await expect(ap.locator('#lead-detail .pill.contacted')).toBeVisible(); await ap.fill('#note-add [name=note]', 'Called - demo booked'); await ap.getByRole('button', { name: 'Add', exact: true }).click(); await expect(ap.locator('#lead-detail')).toContainText('demo booked');
    expect(dbq(`SELECT status FROM portal.sales_inquiries WHERE email='grace@navy.example.test' ORDER BY created_at DESC LIMIT 1`)).toBe('contacted');

    // kill switch: checkout off -> customers get a clear refusal; back on -> works
    await ap.goto('/app/admin?tab=switches'); ap.once('dialog', (d) => d.accept('e2e: simulated provider incident'));
    await ap.locator('tr[data-flag="checkout"]').getByRole('button', { name: /Turn off/ }).click(); await expect(ap.locator('tr[data-flag="checkout"]')).toContainText('OFF');
    const fresh = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE }); const f = await signUpWithWorkspace(fresh, 'blocked');
    const off = await fresh.request.post('/api/v1/billing/checkout', { data: { plan: 'pro', interval: 'month', seats: 1 }, headers: { 'x-csrf-token': f.csrf, origin: BASE, 'x-workspace-id': f.workspaceId } });
    expect(off.status()).toBe(503); expect((await off.json()).code).toBe('feature_disabled');
    await ap.locator('tr[data-flag="checkout"]').getByRole('button', { name: 'Turn on' }).click(); await expect(ap.locator('tr[data-flag="checkout"]')).not.toContainText('OFF');
    const on = await fresh.request.post('/api/v1/billing/checkout', { data: { plan: 'pro', interval: 'month', seats: 1 }, headers: { 'x-csrf-token': f.csrf, origin: BASE, 'x-workspace-id': f.workspaceId } }); expect(on.status()).toBe(201);
    expect(csrf).toBeTruthy(); await fresh.close(); await adminCtx.close(); await customerCtx.close();
  });
});
