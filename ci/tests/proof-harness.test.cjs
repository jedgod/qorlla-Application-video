'use strict';
// The proof harness cannot quietly become a rubber stamp: its workflow wiring is pinned, and each way of weakening it is caught.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkProofWorkflow, steps } = require('../check-workflow-policy.cjs');
const ROOT = path.join(__dirname, '..', '..'), FILE = path.join(ROOT, '.github', 'workflows', 'playwright-artifact-proof.yml'), REAL = fs.readFileSync(FILE, 'utf8');
const mutate = (from, to) => { assert.ok(REAL.includes(from), 'the real proof workflow no longer contains: ' + from.slice(0, 70)); return REAL.replace(from, to); };
const has = (text, re) => checkProofWorkflow(text).some((p) => re.test(p));
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('the real proof workflow satisfies its policy', () => { assert.deepEqual(checkProofWorkflow(REAL), []); });
test('the workflow has the three scenarios in order with their ids, and a verdict after every upload', () => {
  const ids = steps(REAL).map((s) => s.id).filter(Boolean); assert.deepEqual(ids, ['pass_run', 'pass_scan', 'pass_upload', 'fail_run', 'fail_scan', 'fail_upload', 'planted_run', 'planted_scan', 'planted_upload']);
  const all = steps(REAL), verdict = all.findIndex((s) => /verify-proof\.cjs/.test(s.text)); assert.ok(verdict > all.findIndex((s) => s.id === 'planted_upload'));
});
test('BROKEN: the intentionally failing runs must be allowed to fail, and the scans must not hide failures (except the planted one)', () => {
  assert.ok(has(mutate('id: planted_run\n        continue-on-error: true', 'id: planted_run'), /planted_run must be continue-on-error/)); assert.ok(has(mutate('id: fail_run\n        continue-on-error: true', 'id: fail_run'), /fail_run must be continue-on-error/));
  assert.ok(has(mutate('id: pass_scan\n', 'id: pass_scan\n        continue-on-error: true\n'), /pass_scan must not be continue-on-error/)); assert.ok(has(mutate('id: fail_scan\n', 'id: fail_scan\n        continue-on-error: true\n'), /fail_scan must not be continue-on-error/));
});
test('BROKEN: an upload that does not need its scan, runs unconditionally, lasts longer than 7 days, or carries more than its report', () => {
  assert.ok(has(mutate(" && steps.fail_scan.outcome == 'success' }}", ' }}'), /fail_upload must require the run to have failed AND its scan to have succeeded/));
  assert.ok(has(mutate("if: ${{ !cancelled() && steps.planted_run.outcome == 'failure' && steps.planted_scan.outcome == 'success' }}", 'if: always()'), /planted_upload must require/));
  assert.ok(has(mutate('name: playwright-proof-failing-report\n          path: proof-report-fail/\n          retention-days: 7', 'name: playwright-proof-failing-report\n          path: proof-report-fail/\n          retention-days: 30'), /fail_upload: retention-days must be between 1 and 7/));
  for (const p of ['.', '**', 'proof-report-planted/\n            proof-report-fail/']) assert.ok(has(mutate('path: proof-report-planted/', 'path: ' + p), /planted_upload: the only path may be proof-report-planted\//), p);
  assert.ok(has(mutate('path: proof-report-planted/\n          retention-days: 7\n          if-no-files-found: error', 'path: proof-report-planted/\n          retention-days: 7\n          if-no-files-found: ignore'), /planted_upload: if-no-files-found must be "error"/));
});
test('BROKEN: the scans must run the real scanner with the reviewed allowlist and the attestation, only after a failed run', () => {
  assert.ok(has(mutate('node ci/scan-playwright-report.cjs proof-report-planted --allowlist ci/artifact-scan-allowlist.json', 'echo scanned proof-report-planted'), /planted_scan must run the real scanner/));
  assert.ok(has(mutate('node ci/scan-playwright-report.cjs proof-report-fail --allowlist ci/artifact-scan-allowlist.json', 'node ci/scan-playwright-report.cjs proof-report-fail'), /fail_scan must run the real scanner/));
  assert.ok(has(mutate("steps.fail_run.outcome == 'failure' && hashFiles('proof-report-fail/**') != ''", "hashFiles('proof-report-fail/**') != ''"), /fail_scan must run only when fail_run failed/));
});
test('BROKEN: the planted canary must be random, masked and never a literal', () => {
  assert.ok(has(mutate('echo "::add-mask::$PROOF_CANARY"', 'true'), /canary must be generated at run time/)); assert.ok(has(mutate('PROOF_CANARY="$(openssl rand -hex 24)"', 'PROOF_CANARY="0123456789abcdef0123456789abcdef"'), /canary must be generated at run time/));
});
test('BROKEN: the verdict must read every real outcome and this run\'s artifact list', () => {
  assert.ok(has(mutate('          PLANTED_SCAN: ${{ steps.planted_scan.outcome }}\n', ''), /verdict step must read PLANTED_SCAN/)); assert.ok(has(mutate('PASS_RUN: ${{ steps.pass_run.outcome }}', 'PASS_RUN: success'), /verdict step must read PASS_RUN/));
  assert.ok(has(mutate('actions/runs/${{ github.run_id }}/artifacts', 'actions/artifacts'), /artifact list of THIS run/)); assert.ok(!checkProofWorkflow(REAL).length);
  assert.ok(has(mutate('node ci/verify-proof.cjs artifacts.json', 'echo verdict skipped'), /verdict step running ci\/verify-proof\.cjs/));
});
test('BROKEN: permissions and triggers stay minimal', () => {
  assert.ok(has(mutate('contents: read', 'contents: write'), /must not request any write permission/)); assert.ok(has(mutate('  actions: read\n', ''), /actions: read/));
  for (const t of ['pull_request_target:', 'workflow_run:', 'schedule:']) assert.ok(has(mutate('  workflow_dispatch:', '  workflow_dispatch:\n  ' + t), /must not run on pull_request_target/), t);
});
test('BROKEN: cluster hygiene: raw logs, direct compose, printing the environment, teardown that can be skipped, tests after the cluster starts', () => {
  assert.ok(has(mutate('bash ci/cluster.sh diagnostics', 'docker compose logs --tail=100'), /raw "docker compose logs" is forbidden/)); assert.ok(has(mutate('bash ci/cluster.sh up', 'docker compose up -d'), /only through ci\/cluster\.sh/));
  assert.ok(has(mutate('bash ci/cluster.sh check', 'printenv'), /could print the environment/)); assert.ok(has(mutate('        if: always()\n        run: |\n          bash ci/cluster.sh down', '        run: |\n          bash ci/cluster.sh down'), /teardown must run under always\(\)/));
  assert.ok(has(mutate('        if: failure()\n        run: |\n          bash ci/cluster.sh diagnostics', '        run: |\n          bash ci/cluster.sh diagnostics'), /diagnostics must run on failure\(\)/));
  const real = steps(REAL), self = real.find((x) => /node --test ci\/tests\//.test(x.text)).text, up = real.find((x) => /cluster\.sh up/.test(x.text)).text; assert.ok(has(REAL.replace(self, '@@S@@').replace(up, up + '\n' + self).replace('@@S@@', ''), /self-tests must run before the cluster starts/));
});

// ---- the specs and configuration
test('the proof configuration builds on the committed one (git capture stays off) and uses the cluster instead of its own server', () => {
  const cfg = read('ci', 'proof', 'playwright.proof.config.cjs'); assert.match(cfg, /require\('\.\.\/\.\.\/playwright\.config\.js'\)/); assert.match(cfg, /\.\.\.base,/); assert.match(cfg, /webServer:\s*undefined/); assert.match(cfg, /retries:\s*1/); assert.match(cfg, /trace:\s*'on-first-retry'/); assert.match(cfg, /\.proof\\\.js\$/);
  assert.match(read('playwright.config.js'), /captureGitInfo:\s*\{\s*commit:\s*false,\s*diff:\s*false\s*\}/, 'the base keeps git capture off, which the proof config spreads');
});
test('the specs: A passes, B fails on purpose with a clean request, C fails on purpose after sending a canary three ways, never a literal credential', () => {
  const a = read('ci', 'proof', 'specs', 'pass.proof.js'), b = read('ci', 'proof', 'specs', 'fail.proof.js'), c = read('ci', 'proof', 'specs', 'planted.proof.js');
  assert.ok(!/\.toBe\(|\.toHaveTitle\(|\.toEqual\(/.test(a) && /toBeTruthy/.test(a), 'A makes only "it answers" assertions (no exact-value expectation that could fail)'); assert.ok(!/toBe\(\s*2\s*\)|deliberately wrong/.test(a), 'A contains no deliberate failure'); assert.match(b, /INTENTIONAL FAILURE/); assert.ok(!/Authorization|access_token|password/i.test(b), 'B sends nothing sensitive');
  assert.match(c, /process\.env\.PROOF_CANARY/); assert.match(c, /Authorization: 'Bearer '/); assert.match(c, /access_token=/); assert.match(c, /password: canary/); assert.match(c, /INTENTIONAL FAILURE/);
  for (const [n, t] of [['pass', a], ['fail', b], ['planted', c]]) assert.ok(!/\b[0-9a-f]{24,}\b|eyJ[A-Za-z0-9_-]{10,}\./.test(t), n + ' spec contains a credential-shaped literal');
});
