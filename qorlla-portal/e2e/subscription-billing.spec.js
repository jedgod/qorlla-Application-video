const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const { BASE, dbq, fakeJson, signUpWithWorkspace, signUp, providerPays } = require('./helpers');

// SBACS browser certification, against the isolated "qsbacs" project (see deploy/docker-compose.isolated-sbacs.yml): a real browser, the real nginx + MAIN + portal + PostgreSQL,
// and the Stripe TEST DOUBLE as the only provider. Never point this at qiso, qtls, qclk or a production-default environment.
//   E2E_BASE=http://localhost:4100 E2E_DB_CONTAINER=qsbacs-main-db-1 E2E_FAKE_STRIPE_URL=http://127.0.0.1:19501
const ORIGIN = new URL(BASE).origin;
const setFlag = async (on) => { dbq(`UPDATE portal.platform_flags SET enabled=${on ? 'true' : 'false'} WHERE key='billing_live'`); await new Promise((r) => setTimeout(r, 3600)); };   // flags are cached for 3 s
const setPlan = (ws, plan, status = 'active') => dbq(`UPDATE portal.subscriptions SET plan_slug='${plan}', status='${status}', billing_interval='month', current_period_end=now()+interval '20 days' WHERE workspace_id='${ws}'`);
const sub = (ws, col) => dbq(`SELECT ${col} FROM portal.subscriptions WHERE workspace_id='${ws}'`);
const feature = (page, key) => page.locator(`[data-feature="${key}"]`);
async function newOwner(browser, label) {
  const ctx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true }); const ws = await signUpWithWorkspace(ctx, label); const page = await ctx.newPage(); page.on('dialog', (d) => d.accept());
  return { ctx, page, ws, id: ws.workspaceId, csrf: ws.csrf };
}
const api = (o, method, path, data) => o.ctx.request.fetch('/api/v1' + path, { method, data, headers: { 'x-csrf-token': o.csrf, origin: ORIGIN, 'x-workspace-id': o.id } });
const open = async (o) => { await o.page.goto('/app/billing'); await o.page.waitForSelector('#subscription .panel', { timeout: 30000 }); await o.page.waitForLoadState('networkidle'); };

