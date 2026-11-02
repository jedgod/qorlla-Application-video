// Browser end-to-end tests against the REAL unified deployment (nginx + MAIN + portal + Meet + PostgreSQL in Docker).
// Start it with cert/run-portal-cert.mjs (or follow docs/RUNBOOK.md) and export E2E_BASE / E2E_DB_CONTAINER.
const { defineConfig, devices } = require('@playwright/test');
const base = process.env.E2E_BASE || 'https://localhost:18443';
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.js/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 15000 },
  reporter: [['list'], ['json', { outputFile: process.env.E2E_JSON || 'e2e-results.json' }]],
  use: { baseURL: base, ignoreHTTPSErrors: true, headless: true, trace: 'off', screenshot: 'only-on-failure', permissions: ['camera', 'microphone'],
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--ignore-certificate-errors'] } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
