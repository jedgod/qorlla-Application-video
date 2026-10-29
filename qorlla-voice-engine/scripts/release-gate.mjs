// Release gate for Qorlla Voice (QVE-01 .. QVE-15, docs/VOICE_CERTIFICATION.md).
//   node scripts/release-gate.mjs certification-evidence.json [--revision <git sha>] [--record]
// It checks that every gate carries credible evidence (status PASS, a description, an operator, a valid timestamp in the past, the right revision, a non-development environment for the gates that need one,
// and a second person's review for the security/privacy gates). It can NOT check that the evidence is true or that the test succeeded: a person must review the artifacts. It therefore never prints an
// approval: the best outcome is EVIDENCE_RECORDED_REVIEW_REQUIRED, and productionApproved is always false.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const GATES = Array.from({ length: 15 }, (_, i) => `QVE-${String(i + 1).padStart(2, '0')}`);
const NOT_DEV = new Set(['staging', 'production-like', 'production']);
/** Gates that cannot be demonstrated on a developer machine, and gates whose evidence needs a reviewer other than the operator. */
export const NEEDS_REAL_ENVIRONMENT = new Set(['QVE-04', 'QVE-05', 'QVE-09', 'QVE-10', 'QVE-12', 'QVE-15']);
export const NEEDS_SECOND_PERSON = new Set(['QVE-11', 'QVE-12', 'QVE-14']);

export function evaluate(data, { revision = '', now = Date.now() } = {}) {
  const problems = {};
  for (const g of GATES) {
    const e = data && data[g], why = [];
    if (!e || typeof e !== 'object') why.push('no entry');
    else {
      if (e.status !== 'PASS') why.push(`status is ${JSON.stringify(e.status)}, not PASS`);
      if (typeof e.evidence !== 'string' || e.evidence.trim().length < 20) why.push('evidence must describe the artifact (log, report, recording) in at least 20 characters');
      if (typeof e.operator !== 'string' || !e.operator.trim()) why.push('no operator');
      const t = Date.parse(e.timestamp); if (!Number.isFinite(t)) why.push('timestamp is not a valid date'); else if (t > now + 60000) why.push('timestamp is in the future');
      if (revision && e.revision !== revision) why.push(`evidence is for revision ${JSON.stringify(e.revision)}, not ${revision}`);
      if (NEEDS_REAL_ENVIRONMENT.has(g) && !NOT_DEV.has(e.environment)) why.push(`needs environment staging, production-like or production (got ${JSON.stringify(e.environment)})`);
      if (NEEDS_SECOND_PERSON.has(g) && (!e.reviewer || String(e.reviewer).trim() === String(e.operator || '').trim())) why.push('needs a reviewer who is not the operator');
    }
    if (why.length) problems[g] = why;
  }
  const missing = Object.keys(problems);
  return { version: '1.9', result: missing.length ? 'BLOCKED' : 'EVIDENCE_RECORDED_REVIEW_REQUIRED', productionApproved: false, missing, problems, reviewRequired: true };
}

async function record(report, data, revision) {
  if (!process.env.DATABASE_URL) { console.error('--record needs DATABASE_URL'); return; }
  const { default: pg } = await import('pg'), pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query('INSERT INTO voice_certification_runs(id, revision, environment, evidence, status) VALUES($1,$2,$3,$4::jsonb,$5)', [randomUUID(), revision || 'unspecified', String(Object.values(data)[0]?.environment || 'unspecified'), JSON.stringify(data), report.missing.length ? 'INCOMPLETE' : 'PASS']);
  } finally { await pool.end(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2), file = args.find((a) => !a.startsWith('--')) || 'certification-evidence.json', flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  let data; try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { console.error('missing_or_invalid_evidence'); process.exit(2); }
  const revision = flag('--revision') || (spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout || '').trim();
  const report = evaluate(data, { revision }); console.log(JSON.stringify(report, null, 2));
  if (args.includes('--record')) await record(report, data, revision);
  process.exit(report.missing.length ? 1 : 0);
}
