'use strict';
// Verdict for the artifact-pipeline PROOF (.github/workflows/playwright-artifact-proof.yml), computed from what really happened in the run:
// the outcome of every step, and the list of artifacts that GitHub reports for THIS run. The proof passes only if all three scenarios behaved as required.
//   PASS_RUN PASS_SCAN PASS_UPLOAD FAIL_RUN FAIL_SCAN FAIL_UPLOAD PLANTED_RUN PLANTED_SCAN PLANTED_UPLOAD   step outcomes (success | failure | skipped | cancelled)
//   node ci/verify-proof.cjs <artifacts.json>        (the response of GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts)
const fs = require('node:fs');

const DAY = 86400000;
const NAMES = { pass: 'playwright-proof-pass-report', fail: 'playwright-proof-failing-report', planted: 'playwright-proof-planted-report' };
const EXPECT = [
  { id: 'A', title: 'normal successful run: nothing is scanned or uploaded', key: 'PASS', run: 'success', scan: 'skipped', upload: 'skipped', artifact: null },
  { id: 'B', title: 'failing run, clean report: scanned, passes, uploaded for 7 days', key: 'FAIL', run: 'failure', scan: 'success', upload: 'success', artifact: NAMES.fail },
  { id: 'C', title: 'failing run, report with a planted credential: scan rejects it, nothing uploaded', key: 'PLANTED', run: 'failure', scan: 'failure', upload: 'skipped', artifact: null },
];
/** outcomes: { PASS_RUN: 'success', ... }; artifacts: the API response ({ total_count, artifacts: [{ name, size_in_bytes, created_at, expires_at, expired }] }). Returns { ok, rows, problems }. */
function verify(outcomes, artifacts) {
  const problems = [], rows = [], list = (artifacts && artifacts.artifacts) || [];
  if (!artifacts || typeof artifacts.total_count !== 'number') problems.push('the artifact list for this run could not be read: nothing can be proven');
  for (const e of EXPECT) {
    const got = { run: outcomes[e.key + '_RUN'], scan: outcomes[e.key + '_SCAN'], upload: outcomes[e.key + '_UPLOAD'] }, row = { id: e.id, title: e.title, got, ok: true };
    for (const step of ['run', 'scan', 'upload']) if (got[step] !== e[step]) { row.ok = false; problems.push(`scenario ${e.id}: the ${step} step ended "${got[step]}" but must end "${e[step]}"`); }
    const art = list.filter((a) => a.name === (e.artifact || NAMES[e.key.toLowerCase()]));
    if (e.artifact) {
      const a = art[0]; if (!a) { row.ok = false; problems.push(`scenario ${e.id}: the artifact "${e.artifact}" does not exist`); }
      else { const days = (Date.parse(a.expires_at) - Date.parse(a.created_at)) / DAY; row.retentionDays = Math.round(days * 100) / 100; row.sizeBytes = a.size_in_bytes;
        if (!(days > 6.9 && days < 7.1)) { row.ok = false; problems.push(`scenario ${e.id}: retention is ${row.retentionDays} days, not 7`); } if (a.expired) { row.ok = false; problems.push(`scenario ${e.id}: the artifact is already expired`); } if (!(a.size_in_bytes > 0)) { row.ok = false; problems.push(`scenario ${e.id}: the artifact is empty`); } }
    } else if (art.length) { row.ok = false; problems.push(`scenario ${e.id}: an artifact "${art[0].name}" EXISTS but nothing may be uploaded in this scenario`); }
    rows.push(row);
  }
  const unexpected = list.filter((a) => a.name !== NAMES.fail); if (unexpected.length) problems.push('unexpected artifact(s) in this run: ' + unexpected.map((a) => a.name).join(', '));
  if (list.length !== 1) problems.push(`exactly one artifact (scenario B) must exist for this run; found ${list.length}`);
  return { ok: problems.length === 0, rows, problems };
}
function main(argv) {
  const outcomes = {}; for (const k of ['PASS', 'FAIL', 'PLANTED']) for (const s of ['RUN', 'SCAN', 'UPLOAD']) outcomes[`${k}_${s}`] = process.env[`${k}_${s}`];
  let artifacts = null; try { artifacts = JSON.parse(fs.readFileSync(argv[0], 'utf8')); } catch { /* reported as a problem */ }
  const r = verify(outcomes, artifacts), md = ['### Playwright artifact pipeline proof', '', '| Scenario | Playwright run | Scan | Upload | Result |', '|---|---|---|---|---|', ...r.rows.map((x) => `| ${x.id}: ${x.title} | ${x.got.run} | ${x.got.scan} | ${x.got.upload}${x.retentionDays ? ` (retention ${x.retentionDays} days, ${x.sizeBytes} bytes)` : ''} | ${x.ok ? 'as required' : '**NOT as required**'} |`), ''];
  for (const p of r.problems) md.push('- FAIL: ' + p); md.push('', r.ok ? '**PROOF PASSED**: all three scenarios behaved as required.' : '**PROOF FAILED**');
  console.log(md.join('\n')); if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n'); return r.ok ? 0 : 1;
}
module.exports = { verify, NAMES, EXPECT };
if (require.main === module) process.exit(main(process.argv.slice(2)));
