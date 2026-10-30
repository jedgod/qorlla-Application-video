import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { freshDatabase, startMainStandIn, testConfig, startApp } from './helpers.mjs';

// The Admin / Staff / Support pages in a REAL Chromium against the real portal app and PostgreSQL, authenticated only by the MAIN-style cookie JWT + CSRF cookie (no tokens typed into pages).
// Proves: the pages render real data, customer-supplied HTML is shown as text and never runs, an internal note is saved as internal and never appears on the customer page, and Admin explains a missing MFA.
// Not proven: other browsers, mobile layout, accessibility audit, a real MAIN login (the test mints sessions like MAIN's stand-in).
const require = createRequire(import.meta.url);
let chromium; try { ({ chromium } = require('../../node_modules/playwright')); } catch { /* browser library not installed here */ }
const sql = (db, s, a = []) => db.pool.query(s, a).then((r) => r.rows);

describe('operations pages in a real browser', { skip: chromium ? false : 'playwright is not installed' }, () => {
  let db, main, app, browser;
  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn(); const cfg = testConfig({ env: { OPS_ENABLED: 'true' } }, main); cfg.rateLimits.ops = 100000;
    app = await startApp({ pool: db.pool, cfg, jwks: main.jwks }); cfg.origin = app.base;   // browser writes must be same-origin: point the allowed origin at the test server
    browser = await chromium.launch();
  });
  after(async () => { await browser?.close(); await app?.close(); await main?.close(); await db?.drop(); });
  const page = async (session) => { const ctx = await browser.newContext(); await ctx.addCookies([{ name: 'qorlla_portal_session', value: session.jwt, url: app.base }, { name: 'qorlla_csrf', value: session.csrf, url: app.base }]); const p = await ctx.newPage(); p.errors = []; p.on('pageerror', (e) => p.errors.push(String(e))); p.ctx = ctx; return p; };
  const staff = async (role, perms, o = {}) => { const u = await main.mint(o); await sql(db, 'INSERT INTO portal.ops_staff(user_id,display_name,team,role,permissions) VALUES($1,$2,$3,$4,$5)', [u.sub, role, 'support', role, perms]); return u; };

  test('customer opens a case with hostile HTML; staff sees it as text, writes an internal note and a customer reply; the customer sees only the reply; nothing executes', async () => {
    const XSS = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
    const cust = await main.mint(), agent = await staff('support_agent', ['ticket:read', 'ticket:work']), lead = await staff('supervisor', []);
    const cp = await page(cust); await cp.goto(app.base + '/ops/support'); await cp.getByRole('button', { name: 'New case' }).click();
    await cp.getByLabel('Subject').fill('Audio broken ' + XSS); await cp.getByLabel('Description').fill('Cannot hear. ' + XSS); await cp.getByRole('button', { name: 'Open case' }).click(); await cp.locator('#msg').filter({ hasText: 'Your case was opened' }).waitFor();
    const id = (await sql(db, 'SELECT id FROM portal.ops_tickets WHERE customer_id=$1', [cust.sub]))[0].id;
    const asg = await app.client(lead, { origin: app.base }).post(`/api/v1/ops/staff/tickets/${id}/assign`, { assignee_id: agent.sub }); assert.equal(asg.status, 200, JSON.stringify(asg.body));
    const sp = await page(agent); await sp.goto(app.base + '/ops/staff'); await sp.getByRole('button', { name: /Audio broken/ }).click();
    await sp.getByText('Conversation').waitFor(); assert.ok((await sp.locator('main').innerText()).includes('<img src=x onerror='), 'hostile HTML is displayed as text');
    assert.equal(await sp.evaluate(() => window.__xss), undefined, 'nothing executed'); assert.equal(await sp.locator('main img, main script').count(), 0);
    await sp.getByLabel('Message').fill('INTERNAL: check the fraud list'); await sp.locator('select[name=visibility]').selectOption('internal'); await sp.getByRole('button', { name: 'Send' }).click(); await sp.getByText('INTERNAL NOTE (customer cannot see)').waitFor();
    await sp.getByLabel('Message').fill('We are looking into this'); await sp.locator('select[name=visibility]').selectOption('customer'); await sp.getByRole('button', { name: 'Send' }).click(); await sp.getByText('visible to customer').waitFor();
    assert.deepEqual((await sql(db, 'SELECT visibility FROM portal.ops_ticket_messages WHERE ticket_id=$1 ORDER BY created_at', [id])).map((r) => r.visibility), ['internal', 'customer']);
    await cp.reload(); await cp.getByRole('button', { name: 'My cases' }).click(); await cp.getByRole('button', { name: /Audio broken/ }).click(); await cp.getByText('We are looking into this').waitFor();
    const seen = await cp.locator('main').innerText(); assert.ok(!seen.includes('INTERNAL') && !seen.includes('fraud'), 'the customer never sees the internal note'); assert.equal(await cp.evaluate(() => window.__xss), undefined);
    await cp.getByLabel('Your reply').fill('Thank you'); await cp.getByRole('button', { name: 'Reply' }).click(); await cp.getByText('Thank you').waitFor();
    assert.equal((await sql(db, `SELECT count(*)::int n FROM portal.ops_ticket_messages WHERE ticket_id=$1 AND author_kind='customer'`, [id]))[0].n, 1);
    for (const p of [cp, sp]) { assert.deepEqual(p.errors, [], 'no script errors'); await p.ctx.close(); }
  });

  test('a customer opening the Staff page is told they have no access (nothing loads); Admin explains MFA, and with MFA shows the closed release gates', async () => {
    const cust = await main.mint(), cp = await page(cust); await cp.goto(app.base + '/ops/staff'); await cp.getByText('You do not have access to this.').waitFor(); assert.equal(await cp.getByRole('button', { name: 'My queue' }).count(), 0); await cp.ctx.close();
    const noMfa = await staff('ops_admin', [], { mfa: false }), ap = await page(noMfa); await ap.goto(app.base + '/ops/admin'); await ap.locator('#msg').filter({ hasText: 'multi-factor authentication' }).waitFor(); await ap.ctx.close();
    const withMfa = await staff('ops_admin', [], { mfa: true }), mp = await page(withMfa); await mp.goto(app.base + '/ops/admin'); await mp.getByText('Release and security controls').waitFor();
    const text = await mp.locator('main').innerText(); assert.match(text, /BLOCKED/); assert.match(text, /pstn\s*\n?\s*off/i); assert.ok(!/\bON\b/.test(text), 'no gate is on'); assert.deepEqual(mp.errors, []); await mp.ctx.close();
    const signedOut = await browser.newContext(), sp = await signedOut.newPage(); await sp.goto(app.base + '/ops/support'); await sp.locator('#msg').filter({ hasText: 'sign in' }).waitFor(); await signedOut.close();
  });
});
