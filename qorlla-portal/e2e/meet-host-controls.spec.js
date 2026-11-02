const { test, expect: baseExpect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const { BASE, signUp } = require('./helpers');
const expect = baseExpect.configure({ timeout: 45000 });

// HOST-CONTROLLED TOOLS, ENTRY MODES, HOST MUTE AND THE TIME-LIMIT DIALOG, in real browsers against the isolated "qlaunch" project (the main app launches Meet itself there).
//   E2E_BASE=http://localhost:4800  E2E_COMPOSE_PROJECT=qlaunch
// What it proves: a guest sees no Share button, Polls tab, Whiteboard or Breakout item until the host switches each on (and the server refuses the calls meanwhile); the host can grant sharing
// to one person; the host can mute a guest and ask them to unmute (the guest decides); the host chooses how guests enter; and the limit dialog sends "See plans" to the MAIN app's pricing page
// and "Leave" to the MAIN app's landing page.
const PROJECT = process.env.E2E_COMPOSE_PROJECT || 'qlaunch';
const meetSql = (sql) => execFileSync('docker', ['exec', PROJECT + '-meet-db-1', 'psql', '-U', 'qorlla', '-d', 'qorlla_meet', '-tAc', sql], { encoding: 'utf8', timeout: 120000 }).trim();
const O = { origin: BASE };

async function newRoom(browser, { waitingRoom = false, limits = null } = {}) {
  const hctx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
  await signUp(hctx, 'hostctl'); const csrf = (await hctx.cookies()).find((c) => c.name === 'qorlla_csrf').value; const h = { ...O, 'x-csrf-token': csrf };
  const d = new Date(Date.now() + 120000), pad = (n) => String(n).padStart(2, '0');
  const sc = await hctx.request.post('/api/workplace/schedule', { data: { title: 'Host controls', date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), time: pad(d.getHours()) + ':' + pad(d.getMinutes()), duration: 30 }, headers: h }); expect(sc.status()).toBe(201);
  const item = await sc.json();
  const st = await hctx.request.post('/api/meetings/' + encodeURIComponent(item.meetingId) + '/start', { data: { requestId: 'r-' + Math.random().toString(36).slice(2), waitingRoom }, headers: h }); expect(st.status()).toBe(200);
  const url = (await st.json()).url;
  if (limits) meetSql(`UPDATE meetings SET time_limit_ms=${limits.limit}, grace_ms=${limits.grace} WHERE id=(SELECT id FROM meetings ORDER BY created_at DESC LIMIT 1)`);   // before anyone connects: the limiter reads it when the first person arrives
  const hp = await hctx.newPage(); hp.on('dialog', (x) => x.accept()); await hp.goto(url); await expect(hp.locator('#app')).not.toHaveClass(/hidden/, { timeout: 60000 });
  return { hctx, hp, item, h, csrf };
}
async function guestIn(browser, meetingId, name) {
  const gctx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
  const gs = await gctx.request.post('/api/guest/sessions', { data: { meetingId, displayName: name } }); expect(gs.status()).toBe(201);
  const gp = await gctx.newPage(); await gp.goto((await gs.json()).meet.url); return { gctx, gp };
}
const openMore = async (p) => { await p.click('[data-tab=more]'); const h = p.locator('#mgh-manage'); if ((await h.getAttribute('aria-expanded')) !== 'true') await h.click(); };

