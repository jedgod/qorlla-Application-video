const { test, expect } = require('@playwright/test');

test('signed-out visitors see the sign-in screen inside the app shell; old sign-in URL hands over to it', async ({ page }) => {
  await page.goto('/');
  const frame = page.frameLocator('iframe.login-embed');
  await expect(frame.getByRole('heading', { name: 'Welcome to your workspace' })).toBeVisible();
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(page.locator('.nav-item[data-view="mail"]')).toBeHidden();
  const notes = page.locator('.sidebar [data-view="notes"]');
  await page.evaluate(() => { location.hash = '#notes'; });
  await expect(frame.getByRole('heading', { name: 'Welcome to your workspace' })).toBeVisible();
  await page.goto('/login.html?next=qorlla.html');
  await expect(page).toHaveURL(/qorlla.html/);
  await expect(page.frameLocator('iframe.login-embed').locator('#username')).toBeVisible();
  void notes;
});

test('meeting chat manages focus and removes hidden controls from keyboard navigation', async ({ page }) => {
  await page.goto('/index.html');
  const drawer = page.locator('#zoom-chat-sidebar-drawer');
  await expect(drawer).toHaveAttribute('inert', '');
  await page.locator('#openDrawerBtn').click();
  await expect(drawer).toHaveAttribute('aria-hidden', 'false');
  await expect.poll(() => page.evaluate(() => document.querySelector('#zoom-chat-sidebar-drawer').contains(document.activeElement))).toBe(true);
  await page.locator('#zoom-chat-send-trigger').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#tabChat')).toBeFocused();
  await page.locator('#closeDrawerBtn').click();
  await expect(drawer).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#openDrawerBtn')).toBeFocused();
});

test('meeting files use the real file chooser and do not report local files as uploaded', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#workspaceAssetListingContainer li')).toHaveCount(0);
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#dragDropIngestionZone').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: 'agenda.txt', mimeType: 'text/plain', buffer: Buffer.from('Meeting agenda') });
  await expect(page.locator('#toasts')).toContainText('Join a meeting before sharing a file.');
  await expect(page.locator('#workspaceAssetListingContainer li')).toHaveCount(0);
});

test('meeting drafts never claim to be saved without a meeting', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#telemetryWorkspaceNotes').fill('A draft that has not been shared');
  await expect(page.locator('#saveStatusIndicator')).toHaveText('Not shared');
  await expect(page.locator('#endCallBtn')).toBeDisabled();
});

test('unavailable scheduling clears stale slots and shows a recovery message', async ({ page }) => {
  await page.route('**/api/appointments/slots?**', route => route.abort());
  await page.goto('/index.html');
  await expect(page.locator('#slotHint')).toContainText('Availability could not be loaded.');
  await expect(page.locator('#slotRows tr')).toHaveCount(0);
});
