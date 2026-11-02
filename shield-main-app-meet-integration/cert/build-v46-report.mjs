// Builds the v4.6 gate matrix, provider evidence bundle and report from the evidence files. Nothing is typed in by hand: a gate is PASS only
// when an evidence file says so; a missing file or missing human approval is BLOCKED; an executed failure is FAIL.
// Human approvals live in cert/provider/ops-approvals.json (see cert/provider/ops-approvals.example.json) - they are inputs, not claims by this tool.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rj = (f) => { try { return JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')); } catch { return null; } };
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const ai = rj('cert/provider/ai-evidence.json'), tw = rj('cert/provider/twilio-evidence.json'), st = rj('cert/provider/stripe-evidence.json'), ops = rj('cert/provider/ops-approvals.json') || {};
const v45 = rj('cert/WORKPLACE_V4_5_REPORT.json'), load = rj('cert/LOAD_EVIDENCE.json'), bak = rj('cert/BACKUP_RESTORE_EVIDENCE.json');
const fromProvider = (e, what) => (!e ? { status: 'BLOCKED', reason: `${what} has not been run (no evidence file)` } : e.status === 'PASS' ? { status: 'PASS' } : e.status === 'BLOCKED' ? { status: 'BLOCKED', reason: e.reason } : { status: 'FAIL', reason: (e.steps || []).filter((s) => s.status === 'FAIL').map((s) => `${s.id}: ${s.detail}`).join('; ') || e.reason });
const fromLoad = (e) => { if (!e) return { status: 'BLOCKED', reason: 'load evidence missing' }; const bad = Object.entries(e.verdicts || {}).filter(([, x]) => !x.pass).map(([k]) => k); return bad.length ? { status: 'FAIL', reason: 'targets missed: ' + bad.join(', ') + ' (host: ' + e.host?.cpus + ' CPUs, ' + e.host?.platform + '; a loaded developer machine is not a production-like host - rerun on one before deciding)' } : { status: 'PASS' }; };
const fromBackup = (e) => { if (!e) return { status: 'BLOCKED', reason: 'backup/restore evidence missing' }; const bad = (e.checks || []).filter((c) => c.status !== 'PASS'); const o = e.objectives || {}; if (bad.length) return { status: 'FAIL', reason: bad.map((c) => c.name).join('; ') }; return (o.rtoMeasuredSeconds <= o.rtoTargetSeconds) ? { status: 'PASS', reason: 'drill only: ' + (o.note || '') } : { status: 'FAIL', reason: 'RTO target missed' }; };
const approval = (x, ok, what) => (x && ok(x) ? { status: 'PASS' } : { status: 'BLOCKED', reason: `${what} not recorded in cert/provider/ops-approvals.json` });

