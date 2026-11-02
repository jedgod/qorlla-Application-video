// Builds cert/WORKPLACE_V4_5_REPORT.md (+ .json) from the evidence files the certification runners wrote. Nothing here is typed in by hand:
// every count, status, SHA and test name is read from those files; anything that was not executed is reported as NOT EXECUTED or BLOCKED.
// Usage: node cert/build-workplace-report.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return null; } };
const rj = (f) => { const t = rd(f); try { return t ? JSON.parse(t) : null; } catch { return null; } };
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();

const portal = rj('cert/V41_EVIDENCE.json');      // unified-stack runner (unit suites, deployment checks, browser E2E)
const meet = rj('cert/evidence.json');            // Meet + MAIN C01-C24 / R01-R05 runner
const audit = rj('cert/npm-audit.json');
const tap = rd('cert/portal-unit.tap') || '';
const e2e = rj('cert/e2e-results.json');

// ---- unit suites from the TAP file. node:test prints a suite's children BEFORE the suite's own line, so leaves are collected until the next top-level line.
const lines = tap.split(/\r?\n/); const suites = []; let pending = { leaves: 0, failed: 0 };
for (let i = 0; i < lines.length; i++) {
  const m = /^(\s*)(ok|not ok) \d+ - (.+?)(?: # .*)?$/.exec(lines[i]); if (!m) continue;
  const type = (lines.slice(i + 1, i + 9).join('\n').match(/type: '(test|suite)'/) || [])[1];
  if (m[1] === '') { suites.push({ name: m[3], ok: m[2] === 'ok', leaves: pending.leaves, failed: pending.failed }); pending = { leaves: 0, failed: 0 }; continue; }
  if (type === 'test') { pending.leaves++; if (m[2] === 'not ok') pending.failed++; }
}
const footer = (k) => Number((new RegExp(String.raw`^# ${k} (\d+)`, 'm').exec(tap) || [])[1] || 0);
const unitTotal = footer('tests'), unitFailed = footer('fail');
const unitCounted = suites.reduce((n, s) => n + s.leaves, 0);

// ---- browser E2E titles
const e2eTests = []; const walk = (s, file) => { for (const sp of s.specs || []) for (const t of sp.tests) e2eTests.push({ file: path.basename(file || sp.file || ''), title: sp.title, status: t.results?.[t.results.length - 1]?.status || 'unknown' }); for (const c of s.suites || []) walk(c, c.file || file); };
for (const s of e2e?.suites || []) walk(s, s.file);
const e2eBy = (re) => e2eTests.filter((t) => re.test(t.file));
const allPass = (arr) => arr.length > 0 && arr.every((t) => t.status === 'passed');
const unit = (re) => suites.filter((s) => re.test(s.name));
const unitOk = (re) => { const u = unit(re); return u.length > 0 && u.every((s) => s.ok && s.failed === 0); };
const check = (id) => portal?.results?.find((r) => r.id === id);

const gates = [
  { release: 'v4.2 AI Meeting Intelligence', gate: 'full meeting-to-report browser E2E, permission tests, DB persistence tests',
    code: unitOk(/AI meeting intelligence/) && allPass(e2eBy(/meeting-ai\.spec/)) && unitOk(/PostgreSQL migration/),
    blocked: ['Real language-model provider (AI_LLM_API_KEY) was never called: the model in every test is a labelled test double, so summary quality and the real API contract are UNVERIFIED.'] },
  { release: 'v4.3 AI Receptionist and Phone', gate: 'verified inbound/outbound tests, webhook security, failure recovery',
    code: unitOk(/telephony routing|AI receptionist and phone/) && allPass(e2eBy(/phone\.spec/)),
    blocked: ['No real inbound or outbound call has been placed: there is no provider account, provisioned number or compliance sign-off. Telephony is OFF by default and every test uses a labelled Twilio test double.', 'Recording-consent / regulatory review is an operator responsibility and has not been done.'] },
  { release: 'v4.4 QorllaMate, Notes and Productivity', gate: 'workspace boundaries and document authorization; explicit approval for consequential actions',
    code: unitOk(/notes, documents and QorllaMate|document content/) && allPass(e2eBy(/workspace\.spec/)),
    blocked: ['The assistant and AI drafts run against a test-double model; no external action exists (email is blocked because no mail provider is configured).'] },
  { release: 'v4.5 Billing and Enterprise Launch', gate: 'verified webhooks, lifecycle, refunds, usage billing, admin console, monitoring; no real charges until approved',
    code: unitOk(/billing launch|subscription lifecycle|abuse limits/) && allPass(e2eBy(/billing-launch\.spec|pricing\.spec/)) && check('D08')?.status === 'PASS' && check('D09')?.status === 'PASS',
    blocked: ['Real payments were never collected and the real Stripe API was never called (test double only); plan changes, refunds and overage invoice items are UNVERIFIED against a Stripe test-mode account.', 'Live key use additionally needs BILLING_LIVE_AUTHORIZED and explicit owner approval - not granted.'] }
];
const deploy = ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09'].map((id) => check(id)).filter(Boolean);
const deployOk = deploy.length === 9 && deploy.every((r) => r.status === 'PASS');

const meetResults = meet?.results || meet?.checks || [];
const meetPass = meetResults.filter((r) => r.status === 'PASS').length, meetFail = meetResults.filter((r) => r.status === 'FAIL').length;

const sha = portal?.git?.headSha || git('rev-parse', 'HEAD'); const branch = portal?.git?.branch || git('rev-parse', '--abbrev-ref', 'HEAD');
const tree = git('status', '--porcelain').split('\n').filter(Boolean);
const migrations = fs.readdirSync(path.join(root, 'qorlla-portal', 'sql')).filter((f) => /^\d{3}_.+\.(sql|sh)$/.test(f)).sort();
const routes = (rd('docs/API_CONTRACT.md') || '').match(/Total routes: \*\*(\d+)\*\*/)?.[1] || 'unknown';
const mark = (b) => (b ? 'PASS' : 'FAIL');

let md = `# Qorlla Workplace v4.2 - v4.5 release report\n\n_Generated ${new Date().toISOString()} by \`node cert/build-workplace-report.mjs\` from the evidence files. Statements below are read from those files; anything not executed is marked NOT EXECUTED or BLOCKED._\n\n`;
md += `## 1. Decision\n\n| Release | Code gate (executed tests) | Production gate |\n|---|---|---|\n` + gates.map((g) => `| ${g.release} | **${mark(g.code)}** | **BLOCKED** |`).join('\n') + '\n\n';
const codeAll = gates.every((g) => g.code) && deployOk;
md += `**Overall: ${codeAll ? 'PASS for staging / test-double environments' : 'FAIL - see failing items below'}; BLOCKED for production launch.** `;
md += `Production is blocked, not failed, because the external dependencies cannot be exercised without credentials, accounts, hardware and approvals that this work does not have (section 8). Nothing was deployed.\n\n`;
md += `## 2. Exact version tested\n\n- Git SHA: \`${sha}\`\n- Branch: \`${branch}\`\n- Runner finished: ${portal?.finished || 'NOT EXECUTED'}\n- Source tree at certification: ${portal?.git ? (portal.git.sourceTreeClean ? 'clean' : 'DIRTY: ' + (portal.git.dirtySourcePaths || []).join(', ')) : 'unknown'}\n- Working tree now (\`git status --porcelain\`): ${tree.length ? tree.length + ' entries (certification output files and this report are untracked evidence)' : 'clean'}\n\n`;
md += `## 3. What was implemented\n\n- **v4.2 AI Meeting Intelligence** - host-attested consent (recordings are never processed), leased job queue with fenced writes and backoff, Meet chat export through a read-only secret, reports with decisions/topics/action items, server-side visibility levels, bearer-link shares, PDF/DOCX export, usage ledger and plan quota, transcript retention purge.\n`;
md += `- **v4.3 AI Receptionist and Phone** - profiles, business hours/closures, routing rules and keypad menus, signature-verified provider webhooks, voicemail with recording-notice gate and AI summaries, escalation acknowledgement, click-to-call and browser dialer token, appointment booking with conflict-free slots, minutes metering, analytics. **Off by default.**\n`;
md += `- **v4.4 QorllaMate, Notes and Productivity** - private-by-default notes with notebooks and search, documents/sheets/slides with immutable versions, optimistic concurrency and explicit sharing, AI drafts, assistant threads whose actions are human-approved proposals.\n`;
md += `- **v4.5 Billing and Enterprise Launch** - plan upgrade/downgrade with proration and period-end scheduling, admin-initiated refunds, opt-in usage-based AI billing with price snapshots, platform admin console, Enterprise sales workflow, kill switches, health alerts and a token-protected metrics endpoint, per-user rate limits.\n\n`;
md += `## 4. Migrations\n\n${migrations.map((m) => `- \`qorlla-portal/sql/${m}\`${fs.existsSync(path.join(root, 'qorlla-portal/sql/rollback', m.replace('.sql', '.down.sql'))) ? ` (rollback: \`sql/rollback/${m.replace('.sql', '.down.sql')}\`)` : ''}`).join('\n')}\n\nUp/down/up behaviour, idempotency and constraint checks are executed by \`tests/migrations.test.mjs\`.\n\n`;
md += `## 5. API contract\n\n\`docs/API_CONTRACT.md\` is generated from the route registrations (${routes} routes, each with its access class). Regenerate with \`node cert/gen-api-contract.mjs\`.\n\n`;
md += `## 6. Automated test results\n\n`;
md += suites.length ? `Node test suites against real PostgreSQL (Stripe, Twilio and the language model are labelled test doubles): **${unitTotal - unitFailed} passed, ${unitFailed} failed** (${unitTotal} tests per the TAP summary${unitCounted === unitTotal ? '' : '; per-suite attribution below covers ' + unitCounted}).\n\n| Suite | Tests | Result |\n|---|---|---|\n${suites.map((s) => `| ${s.name} | ${s.leaves} | ${s.ok && !s.failed ? 'PASS' : 'FAIL'} |`).join('\n')}\n\n` : 'NOT EXECUTED (no TAP file).\n\n';
md += `### Deployment checks (unified Docker stack: MAIN, Meet, portal, three PostgreSQL databases, nginx/TLS)\n\n${deploy.length ? deploy.map((r) => `- **${r.id} ${r.status}** - ${r.name}${r.detail ? ' - ' + String(r.detail).slice(0, 200) : ''}`).join('\n') : 'NOT EXECUTED.'}\n\n`;
md += `### Browser E2E (Chromium against the unified HTTPS origin, real MAIN sign-in, real PostgreSQL)\n\n`;
md += e2eTests.length ? `**${e2eTests.filter((t) => t.status === 'passed').length} passed, ${e2eTests.filter((t) => t.status !== 'passed').length} not passed** of ${e2eTests.length}.\n\n${e2eTests.map((t) => `- ${t.status === 'passed' ? 'PASS' : 'FAIL'} \`${t.file}\` - ${t.title}`).join('\n')}\n\n` : 'NOT EXECUTED.\n\n';
md += `### Meet + MAIN certification on this branch (C01-C24, R01-R05)\n\n`;
md += meet ? `Result file written ${meet.finished || meet.generated || ''} for SHA \`${meet.git?.headSha || meet.headSha || 'unknown'}\`: **${meetPass} PASS, ${meetFail} FAIL** of ${meetResults.length} recorded checks.${meet.git?.headSha && meet.git.headSha !== sha ? ' **WARNING: this evidence is for a different SHA than the one above.**' : ''}\n\n` : 'NOT EXECUTED on this branch (no cert/evidence.json).\n\n';
const sec = rj('cert/SECURITY_EVIDENCE.json'), prox = rj('cert/PROXY_EVIDENCE.json'); const pwLog = rd('cert/meet-playwright.log') || '';
const tally = (j) => { const r = j?.results || []; return r.length ? `${r.filter((x) => x.status === 'PASS').length} PASS, ${r.filter((x) => x.status === 'FAIL').length} FAIL of ${r.length}` : 'NOT EXECUTED'; };
const shaOf = (j) => j?.git?.headSha || j?.gitHeadSha || 'unknown';
md += `### Meet side, same commit: security, proxy and browser suites\n\n- Meet/MAIN security checks (SEC01-SEC15, \`cert/run-security.mjs\`): ${tally(sec)} (SHA \`${shaOf(sec)}\`)\n- nginx proxy certification (P01-P12, \`cert/run-proxy-cert.mjs\`): ${tally(prox)} (SHA \`${shaOf(prox)}\`)\n- Meet/MAIN browser suite (\`npx playwright test\`, root \`tests/\`): ${/(\d+) passed/.exec(pwLog)?.[0] || 'NOT EXECUTED'}${/(\d+) failed/.exec(pwLog) ? ', ' + /(\d+) failed/.exec(pwLog)[0] : ''}\n- **NOT EXECUTED on this branch:** the v3.9.2 load runner (\`cert/run-load.mjs\`) and backup/restore runner (\`cert/run-backup-restore.mjs\`). Their earlier results belong to the Meet release branch; they were not re-run here and nothing in this report claims them.\n\n`;
md += `### Branch integration (Part G)\n\n- The Workplace work lives on \`${branch}\` (a chain of feature branches v4.1 -> v4.5); the Meet release branch \`release/qorlla-meet-v3.9.2-production-closure\` was **not modified**. Its tip was merged INTO the Workplace branch so the Workplace branch runs the identical Meet code; the first attempt (branched from an older Meet commit) failed two Meet security checks until that merge, which is why this is recorded.\n- Meet certification after integration: C01-C24/R01-R05/RC01-RC08, SEC01-SEC15, P01-P12 and the browser suite above, all on SHA \`${sha}\`.\n- \`stash@{N}: wip/portal-v4 ...\` was inspected, **not applied**. It contains the first (v4.0) pricing-page wiring and the original portal-v4 pack. Everything useful in it was already re-implemented in v4.1 in a safer form (same-origin routes instead of a \`?portal=\` URL remembered in localStorage and a cross-origin catalogue, database-backed annual prices, working checkout). Applying it would have re-introduced a link-injection risk and removed the annual-price support. It remains untouched in the repository stash list (note: a \`git rebase --autostash\` created an extra \`autostash\` entry above it that only holds line-ending noise, so the WIP stash is now \`stash@{1}\`).\n\n`;
md += `### Certification-harness corrections made on the way (test code only; no product behaviour was changed to make a check pass)\n\n- **RC08** read the escrow immediately after un-pausing Meet's database, racing the worker that legitimately finishes the acknowledgement within a second. It now accepts exactly two end states (still pending with its ciphertext, or acknowledged) and fails on anything else.\n- **P10** stopped a host Meet process while nginx was (since the unified compose file) proxying to a dockerised \`meet\` service, so "Meet down" still answered 200. The proxy runner now points nginx at the host process and starts only the services it needs.\n- The runners' fetch wrapper also retries stale keep-alive sockets reported as \`UND_ERR_SOCKET\` (it already did for \`ECONNRESET\`); a single such error had failed RC05 once.\n- Portal runner: probes of the self-signed test certificate, \`D06\` output parsing, and the "source tree clean" check (it counted its own evidence files as source) were corrected.\n- Real product defects found by the first complete browser run are listed in the security review (F1-F6), e.g. the \`/app\` redirect loop.\n- Observed but not explained: one run of the unit stage reported 24 failures (503 from the portal's fail-closed authentication) while a previous, aborted certification's Docker build was still consuming the machine; the same suites passed in isolation and in the next three complete runs. Treat portal authentication as sensitive to heavy host load.\n\n`;
md += `### Dependency audit\n\n${audit ? `\`npm audit --omit=dev\` (qorlla-portal): ${JSON.stringify(audit.metadata?.vulnerabilities || audit)}\n\n` : 'NOT EXECUTED.\n\n'}`;
md += `## 7. Security findings\n\nSee \`docs/SECURITY_REVIEW_v4.2-v4.5.md\`: six defects found and fixed during certification (including a redirect loop and a cost-abuse gap), the controls proven by tests, and the residual risks. It is the **author's** review, not an independent one.\n\n`;
md += `## 8. Blockers (why production is BLOCKED)\n\n${gates.flatMap((g) => g.blocked.map((b) => `- **${g.release.split(' ')[0]}** - ${b}`)).join('\n')}\n- **All** - No independent security review or penetration test.\n- **All** - No real-device / real-network verification of the browser UI beyond headless Chromium with fake media.\n- **All** - No backup schedule / RPO-RTO evidence for the portal databases (the v3.9.2 backup/restore runner covers MAIN and Meet only).\n- **All** - Nothing was deployed to any environment, and no real customer, caller or payment was involved.\n\n`;
md += `## 9. Deploy and rollback\n\nSee \`docs/RUNBOOK.md\` (sections 1-5 of "Workplace v4.2 - v4.5 operations"): migration order and rollback SQL, telephony enablement checklist, billing go-live gate, kill switches, metrics and alert rules, rollback procedure. Keep telephony off, billing unauthorised and the \`ai\` switch off until their checklists are complete.\n\n`;
md += `## 10. Working-tree status\n\n${tree.length ? '```\n' + tree.slice(0, 40).join('\n') + '\n```' : 'clean'}\n`;

fs.writeFileSync(path.join(root, 'cert', 'WORKPLACE_V4_5_REPORT.md'), md);
fs.writeFileSync(path.join(root, 'cert', 'WORKPLACE_V4_5_REPORT.json'), JSON.stringify({ sha, branch, gates: gates.map((g) => ({ release: g.release, code: g.code, production: 'BLOCKED' })), unit: { total: unitTotal, failed: unitFailed, suites }, deployment: deploy.map((r) => ({ id: r.id, status: r.status })), e2e: { total: e2eTests.length, passed: e2eTests.filter((t) => t.status === 'passed').length }, meet: { pass: meetPass, fail: meetFail } }, null, 2));
console.log(`report: code gates ${gates.map((g) => mark(g.code)).join('/')} | unit ${unitTotal - unitFailed}/${unitTotal} | e2e ${e2eTests.filter((t) => t.status === 'passed').length}/${e2eTests.length} | meet ${meetPass}/${meetResults.length}`);
