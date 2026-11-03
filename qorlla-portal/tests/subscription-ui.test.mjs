import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, addMember, ORIGIN, here } from './helpers.mjs';
import { startFakeStripe, WEBHOOK_SECRET } from './fake-stripe.mjs';
import { createSbacs } from '../server/sbacs.mjs';

// Phase 3B: the Subscription & Billing page, driven in a real browser (Chromium via the repository's Playwright) against a real portal server and PostgreSQL.
// The page must tell apart: included / not in your plan / not offered at all, and must show NO checkout or upgrade action while live billing is off.
const { chromium } = createRequire(import.meta.url)(path.join(here, '..', '..', 'node_modules', 'playwright'));
const SHOTS = process.env.SBACS_SHOTS_DIR;

describe('Settings -> Subscription & Billing (browser)', () => {
  let db, main, stripe, app, off, sbacs, browser;
  const env = () => ({ BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_API_BASE: stripe.url });
  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn(); stripe = await startFakeStripe(); sbacs = createSbacs({ pool: db.pool });
    app = await startApp({ pool: db.pool, cfg: testConfig({ env: env() }, main), jwks: main.jwks });         // provider configured (test double)
    off = await startApp({ pool: db.pool, cfg: testConfig({}, main), jwks: main.jwks });                       // production-default: no provider at all
    browser = await chromium.launch();
  });
  after(async () => { await browser?.close(); await app.close(); await off.close(); await stripe.close(); await main.close(); await db.drop(); });

  const sql = (q, a) => db.pool.query(q, a);
  async function open(server, session, shot) {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 1600 } }); const u = new URL(server.base);
    await ctx.addCookies([{ name: 'qorlla_portal_session', value: session.jwt, domain: u.hostname, path: '/', httpOnly: true }, { name: 'qorlla_csrf', value: session.csrf, domain: u.hostname, path: '/' }]);
    const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    // the test server allows exactly one Origin (ORIGIN); a browser on 127.0.0.1 sends its own, so state-changing calls get the allowed one at the network layer
    await page.route('**/api/v1/**', (route) => { const r = route.request(); if (r.method() === 'GET') return route.continue(); return route.fetch({ headers: { ...r.headers(), origin: ORIGIN } }).then((resp) => route.fulfill({ response: resp })); });
    await page.goto(server.base + '/app/billing'); await page.waitForSelector('#subscription .panel', { timeout: 20000 });
    if (shot && SHOTS) await page.screenshot({ path: path.join(SHOTS, shot), fullPage: true });
    return { ctx, page, errors };
  }
  const newWs = async (plan = 'basic', status = 'active', cancel = false) => {
    const u = await main.mint(); const ws = await seedWorkspace(db.pool, u.sub);
    if (plan !== 'basic') await sql(`UPDATE portal.subscriptions SET plan_slug=$2,status=$3,billing_interval='month',current_period_end=now()+interval '20 days',cancel_at_period_end=$4,provider_subscription_id=$5 WHERE workspace_id=$1`, [ws, plan, status, cancel, 'sub_ui_' + crypto.randomBytes(4).toString('hex')]);
    return { u, ws };
  };
  const state = (page, key) => page.locator(`[data-feature="${key}"]`).getAttribute('data-state');

  test('live billing OFF: the page is informative, distinguishes the three feature states, and offers no checkout, upgrade or payment action', async () => {
    const { u, ws } = await newWs(); await sbacs.reserve({ workspaceId: ws, featureKey: 'clips.create', idempotencyKey: 'ui-use-0001' }).then((r) => sbacs.finalize(r.reservationId));
    const { ctx, page, errors } = await open(off, u, 'subscription-off.png');
    try {
      await page.waitForSelector('[data-feature]');
      await page.locator('#billing-off').waitFor(); assert.match(await page.locator('#billing-off').innerText(), /checkout and payment management are unavailable/i);
      assert.equal(await state(page, 'docs.history.read'), 'enabled'); assert.equal(await state(page, 'docs.history.restore'), 'restricted'); assert.equal(await state(page, 'phone.pstn'), 'unavailable');
      assert.match(await page.locator('[data-feature="phone.pstn"]').innerText(), /Not available/); assert.match(await page.locator('[data-feature="meet.recording"]').innerText(), /Not in your plan/);
      assert.equal(await page.getByRole('button', { name: /^Upgrade$/ }).count(), 0, 'no Upgrade button while billing is off'); assert.equal(await page.locator('[data-choose]').count(), 0);
      assert.equal(await page.getByRole('button', { name: /Cancel at period end|Keep my subscription/ }).count(), 0);
      assert.equal(await page.locator('[data-plan="starter"]').count(), 0, 'the unlisted Starter plan is not offered'); assert.equal(await page.locator('[data-plan]').count(), 4);
      const body = await page.locator('#billing').innerText(); assert.doesNotMatch(body, /\$\s?\d/, 'no prices are shown on this page'); assert.match(body, /No invoices yet/); assert.match(body, /Card details are entered and stored only by the payment provider/); assert.match(await page.locator('#pm-unavailable').innerText(), /Payment management unavailable/); assert.equal(await page.locator('#manage-payment').count(), 0, 'no non-functional button');
      const row = page.locator('[data-usage-feature="clips.create"]'); assert.match(await row.innerText(), /No limit applied/, 'a provisional (unapproved) limit is not shown as a limit');
      assert.match(await page.locator('#billing').innerText(), /basic/i); assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('live billing ON: managers get Upgrade / Choose plan where a plan offers the feature; nothing for hard-disabled features; plain members get no actions', async () => {
    await app.flags.set('billing_live', true, 'test', crypto.randomUUID());
    const { u, ws } = await newWs(); const m = await main.mint(); await addMember(db.pool, ws, m.sub, 'member');
    const mgr = await open(app, u, 'subscription-live.png');
    try {
      await mgr.page.waitForSelector('[data-feature]'); assert.equal(await mgr.page.locator('#billing-off').count(), 0);
      const up = mgr.page.locator('[data-feature="meet.recording"] button[data-upgrade]'); assert.equal(await up.count(), 1);
      assert.equal(await mgr.page.locator('[data-feature="phone.pstn"] button').count(), 0, 'a globally disabled capability never gets an Upgrade button');
      assert.equal(await mgr.page.locator('[data-feature="docs.history.read"] button').count(), 0, 'an included feature has no upgrade button');
      assert.equal(await mgr.page.locator('[data-choose="pro"]').count(), 1); assert.equal(await mgr.page.locator('[data-plan="enterprise"] [data-choose]').count(), 0); assert.equal(await mgr.page.locator('[data-plan="enterprise"] a').count(), 1);
      // Upgrade goes to a SERVER-created checkout; the page itself activates nothing
      mgr.page.on('dialog', (d) => d.accept()); await mgr.page.route('https://checkout.stripe.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html><body id="provider">provider checkout (test double)</body></html>' }));
      await Promise.all([mgr.page.waitForURL(/checkout\.stripe\.test/), mgr.page.locator('[data-choose="pro"]').click()]);
      assert.equal((await sql(`SELECT plan_slug FROM portal.subscriptions WHERE workspace_id=$1`, [ws])).rows[0].plan_slug, 'basic', 'the redirect alone changed nothing');
    } finally { await mgr.ctx.close(); }
    const mem = await open(app, m, null); mem.page.on('dialog', (d) => d.accept());
    try {
      await mem.page.waitForSelector('[data-feature]');
      assert.equal(await mem.page.locator('button[data-upgrade], [data-choose]').count(), 0, 'a plain member sees the plan but no billing actions');
      assert.match(await mem.page.locator('[data-feature="meet.recording"]').innerText(), /Available on a higher plan/);
    } finally { await mem.ctx.close(); }
  });

  test('renewal, cancellation-pending and suspension are explained; resume works from the page; suspended workspaces get no actions', async () => {
    await app.flags.set('billing_live', true, 'test', crypto.randomUUID());
    const sub = stripe.subscription({ checkoutId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), unitAmount: 1699, interval: 'month', quantity: 1 });
    const { u, ws } = await newWs('pro', 'active', true); await sql(`UPDATE portal.subscriptions SET provider_subscription_id=$2, provider='stripe', seats=1 WHERE workspace_id=$1`, [ws, sub.id]); sub.cancel_at_period_end = true; stripe.st.subs.set(sub.id, sub);
    const { ctx, page } = await open(app, u, 'subscription-cancelling.png');
    try {
      await page.waitForSelector('[data-feature]');
      assert.match(await page.locator('#subscription').innerText(), /Cancels on .* you keep your plan until then/); assert.equal(await state(page, 'meet.recording'), 'enabled');
      await page.getByRole('button', { name: 'Keep my subscription' }).click(); await page.waitForFunction(() => !/Cancels on/.test(document.querySelector('#subscription')?.innerText || ''));
      assert.equal((await sql(`SELECT cancel_at_period_end FROM portal.subscriptions WHERE workspace_id=$1`, [ws])).rows[0].cancel_at_period_end, false);
    } finally { await ctx.close(); }
    await sbacs.setSuspended({ workspaceId: ws, suspended: true, reason: 'review', actorId: crypto.randomUUID() });
    const s = await open(app, u, 'subscription-suspended.png');
    try {
      await s.page.waitForSelector('#suspended-note'); assert.equal(await state(s.page, 'meet.recording'), 'suspended');
      assert.equal(await s.page.locator('[data-choose], button[data-upgrade], #resume').count(), 0);
    } finally { await s.ctx.close(); }
  });

  test('payment methods: a billing admin is sent to the provider-hosted portal and back; members, suspended and no-customer workspaces get an explanation, not a button', async () => {
    await app.flags.set('billing_live', true, 'test', crypto.randomUUID());
    const { u, ws } = await newWs('pro'); const sub = stripe.subscription({ checkoutId: crypto.randomUUID(), workspaceId: ws, unitAmount: 1699, interval: 'month', quantity: 1 });
    await sql(`INSERT INTO portal.billing_customers(workspace_id,provider,provider_customer_id) VALUES($1,'stripe',$2)`, [ws, sub.customer]);
    const m = await main.mint(); await addMember(db.pool, ws, m.sub, 'member');
    const adm = await open(app, u, 'subscription-payment.png');
    try {
      await adm.page.waitForSelector('[data-feature]'); assert.equal(await adm.page.locator('#manage-payment').count(), 1); assert.equal(await adm.page.locator('#pm-unavailable').count(), 0);
      await adm.page.route('https://billing.stripe.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html><body id="provider-portal">provider hosted portal (test double)</body></html>' }));
      await Promise.all([adm.page.waitForURL(/billing\.stripe\.test\/session\//), adm.page.locator('#manage-payment').click()]);
      assert.equal(stripe.st.portalSessions.at(-1).customer, sub.customer); assert.match(stripe.st.portalSessions.at(-1).return_url, /\/app\/billing\?portal=return$/);
      // back from the provider: the page re-reads billing state from the backend and drops the query string
      await adm.page.goto(app.base + '/app/billing?portal=return'); await adm.page.waitForSelector('#subscription .panel');
      assert.match(await adm.page.locator('#notice').innerText(), /Welcome back/); assert.equal(new URL(adm.page.url()).search, '', 'the return marker is removed');
    } finally { await adm.ctx.close(); }
    const mem = await open(app, m, null);
    try { await mem.page.waitForSelector('[data-feature]'); assert.match(await mem.page.locator('#pm-unavailable').innerText(), /unavailable to you/); assert.equal(await mem.page.locator('#manage-payment').count(), 0); } finally { await mem.ctx.close(); }
    const fresh = await newWs('pro'); const nc = await open(app, fresh.u, null);
    try { await nc.page.waitForSelector('[data-feature]'); assert.match(await nc.page.locator('#pm-unavailable').innerText(), /No payment method on file yet/); assert.equal(await nc.page.locator('#manage-payment').count(), 0); } finally { await nc.ctx.close(); }
    await sbacs.setSuspended({ workspaceId: ws, suspended: true, reason: 'review', actorId: crypto.randomUUID() });
    const sus = await open(app, u, null);
    try { await sus.page.waitForSelector('#suspended-note'); assert.match(await sus.page.locator('#pm-unavailable').innerText(), /suspended/); assert.equal(await sus.page.locator('#manage-payment').count(), 0); } finally { await sus.ctx.close(); }
  });

  test('the page source is static, escapes server text, and never holds card data', async () => {
    const js = fs.readFileSync(path.join(here, '..', 'public', 'assets', 'subscription.js'), 'utf8');
    assert.doesNotMatch(js, /card.?number|cvc|cvv|stripe\.js|loadStripe/i); assert.match(js, /esc\(plain\(f\.description/); assert.doesNotMatch(js, /innerHTML\s*=\s*[^;]*\+\s*(?:err|e)\.message/);
    assert.ok(ORIGIN);
  });
});
