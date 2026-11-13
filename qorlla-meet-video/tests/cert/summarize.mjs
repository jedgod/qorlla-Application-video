// Collects the evidence files of the M1.3 certification runs (docs/evidence/m13/*.runN.json) into one matrix: per suite, per run, passed/total, and the check-level repeatability
// (a check that passed in every run, failed in every run, or FLAPPED). Writes docs/evidence/m13/SUMMARY.json and prints a Markdown table.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'evidence', 'm13');
const files = readdirSync(dir).filter((f) => /\.run\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
const bySuite = {}; for (const r of files) (bySuite[r.suite] ||= []).push(r);
const summary = {}; const lines = ['| Suite | Runs | Per run (passed/total) | Checks that flapped |', '|---|---|---|---|'];
for (const [suite, runs] of Object.entries(bySuite)) {
  runs.sort((a, b) => Number(a.run) - Number(b.run)); const names = new Map();
  for (const r of runs) for (const c of r.results) (names.get(c.name) || names.set(c.name, []).get(c.name)).push(c.ok);
  const flapped = [...names].filter(([, v]) => v.some((x) => x) && v.some((x) => !x) || v.length !== runs.length).map(([n]) => n);
  const alwaysFail = [...names].filter(([, v]) => v.length === runs.length && v.every((x) => !x)).map(([n]) => n);
  summary[suite] = { runs: runs.length, perRun: runs.map((r) => `${r.passed}/${r.total}`), flapped, alwaysFail, metrics: runs.map((r) => r.metrics) };
  lines.push(`| ${suite} | ${runs.length} | ${runs.map((r) => `${r.passed}/${r.total}`).join(', ')} | ${flapped.length ? flapped.join('; ') : 'none'}${alwaysFail.length ? ' ; ALWAYS FAILED: ' + alwaysFail.join('; ') : ''} |`);
}
writeFileSync(join(dir, 'SUMMARY.json'), JSON.stringify(summary, null, 1)); console.log(lines.join('\n'));
