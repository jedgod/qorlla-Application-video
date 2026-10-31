'use strict';
// The upload policy holds for the real workflow, and each way of breaking it is caught.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkWorkflowPolicy, steps } = require('../check-workflow-policy.cjs');
const FILE = path.join(__dirname, '..', '..', '.github', 'workflows', 'workspace-ci.yml'), REAL = fs.readFileSync(FILE, 'utf8');
const mutate = (from, to) => { assert.ok(REAL.includes(from), 'the real workflow no longer contains: ' + from.slice(0, 60)); return REAL.replace(from, to); };
const violations = (text) => checkWorkflowPolicy(text);
const has = (text, re) => violations(text).some((p) => re.test(p));

test('the real workflow satisfies the policy', () => { assert.deepEqual(violations(REAL), []); const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'check-workflow-policy.cjs')], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /policy holds/); });
test('the step splitter finds the wiring: self-test, playwright, scan, upload, in that order', () => {
  const s = steps(REAL), at = (f) => s.findIndex(f), self = at((x) => /node --test ci\/tests\/\*\.test\.cjs/.test(x.text)), pw = at((x) => x.id === 'playwright'), scan = at((x) => x.id === 'scan'), up = at((x) => /upload-artifact/.test(x.uses || ''));
  assert.ok(self >= 0 && self < pw && pw < scan && scan < up, JSON.stringify({ self, pw, scan, up })); assert.equal(s[up].retention, '7'); assert.equal(s[up].noFiles, 'error');
});
test('BROKEN: retention longer than seven days', () => { assert.ok(has(mutate('retention-days: 7', 'retention-days: 30'), /retention-days must be between 1 and 7/)); assert.ok(has(mutate('retention-days: 7\n', ''), /retention-days must be between 1 and 7/)); });
test('BROKEN: an upload that does not need the scan, that runs on success, or that is unconditional', () => {
  assert.ok(has(mutate("&& steps.scan.outcome == 'success' }}", '}}'), /must require the scan to have succeeded/));
  assert.ok(has(mutate("steps.playwright.outcome == 'failure' && steps.scan.outcome", "steps.playwright.outcome != 'failure' && steps.scan.outcome"), /must run only when the Playwright tests failed/));
  assert.ok(has(mutate("if: ${{ !cancelled() && steps.playwright.outcome == 'failure' && steps.scan.outcome == 'success' }}", 'if: always()'), /must not be unconditional or always\(\)/));
  assert.ok(has(mutate("        if: ${{ !cancelled() && steps.playwright.outcome == 'failure' && steps.scan.outcome == 'success' }}\n", ''), /must not be unconditional/));
});
test('BROKEN: the upload may not fail silently, tolerate an empty report, or carry more than the report', () => {
  assert.ok(has(mutate('if-no-files-found: error', 'if-no-files-found: ignore'), /if-no-files-found must be "error"/));
  assert.ok(has(mutate('          if-no-files-found: error', '          if-no-files-found: error\n          continue-on-error: true'), /continue-on-error is not allowed/));
  for (const p of ['.', '**', 'playwright-report/\n            test-results/', 'dist/', '/']) assert.ok(has(mutate('path: playwright-report/', 'path: ' + p), /only path that may be uploaded/), p);
});
test('BROKEN: the scan is missing, mis-ordered, optional, run without the allowlist or without the attestation', () => {
  assert.ok(has(mutate('id: scan', 'id: scanning'), /"id: scan"/)); assert.ok(has(mutate('node ci/scan-playwright-report.cjs playwright-report', 'echo skipped playwright-report'), /must run "node ci\/scan-playwright-report\.cjs/));
  assert.ok(has(mutate(' --allowlist ci/artifact-scan-allowlist.json', ''), /reviewed allowlist/)); assert.ok(has(mutate("          QORLLA_CI_SYNTHETIC_DATA: '1'", "          UNRELATED: 'x'"), /synthetic-data attestation/));
  assert.ok(has(mutate('        id: scan\n', '        id: scan\n        continue-on-error: true\n'), /must not be allowed to fail silently/));
  // upload moved in front of the scan
  const real = steps(REAL), scanStep = real.find((x) => x.id === 'scan').text, upStep = real.find((x) => /upload-artifact/.test(x.uses || '')).text; assert.ok(has(REAL.replace(scanStep, '@@S@@').replace(upStep, scanStep).replace('@@S@@', upStep), /upload must come AFTER the scan|must come after the Playwright|scan must come after/));
});
test('BROKEN: the scanner is not self-tested before the tests run, or the Playwright step cannot be referenced', () => {
  assert.ok(has(mutate('node --test ci/tests/*.test.cjs', 'echo no self test'), /self-tests the scanner/)); assert.ok(has(mutate('id: playwright', 'id: pw'), /"id: playwright"/));
  const real = steps(REAL), self = real.find((x) => /node --test ci\/tests\/\*\.test\.cjs/.test(x.text)).text, pw = real.find((x) => x.id === 'playwright').text; assert.ok(has(REAL.replace(self, '@@S@@').replace(pw, pw + '\n' + self).replace('@@S@@', ''), /self-test must run BEFORE/));
});
test('BROKEN: a second, unguarded upload step is caught; with no upload at all the policy asks for an explicit update', () => {
  const extra = REAL.replace('      # 10) Teardown', "      - name: Archive everything\n        uses: actions/upload-artifact@v4\n        with:\n          name: all\n          path: .\n\n      # 10) Teardown"); assert.ok(violations(extra).length >= 3, JSON.stringify(violations(extra)));
  const none = REAL.replace(/      - name: Archive the Playwright report[\s\S]*?if-no-files-found: error\n/, ''); assert.ok(has(none, /no upload step found/));
});
