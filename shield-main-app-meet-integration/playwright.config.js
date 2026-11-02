const { defineConfig, devices } = require('@playwright/test');
const path = require('path');
const os = require('os');

const port = process.env.PLAYWRIGHT_PORT || '5100';
if (!/^\d+$/.test(port)) throw new Error('PLAYWRIGHT_PORT must be a numeric port.');
const baseURL = 'http://localhost:' + port;
// Keep test accounts and meetings separate from the application's real data.
const testData = path.join(os.tmpdir(), 'qorlla-playwright-' + process.pid + '-' + Date.now());

const FAKE_MEDIA = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];   // a synthetic camera and microphone: tests never touch real hardware

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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: FAKE_MEDIA } } },
    // opt-in: Microsoft Edge (the installed browser, Chromium engine): E2E_EDGE=1 npx playwright test --project=edge
    ...(process.env.E2E_EDGE ? [{ name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge', launchOptions: { args: FAKE_MEDIA } } }] : []),
    // opt-in: WebKit, the engine Safari uses (NOT Safari itself, and no synthetic microphone: microphone tests are skipped there): E2E_WEBKIT=1 npx playwright test --project=webkit
    ...(process.env.E2E_WEBKIT ? [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }] : []),
    // opt-in: a phone-sized touch device (Chromium engine; NOT a real phone): E2E_MOBILE=1 npx playwright test --project=mobile
    ...(process.env.E2E_MOBILE ? [{ name: 'mobile', use: { ...devices['Pixel 7'], launchOptions: { args: FAKE_MEDIA } } }] : []),
    // opt-in second browser: E2E_FIREFOX=1 npx playwright test --project=firefox   (fake camera/microphone through Firefox preferences)
    ...(process.env.E2E_FIREFOX ? [{ name: 'firefox', use: { ...devices['Desktop Firefox'], launchOptions: { firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true } } } }] : [])
  ]
});
