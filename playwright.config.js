const { defineConfig, devices } = require('@playwright/test');
const path = require('path');
const os = require('os');

const port = process.env.PLAYWRIGHT_PORT || '5100';
if (!/^\d+$/.test(port)) throw new Error('PLAYWRIGHT_PORT must be a numeric port.');
const baseURL = 'http://localhost:' + port;
// Keep test accounts and meetings separate from the application's real data.
const testData = path.join(os.tmpdir(), 'qorlla-playwright-' + process.pid + '-' + Date.now());

module.exports = defineConfig({
  testDir: './tests',
  testMatch: /.*.spec.js$/,          // *.test.mjs files are node:test suites (PostgreSQL lockout) run with `node --test`, never by Playwright
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: 'html',
  webServer: {
    command: 'node server.js',
    url: baseURL + '/api/health',
    env: { PORT: port, DATA_DIR: testData, GUEST_RATE_LIMIT_MAX: '5000', MEET_DETECT: 'off' },
    reuseExistingServer: false,
    timeout: 30000
  },
  use: {
    baseURL,
    trace: 'on-first-retry',
    headless: true
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
