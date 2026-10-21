const { test, expect } = require('@playwright/test');

test('workspace navigation and join dialog work from the keyboard', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#greeting')).toBeVisible();
  const notes = page.locator('.sidebar [data-view="notes"]');
  await notes.focus();
  await page.keyboard.press('Enter');
  await expect(notes).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#view')).toContainText('Sign in');
  await page.locator('[data-view="home"]').click();
  await page.locator('.action-btn[data-act="join"]').click();
  await expect(page.locator('#joinDialog')).toBeVisible();
  await expect(page.locator('#mid')).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(page.locator('#joinDialog')).toBeHidden();
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
