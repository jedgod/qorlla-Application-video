const { test, expect } = require('@playwright/test');
const { BASE, dbq, fakeJson, signUp, signUpWithWorkspace, providerPays, redeliver, money } = require('./helpers');

const catalog = async (request) => (await request.get('/api/v1/plans')).json();
const price = (cat, slug, interval) => cat.plans.find((p) => p.slug === slug).prices[interval];

test.describe('pricing page - prices come only from the server catalogue', () => {
  test.beforeEach(async () => { await fakeJson('/__control/reset', {}); });

  test('[I04][I05] displayed prices equal the database-backed API (monthly and annual), with computed saving', async ({ page, request }) => {
    const cat = await catalog(request);
    await page.goto('/pricing/');
    const pro = price(cat, 'pro', 'month'), biz = price(cat, 'business', 'month');
    await expect(page.locator('#price-pro')).toContainText(money(pro.per_seat_per_month_cents));
    await expect(page.locator('#price-business')).toContainText(money(biz.per_seat_per_month_cents));
    await expect(page.locator('#sub-pro')).toContainText(money(pro.amount_cents));
    const proY = price(cat, 'pro', 'year'), bizY = price(cat, 'business', 'year');
    await page.locator('#annualToggle').click();
    await expect(page.locator('#price-pro')).toContainText(money(proY.per_seat_per_month_cents));
    await expect(page.locator('#price-business')).toContainText(money(bizY.per_seat_per_month_cents));
    await expect(page.locator('#sub-pro')).toContainText(`${money(proY.amount_cents)} per user per year`);
    const best = Math.max(...['pro', 'business'].map((s) => Math.floor(100 * (1 - price(cat, s, 'year').amount_cents / (12 * price(cat, s, 'month').amount_cents)))));
    await expect(page.locator('#saveText')).toHaveText(`(Save up to ${best}%)`);
  });

  test('[I06] annual/monthly switch works with the mouse and the keyboard and exposes its state', async ({ page }) => {
    await page.goto('/pricing/');
    const sw = page.locator('#annualToggle');
    await expect(sw).toHaveAttribute('role', 'switch'); await expect(sw).toHaveAttribute('aria-checked', 'false');
    await sw.focus(); await page.keyboard.press('Space'); await expect(sw).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Enter'); await expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  test('seat count changes the displayed total', async ({ page, request }) => {
    const cat = await catalog(request); await page.goto('/pricing/');
    await page.locator('#seats').fill('4');
    await expect(page.locator('#sub-pro')).toContainText(money(price(cat, 'pro', 'month').amount_cents * 4));
    await page.locator('#seats').fill('0'); await expect(page.locator('#sub-pro')).toContainText('1 seat');
  });

  test('[I13] a price change in PostgreSQL shows on the page after reload; nothing is cached or hard-coded', async ({ page }) => {
    try {
      dbq("UPDATE portal.plan_prices SET amount_cents=1799 WHERE plan_slug='pro' AND billing_interval='month'");
      await page.goto('/pricing/'); await expect(page.locator('#price-pro')).toContainText('$17.99');
      expect(await page.content()).not.toContain('16.99');
    } finally { dbq("UPDATE portal.plan_prices SET amount_cents=1699 WHERE plan_slug='pro' AND billing_interval='month'"); }
  });

  test('[I14] annual billing is disabled (not invented) when a plan has no annual price row', async ({ page }) => {
    try {
      dbq("UPDATE portal.plan_prices SET active=false WHERE billing_interval='year'");
      await page.goto('/pricing/'); await expect(page.locator('#annualToggle')).toHaveAttribute('aria-disabled', 'true');
      await page.locator('#annualToggle').click({ force: true }); await expect(page.locator('#annualToggle')).toHaveAttribute('aria-checked', 'false');
      await expect(page.locator('#price-pro')).toContainText('$16.99');
    } finally { dbq("UPDATE portal.plan_prices SET active=true WHERE billing_interval='year'"); }
  });

  test('[I15] catalogue unavailable => explicit "unavailable" state, buying disabled, NO fallback prices; Retry recovers', async ({ page }) => {
    await page.route('**/api/v1/plans', (route) => route.abort());
    await page.goto('/pricing/');
    await expect(page.locator('#price-pro')).toHaveText('Price unavailable'); await expect(page.locator('#price-business')).toHaveText('Price unavailable');
    await expect(page.locator('#btn-pro')).toBeDisabled(); await expect(page.locator('#btn-business')).toBeDisabled();
    await expect(page.locator('#pricingStatus')).toContainText('unavailable');
    const cards = await page.locator('.plans').innerText(); expect(cards).not.toMatch(/\$\s?\d/);
    await page.unroute('**/api/v1/plans');
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('#price-pro')).toContainText('$'); await expect(page.locator('#btn-pro')).toBeEnabled();
  });

  test('when the server says checkout is not available, purchase buttons are disabled with an explanation', async ({ page }) => {
    await page.route('**/api/v1/plans', async (route) => { const r = await route.fetch(); const j = await r.json(); j.billing = { checkout_available: false, unavailable_reasons: ['billing_disabled'] }; await route.fulfill({ response: r, json: j }); });
    await page.goto('/pricing/');
    await expect(page.locator('#btn-pro')).toBeDisabled(); await expect(page.locator('#note-pro')).toContainText('not enabled');
    await expect(page.locator('#price-pro')).toContainText('$');     // prices still shown (they are real), only buying is paused
  });

  test('[I12] Enterprise "Contact sales" creates a real inquiry in PostgreSQL (and the honeypot does not)', async ({ page }) => {
    await page.goto('/pricing/');
    await page.locator('#btn-ent').click(); await expect(page.locator('#salesDialog')).toBeVisible();
    await page.fill('#salesForm [name=name]', 'E2E Buyer'); await page.fill('#salesForm [name=email]', 'buyer@example.test');
    await page.fill('#salesForm [name=company]', 'E2E Co'); await page.fill('#salesForm [name=message]', 'We need SSO for 400 seats - e2e inquiry');
    await page.locator('#salesSend').click();
    await expect(page.locator('#salesMsg')).toContainText('Thank you');
    expect(dbq("SELECT count(*) FROM portal.sales_inquiries WHERE email='buyer@example.test' AND message LIKE '%e2e inquiry%' AND plan_interest='enterprise'")).toBe('1');
    // Esc closes the dialog and focus returns to the page
    await page.keyboard.press('Escape'); await expect(page.locator('#salesDialog')).toBeHidden();
    await page.locator('#btn-ent').click(); await expect(page.locator('#salesDialog')).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.locator('#salesDialog')).toBeHidden();
  });

  test('signed-out visitors who click Buy are sent to sign in and come back to pricing', async ({ page }) => {
    await page.goto('/pricing/'); await expect(page.locator('#btn-pro')).toBeEnabled();
    await page.locator('#btn-pro').click();
    await page.waitForURL(/\/login\.html\?next=%2Fpricing%2F/);
  });

  test('[I10] signed-in Buy creates a SERVER-SIDE checkout with the database price; the redirect alone activates nothing; a verified webhook does', async ({ page, context, request }) => {
    const ws = await signUpWithWorkspace(context, 'buyer');
    const cat = await catalog(request); const unit = price(cat, 'pro', 'year').amount_cents;
    await page.route('https://checkout.stripe.test/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body id="provider">provider checkout (test double)</body></html>' }));
    await page.goto('/pricing/'); await page.locator('#annualToggle').click(); await page.locator('#seats').fill('2');
    await page.locator('#btn-pro').click();
    await page.waitForURL(/checkout\.stripe\.test\/pay\//);
    // what the provider was asked to charge == the database price x seats (the browser never supplied an amount)
    const reqs = await fakeJson('/__control/requests'); const create = reqs.find((r) => r.path === '/v1/checkout/sessions');
    expect(create.form['line_items[0][price_data][unit_amount]']).toBe(String(unit)); expect(create.form['line_items[0][quantity]']).toBe('2');
    expect(create.form['line_items[0][price_data][recurring][interval]']).toBe('year'); expect(create.form['metadata[workspace_id]']).toBe(ws.workspaceId);
    const checkoutId = create.form['metadata[checkout_id]'];
    // redirect back from the provider (success URL) proves nothing
    await page.goto('/app/billing?checkout=success');
    await expect(page.locator('#notice')).toContainText('confirming your payment');
    expect(dbq(`SELECT plan_slug FROM portal.workspace_effective_plan WHERE workspace_id='${ws.workspaceId}'`)).toBe('basic');
    // the signed, provider-confirmed webhook is what activates
    const paid = await providerPays({ checkoutId, workspaceId: ws.workspaceId, unitAmount: unit, interval: 'year', quantity: 2 }); expect(paid.status).toBe(200);
    await expect(page.locator('#notice')).toContainText('Payment confirmed', { timeout: 30000 });
    await expect(page.locator('#billing')).toContainText('pro'); await expect(page.locator('#billing table:has(th:text("Receipt"))')).toContainText(money(unit * 2));
    expect(dbq(`SELECT plan_slug FROM portal.workspace_effective_plan WHERE workspace_id='${ws.workspaceId}'`)).toBe('pro');
    // the identical delivery replayed (provider retry) is acknowledged and changes nothing
    const again = await redeliver(paid.ev); expect(again.status).toBe(200); expect(again.body.duplicate).toBe(true);
    expect(dbq(`SELECT count(*) FROM portal.invoices WHERE workspace_id='${ws.workspaceId}'`)).toBe('1');
    expect(dbq(`SELECT count(*) FROM portal.subscriptions WHERE workspace_id='${ws.workspaceId}'`)).toBe('1');
  });
});
