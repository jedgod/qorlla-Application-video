const { test, expect } = require('@playwright/test');
const { measureOverflow } = require('./support/overflow');

test('account tabs expose selection and support arrow-key navigation', async ({ page }) => {
  await page.goto('/login.html?standalone=1');
  await page.locator('#tabIn').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tabUp')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tabUp')).toBeFocused();
  await expect(page.locator('#displayName')).toBeVisible();
  await expect(page.locator('#password')).toHaveAttribute('minlength', '8');
  await page.keyboard.press('Home');
  await expect(page.locator('#tabIn')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#displayName')).toBeHidden();
});

test('account creation, recovery-code acknowledgement, and authenticated chat work', async ({ page }) => {
  await page.goto('/login.html?standalone=1');
  await page.locator('#tabUp').click();
  await page.locator('#username').fill('qa_'+Date.now().toString().slice(-10));
  await page.locator('#displayName').fill('Alex Morgan');
  await page.locator('#password').fill('Product-test-7214!');
  await page.locator('#go').click();
  await expect(page.locator('#pCodes')).toBeVisible();
  await expect(page.locator('#codeList span')).toHaveCount(10);
  await expect(page.locator('#codesDone')).toBeDisabled();
  await page.locator('#savedBox').check();
  await page.locator('#codesDone').click();
  await expect(page).toHaveURL(/qorlla\.html/);
  await expect(page.locator('#greeting')).toContainText('Alex Morgan');
  await page.locator('[data-act="chat"]').click();
  await expect(page).toHaveURL(/chat\.html/);
  await expect(page.locator('.sidebar-header')).toContainText('Chat');
});

for (const locale of ['en','fr','pt-PT']) {
  test('phone layouts remain usable in '+locale, async ({ page }) => {
    await page.setViewportSize({ width:390, height:844 });
    await page.addInitScript(value => localStorage.setItem('qorlla.locale',value),locale);
    for (const url of ['/login.html?standalone=1','/','/index.html']) {
      await page.goto(url);
      await expect(page.locator('html')).toHaveAttribute('lang',locale);
      await expect(page.locator('[data-language-select]')).toBeVisible();
      const m = await measureOverflow(page); expect(m.scrollWidth <= m.innerWidth, 'horizontal overflow at ' + url + ': ' + JSON.stringify(m)).toBe(true);
    }
  });
}
