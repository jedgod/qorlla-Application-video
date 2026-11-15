const { defineConfig, devices } = require('@playwright/test');
const path = require('path');
const os = require('os');

const port = process.env.PLAYWRIGHT_PORT || '5100';
if (!/^\d+$/.test(port)) throw new Error('PLAYWRIGHT_PORT must be a numeric port.');
const baseURL = 'http://localhost:' + port;
// Keep test accounts and meetings separate from the application's real data.
const testData = path.join(os.tmpdir(), 'qorlla-playwright-' + process.pid + '-' + Date.now());
const testServerPidFile = path.join(testData, 'server.pid');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: 'html',
  metadata: { testServerPidFile },
  globalTeardown: require.resolve('./scripts/playwright-teardown.cjs'),
  webServer: {
    command: 'node scripts/playwright-server.cjs',
    url: baseURL + '/api/health',
    // A browser run must never inherit SMTP, bridge or database production wiring.
    env: {
      PORT: port, DATA_DIR: testData, SIGNUP_LIMIT: '100', NODE_ENV: 'test', QORLLA_TEST_PID_FILE: testServerPidFile,
      DOTENV_PATH: path.join(testData, 'missing.env'), DATABASE_URL: '',
      QORLLA_BRIDGE_SECRET: '', ENCRYPT_KEY: '', ENCRYPT_KEY_OLD: '',
      SMTP_URL: '', SMTP_FROM: '', PUBLIC_URL: baseURL,
      CORS_ALLOWED_ORIGINS: '', MEET_PUBLIC_URL: ''
    },
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
