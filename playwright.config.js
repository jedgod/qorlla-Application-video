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
  // On CI Playwright embeds the git commit (author and committer name and e-mail, the commit message body, the branch) and a source diff in the HTML report, which this repository's pipeline may upload as a public artifact.
  // Nothing in the report needs them, so they are switched off at the source; ci/scan-playwright-report.cjs is the safety net if they ever come back.
  captureGitInfo: { commit: false, diff: false },
  webServer: {
    command: 'node server.js',
    url: baseURL + '/api/health',
    env: { PORT: port, DATA_DIR: testData, GUEST_RATE_LIMIT_MAX: '5000' },
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
