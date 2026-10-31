// Scenario B: an INTENTIONALLY FAILING test whose report is clean. The pipeline must scan it, find nothing, and upload it for seven days.
// The failure is on purpose: it is what makes Playwright produce a report with a trace (recorded on the retry) and a screenshot. Nothing sensitive is sent.
const { test, expect } = require('@playwright/test');

test('proof B: fails on purpose after visiting the cluster, so a report with a trace and a screenshot exists', async ({ request, page }) => {
  await request.get('/');
  await page.goto('/');
  expect(await page.title(), 'INTENTIONAL FAILURE for the artifact pipeline proof: this expectation is deliberately wrong').toBe('__this title is deliberately wrong__');
});
