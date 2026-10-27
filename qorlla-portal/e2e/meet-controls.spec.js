const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const { BASE } = require('./helpers');

// Qorlla Meet video page: compact toolbar, meeting recording (with an indicator for everyone), and a screen share that can never mirror itself.
// Runs through the unified HTTPS origin under /meet/ in certification; for a local Meet use E2E_BASE=http://localhost:3300 E2E_MEET_PATH=/.
const MEET = process.env.E2E_MEET_PATH || '/meet/';
const bytes = (path) => fs.readFileSync(path);

async function host(browser, title = 'Controls check') {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE, permissions: ['camera', 'microphone'], viewport: { width: 1366, height: 768 }, acceptDownloads: true }); const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.addInitScript(() => { const orig = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices); window.__gdm = []; navigator.mediaDevices.getDisplayMedia = (c) => { window.__gdm.push(JSON.parse(JSON.stringify(c || {}))); return orig(c); }; });
  await page.goto(MEET); await page.fill('#displayName', 'Alice'); await page.fill('#meetingTitle', title); await page.click('#createBtn'); await page.waitForSelector('#app:not(.hidden)');
  await expect(page.locator('#status')).toContainText('Connected'); const code = (await page.locator('#roomId').textContent()).trim(); return { ctx, page, code };
}
async function guest(browser, code, name = 'Bob') {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE, permissions: ['camera', 'microphone'], viewport: { width: 1366, height: 768 } }); const page = await ctx.newPage();
  await page.goto(MEET); await page.fill('#displayName', name); await page.fill('#meetingId', code); await page.click('#joinBtn'); await page.waitForSelector('#app:not(.hidden)');
  await expect(page.locator('#status')).toContainText('Connected'); return { ctx, page };
}

