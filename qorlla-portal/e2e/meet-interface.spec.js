const { test, expect } = require('@playwright/test');
const { BASE } = require('./helpers');

// Qorlla Meet v4.0.2 / Gate G2: responsive shell, collapsible panel, adaptive toolbar, keyboard operation and screen-reader semantics.
// Automated checks only: they do NOT replace a manual screen-reader pass (NVDA/JAWS/VoiceOver) or a full WCAG 2.2 AA audit.
// Through the unified origin: /meet/. Local Meet: E2E_BASE=http://localhost:3310 E2E_MEET_PATH=/.
const MEET = process.env.E2E_MEET_PATH || '/meet/';
const DESKTOP = { width: 1366, height: 768 }, TABLET = { width: 1024, height: 700 }, MOBILE = { width: 390, height: 844 };

async function open(browser, who, code, viewport = DESKTOP) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE, permissions: ['camera', 'microphone'], viewport }); const page = await ctx.newPage();
  await page.goto(MEET); await page.fill('#displayName', who);
  if (code) { await page.fill('#meetingId', code); await page.click('#joinBtn'); } else { await page.fill('#meetingTitle', 'Interface check'); await page.click('#createBtn'); }
  await page.waitForSelector('#app:not(.hidden)'); await expect(page.locator('#liveBadge')).toHaveAttribute('data-state', 'live'); await page.waitForFunction(() => window.__qorlla.state.stream);
  const out = { ctx, page }; if (!code) out.code = (await page.locator('#roomId').textContent()).trim(); return out;
}
const box = (page, sel) => page.locator(sel).boundingBox();
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
const focused = (page) => page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.textContent.trim().slice(0, 30)));

