// Controlled A/B for the Meet regression question. NOT a Playwright spec: a driver that runs the same Meet spec(s) alternately against
//   NEW  = the current Meet build (isolated project "qai": has the Qorlla AI consent changes)
//   BASE = Meet exactly as it was before any of those changes (isolated project "qbase", built from commit 5e74232)
// alternating the order every round so host-load drift hits both equally, recording the host CPU load of every run, and keeping the trace, screenshot and browser console of EVERY failure.
//   node e2e/ab-meet-regression.cjs <rounds> <outDir> [grep]
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const rounds = Number(process.argv[2] || 10), out = path.resolve(process.argv[3] || 'meet-regression'), grep = process.argv[4] || 'fits the window';
const TARGETS = { NEW: { base: 'http://localhost:3900', project: 'qai', main: 'qai_main' }, BASE: { base: 'http://localhost:4500', project: 'qbase', main: 'qbase_main' } };
fs.mkdirSync(out, { recursive: true });
const load = () => { const r = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'], { encoding: 'utf8' }); return Number(String(r.stdout).trim()) || null; };
const results = [];
function runOne(round, name, spec) {
  const t = TARGETS[name], dir = path.join(out, `r${String(round).padStart(2, '0')}-${name}-${spec.replace(/\W+/g, '_')}`); fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, E2E_BASE: t.base, E2E_COMPOSE_PROJECT: t.project, E2E_DB_CONTAINER: t.project + '-main-db-1', E2E_MAIN_CONTAINER: t.main, E2E_JSON: path.join(dir, 'result.json') };
  const l0 = load(), t0 = Date.now();
  const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['playwright', 'test', '--config', 'e2e/playwright.config.cjs', `e2e/${spec}`, '-g', grep, '--reporter=json', '--trace', 'retain-on-failure', '--output', path.join(dir, 'artifacts')], { env, encoding: 'utf8', shell: process.platform === 'win32', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  const ms = Date.now() - t0; let status = 'unknown', error = null, tests = 0;
  try { const j = JSON.parse(r.stdout); const walk = (s) => { for (const x of s.specs || []) for (const tt of x.tests) { tests += 1; const res = tt.results[tt.results.length - 1]; if (res.status !== 'passed') { status = res.status; error = (res.error && res.error.message || '').split('\n').slice(0, 6).join('\n'); } } (s.suites || []).forEach(walk); }; status = 'passed'; j.suites.forEach(walk); if (!tests) status = 'no tests ran'; } catch { status = r.status === 0 ? 'passed' : 'failed (unparsed)'; error = String(r.stderr || '').slice(0, 400); }
  fs.writeFileSync(path.join(dir, 'stdout.json'), r.stdout || ''); fs.writeFileSync(path.join(dir, 'stderr.txt'), r.stderr || '');
  const row = { round, target: name, spec, grep, status, ms, hostLoadBefore: l0, hostLoadAfter: load(), error, evidence: status === 'passed' ? null : path.relative(out, dir) };
  results.push(row); console.log(`${row.round} ${row.target.padEnd(4)} ${spec.padEnd(26)} ${status.padEnd(8)} ${String(ms).padStart(6)}ms load ${row.hostLoadBefore}->${row.hostLoadAfter}`);
  if (status === 'passed') fs.rmSync(path.join(dir, 'artifacts'), { recursive: true, force: true });                  // keep traces only for failures
  return row;
}
const specFor = (g) => (/route|two browsers/.test(g) ? 'meet-route.spec.js' : 'meet-controls.spec.js');
for (let i = 1; i <= rounds; i += 1) { for (const name of (i % 2 ? ['NEW', 'BASE'] : ['BASE', 'NEW'])) runOne(i, name, specFor(grep)); }
const sum = {}; for (const r of results) { const k = r.target; sum[k] ??= { runs: 0, passed: 0, failed: 0, loadSum: 0 }; sum[k].runs += 1; r.status === 'passed' ? sum[k].passed += 1 : sum[k].failed += 1; sum[k].loadSum += (r.hostLoadBefore || 0); }
for (const k of Object.keys(sum)) { sum[k].meanHostLoadBefore = Math.round(sum[k].loadSum / sum[k].runs); delete sum[k].loadSum; }
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ grep, rounds, order: 'alternating', summary: sum, results }, null, 2));
console.log(JSON.stringify(sum));
