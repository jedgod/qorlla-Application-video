'use strict';
// Validates a physical-Linux certification evidence file produced by qorlla-clients/tools/linux-collect-evidence.py.
//   node qorlla-clients/e2e/linux-evidence-check.cjs <evidence.json> [--expect-sha256 <ci sha>]
// Verdicts and exit codes:  PASS (0)   FAIL (1: a test failed, or the evidence is invalid or unsafe)   INCOMPLETE (3: valid so far, but tests are still NOT_RUN)
// This does not run any test: it refuses evidence that is not physical, not for the exact package, shows a disabled sandbox, leaks identifying data, or leaves a test unaccounted for.
const fs = require('node:fs');

const REQUIRED_TESTS = ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10', 'T11', 'T12', 'T13', 'T14'];
const STATUS = new Set(['pass', 'fail', 'not_applicable', 'NOT_RUN']);
const SUPPORTED = new Set(['22.04', '24.04']);
// Data that must never be in an evidence file: network addresses, hardware ids, accounts, paths in a home directory, host names.
const PRIVACY = [[/(?<![\w.-])(?!127\.0\.0\.1(?![\w-]|\.\d))(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w-]|\.\d)/, 'an IPv4 address'], [/\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/i, 'a MAC address'], [/[\w.+-]+@[\w-]+\.[\w.-]+/, 'an e-mail address'], [/\/home\/[^\s"']+/, 'a home-directory path'], [/\/Users\/[^\s"']+/, 'a home-directory path'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, 'a UUID (machine id, participant id or meeting id)'], [/\b\d{11}\b/, 'an 11-digit meeting id'], [/"(hostname|host|user|username|serial|machine-id|machineId)"\s*:/i, 'a host, user or serial field'], [/BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}/, 'key or token material'],
  [/\bserial(?:\s*(?:number|no\.?|#))?\s*[:=#]?\s*[A-Za-z0-9-]{6,}/i, 'a serial number'], [/(?<![\w-])[0-9a-f]{16,}(?![\w-])/i, 'a long hexadecimal identifier'],
  [/(?<![\w-])(?=[A-Za-z0-9+\/_-]*\d)(?=[A-Za-z0-9+\/_-]*[A-Za-z])[A-Za-z0-9+\/_-]{28,}(?![\w-])/, 'a long opaque string (a token, key or id)']];

/** Returns { verdict, problems[], incomplete[] } */
/** The auditable record of the private test package (written by tools/build-test-package.cjs). */
function checkRecord(rec) {
  const problems = [], incomplete = [], bad = (m) => problems.push('package record: ' + m), r = rec || {}, v = r.verification || {}, p = r.package || {}, b = r.builder || {};
  if (r.schema !== 'qorlla-test-package-record/1') bad('unknown schema');
  if (!/^[0-9a-f]{40}$/.test(r.sourceCommit || '')) bad('sourceCommit must be a full 40-character commit id');
  if (!/^[0-9a-f]{64}$/.test(p.sha256 || '')) bad('package.sha256 missing'); if (!(p.sizeBytes > 1e6)) bad('package size missing or implausible');
  if (!/^sha256:[0-9a-f]{64}$/.test(b.imageDigest || '') || !b.node || !b.electron || !b.electronBuilder || !/^[0-9a-f]{64}$/.test(b.lockfileSha256 || '')) bad('the builder is not fully recorded (image digest, node, electron, electron-builder, lockfile hash)');
  for (const k of ['desktopTests', 'sandboxRegressionCheck', 'releaseSafetyCheck']) if (v[k] !== 'passed') bad(`verification.${k} is not "passed"`);
  if (v.setuidFree !== true || v.chromeSandboxMode !== '755' || v.appArmorProfileMode !== '644') bad('the sandbox policy of the package is not as required (chrome-sandbox 0755 and not setuid, AppArmor profile 0644)');
  if (/--no-sandbox|disable-.*sandbox/i.test(v.desktopEntryExec || '')) bad('the desktop entry disables the sandbox'); if (!/^\/opt\/Qorlla\/qorlla\b/.test(v.desktopEntryExec || '')) bad('the desktop entry does not start /opt/Qorlla/qorlla');
  if (!r.approvedBy) incomplete.push('package record is not yet approved (approvedBy is empty): testers must not use this package until a person approves it');
  return { problems, incomplete };
}
function validate(doc, { expectSha256, record } = {}) {
  const problems = [], incomplete = [], bad = (m) => problems.push(m);
  // The two package hashes are legitimate long hex strings: take them out before looking for opaque identifiers.
  const scrubbed = JSON.parse(JSON.stringify(doc)); if (scrubbed.package) { scrubbed.package.debSha256 = ''; scrubbed.package.expectedSha256 = ''; }
  const text = JSON.stringify(scrubbed); for (const [re, what] of PRIVACY) if (re.test(text)) bad(`privacy: the evidence contains ${what}`);
  // The package under test is the PRIVATE build recorded in a package record, not a CI artifact: when a record is supplied it decides what "the exact package" means.
  if (record) { const rp = checkRecord(record); problems.push(...rp.problems); incomplete.push(...rp.incomplete); expectSha256 = expectSha256 || (record.package && record.package.sha256); if (doc.package && doc.package.expectedSha256 && record.package && doc.package.expectedSha256.toLowerCase() !== String(record.package.sha256).toLowerCase()) bad('the evidence was collected against a different expected hash than the package record'); }
  if (doc.schema !== 'qorlla-linux-evidence/1') bad('unknown schema');
  if (!/^ubuntu-(22\.04|24\.04)-[a-z0-9]{1,6}$/.test(doc.label || '')) bad('label must look like ubuntu-24.04-a (the OS version and a short letter or number: never a name or a place)');
  const m = doc.machine || {}, os = doc.os || {}, sec = doc.security || {}, pkg = doc.package || {}, procs = Array.isArray(doc.processes) ? doc.processes : [];
  // physical machine only
  if (m.physical !== true || m.virtualization !== 'none') bad(`not a physical machine (virtualization: ${m.virtualization}); this pack certifies real hardware only`);
  if (!m.cpuModel || !(m.memoryGB > 0)) bad('machine specification is incomplete (CPU model, memory)'); if (m.arch !== 'x86_64') bad('only x86_64 is covered by this package');
  // operating system
  if (os.id !== 'ubuntu' || !SUPPORTED.has(os.versionId)) bad(`unsupported OS: ${os.id} ${os.versionId} (supported: Ubuntu 22.04, 24.04)`); if (!os.kernel) bad('kernel version missing');
  // the exact package
  const sha = /^[0-9a-f]{64}$/;
  if (!sha.test(pkg.debSha256 || '')) bad('package.debSha256 missing: run the collector with --deb <the installed file>');
  if (!sha.test(pkg.expectedSha256 || '') && !expectSha256) bad('no expected SHA-256 (from the CI run) was recorded or supplied'); else {
    const want = (expectSha256 || pkg.expectedSha256 || '').toLowerCase(); if (pkg.debSha256 !== want) bad(`the installed package is NOT the approved test package (sha256 ${String(pkg.debSha256).slice(0, 12)}… vs ${want.slice(0, 12)}…)`); if (expectSha256 && pkg.expectedSha256 && pkg.expectedSha256.toLowerCase() !== expectSha256.toLowerCase()) bad('the recorded expected SHA-256 differs from the one supplied now');
  }
  if (!pkg.version) bad('qorlla is not installed according to dpkg');
  const cs = pkg.chromeSandbox; if (cs && cs.ownedByRoot !== true) bad('chrome-sandbox is not owned by root'); if (!cs) bad('chrome-sandbox not found under /opt/Qorlla'); else if (parseInt(cs.mode, 8) & 0o6000) bad(`chrome-sandbox is setuid/setgid (mode ${cs.mode}): the setuid helper is not the supported solution`);
  // sandbox state of the RUNNING app
  if (!procs.length) bad('no running Qorlla process was recorded: start Qorlla as a normal user and collect again');
  else {
    if (procs.some((p) => p.sandboxOffSwitch)) bad('a Qorlla process runs with a sandbox-disabling switch');
    if (procs.some((p) => p.runsAsRoot !== false)) bad('Qorlla is running as root (or the user could not be determined)'); if (procs.some((p) => p.sameUserAsMain !== true)) bad('Qorlla processes run under different users');
    if (!procs.some((p) => p.seccomp === '2' && p.noNewPrivs === '1')) bad('no process shows a seccomp filter with no-new-privs: Chromium\'s sandbox is not demonstrably in effect');
    if (!procs.some((p) => p.ownUserNamespace === true)) bad('no child process runs in its own user namespace: the namespace sandbox is not demonstrably in use');
  }
  // AppArmor: do not assume 22.04 behaves like 24.04
  const restricted = sec.restrictUnprivilegedUserns === '1';
  if (os.versionId === '24.04' && !restricted) bad(`Ubuntu 24.04 with kernel.apparmor_restrict_unprivileged_userns=${sec.restrictUnprivilegedUserns}: the host-wide protection was changed, so this evidence does not show the profile at work`);
  if (restricted) {
    if (sec.profileLoaded !== true) (sec.profileLoaded === null ? incomplete : problems).push('AppArmor profile "qorlla" is ' + (sec.profileLoaded === null ? 'unknown (collect with sudo)' : 'NOT loaded in the kernel'));
    if (procs.length && !String(procs[0].apparmor || '').startsWith('qorlla')) bad(`the AppArmor profile is not attached to the running process (attr/current = "${procs[0].apparmor || 'unavailable'}")`);
  } else if (os.versionId === '22.04') { if (sec.normalUserCanCreateUserNamespace !== true) bad('Ubuntu 22.04: a normal user cannot create a user namespace, so the sandbox cannot work without further configuration (record how it was handled)'); }
  // results
  const res = doc.results || {};
  for (const id of REQUIRED_TESTS) {
    const r = res[id]; if (!r) { bad(`test ${id} has no entry`); continue; }
    if (!STATUS.has(r.status)) { bad(`test ${id}: unknown status "${r.status}"`); continue; }
    if (r.status === 'NOT_RUN') incomplete.push(`test ${id} not run`);
    else if (String(r.note || '').trim().length < 15) bad(`test ${id}: a result needs a note (what was done and what was observed, at least 15 characters)`);
    if (r.status === 'fail') bad(`test ${id} FAILED: ${String(r.note || '').slice(0, 100)}`);
    if (r.status === 'not_applicable' && ['T01', 'T02', 'T14'].includes(id)) bad(`test ${id} cannot be not_applicable`);
  }
  const failedTests = problems.filter((p) => /^test T\d+ FAILED/.test(p));
  const verdict = problems.length ? 'FAIL' : incomplete.length ? 'INCOMPLETE' : 'PASS';
  return { verdict, problems, incomplete, failedTests };
}
function main(argv) {
  const file = argv[0]; if (!file) { console.error('usage: linux-evidence-check.cjs <evidence.json> [--package-record <record.json> | --expect-sha256 <sha>]'); return 2; }
  const i = argv.indexOf('--expect-sha256'), j = argv.indexOf('--package-record'); let doc, record; try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log('FAIL: not readable JSON: ' + e.message); return 1; }
  if (j >= 0) { try { record = JSON.parse(fs.readFileSync(argv[j + 1], 'utf8')); } catch (e) { console.log('FAIL: package record not readable: ' + e.message); return 1; } }
  const r = validate(doc, { expectSha256: i >= 0 ? argv[i + 1] : undefined, record });
  console.log(`${doc.label || '?'}: ${doc.os && doc.os.pretty} / kernel ${doc.os && doc.os.kernel}`); for (const p of r.problems) console.log('  FAIL ' + p); for (const p of r.incomplete) console.log('  todo ' + p);
  console.log('VERDICT: ' + r.verdict + (r.verdict === 'PASS' ? ' (this evidence file only; it does not release anything)' : '')); return r.verdict === 'PASS' ? 0 : r.verdict === 'INCOMPLETE' ? 3 : 1;
}
module.exports = { validate, checkRecord, REQUIRED_TESTS };
if (require.main === module) process.exit(main(process.argv.slice(2)));