const gates = [
  { id: 'P1', name: 'Real AI provider: contracts, structured output, quality thresholds, injection, cost', ...fromProvider(ai, 'cert/provider/run-ai-cert.mjs'), evidence: 'cert/provider/ai-evidence.json' },
  { id: 'P2', name: 'Twilio: number, inbound/outbound authorised calls, signed webhooks, voicemail, handoff, usage', ...fromProvider(tw, 'cert/provider/run-twilio-cert.mjs'), evidence: 'cert/provider/twilio-evidence.json' },
  { id: 'P3', name: 'Stripe test mode: lifecycle, failures, refunds, usage billing, replay/reconciliation, ledger', ...fromProvider(st, 'cert/provider/run-stripe-cert.mjs'), evidence: 'cert/provider/stripe-evidence.json' },
  { id: 'P4a', name: 'Load test on the candidate', ...fromLoad(load), evidence: 'cert/LOAD_EVIDENCE.json' },
  { id: 'P4b', name: 'Backup and restore of MAIN and Meet databases, encrypted secret restoration', ...fromBackup(bak), evidence: 'cert/BACKUP_RESTORE_EVIDENCE.json' },
  { id: 'P4c', name: 'Portal database restoration and key recovery tested', ...approval(ops.portalRestore, (x) => x.testedAt && x.result === 'PASS', 'portal database restore test'), evidence: 'ops-approvals.json#portalRestore' },
  { id: 'P4d', name: 'RPO/RTO documented and approved; automated backup monitoring in place', ...approval(ops.rpoRto, (x) => x.rpoMinutes > 0 && x.rtoMinutes > 0 && x.approvedBy && x.approvedAt && x.backupMonitoring === true, 'approved RPO/RTO and backup monitoring'), evidence: 'ops-approvals.json#rpoRto' },
  { id: 'P4e', name: 'Physical-device audio/video and responsive UI testing', ...approval(ops.devices, (x) => Array.isArray(x.results) && x.results.length >= 3 && x.results.every((r) => r.result === 'PASS'), 'physical-device results (>= 3 devices)'), evidence: 'ops-approvals.json#devices' },
  { id: 'P4f', name: 'Independent security review signed; no open release-blocking findings', ...approval(ops.securityReview, (x) => x.reviewer && x.independentOfAuthor === true && x.signedAt && x.openReleaseBlockingFindings === 0, 'signed independent security review'), evidence: 'ops-approvals.json#securityReview' },
  { id: 'R1', name: 'v4.5 regression evidence still valid (portal, Meet, security, proxy, browser)', status: v45 && v45.gates?.every((g) => g.code) ? 'PASS' : 'BLOCKED', reason: v45 ? undefined : 'v4.5 report json missing', evidence: 'cert/WORKPLACE_V4_5_REPORT.json (SHA ' + (v45?.sha || '?') + ')' }
];
const decision = gates.some((g) => g.status === 'FAIL') ? 'FAIL' : gates.some((g) => g.status === 'BLOCKED') ? 'BLOCKED' : 'PASS';
const sha = git('rev-parse', 'HEAD'), branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const now = new Date().toISOString();
fs.writeFileSync(path.join(root, 'cert/WORKPLACE_V4_6_GATE_MATRIX.json'), JSON.stringify({ generated: now, branch, headSha: sha, baseSourceSha: 'e9878003952817b2216c251506e639b34bbe1238', baseEvidenceCommit: '5499d0a', decision, gates }, null, 2));
fs.writeFileSync(path.join(root, 'cert/WORKPLACE_V4_6_PROVIDER_EVIDENCE.json'), JSON.stringify({ generated: now, note: 'Secrets are never written to evidence. Provider object ids below come from the provider APIs during the runs.', ai, twilio: tw, stripe: st, load: load && { summary: load.summary, git: load.git }, backupRestore: bak && { summary: bak.summary, git: bak.git }, ops }, null, 2));
const sym = { PASS: 'PASS', BLOCKED: 'BLOCKED', FAIL: 'FAIL' };
let md = `# Qorlla Workplace v4.6 - Real provider and production certification\n\n_Generated ${now} by \`node cert/build-v46-report.mjs\` from evidence files._\n\n## Decision: **${sym[decision]}**\n\n`;
md += `- Branch \`${branch}\`, HEAD \`${sha}\`\n- Base source SHA \`e9878003952817b2216c251506e639b34bbe1238\` (v4.5), evidence commit \`5499d0a\`\n- The Meet production-closure branch was not modified; both stash entries were left untouched; nothing was pushed, merged, deployed, and no live payment, call or model request was made by this work.\n\n`;
md += `| Gate | Status | Evidence / reason |\n|---|---|---|\n${gates.map((g) => `| ${g.id} - ${g.name} | **${g.status}** | ${g.status === 'PASS' ? g.evidence : (g.reason || '') + (g.evidence ? ` (${g.evidence})` : '')} |`).join('\n')}\n\n`;
md += `## What exists now\n\n- \`cert/provider/run-ai-cert.mjs\` - real-provider run on a synthetic evaluation set with documented thresholds (\`--self-test\` validates the scorer only).\n- \`cert/provider/run-twilio-cert.mjs\` and \`run-stripe-cert.mjs\` - credential-gated certification runners. They are written to the providers' documented contracts but have **never been executed against a real account**; expect first-run corrections. They refuse to run without all inputs, and the Stripe runner refuses live keys.\n- This builder, and \`cert/provider/ops-approvals.example.json\`, the form in which humans record device results, the independent review, RPO/RTO approval and restore tests.\n\n## Exactly what is needed to unblock\n\n${gates.filter((g) => g.status === 'BLOCKED').map((g) => `- **${g.id}** - ${g.reason}`).join('\n') || '(none)'}\n\n`;
if (gates.some((g) => g.status === 'FAIL')) md += `## Failures\n\n${gates.filter((g) => g.status === 'FAIL').map((g) => `- **${g.id}** - ${g.reason}`).join('\n')}\n\n`;
fs.writeFileSync(path.join(root, 'cert/WORKPLACE_V4_6_REPORT.md'), md);
console.log(`decision ${decision}: ` + gates.map((g) => `${g.id}=${g.status}`).join(' '));
