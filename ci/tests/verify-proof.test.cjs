'use strict';
// The proof's verdict: exactly the required behaviour passes; every deviation fails.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verify, NAMES } = require('../verify-proof.cjs');
const GOOD = { PASS_RUN: 'success', PASS_SCAN: 'skipped', PASS_UPLOAD: 'skipped', FAIL_RUN: 'failure', FAIL_SCAN: 'success', FAIL_UPLOAD: 'success', PLANTED_RUN: 'failure', PLANTED_SCAN: 'failure', PLANTED_UPLOAD: 'skipped' };
const art = (over = {}) => ({ name: NAMES.fail, size_in_bytes: 1500000, created_at: '2026-11-01T10:00:00Z', expires_at: '2026-11-08T10:00:00Z', expired: false, ...over });
const api = (...a) => ({ total_count: a.length, artifacts: a });
const problems = (o, a) => verify({ ...GOOD, ...o }, a).problems;
const has = (ps, re) => ps.some((p) => re.test(p));

test('the required behaviour passes: A uploads nothing, B uploads one clean report for 7 days, C is rejected and uploads nothing', () => { const r = verify(GOOD, api(art())); assert.equal(r.ok, true, JSON.stringify(r.problems)); assert.deepEqual(r.rows.map((x) => x.ok), [true, true, true]); assert.equal(r.rows[1].retentionDays, 7); });
test('scenario A fails if a passing run is scanned or uploaded', () => {
  assert.ok(has(problems({ PASS_UPLOAD: 'success' }, api(art(), art({ name: NAMES.pass }))), /scenario A: the upload step ended "success"/)); assert.ok(has(problems({ PASS_SCAN: 'success' }, api(art())), /scenario A: the scan step/));
  assert.ok(has(problems({}, api(art(), art({ name: NAMES.pass }))), /scenario A: an artifact .* EXISTS/)); assert.ok(has(problems({ PASS_RUN: 'failure' }, api(art())), /scenario A: the run step ended "failure"/));
});
test('scenario B fails if the failing run was not scanned, not uploaded, uploaded for the wrong time, empty, or expired', () => {
  assert.ok(has(problems({ FAIL_UPLOAD: 'skipped' }, api()), /scenario B: the upload step ended "skipped"/)); assert.ok(has(problems({}, api()), /scenario B: the artifact .* does not exist/)); assert.ok(has(problems({ FAIL_SCAN: 'failure' }, api(art())), /scenario B: the scan step/));
  assert.ok(has(problems({}, api(art({ expires_at: '2026-11-30T10:00:00Z' }))), /retention is 29 days, not 7/)); assert.ok(has(problems({}, api(art({ expires_at: '2026-11-03T10:00:00Z' }))), /not 7/));
  assert.ok(has(problems({}, api(art({ size_in_bytes: 0 }))), /empty/)); assert.ok(has(problems({}, api(art({ expired: true }))), /already expired/)); assert.ok(has(problems({ FAIL_RUN: 'success' }, api(art())), /scenario B: the run step/));
});
test('scenario C fails if the planted credential was NOT rejected, or anything was uploaded for it', () => {
  assert.ok(has(problems({ PLANTED_SCAN: 'success', PLANTED_UPLOAD: 'success' }, api(art(), art({ name: NAMES.planted }))), /scenario C: the scan step ended "success" but must end "failure"/));
  assert.ok(has(problems({}, api(art(), art({ name: NAMES.planted }))), /scenario C: an artifact .* EXISTS/)); assert.ok(has(problems({ PLANTED_RUN: 'success' }, api(art())), /scenario C: the run step/));
  assert.ok(has(problems({ PLANTED_UPLOAD: 'failure' }, api(art())), /scenario C: the upload step ended "failure"/));
});
test('exactly one artifact may exist for the run, and an unreadable artifact list proves nothing', () => {
  assert.ok(has(problems({}, api(art(), art({ name: 'something-else' }))), /unexpected artifact/)); assert.ok(has(problems({}, api(art(), art())), /exactly one artifact/));
  for (const bad of [null, {}, { total_count: 'x' }]) assert.ok(has(problems({}, bad), /could not be read/));
  assert.ok(has(verify({}, api(art())).problems, /ended "undefined"/), 'missing outcomes are failures, not passes');
});
test('the command line: exit 0 only for the required behaviour; it also writes the step summary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-')), f = path.join(dir, 'a.json'), sum = path.join(dir, 'summary.md'), run = (o, a) => { fs.writeFileSync(f, JSON.stringify(a)); return spawnSync(process.execPath, [path.join(__dirname, '..', 'verify-proof.cjs'), f], { encoding: 'utf8', env: { ...process.env, ...o, GITHUB_STEP_SUMMARY: sum } }); };
  try { let r = run(GOOD, api(art())); assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /PROOF PASSED/); assert.match(fs.readFileSync(sum, 'utf8'), /Scenario \| Playwright run/); r = run({ ...GOOD, PLANTED_SCAN: 'success' }, api(art())); assert.equal(r.status, 1); assert.match(r.stdout, /PROOF FAILED/); assert.match(r.stdout, /NOT as required/);
    r = spawnSync(process.execPath, [path.join(__dirname, '..', 'verify-proof.cjs'), path.join(dir, 'missing.json')], { encoding: 'utf8', env: { ...process.env, ...GOOD } }); assert.equal(r.status, 1); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
