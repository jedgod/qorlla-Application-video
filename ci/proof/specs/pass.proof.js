// Scenario A: a normal SUCCESSFUL Playwright run against the disposable cluster. The pipeline must upload NOTHING for it.
const { test, expect } = require('@playwright/test');

test('proof A: the cluster answers and the page loads (passes)', async ({ request, page }) => {
  const res = await request.get('/');
  expect(res.ok(), 'the proxy answers').toBeTruthy();
  await page.goto('/');
  expect(await page.title()).toBeTruthy();
});
