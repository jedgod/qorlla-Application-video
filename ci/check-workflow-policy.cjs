'use strict';
// Static policy for how .github/workflows/workspace-ci.yml may upload the Playwright report from this PUBLIC repository.
//   node ci/check-workflow-policy.cjs [workflow file]        exit 0 = policy holds, 1 = violations
// The scanner is only useful if the pipeline cannot reach an upload without it. This checks the wiring (order, conditions, retention, paths), so that a later edit that makes the upload unconditional,
// longer-lived, or independent of the scan fails CI before it can leak anything.
const fs = require('node:fs');
const path = require('node:path');

/** Every path an upload step lists. `path:` may be a single value or a multi-line value (each line another path to upload), so the lines indented under the key are part of it. */
function pathList(stepText) {
  const m = /^([ \t]*)path:[ \t]*([^\n]*)((?:\n(?:\1[ \t]+[^\n]*|[ \t]*))*)/m.exec(stepText); if (!m) return [];
  return `${m[2]}\n${m[3]}`.split('\n').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter((x) => x && !/^[|>][-+]?$/.test(x) && !x.startsWith('#'));
}
/** Splits the steps of the (single) job: every line that starts a list item at the step indentation begins one; comment lines and blank lines between steps are not part of a step. */
function steps(text) {
  const out = []; let cur = null;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^ {6}- /.test(line)) { cur = { line: i + 1, lines: [line] }; out.push(cur); }
    else if (/^ {6}#/.test(line) || (/^\S/.test(line) && line.trim())) cur = null;
    else if (cur) cur.lines.push(line);
  });
  return out.map((s) => { const t = s.lines.join('\n'), g = (re) => { const m = re.exec(t); return m ? m[1].trim() : null; };
    return { line: s.line, text: t, name: g(/\bname:\s*(.+)/), id: g(/^\s*(?:- )?id:\s*(\S+)/m), cond: g(/^\s*if:\s*(.+)/m), uses: g(/\buses:\s*(\S+)/), retention: g(/retention-days:\s*(\d+)/), noFiles: g(/if-no-files-found:\s*(\S+)/), paths: pathList(t), run: (/^\s*run:\s*\|?\s*\n?([\s\S]*?)(?=^\s*(?:env|with|if|id|name|uses):|$(?![\s\S]))/m.exec(t) || [null, ''])[1] }; });
}
function checkWorkflowPolicy(text) {
  const problems = [], bad = (m) => problems.push(m), all = steps(text), idx = (pred) => all.findIndex(pred);
  const uploads = all.filter((s) => /^actions\/upload-artifact@/.test(s.uses || ''));
  const iPw = idx((s) => s.id === 'playwright'), iScan = idx((s) => s.id === 'scan'), iSelf = idx((s) => /node --test ci\/tests\/\*\.test\.cjs/.test(s.text)), iUp = idx((s) => /^actions\/upload-artifact@/.test(s.uses || ''));
  if (iPw < 0) bad('the Playwright step must have "id: playwright" so later steps can depend on its outcome');
  if (iScan < 0) bad('there must be a step with "id: scan" that scans the report before any upload');
  if (iSelf < 0) bad('there must be a step that self-tests the scanner and this policy ("node --test ci/tests/*.test.cjs")'); else if (iPw >= 0 && iSelf > iPw) bad('the scanner self-test must run BEFORE the Playwright step');
  if (iPw >= 0 && iScan >= 0 && iScan < iPw) bad('the scan must come after the Playwright step');
  if (iScan >= 0) {
    const s = all[iScan];
    if (!/node ci\/scan-playwright-report\.cjs\s+playwright-report\b/.test(s.text)) bad('the scan step must run "node ci/scan-playwright-report.cjs playwright-report"');
    if (!/--allowlist\s+ci\/artifact-scan-allowlist\.json/.test(s.text)) bad('the scan step must use the reviewed allowlist ci/artifact-scan-allowlist.json');
    if (/continue-on-error:\s*true/.test(s.text)) bad('the scan step must not be allowed to fail silently (continue-on-error)');
    if (!/QORLLA_CI_SYNTHETIC_DATA:\s*'?1'?/.test(s.text)) bad('the scan step must carry the synthetic-data attestation (QORLLA_CI_SYNTHETIC_DATA)');
    if (s.cond && /always\(\)/.test(s.cond)) bad('the scan step must not run under always()');
  }
  if (uploads.length === 0) bad('no upload step found: the policy checks the upload, so it must exist (or this file must be updated deliberately)');
  uploads.forEach((s) => {
    const where = `upload step at line ${s.line}`, c = s.cond || '';
    if (!(Number(s.retention) >= 1 && Number(s.retention) <= 7)) bad(`${where}: retention-days must be between 1 and 7 (found ${s.retention || 'none'})`);
    if (/always\(\)/.test(c) || !c) bad(`${where}: must not be unconditional or always()`);
    if (!/steps\.playwright\.outcome\s*==\s*'failure'/.test(c)) bad(`${where}: must run only when the Playwright tests failed (steps.playwright.outcome == 'failure')`);
    if (!/steps\.scan\.outcome\s*==\s*'success'/.test(c)) bad(`${where}: must require the scan to have succeeded (steps.scan.outcome == 'success')`);
    if (s.noFiles !== 'error') bad(`${where}: if-no-files-found must be "error"`);
    if (/continue-on-error:\s*true/.test(s.text)) bad(`${where}: continue-on-error is not allowed`);
    if (s.paths.length !== 1 || s.paths[0] !== 'playwright-report/') bad(`${where}: the only path that may be uploaded is exactly one: "playwright-report/" (found ${JSON.stringify(s.paths)})`);
  });
  if (iUp >= 0 && iScan >= 0 && iUp < iScan) bad('the upload must come AFTER the scan');
  // ---- the disposable cluster: secrets and public-log hygiene. Everything goes through ci/cluster.sh, which carries the ephemeral environment, prints nothing sensitive and always tears down.
  const code = (s) => s.text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'), via = (cmd) => idx((s) => new RegExp('bash ci/cluster\\.sh ' + cmd + '\\b').test(code(s)));
  for (const s of all) {
    const c = code(s), where = `step at line ${s.line}`;
    if (/docker[- ]compose\s+(?:--env-file\s+\S+\s+)?logs\b/.test(c)) bad(`${where}: raw "docker compose logs" is forbidden in this public pipeline; use "bash ci/cluster.sh diagnostics" (sanitized)`);
    if (/docker[- ]compose\b[^\n]*\b(up|down|config|exec|run)\b/.test(c)) bad(`${where}: call compose only through ci/cluster.sh (it passes the ephemeral environment, never prints the resolved configuration and always tears down)`);
    if (/(^|[\s;&|])(printenv|env)(\s*$|\s*\||\s*>|\s+-0)/m.test(c) || /\bset\s+-[a-z]*x/.test(c) || /\bcat\s+\S*\.env\b/.test(c) || /\bcat\s+"?\$\{?(QORLLA_CI_ENV_FILE|RUNNER_TEMP)/.test(c)) bad(`${where}: it could print the environment or a secret (printenv, env, set -x, cat of an env file)`);
    if (/\.env\b/.test(c) && /\b(cp|copy|echo|tee)\b[^\n]*\.env\b/.test(c)) bad(`${where}: do not write a .env file into the workspace; the ephemeral environment lives in $RUNNER_TEMP`);
  }
  const iPrep = via('prepare'), iCheck = via('check'), iUpC = via('up'), iDiag = via('diagnostics'), iDown = via('down');
  if (iPrep < 0 || iCheck < 0 || iUpC < 0) bad('the cluster must be started with "bash ci/cluster.sh prepare", then "check", then "up"'); else if (!(iPrep < iCheck && iCheck < iUpC)) bad('cluster order must be prepare, then check, then up');
  if (iPw >= 0 && iUpC >= 0 && iUpC > iPw) bad('the cluster must be up before the Playwright step');
  if (iDiag < 0 || !/failure\(\)/.test(all[iDiag].cond || '')) bad('sanitized diagnostics ("bash ci/cluster.sh diagnostics") must run on failure()');
  if (iDown < 0 || !/always\(\)/.test(all[iDown].cond || '')) bad('teardown ("bash ci/cluster.sh down") must run under always() so containers and volumes are removed even on failure');
  return problems;
}
function main(argv) {
  const file = path.resolve(argv[0] || path.join(__dirname, '..', '.github', 'workflows', 'workspace-ci.yml')), problems = checkWorkflowPolicy(fs.readFileSync(file, 'utf8'));
  console.log(`checked ${path.basename(file)}`); for (const p of problems) console.log('FAIL ' + p); console.log(problems.length ? 'WORKFLOW POLICY VIOLATED' : 'workflow policy holds: ephemeral secrets, compose only through ci/cluster.sh, sanitized diagnostics, teardown always; self-test, then tests, then a fail-closed scan, then an upload only on failure with a passing scan, kept 7 days'); return problems.length ? 1 : 0;
}
module.exports = { checkWorkflowPolicy, steps };
if (require.main === module) process.exit(main(process.argv.slice(2)));
