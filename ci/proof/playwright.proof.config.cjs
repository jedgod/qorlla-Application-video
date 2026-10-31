'use strict';
// Playwright configuration for the artifact-pipeline PROOF scenarios (.github/workflows/playwright-artifact-proof.yml).
// It builds on the committed playwright.config.js, so the safeguards there (captureGitInfo off, trace on first retry) apply unchanged, and points at the disposable cluster instead of starting its own server.
// The specs are synthetic: one passes, one fails on purpose, one fails on purpose after sending a canary credential so the report really contains one.
const path = require('node:path');
const base = require('../../playwright.config.js');

module.exports = {
  ...base,
  testDir: path.join(__dirname, 'specs'),
  testMatch: /.*\.proof\.js$/,
  webServer: undefined,                                   // the cluster is already up (ci/cluster.sh up)
  fullyParallel: false,
  workers: 1,
  retries: 1,                                             // the trace is recorded on the retry
  // Playwright resolves a RELATIVE outputFolder against the directory of the config file (ci/proof/), not the working directory; the workflow scans and uploads from the repository root, so the folder is made absolute here.
  reporter: [['html', { outputFolder: path.resolve(process.cwd(), process.env.PROOF_REPORT_DIR || 'playwright-report'), open: 'never' }]],
  use: { ...base.use, baseURL: process.env.PROOF_BASE_URL || 'http://localhost:8080', trace: 'on-first-retry', screenshot: 'only-on-failure' },
};