test.describe('Settings -> Subscription & Billing (isolated SBACS stack)', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async () => { expect(dbq("SELECT to_regclass('portal.entitlement_events') IS NOT NULL")).toBe('t'); });   // the stack really runs SBACS (migrations 012-014)

  test('navigation and rendering: the sidebar link, title and heading say Subscription & Billing; the page loads without console errors', async ({ browser }) => {
    await setFlag(false);
    const o = await newOwner(browser, 'nav'); const errors = []; o.page.on('pageerror', (e) => errors.push(e.message));
    await o.page.goto('/app/products'); await o.page.getByRole('link', { name: /Subscription & Billing/ }).click(); await o.page.waitForSelector('#subscription .panel');
    await expect(o.page).toHaveURL(/\/app\/billing$/); await expect(o.page).toHaveTitle(/Subscription & Billing/); await expect(o.page.getByRole('heading', { name: 'Subscription & Billing' })).toBeVisible();
    await expect(o.page.locator('#billing')).toContainText('No invoices yet');                                                              // empty state
    await expect(o.page.locator('#billing')).toContainText('basic'); expect(errors).toEqual([]); await o.ctx.close();
  });

  test('every plan displays and the current plan is identified: Free, Professional, Business and Enterprise are listed; Starter is not offered; a Starter workspace still renders', async ({ browser }) => {
    for (const [slug, label] of [['basic', 'Basic'], ['pro', 'Pro'], ['business', 'Business'], ['enterprise', 'Enterprise']]) {
      const o = await newOwner(browser, 'pl' + slug); if (slug !== 'basic') setPlan(o.id, slug); await open(o);
      await expect(o.page.locator('[data-plan]')).toHaveCount(4); await expect(o.page.locator('[data-plan="starter"]')).toHaveCount(0);
      for (const s of ['basic', 'pro', 'business', 'enterprise']) await expect(o.page.locator(`[data-plan="${s}"]`)).toBeVisible();
      await expect(o.page.locator(`[data-plan="${slug}"]`)).toContainText('Current plan'); await expect(o.page.locator('[data-plan] :text("Current plan")')).toHaveCount(1);
      await expect(o.page.locator('#billing')).not.toContainText(/\$\s?\d/);                                                                  // no prices are published by this page
      if (slug === 'enterprise') { await expect(feature(o.page, 'org.sso')).toHaveAttribute('data-state', 'enabled'); } if (slug === 'basic') { await expect(feature(o.page, 'org.sso')).toHaveAttribute('data-state', 'restricted'); }
      await o.ctx.close();
    }
    const st = await newOwner(browser, 'plstarter'); setPlan(st.id, 'starter'); const errors = []; st.page.on('pageerror', (e) => errors.push(e.message)); await open(st);
    await expect(st.page.locator('[data-plan]')).toHaveCount(4); await expect(st.page.locator('[data-plan="starter"]')).toHaveCount(0); expect(errors).toEqual([]); await st.ctx.close();
  });

  test('entitlement and usage displays: included / not in your plan / not available are distinct, hard-disabled features never get an Upgrade, usage counts real use, provisional limits are not shown', async ({ browser }) => {
    await setFlag(true);
    const o = await newOwner(browser, 'ent'); expect((await api(o, 'POST', '/documents', { kind: 'doc', title: 'one' })).status()).toBe(201);
    await open(o);
    await expect(feature(o.page, 'docs.history.read')).toHaveAttribute('data-state', 'enabled'); await expect(feature(o.page, 'docs.history.restore')).toHaveAttribute('data-state', 'restricted');
    await expect(feature(o.page, 'phone.pstn')).toHaveAttribute('data-state', 'unavailable'); await expect(feature(o.page, 'phone.pstn')).toContainText('Not available');
    await expect(feature(o.page, 'phone.pstn').locator('button')).toHaveCount(0); await expect(feature(o.page, 'docs.history.restore').locator('button[data-upgrade]')).toHaveCount(1);
    await expect(feature(o.page, 'docs.history.read').locator('button')).toHaveCount(0);
    const used = o.page.locator('[data-usage-feature="docs.create"]'); await expect(used).toContainText('1'); await expect(used).toContainText('No limit applied');
    await o.ctx.close();
  });

  test('payment-method management is unavailable (no button) while billing is disabled, for owners as well as members; the API refuses', async ({ browser }) => {
    await setFlag(false);
    const o = await newOwner(browser, 'off'); await open(o);
    await expect(o.page.locator('#billing-off')).toContainText('checkout and payment management are unavailable'); await expect(o.page.locator('#pm-unavailable')).toContainText('Payment management unavailable');
    await expect(o.page.locator('#manage-payment')).toHaveCount(0); await expect(o.page.locator('[data-choose], button[data-upgrade], #resume')).toHaveCount(0);
    for (const p of ['/subscriptions/payment-methods', '/subscriptions/checkout']) { const r = await api(o, 'POST', p, { plan: 'pro', interval: 'month', seats: 1 }); expect(r.status(), p).toBe(503); expect((await r.json()).flag).toBe('billing_live'); }
    await o.ctx.close();
  });

  test('upgrade: Choose plan creates a server-side checkout and sends the browser to the provider; the redirect alone changes nothing; the verified webhook does', async ({ browser }) => {
    await setFlag(true);
    const o = await newOwner(browser, 'up'); await open(o);
    await expect(o.page.locator('[data-choose="pro"]')).toBeVisible(); await expect(o.page.locator('[data-plan="enterprise"] [data-choose]')).toHaveCount(0);
    await o.page.route('https://checkout.stripe.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html><body id="provider">provider checkout (test double)</body></html>' }));
    await Promise.all([o.page.waitForURL(/checkout\.stripe\.test\/pay\//), o.page.locator('[data-choose="pro"]').click()]);
    expect(sub(o.id, 'plan_slug')).toBe('basic'); await open(o); await expect(o.page.locator('[data-plan="basic"]')).toContainText('Current plan');   // back from the provider with nothing confirmed: still Free
    const reqs = await fakeJson('/__control/requests'); const create = reqs.filter((x) => x.path === '/v1/checkout/sessions').at(-1); const checkoutId = create.form['metadata[checkout_id]'];
    const paid = await providerPays({ checkoutId, workspaceId: o.id, unitAmount: Number(create.form['line_items[0][price_data][unit_amount]']), interval: 'month', quantity: 1 }); expect(paid.status).toBe(200);
    await open(o); await expect(o.page.locator('[data-plan="pro"]')).toContainText('Current plan'); await expect(feature(o.page, 'meet.recording')).toHaveAttribute('data-state', 'enabled');
    await expect(o.page.locator('#subscription')).toContainText('Renews'); await expect(o.page.locator('#billing')).toContainText('Invoices & receipts');
    await expect(o.page.locator('#billing section.panel', { has: o.page.getByRole('heading', { name: 'Invoices & receipts' }) }).locator('table')).toContainText('paid');                                                                  // the invoice from the verified event
    await o.ctx.close();
  });

  test('downgrade and cancellation: cancel keeps the plan until the period ends, resume undoes it, the end of the period returns to Free and every document survives', async ({ browser }) => {
    await setFlag(true);
    const o = await newOwner(browser, 'down'); await open(o);
    await o.page.route('https://checkout.stripe.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' }));
    await Promise.all([o.page.waitForURL(/checkout\.stripe\.test/), o.page.locator('[data-choose="pro"]').click()]);
    const create = (await fakeJson('/__control/requests')).filter((x) => x.path === '/v1/checkout/sessions').at(-1);
    await providerPays({ checkoutId: create.form['metadata[checkout_id]'], workspaceId: o.id, unitAmount: Number(create.form['line_items[0][price_data][unit_amount]']), interval: 'month', quantity: 1 });
    const doc = await (await api(o, 'POST', '/documents', { kind: 'doc', title: 'Keep me' })).json();
    await open(o); await o.page.locator('#cancel').click(); await expect(o.page.locator('#notice')).toContainText('Cancellation requested'); await o.page.waitForSelector('#subscription .panel');
    await expect(o.page.locator('#subscription')).toContainText('Cancels on'); await expect(o.page.locator('[data-plan="pro"]')).toContainText('Current plan');
    await o.page.getByRole('button', { name: 'Keep my subscription' }).click(); await expect(o.page.locator('#subscription')).not.toContainText('Cancels on'); expect(sub(o.id, 'cancel_at_period_end')).toBe('f');
    await o.page.locator('#cancel').click(); await expect(o.page.locator('#subscription')).toContainText('Cancels on');
    dbq(`UPDATE portal.subscriptions SET status='canceled' WHERE workspace_id='${o.id}'`);                                                   // what the verified end-of-period event leaves behind
    await open(o); await expect(o.page.locator('[data-plan="basic"]')).toContainText('Current plan'); await expect(feature(o.page, 'meet.recording')).toHaveAttribute('data-state', 'restricted');
    expect((await api(o, 'GET', `/documents/${doc.id}`)).status()).toBe(200); expect((await api(o, 'GET', `/documents/${doc.id}/versions`)).status()).toBe(200);
    expect((await api(o, 'POST', `/documents/${doc.id}/restore`, { version_no: 1, base_version: 1 })).status()).toBe(403);
    expect(Number(dbq(`SELECT count(*) FROM portal.entitlement_events WHERE workspace_id='${o.id}' AND kind LIKE 'subscription.%'`))).toBeGreaterThanOrEqual(4);   // audited by the database
    await o.ctx.close();
  });

  test('owner versus ordinary member: the owner and a billing contact may manage payment methods; a plain member sees the plan but no actions and is refused by the API', async ({ browser }) => {
    await setFlag(true);
    const o = await newOwner(browser, 'own'); await o.page.route('https://checkout.stripe.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' })); await open(o);
    await Promise.all([o.page.waitForURL(/checkout\.stripe\.test/), o.page.locator('[data-choose="pro"]').click()]);
    const create = (await fakeJson('/__control/requests')).filter((x) => x.path === '/v1/checkout/sessions').at(-1);
    await providerPays({ checkoutId: create.form['metadata[checkout_id]'], workspaceId: o.id, unitAmount: Number(create.form['line_items[0][price_data][unit_amount]']), interval: 'month', quantity: 1 });
    const mk = async (label, role) => { const ctx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true }); const me = await signUp(ctx, label); dbq(`INSERT INTO portal.members(workspace_id,user_id,role) VALUES('${o.id}','${String(me.user.id).replace(/^u_/, '')}','${role}')`); const page = await ctx.newPage(); page.on('dialog', (d) => d.accept()); const cookies = await ctx.cookies(); return { ctx, page, id: o.id, csrf: cookies.find((c) => c.name === 'qorlla_csrf').value }; };
    await open(o); await expect(o.page.locator('#manage-payment')).toHaveCount(1); await expect(o.page.locator('[data-feature="meet.recording"][data-state="enabled"]')).toHaveCount(1);
    const billing = await mk('bill', 'billing'); await open(billing); await expect(billing.page.locator('#manage-payment')).toHaveCount(1);
    const member = await mk('mem', 'member'); await open(member);
    await expect(member.page.locator('#manage-payment')).toHaveCount(0); await expect(member.page.locator('#pm-unavailable')).toContainText('unavailable to you'); await expect(member.page.locator('button[data-upgrade], [data-choose], #resume, #cancel')).toHaveCount(0);
    await expect(member.page.locator('[data-plan="pro"]')).toContainText('Current plan');
    for (const p of ['/subscriptions/payment-methods', '/subscriptions/cancel', '/subscriptions/resume']) expect((await api(member, 'POST', p, {})).status(), p).toBe(403);
    // the owner is sent to the hosted portal and brought back to a page that re-reads billing from the backend
    await o.page.route('https://billing.stripe.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>provider portal (test double)</body></html>' }));
    await Promise.all([o.page.waitForURL(/billing\.stripe\.test\/session\//), o.page.locator('#manage-payment').click()]);
    await o.page.goto('/app/billing?portal=return'); await o.page.waitForSelector('#subscription .panel'); await expect(o.page.locator('#notice')).toContainText('Welcome back'); await expect(o.page).toHaveURL(/\/app\/billing$/);
    for (const x of [billing, member, o]) await x.ctx.close();
  });

  test('sessions: with no session the page asks to sign in; an expired portal token is renewed silently from the MAIN session', async ({ browser }) => {
    const o = await newOwner(browser, 'ses'); await open(o);
    const cookies = await o.ctx.cookies(); const portal = cookies.find((c) => c.name === 'qorlla_portal_session'); expect(portal).toBeTruthy();
    await o.ctx.addCookies([{ ...portal, value: 'expired.or.invalid' }]);                                                                  // the 15-minute portal token has lapsed
    await o.page.reload(); await o.page.waitForSelector('#subscription .panel', { timeout: 30000 }); await expect(o.page.locator('#billing')).toContainText('Current plan');
    await o.ctx.clearCookies(); await o.page.goto('/app/billing');
    await expect(o.page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible(); await expect(o.page.locator('#subscription')).toHaveCount(0); await expect(o.page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();
    await o.ctx.close();
  });

  test('a suspended workspace is told so and gets no actions; lifting the suspension restores the page', async ({ browser }) => {
    await setFlag(true);
    const o = await newOwner(browser, 'sus'); setPlan(o.id, 'business'); await open(o);
    await expect(feature(o.page, 'org.admin')).toHaveAttribute('data-state', 'enabled');
    dbq(`UPDATE portal.workspaces SET suspended_at=now(), suspended_reason='certification' WHERE id='${o.id}'`);
    await open(o); await expect(o.page.locator('#suspended-note')).toBeVisible(); await expect(feature(o.page, 'org.admin')).toHaveAttribute('data-state', 'suspended');
    await expect(o.page.locator('[data-choose], button[data-upgrade], #resume, #manage-payment')).toHaveCount(0); await expect(o.page.locator('#pm-unavailable')).toContainText('suspended');
    expect((await api(o, 'POST', '/documents', { kind: 'doc', title: 'x' })).status()).toBe(403); expect((await api(o, 'POST', '/subscriptions/payment-methods', {})).status()).toBe(403);
    dbq(`UPDATE portal.workspaces SET suspended_at=NULL, suspended_reason=NULL WHERE id='${o.id}'`);
    await open(o); await expect(o.page.locator('#suspended-note')).toHaveCount(0); await expect(feature(o.page, 'org.admin')).toHaveAttribute('data-state', 'enabled');
    await setFlag(false); await o.ctx.close();
  });
});