test.describe('Qorlla Meet G2 interface and accessibility', () => {
  test('desktop: panel and video side by side; the panel collapses, expands and is resizable by keyboard', async ({ browser }) => {
    const a = await open(browser, 'Alice'); const p = a.page;
    await expect(p.locator('#panel')).toBeVisible(); await expect(p.locator('#panelToggle')).toHaveAttribute('aria-expanded', 'true');
    const open1 = await box(p, '.stage'); const pb = await box(p, '#panel'); expect(pb.x).toBeGreaterThanOrEqual(open1.x + open1.width - 2);               // side by side, not overlapping
    await p.focus('#panelToggle'); await p.keyboard.press('Enter');
    await expect(p.locator('#panelToggle')).toHaveAttribute('aria-expanded', 'false'); await expect(p.locator('#panelToggle')).toHaveText('Show panel'); await expect(p.locator('#panel')).toBeHidden();
    const closed = await box(p, '.stage'); expect(closed.width).toBeGreaterThan(open1.width + 250);                                                                    // video takes the space
    await p.keyboard.press('Enter'); await expect(p.locator('#panel')).toBeVisible();
    await p.focus('#panelResizer'); const w0 = Number(await p.locator('#panelResizer').getAttribute('aria-valuenow')); await p.keyboard.press('ArrowLeft'); await p.keyboard.press('ArrowLeft');
    expect(Number(await p.locator('#panelResizer').getAttribute('aria-valuenow'))).toBe(w0 + 40); expect((await box(p, '#panel')).width).toBeGreaterThan(pb.width + 30);
    await p.keyboard.press('Home'); expect(Number(await p.locator('#panelResizer').getAttribute('aria-valuenow'))).toBe(280);
    await a.ctx.close();
  });

  test('tablet: video first, the panel is a drawer that opens on demand, traps nothing, closes on Escape / scrim and returns focus', async ({ browser }) => {
    const a = await open(browser, 'Alice', undefined, TABLET); const p = a.page;
    await expect(p.locator('#panel')).toBeHidden(); const stage = await box(p, '.stage'); expect(stage.width).toBeGreaterThan(TABLET.width - 4); expect(await noHScroll(p)).toBe(true);
    await p.focus('#chatBtn'); await p.keyboard.press('Enter'); await expect(p.locator('#panel')).toBeVisible(); await expect(p.locator('#chatBtn')).toHaveAttribute('aria-pressed', 'true');
    await p.waitForTimeout(400); const dr = await box(p, '#panel'); expect(dr.x + dr.width).toBeLessThanOrEqual(TABLET.width + 1); expect(dr.width).toBeLessThanOrEqual(381);
    expect(await focused(p)).toBe('tabbtn-chat');                                                                                                                     // focus moved into the drawer
    await p.keyboard.press('Escape'); await expect(p.locator('#panel')).toBeHidden(); expect(await focused(p)).toBe('chatBtn');                                      // ...and came back
    await p.click('#peopleBtn'); await expect(p.locator('#tab-people')).toBeVisible(); await p.locator('#panelScrim').click({ position: { x: 20, y: 200 } }); await expect(p.locator('#panel')).toBeHidden();
    await p.click('#peopleBtn'); await p.click('#panelClose'); await expect(p.locator('#panel')).toBeHidden();
    await a.ctx.close();
  });

  test('mobile: compact controls with a More menu, bottom-sheet panel, nothing scrolls sideways, also at 320px (reflow)', async ({ browser }) => {
    const a = await open(browser, 'Alice', undefined, MOBILE); const p = a.page;
    await expect(p.locator('#moreCtl')).toBeVisible(); await expect(p.locator('#handBtn')).toBeHidden(); await expect(p.locator('#shareBtn')).toBeHidden();
    for (const id of ['micBtn', 'camBtn', 'chatBtn', 'peopleBtn', 'moreCtl', 'leaveBtn']) { const b = await box(p, '#' + id); expect(b.x, id).toBeGreaterThanOrEqual(0); expect(b.x + b.width, id).toBeLessThanOrEqual(MOBILE.width + 1); }
    expect(await noHScroll(p)).toBe(true);
    await p.focus('#moreCtl'); await p.keyboard.press('Enter'); await expect(p.locator('#moreCtl')).toHaveAttribute('aria-expanded', 'true'); await expect(p.locator('#overflowMenu')).toBeVisible();
    await expect(p.locator('#overflowMenu').getByRole('button', { name: /Raise hand/ })).toBeVisible();
    await p.keyboard.press('Escape'); await expect(p.locator('#overflowMenu')).toBeHidden(); expect(await focused(p)).toBe('moreCtl');
    await p.click('#moreCtl'); await p.locator('#overflowMenu').getByRole('button', { name: /Raise hand/ }).click(); await expect(p.locator('#overflowMenu')).toBeHidden();
    await p.click('#moreCtl'); await expect(p.locator('#overflowMenu').getByRole('button', { name: /Lower hand/ })).toHaveAttribute('aria-pressed', 'true'); await expect(p.locator('.tile .hand')).toContainText('Hand raised'); await p.keyboard.press('Escape');
    await p.click('#chatBtn'); await expect(p.locator('#panel')).toBeVisible(); await p.waitForTimeout(400); const sheet = await box(p, '#panel'); expect(sheet.width).toBeGreaterThan(MOBILE.width - 2); expect(sheet.y).toBeGreaterThan(MOBILE.height * 0.2); expect(sheet.y + sheet.height).toBeLessThanOrEqual(MOBILE.height + 1);
    await p.keyboard.press('Escape'); await expect(p.locator('#panel')).toBeHidden();
    await p.setViewportSize({ width: 320, height: 640 }); await p.waitForTimeout(300); expect(await noHScroll(p)).toBe(true);
    for (const id of ['micBtn', 'camBtn', 'moreCtl', 'leaveBtn']) { const b = await box(p, '#' + id); expect(b.x + b.width, id).toBeLessThanOrEqual(321); expect(b.x, id).toBeGreaterThanOrEqual(0); }
    await p.setViewportSize(DESKTOP); await p.waitForTimeout(300); await expect(p.locator('#moreCtl')).toBeHidden(); await expect(p.locator('#handBtn')).toBeVisible();                       // controls return to the bar
    expect(await p.evaluate(() => [...document.querySelectorAll('.controls > button')].filter((b) => b.offsetParent).map((b) => b.id))).toEqual(['micBtn', 'camBtn', 'shareBtn', 'recordBtn', 'handBtn', 'peopleBtn', 'chatBtn', 'leaveBtn', 'endBtn']);
    await a.ctx.close();
  });

  test('keyboard: shortcuts work, never fire while typing, can be switched off, and the dialog traps focus, closes on Escape and restores focus', async ({ browser }) => {
    const a = await open(browser, 'Alice'); const p = a.page;
    await p.locator('body').click({ position: { x: 5, y: 5 } });
    await p.keyboard.press('m'); await expect(p.locator('#micBtn')).toHaveAttribute('aria-pressed', 'true'); await p.keyboard.press('m'); await expect(p.locator('#micBtn')).toHaveAttribute('aria-pressed', 'false');
    await p.keyboard.press('v'); await expect(p.locator('#camBtn')).toHaveAttribute('aria-pressed', 'true'); await p.keyboard.press('v');
    await p.keyboard.press('h'); await expect(p.locator('#handBtn')).toHaveAttribute('aria-pressed', 'true'); await p.keyboard.press('h');
    await p.keyboard.press('p'); await expect(p.locator('#tab-people')).toBeVisible(); await p.keyboard.press('p'); await expect(p.locator('#panel')).toBeHidden(); await p.keyboard.press('c'); await expect(p.locator('#tab-chat')).toBeVisible();
    await p.fill('#chatText', ''); await p.focus('#chatText'); await p.keyboard.type('mvh'); await expect(p.locator('#chatText')).toHaveValue('mvh'); await expect(p.locator('#micBtn')).toHaveAttribute('aria-pressed', 'false');   // typing is not a shortcut
    await p.locator('body').click({ position: { x: 5, y: 5 } }); await p.focus('#settingsBtn'); await p.keyboard.press('Enter');
    const dlg = p.locator('#rcModal'); await expect(dlg).toBeVisible(); await expect(dlg).toHaveAttribute('role', 'dialog').catch(() => {}); await expect(p.locator('#rcModal [role=dialog]')).toHaveAttribute('aria-modal', 'true'); await expect(p.locator('#rcModal [role=dialog]')).toHaveAttribute('aria-labelledby', 'rcTitle');
    expect(await p.evaluate(() => !!document.activeElement.closest('#rcModal'))).toBe(true);
    for (let i = 0; i < 8; i++) { await p.keyboard.press('Tab'); expect(await p.evaluate(() => !!document.activeElement.closest('#rcModal')), 'Tab stays inside the dialog').toBe(true); }
    await p.keyboard.press('Shift+Tab'); expect(await p.evaluate(() => !!document.activeElement.closest('#rcModal'))).toBe(true);
    await dlg.getByLabel(/Single-key shortcuts/).uncheck(); await p.keyboard.press('Escape'); await expect(dlg).toHaveCount(0); expect(await focused(p)).toBe('settingsBtn');
    await p.locator('body').click({ position: { x: 5, y: 5 } }); await p.keyboard.press('m'); await expect(p.locator('#micBtn')).toHaveAttribute('aria-pressed', 'false');                                  // switched off
    await p.keyboard.press('?'); await expect(p.locator('#rcModal')).toBeVisible(); await p.keyboard.press('Escape');                                                                       // '?' help still works
    await a.ctx.close();
  });

  test('screen-reader semantics: tabs, names for every control, connection changes announced once, state not by colour alone, accessible confirmations', async ({ browser }) => {
    test.setTimeout(90000);
    const a = await open(browser, 'Alice'); const b = await open(browser, 'Bob', a.code); const p = a.page;
    // tab pattern
    await expect(p.locator('[role=tab][aria-selected=true]')).toHaveCount(1); await p.focus('[data-tab=chat]'); await p.keyboard.press('ArrowRight'); await expect(p.locator('#tabbtn-people')).toHaveAttribute('aria-selected', 'true'); expect(await focused(p)).toBe('tabbtn-people'); await expect(p.locator('#tab-people')).toBeVisible();
    await p.keyboard.press('End'); await expect(p.locator('#tabbtn-more')).toHaveAttribute('aria-selected', 'true'); await p.keyboard.press('Home'); await expect(p.locator('#tabbtn-chat')).toHaveAttribute('aria-selected', 'true');
    // every visible button / input has an accessible name; the clock does not live in a live region
    const unnamed = await p.evaluate(() => [...document.querySelectorAll('button,input:not([type=hidden]),textarea,select')].filter((e) => e.offsetParent !== null).filter((e) => !(e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.title || (e.labels && e.labels.length) || e.textContent.trim() || e.placeholder)).map((e) => e.id || e.outerHTML.slice(0, 60)));
    expect(unnamed).toEqual([]);
    expect(await p.evaluate(() => !document.getElementById('liveBadge').closest('[aria-live],[role=status]'))).toBe(true);
    await expect(p.locator('[data-layout=gallery]')).toHaveAttribute('aria-pressed', 'true'); await p.click('[data-layout=speaker]'); await expect(p.locator('[data-layout=speaker]')).toHaveAttribute('aria-pressed', 'true'); await expect(p.locator('[data-layout=gallery]')).toHaveAttribute('aria-pressed', 'false');
    // muted / camera-off / raised hand are shown as TEXT on the tile, for the other side too
    await a.page.click('#micBtn'); await a.page.click('#camBtn'); await a.page.click('#handBtn');
    const remote = b.page.locator('.tile:not(#tile-' + (await b.page.evaluate(() => window.__qorlla.state.participantId)) + ')');
    await expect(remote.locator('.chip')).toContainText(['🔇 Muted', '📷 Camera off']); await expect(remote.locator('.hand')).toContainText('Hand raised'); await expect(b.page.locator('#announcer')).toContainText('Alice raised their hand');
    await expect(p.locator('.tile.micoff .chip').first()).toBeVisible();
    // connection change: announced once, in words
    await p.evaluate(() => { window.__ann = []; new MutationObserver(() => window.__ann.push(document.getElementById('announcer').textContent)).observe(document.getElementById('announcer'), { childList: true, characterData: true, subtree: true }); window.__qorlla.state.socket.io.reconnection(false); window.__qorlla.state.socket.io.engine.close(); });
    await expect(p.locator('#announcer')).toContainText('Disconnected'); await p.waitForTimeout(2500);
    expect((await p.evaluate(() => window.__ann)).filter((t) => t === 'Disconnected').length).toBe(1);
    await a.ctx.close(); await b.ctx.close();
  });

  test('host controls: End for all is an accessible confirmation (Escape and Cancel keep the meeting), guests do not get it', async ({ browser }) => {
    test.setTimeout(60000);
    const a = await open(browser, 'Alice'); const b = await open(browser, 'Bob', a.code); await expect(b.page.locator('#endBtn')).toBeHidden();
    await a.page.click('#endBtn'); const dlg = a.page.locator('#rcModal'); await expect(dlg).toContainText('End the meeting for everyone?'); expect(await focused(a.page)).toBe('Cancel');                // safe default
    await a.page.keyboard.press('Escape'); await expect(dlg).toHaveCount(0); expect(await focused(a.page)).toBe('endBtn'); await expect(a.page.locator('#app')).toBeVisible();
    await a.page.click('#endBtn'); await dlg.getByRole('button', { name: 'Cancel' }).click(); await expect(a.page.locator('#app')).toBeVisible(); await expect(b.page.locator('#app')).toBeVisible();
    await a.page.click('#endBtn'); await dlg.getByRole('button', { name: 'End for all' }).click(); await expect(b.page.locator('#landing')).toBeVisible({ timeout: 15000 });
    await a.ctx.close(); await b.ctx.close();
  });

  test('the consent question cannot be dismissed with Escape (Agree or Decline is required) but is keyboard-operable', async ({ browser }) => {
    const a = await open(browser, 'Alice'); const b = await open(browser, 'Bob', a.code);
    await a.page.click('#recordBtn'); await a.page.fill('#rc_purpose', 'Minutes'); await a.page.fill('#rc_recipients', 'Team'); await a.page.fill('#rc_retention', '30 days'); await a.page.fill('#rc_privacyContact', 'p@example.com');
    await a.page.keyboard.press('Escape'); await expect(a.page.locator('#rcModal')).toHaveCount(0);                                                                                                     // the host's own form IS dismissible
    await a.page.click('#recordBtn'); await a.page.fill('#rc_purpose', 'Minutes'); await a.page.fill('#rc_recipients', 'Team'); await a.page.fill('#rc_retention', '30 days'); await a.page.fill('#rc_privacyContact', 'p@example.com'); await a.page.getByRole('button', { name: 'Send request' }).click();
    await expect(b.page.locator('#rcModal')).toBeVisible(); await b.page.keyboard.press('Escape'); await expect(b.page.locator('#rcModal')).toBeVisible();
    await b.page.keyboard.press('Space'); await expect(b.page.locator('#rcVideo, #rcAudio').first()).toBeChecked();                                               // checkboxes toggle from the keyboard
    await a.ctx.close(); await b.ctx.close();
  });
});