test.describe('host-controlled tools in Meet', () => {
  test.describe.configure({ mode: 'serial' });
  test('guests see no Share, Polls, Whiteboard or Breakout until the host switches them on; the server refuses meanwhile; sharing can be granted to one person', async ({ browser }) => {
    test.setTimeout(180000);
    const { hctx, hp, item } = await newRoom(browser);
    const { gctx, gp } = await guestIn(browser, item.meetingId, 'Gail'); await expect(gp.locator('#app')).not.toHaveClass(/hidden/, { timeout: 60000 });
    // ---- nothing for the guest
    await expect(gp.locator('#shareBtn')).toBeHidden(); await expect(gp.locator('[data-tab=polls]')).toBeHidden();
    await gp.click('[data-tab=more]'); await expect(gp.locator('#tab-more')).not.toContainText('Whiteboard'); await expect(gp.locator('#tab-more')).not.toContainText('Breakout');
    await expect(hp.locator('#shareBtn')).toBeVisible(); await expect(hp.locator('[data-tab=polls]')).toBeVisible();      // the host has everything
    await hp.click('[data-tab=more]'); await expect(hp.locator('#tab-more')).toContainText('Whiteboard'); await expect(hp.locator('#tab-more')).toContainText('Breakout');
    // ---- the server refuses, whatever the page shows
    const gtok = await gp.evaluate(() => JSON.parse(sessionStorage.getItem('qorlla-session')).token), mid = await gp.evaluate(() => JSON.parse(sessionStorage.getItem('qorlla-session')).meetingId);
    const meetOrigin = new URL(gp.url()).origin;
    const call = async (path, method, body) => { const r = await fetch(meetOrigin + '/api' + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + gtok }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    expect((await call('/meetings/' + mid + '/tools', 'PATCH', { share: true })).status).toBe(403);                         // a guest cannot switch tools on
    expect((await call('/meetings/' + mid + '/polls', 'GET')).body).toMatchObject({ polls: [], disabled: true });
    expect((await call('/meetings/' + mid + '/polls/00000000-0000-4000-8000-000000000000/votes', 'POST', { choices: [0] })).status).toBe(403);
    // ---- the host switches Polls on: the guest gets the tab at once
    await openMore(hp); await hp.getByRole('checkbox', { name: 'Polls', exact: true }).check(); await expect(gp.locator('[data-tab=polls]')).toBeVisible();
    expect((await call('/meetings/' + mid + '/polls', 'GET')).body.disabled).toBeUndefined();
    await hp.getByRole('checkbox', { name: 'Polls', exact: true }).uncheck(); await expect(gp.locator('[data-tab=polls]')).toBeHidden();
    // ---- screen sharing for everyone, then off again
    await hp.getByRole('checkbox', { name: 'Screen sharing (everyone)' }).check(); await expect(gp.locator('#shareBtn')).toBeVisible();
    await hp.getByRole('checkbox', { name: 'Screen sharing (everyone)' }).uncheck(); await expect(gp.locator('#shareBtn')).toBeHidden();
    // ---- sharing for ONE person, from the People tab
    await hp.click('[data-tab=people]'); await hp.getByRole('button', { name: 'Allow sharing' }).click(); await expect(gp.locator('#shareBtn')).toBeVisible();
    await expect(hp.getByRole('button', { name: 'Stop sharing' })).toBeVisible(); await hp.getByRole('button', { name: 'Stop sharing' }).click(); await expect(gp.locator('#shareBtn')).toBeHidden();
    await hctx.close(); await gctx.close();
  });

  test('the host can mute a guest, mute everyone, and ask to unmute; the microphone only comes on if the guest agrees', async ({ browser }) => {
    test.setTimeout(180000);
    const { hctx, hp, item } = await newRoom(browser);
    const { gctx, gp } = await guestIn(browser, item.meetingId, 'Gail'); await expect(gp.locator('#app')).not.toHaveClass(/hidden/, { timeout: 60000 });
    await expect(gp.locator('#micBtn span')).toHaveText('Mute');                                                              // microphone on
    await hp.click('[data-tab=people]'); await expect(hp.locator('#peopleList')).toContainText('Gail');
    await hp.locator('#peopleList').getByRole('button', { name: 'Mute', exact: true }).click();
    await expect(gp.locator('#micBtn span')).toHaveText('Unmute');
    // asking is not forcing: the guest gets a prompt and may decline
    await hp.locator('#peopleList').getByRole('button', { name: 'Ask to unmute' }).click(); await expect(gp.locator('#rcModal')).toContainText('The host asks you to unmute');
    await gp.locator('#rcModal').getByRole('button', { name: 'Not now' }).click(); await expect(gp.locator('#micBtn span')).toHaveText('Unmute');
    await hp.locator('#peopleList').getByRole('button', { name: 'Ask to unmute' }).click(); await gp.locator('#rcModal').getByRole('button', { name: 'Unmute', exact: true }).click(); await expect(gp.locator('#micBtn span')).toHaveText('Mute');
    // mute everyone
    await hp.locator('#peopleList').getByRole('button', { name: 'Mute everyone' }).click(); await expect(gp.locator('#micBtn span')).toHaveText('Unmute');
    // a guest has no mute buttons
    await gp.click('[data-tab=people]'); await expect(gp.locator('#peopleList').getByRole('button', { name: 'Mute everyone' })).toHaveCount(0);
    await hctx.close(); await gctx.close();
  });

  test('entry modes: with the waiting room on, an invited guest waits until the host accepts; the host can open the door instead', async ({ browser }) => {
    test.setTimeout(180000);
    const { hctx, hp, item } = await newRoom(browser, { waitingRoom: true });
    const g1 = await guestIn(browser, item.meetingId, 'Wendy');
    await expect(g1.gp.locator('#app')).toHaveClass(/hidden/); await expect(hp.locator('[data-tab=people]')).toContainText('waiting', { timeout: 30000 });      // held in the waiting room, the host sees it
    await openMore(hp); await expect(hp.getByRole('radio', { name: 'Waiting room: I accept each guest before they come in' })).toBeChecked();
    await hp.click('[data-tab=people]').catch(() => {});
    await expect(hp.locator('#waitingBox, .waiting-box, :text("Waiting room")').first()).toBeVisible();
    await hp.getByRole('button', { name: 'Admit all' }).click(); await expect(g1.gp.locator('#app')).not.toHaveClass(/hidden/, { timeout: 60000 });
    // open the door: the next guest comes straight in
    await openMore(hp); await hp.getByRole('radio', { name: 'Guests come in right away, even before I start' }).check();
    const g2 = await guestIn(browser, item.meetingId, 'Walt'); await expect(g2.gp.locator('#app')).not.toHaveClass(/hidden/, { timeout: 60000 });
    await hctx.close(); await g1.gctx.close(); await g2.gctx.close();
  });

  test('the time-limit dialog: See plans opens the main app pricing page and Leave goes to the main landing page', async ({ browser }) => {
    test.setTimeout(240000);
    const { hctx, hp, item } = await newRoom(browser, { limits: { limit: 15000, grace: 6000 } });
    const { gctx, gp } = await guestIn(browser, item.meetingId, 'Gail'); await expect(gp.locator('#app')).not.toHaveClass(/hidden/, { timeout: 60000 });
    for (const p of [hp, gp]) { await expect(p.locator('#rcModal')).toContainText('Meeting time limit reached', { timeout: 90000 }); await expect(p.locator('#limitPlans')).toHaveAttribute('href', new RegExp('^' + BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/pricing\\?reason=meeting-limit')); }
    await Promise.all([gp.waitForURL((u) => new URL(u).origin === new URL(BASE).origin && ['/pricing', '/pricing/'].includes(new URL(u).pathname)), gp.click('#limitPlans')]);
    await expect(gp.locator('body')).toContainText(/plan|pricing|Basic|Pro/i);
    await Promise.all([hp.waitForURL((u) => new URL(u).origin === new URL(BASE).origin && new URL(u).pathname === '/'), hp.click('#limitLeave')]);
    await hctx.close(); await gctx.close();
  });
});