test.describe('Qorlla Meet controls', () => {
  test('the toolbar uses compact standard-size controls, all visible, with Record in the bar', async ({ browser }) => {
    const a = await host(browser);
    for (const vp of [{ width: 1366, height: 768 }, { width: 1024, height: 700 }]) {
      await a.page.setViewportSize(vp);
      const m = await a.page.evaluate(() => ({ footer: Math.round(document.querySelector('.controls').getBoundingClientRect().height),
        ctl: [...document.querySelectorAll('.controls button')].filter((b) => b.offsetParent).map((b) => { const r = b.getBoundingClientRect(); return { id: b.id, w: Math.round(r.width), h: Math.round(r.height), inView: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; }),
        header: [...document.querySelectorAll('.header-actions button')].map((b) => b.textContent.trim()), overflow: document.documentElement.scrollWidth > innerWidth }));
      expect(m.footer).toBeLessThanOrEqual(72); expect(m.overflow).toBe(false);
      for (const c of m.ctl) { expect(c.h, c.id).toBeLessThanOrEqual(52); expect(c.w, c.id).toBeLessThanOrEqual(96); expect(c.inView, c.id).toBe(true); }
      expect(m.ctl.map((c) => c.id)).toEqual(['micBtn', 'camBtn', 'shareBtn', 'recordBtn', 'handBtn', 'peopleBtn', 'chatBtn', 'leaveBtn', 'endBtn']);
      expect(m.header).not.toContain('Record');
    }
    await expect(a.page.locator('#micBtn')).toHaveText('Mute'); await a.page.click('#micBtn'); await expect(a.page.locator('#micBtn')).toHaveText('Unmute'); await expect(a.page.locator('#micBtn')).toHaveAttribute('aria-pressed', 'true');
    await a.page.click('#handBtn'); await expect(a.page.locator('#handBtn')).toHaveText('Lower hand'); await expect(a.page.locator('#handBtn')).toHaveClass(/on/);
    await a.ctx.close();
  });

  test('recording: indicator for everyone (a late joiner too), a real audio+video file is saved, and leaving while recording saves it', async ({ browser }) => {
    test.setTimeout(120000);
    const a = await host(browser, 'Recording check'); const b = await guest(browser, a.code, 'Bob');
    await expect(a.page.locator('#recordBtn')).toHaveText('Record'); await a.page.click('#recordBtn');
    await expect(a.page.locator('#recordBtn')).toHaveText(/Stop \d\d:\d\d/); await expect(a.page.locator('#recordBtn')).toHaveAttribute('aria-pressed', 'true'); await expect(a.page.locator('#recBanner')).toContainText('You are recording this meeting');
    await expect(b.page.locator('#recBanner')).toContainText('Alice is recording this meeting'); await expect(b.page.locator('.tile .rec-badge')).toHaveCount(1);
    const c = await guest(browser, a.code, 'Carol'); await expect(c.page.locator('#recBanner')).toContainText('Alice is recording this meeting');             // joined after it started
    await a.page.waitForTimeout(3000);
    const [dl] = await Promise.all([a.page.waitForEvent('download'), a.page.click('#recordBtn')]);
    expect(dl.suggestedFilename()).toMatch(/^qorlla-\d+-\d{8}-\d{4}\.webm$/); const buf = bytes(await dl.path()); expect(buf.length).toBeGreaterThan(20000); expect(buf.subarray(0, 4).toString('hex')).toBe('1a45dfa3');   // a WebM container
    await expect(a.page.locator('#recordBtn')).toHaveText('Record'); await expect(b.page.locator('#recBanner')).toBeHidden(); await expect(b.page.locator('.tile .rec-badge')).toHaveCount(0);
    // leaving during a recording still saves it
    await a.page.click('#recordBtn'); await expect(b.page.locator('#recBanner')).toContainText('Alice is recording'); await a.page.waitForTimeout(2000);
    const [dl2] = await Promise.all([a.page.waitForEvent('download'), a.page.click('#leaveBtn')]); expect(bytes(await dl2.path()).length).toBeGreaterThan(10000);
    await expect(b.page.locator('#recBanner')).toBeHidden();
    await a.ctx.close(); await b.ctx.close(); await c.ctx.close();
  });

  test('screen share never mirrors itself: this tab is excluded, your own share is a placeholder, others see the real screen', async ({ browser }) => {
    test.setTimeout(120000);
    const a = await host(browser, 'Share check'); const b = await guest(browser, a.code, 'Bob'); await expect(a.page.locator('.tile')).toHaveCount(2);
    await a.page.click('#shareBtn');
    await expect(a.page.locator('#shareBtn')).toHaveText('Stop share'); const gdm = await a.page.evaluate(() => window.__gdm); expect(gdm).toHaveLength(1); expect(gdm[0].selfBrowserSurface).toBe('exclude'); expect(gdm[0].audio).toBe(false);
    const mine = a.page.locator('.tile.sharing-local'); await expect(mine).toHaveCount(1); await expect(mine.locator('.share-note')).toContainText("You're sharing your screen");
    expect(await mine.locator('video').evaluate((v) => getComputedStyle(v).visibility)).toBe('hidden');             // the live capture is never drawn back into the page
    await expect(b.page.locator('.tile.sharing-remote')).toHaveCount(1);
    await expect.poll(() => b.page.locator('.tile.sharing-remote video').evaluate((v) => v.videoWidth), { timeout: 20000 }).toBeGreaterThan(0);   // the other side receives the real picture
    await mine.getByRole('button', { name: 'Stop sharing' }).click(); await expect(a.page.locator('#shareBtn')).toHaveText('Share'); await expect(a.page.locator('.tile.sharing-local')).toHaveCount(0); await expect(a.page.locator('.share-note')).toHaveCount(0);
    await expect(b.page.locator('.tile.sharing-remote')).toHaveCount(0);
    await a.ctx.close(); await b.ctx.close();
  });

  test('the video page fits the window with nothing to scroll: 1 to 4 people, every layout, several window sizes, and while sharing', async ({ browser }) => {
    test.setTimeout(180000);
    const fits = (page) => page.evaluate(() => { const se = document.scrollingElement, st = document.querySelector('.stage'), vd = document.getElementById('videos'), c = document.querySelector('.controls');
      const tiles = [...document.querySelectorAll('.tile')].map((t) => t.getBoundingClientRect()); const g = vd.getBoundingClientRect();
      return { page: se.scrollHeight <= innerHeight && se.scrollWidth <= innerWidth, stage: st.scrollHeight <= st.clientHeight + 1 && st.scrollWidth <= st.clientWidth + 1, videos: vd.scrollHeight <= vd.clientHeight + 1, controls: c.scrollWidth <= c.clientWidth + 1,
        tilesInside: tiles.every((r) => r.left >= g.left - 1 && r.right <= g.right + 1 && r.top >= g.top - 1 && r.bottom <= g.bottom + 1), n: tiles.length }; });
    const expectFit = async (page, what) => { const m = await fits(page); expect(m, what).toMatchObject({ page: true, stage: true, videos: true, controls: true, tilesInside: true }); return m; };
    const a = await host(browser, 'Fit check'); await expectFit(a.page, 'one person');
    const guests = []; for (const name of ['Ann', 'Ben', 'Cy']) { guests.push(await guest(browser, a.code, name)); await expect(a.page.locator('.tile')).toHaveCount(guests.length + 1); await expectFit(a.page, (guests.length + 1) + ' people'); }
    for (const vp of [{ width: 1366, height: 768 }, { width: 1024, height: 600 }, { width: 800, height: 500 }, { width: 390, height: 844 }]) { await a.page.setViewportSize(vp); await a.page.waitForTimeout(300); await expectFit(a.page, 'window ' + vp.width + 'x' + vp.height); }
    await a.page.setViewportSize({ width: 1366, height: 768 });
    for (const layout of ['speaker', 'stage', 'gallery']) { await a.page.click('[data-layout=' + layout + ']'); await a.page.waitForTimeout(300); await expectFit(a.page, 'layout ' + layout); }
    await a.page.click('#shareBtn'); await expect(a.page.locator('#shareBtn')).toHaveText('Stop share'); await a.page.waitForTimeout(500); await expectFit(a.page, 'while sharing (host)'); await expectFit(guests[0].page, 'while sharing (viewer)');
    const mainBox = await guests[0].page.locator('.tile.main').boundingBox(); const other = await guests[0].page.locator('.tile:not(.main)').first().boundingBox(); expect(mainBox.width).toBeGreaterThan(other.width * 2);   // the shared screen gets the big area
    await a.ctx.close(); for (const g of guests) await g.ctx.close();
  });
});
