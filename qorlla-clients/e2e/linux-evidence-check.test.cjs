'use strict';
// The certification validator accepts good evidence and refuses each kind of bad evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validate, REQUIRED_TESTS } = require('./linux-evidence-check.cjs');
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'.slice(0, 64);

const good = (version = '24.04') => {
  const d = {
    schema: 'qorlla-linux-evidence/1', label: 'ubuntu-' + version + '-a', date: '2026-11-02',
    machine: { virtualization: 'none', physical: true, cpuModel: 'Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz', memoryGB: 15.5, gpu: ['Intel UHD Graphics 620'], arch: 'x86_64', videoDeviceNodes: 2 },
    os: { id: 'ubuntu', versionId: version, pretty: 'Ubuntu ' + version + ' LTS', kernel: version === '24.04' ? '6.8.0-48-generic' : '5.15.0-122-generic' },
    security: { apparmorEnabled: true, restrictUnprivilegedUserns: version === '24.04' ? '1' : 'absent', normalUserCanCreateUserNamespace: version !== '24.04' ? true : false, profileLoaded: version === '24.04' ? true : null, profileFile: version === '24.04' ? { mode: '644', ownedByRoot: true } : null, ranAsRoot: false },
    package: { version: '0.2.0', chromeSandbox: { mode: '755', ownedByRoot: true }, debSha256: SHA, expectedSha256: SHA },
    processes: [{ runsAsRoot: false, sameUserAsMain: true, seccomp: '0', noNewPrivs: '0', apparmor: version === '24.04' ? 'qorlla (unconfined)' : 'unconfined', sandboxOffSwitch: false, ownUserNamespace: false }, { runsAsRoot: false, sameUserAsMain: true, seccomp: '2', noNewPrivs: '1', apparmor: version === '24.04' ? 'qorlla (unconfined)' : 'unconfined', sandboxOffSwitch: false, ownUserNamespace: true }],
    results: Object.fromEntries(REQUIRED_TESTS.map((id) => [id, { status: 'pass', note: 'Observed on the real machine: ' + id + ' behaved as required.' }])),
  };
  return d;
};
const clone = (d) => JSON.parse(JSON.stringify(d)), V = (d, o) => validate(d, o);
const has = (r, re) => r.problems.some((p) => re.test(p));

test('complete, correct evidence passes on Ubuntu 24.04 and on Ubuntu 22.04', () => { assert.equal(V(good('24.04')).verdict, 'PASS', JSON.stringify(V(good('24.04')))); assert.equal(V(good('22.04')).verdict, 'PASS', JSON.stringify(V(good('22.04')))); });
test('only physical hardware counts: a VM or container is refused', () => { for (const v of ['kvm', 'docker', 'wsl', 'unknown']) { const d = good(); d.machine.virtualization = v; d.machine.physical = false; assert.equal(V(d).verdict, 'FAIL'); assert.ok(has(V(d), /not a physical machine/), v); } });
test('only Ubuntu 22.04 and 24.04 on x86_64', () => { for (const [id, v] of [['debian', '12'], ['ubuntu', '20.04'], ['ubuntu', '25.04']]) { const d = good(); d.os.id = id; d.os.versionId = v; assert.ok(has(V(d), /unsupported OS/), id + v); } const a = good(); a.machine.arch = 'aarch64'; assert.ok(has(V(a), /x86_64/)); });
test('the evidence must be for the exact CI-validated package', () => {
  const d = good(); d.package.debSha256 = 'f'.repeat(64); assert.ok(has(V(d), /NOT the approved test package/));
  assert.ok(has(V(good(), { expectSha256: 'b'.repeat(64) }), /NOT the approved test package|differs/)); assert.equal(V(good(), { expectSha256: SHA }).verdict, 'PASS');
  const m = good(); delete m.package.debSha256; assert.ok(has(V(m), /debSha256 missing/)); const n = good(); n.package.expectedSha256 = null; assert.ok(has(V(n), /no expected SHA-256/)); assert.equal(V(n, { expectSha256: SHA }).verdict, 'PASS');
});
test('a setuid chrome-sandbox is refused (the setuid helper is not the supported solution)', () => { for (const mode of ['4755', '2755', '6755']) { const d = good(); d.package.chromeSandbox.mode = mode; assert.ok(has(V(d), /setuid\/setgid/), mode); } });
test('the running app must show a working sandbox: no off-switch, not root, seccomp with no-new-privs, own user namespace', () => {
  let d = good(); d.processes[1].sandboxOffSwitch = true; assert.ok(has(V(d), /sandbox-disabling switch/));
  d = good(); d.processes.forEach((p) => { p.runsAsRoot = true; }); assert.ok(has(V(d), /running as root/));
  d = good(); d.processes[1].sameUserAsMain = false; assert.ok(has(V(d), /different users/));
  d = good(); d.package.chromeSandbox.ownedByRoot = false; assert.ok(has(V(d), /not owned by root/));
  d = good(); d.processes.forEach((p) => { delete p.runsAsRoot; }); assert.ok(has(V(d), /could not be determined/), 'an unknown user is not accepted as non-root');
  d = good(); d.processes.forEach((p) => { p.seccomp = '0'; }); assert.ok(has(V(d), /seccomp filter/));
  d = good(); d.processes.forEach((p) => { p.ownUserNamespace = false; }); assert.ok(has(V(d), /own user namespace/));
  d = good(); d.processes = []; assert.ok(has(V(d), /no running Qorlla process/));
});
test('Ubuntu 24.04: the host protection must be on, the profile loaded, and attached to the running process', () => {
  let d = good(); d.security.restrictUnprivilegedUserns = '0'; assert.ok(has(V(d), /host-wide protection was changed/));
  d = good(); d.security.profileLoaded = false; assert.ok(has(V(d), /NOT loaded/)); assert.equal(V(d).verdict, 'FAIL');
  d = good(); d.security.profileLoaded = null; assert.equal(V(d).verdict, 'INCOMPLETE'); assert.ok(V(d).incomplete.some((x) => /collect with sudo/.test(x)));
  d = good(); d.processes[0].apparmor = 'unconfined'; assert.ok(has(V(d), /not attached to the running process/));
});
test('Ubuntu 22.04 is not assumed to behave like 24.04: no profile is required, but a normal user must be able to create a user namespace', () => {
  assert.equal(V(good('22.04')).verdict, 'PASS'); const d = good('22.04'); d.security.normalUserCanCreateUserNamespace = false; assert.ok(has(V(d), /cannot create a user namespace/));
  const r = good('22.04'); r.security.restrictUnprivilegedUserns = '1'; r.security.profileLoaded = true; r.processes.forEach((p) => { p.apparmor = 'qorlla (unconfined)'; }); assert.equal(V(r).verdict, 'PASS', 'a 22.04 host that does restrict is held to the 24.04 rules');
  r.security.profileLoaded = false; assert.equal(V(r).verdict, 'FAIL');
});
test('every test must be accounted for, with a real note; failures and gaps are reported as such', () => {
  let d = good(); d.results.T07.status = 'NOT_RUN'; d.results.T07.note = ''; assert.equal(V(d).verdict, 'INCOMPLETE'); assert.ok(V(d).incomplete.includes('test T07 not run'));
  d = good(); d.results.T10 = { status: 'fail', note: 'relay never selected; direct path used instead' }; assert.equal(V(d).verdict, 'FAIL'); assert.equal(V(d).failedTests.length, 1);
  d = good(); d.results.T03.note = 'ok'; assert.ok(has(V(d), /needs a note/));
  d = good(); delete d.results.T05; assert.ok(has(V(d), /test T05 has no entry/));
  d = good(); d.results.T01.status = 'not_applicable'; assert.ok(has(V(d), /cannot be not_applicable/)); d = good(); d.results.T06 = { status: 'not_applicable', note: 'No display server screen-sharing portal on this machine.' }; assert.equal(V(d).verdict, 'PASS');
  d = good(); d.results.T02.status = 'maybe'; assert.ok(has(V(d), /unknown status/));
});
test('PRIVACY: addresses, hardware ids, accounts, home paths, tokens and meeting ids never belong in the evidence', () => {
  const leaks = { 'an IPv4 address': (d) => { d.results.T09.note = 'Direct pair to 192.168.1.20 selected, both directions flowing.'; }, 'a MAC address': (d) => { d.machine.cpuModel += ' 3c:22:fb:12:34:56'; }, 'an e-mail address': (d) => { d.results.T07.note = 'Joined as someone@example.org and exchanged media.'; },
    'a home-directory path': (d) => { d.results.T01.note = 'Installed from /home/alice/Downloads/qorlla.deb and checked.'; }, 'a UUID': (d) => { d.results.T08.note = 'Reconnected participant 123e4567-e89b-12d3-a456-426614174000 in 6 s.'; },
    'an 11-digit meeting id': (d) => { d.results.T07.note = 'Meeting 12345678901 created, joined and ended normally.'; }, 'a host, user or serial field': (d) => { d.machine.hostname = 'x'; }, 'key or token material': (d) => { d.results.T07.note = 'Token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 was shown in the console.'; } };
  for (const [what, mutate] of Object.entries(leaks)) { const d = good(); mutate(d); const r = V(d); assert.equal(r.verdict, 'FAIL', what); assert.ok(has(r, new RegExp('privacy: .*' + what.split(' ').slice(-2).join(' ').replace(/[-]/g, '.'))), what + ' :: ' + JSON.stringify(r.problems)); }
  const ok = good(); ok.package.debSha256 = '0123456789'.repeat(6) + '0123'; ok.package.expectedSha256 = ok.package.debSha256; assert.equal(V(ok).verdict, 'PASS', 'a hash made of digits is not mistaken for an id');
});
test('the command line: exit 0 for PASS, 3 for INCOMPLETE, 1 for FAIL and for unreadable files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lev-')); try {
    const run = (d) => { const f = path.join(dir, 'e.json'); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d)); return spawnSync(process.execPath, [path.join(__dirname, 'linux-evidence-check.cjs'), f], { encoding: 'utf8' }); };
    assert.equal(run(good()).status, 0); const inc = good(); inc.results.T13.status = 'NOT_RUN'; assert.equal(run(inc).status, 3); const bad = good(); bad.machine.physical = false; assert.equal(run(bad).status, 1); assert.equal(run('{ not json').status, 1);
    assert.match(run(good()).stdout, /VERDICT: PASS \(this evidence file only; it does not release anything\)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the address rule flags real addresses but not kernel or package versions', () => {
  const kernels = ['6.6.87.2-microsoft-standard-WSL2', '5.15.0-122-generic', '6.8.0-48-generic', '6.11.0-1007-oem', '0.2.0'];
  for (const k of kernels) { const d = good(); d.os.kernel = k; assert.ok(!has(V(d), /IPv4/), 'false positive on ' + k); }
  for (const note of ['Direct pair to 192.168.1.20 selected.', 'Direct pair to 192.168.1.20.', 'TURN at 203.0.113.9: relay selected', 'peer 10.0.0.5, flowing']) { const d = good(); d.results.T09.note = note + ' Both directions flowing.'; assert.ok(has(V(d), /IPv4/), 'missed: ' + note); }
});

const rec = () => ({ schema: 'qorlla-test-package-record/1', status: 'built and verified; approved', approvedBy: 'release engineering', sourceCommit: 'd'.repeat(40), builtOn: '2026-11-02',
  builder: { image: 'node:22-bookworm', imageDigest: 'sha256:' + 'b'.repeat(64), os: 'Debian GNU/Linux 12', node: 'v22.18.0', npm: '10.9.0', electron: '33.4.11', electronBuilder: '25.1.8', lockfileSha256: 'c'.repeat(64) },
  package: { file: 'qorlla-0.2.0-amd64.deb', sizeBytes: 75000000, sha256: SHA, dpkgVersion: '0.2.0' },
  verification: { desktopTests: 'passed', sandboxRegressionCheck: 'passed', releaseSafetyCheck: 'passed', chromeSandboxMode: '755', chromeSandboxOwner: 'root', appArmorProfileMode: '644', setuidFree: true, desktopEntryExec: '/opt/Qorlla/qorlla %U' } });
const clone2 = (d) => JSON.parse(JSON.stringify(d));

test('the label cannot carry a name or a place', () => {
  assert.equal(V(good()).verdict, 'PASS'); for (const bad of ['alice-laptop', 'ubuntu-24.04-alices-laptop', 'ubuntu-20.04-a', 'ubuntu-24.04', 'ubuntu-24.04-a b']) { const d = good(); d.label = bad; assert.ok(has(V(d), /label must look like/), bad); }
});
test('PRIVACY: serial numbers, long hexadecimal ids and long opaque strings are refused; ordinary field names and hardware names are not', () => {
  const leaks = { 'a serial number': 'Webcam serial number: C920A1B2C3D4 recognised', 'a long hexadecimal identifier': 'Device 0123456789abcdef0123 appeared in the list', 'a long opaque string': 'Session ab12CD34ef56GH78ij90KL12mn34OP56 was shown' };
  for (const [what, note] of Object.entries(leaks)) { const d = good(); d.results.T03.note = note + ' and worked fine.'; const r = V(d); assert.equal(r.verdict, 'FAIL', what); assert.ok(has(r, new RegExp('privacy: .*' + what.split(' ').slice(-2).join(' '))), what + ' :: ' + JSON.stringify(r.problems)); }
  const ok = good(); ok.machine.cpuModel = 'AMD Ryzen 7 5800U with Radeon Graphics'; ok.machine.gpu = ['Advanced Micro Devices, Inc. [AMD/ATI] Cezanne [Radeon Vega Series]']; ok.os.kernel = '6.8.0-48-generic'; ok.results.T03.note = 'Integrated 720p webcam listed, self-view live, remote side saw it.'; assert.equal(V(ok).verdict, 'PASS', JSON.stringify(V(ok)));
});
test('PACKAGE RECORD: the exact package is the privately built, recorded one, never a CI hash', () => {
  assert.equal(V(good(), { record: rec() }).verdict, 'PASS', JSON.stringify(V(good(), { record: rec() })));
  const other = good(); other.package.debSha256 = other.package.expectedSha256 = 'e'.repeat(64); assert.ok(has(V(other, { record: rec() }), /NOT the approved test package/));
  const diff = good(); diff.package.expectedSha256 = 'e'.repeat(64); assert.ok(has(V(diff, { record: rec() }), /different expected hash than the package record/));
  const none = good(); none.package.expectedSha256 = null; assert.equal(V(none, { record: rec() }).verdict, 'PASS', 'the record supplies the expected hash');
});
test('PACKAGE RECORD: an unapproved or unverified record is not a basis for certification', () => {
  const unapproved = rec(); unapproved.approvedBy = null; const r = V(good(), { record: unapproved }); assert.equal(r.verdict, 'INCOMPLETE'); assert.ok(r.incomplete.some((x) => /not yet approved/.test(x)));
  const mut = { 'unknown schema': (x) => { x.schema = 'x'; }, 'full 40-character commit': (x) => { x.sourceCommit = 'abc123'; }, 'builder is not fully recorded': (x) => { delete x.builder.imageDigest; }, 'verification.sandboxRegressionCheck': (x) => { x.verification.sandboxRegressionCheck = 'failed'; },
    'sandbox policy of the package': (x) => { x.verification.setuidFree = false; }, 'disables the sandbox': (x) => { x.verification.desktopEntryExec = '/opt/Qorlla/qorlla --no-sandbox %U'; }, 'does not start /opt/Qorlla/qorlla': (x) => { x.verification.desktopEntryExec = '/usr/bin/other %U'; }, 'package.sha256 missing': (x) => { delete x.package.sha256; } };
  for (const [what, m] of Object.entries(mut)) { const x = rec(); m(x); const r2 = V(good(), { record: x }); assert.equal(r2.verdict, 'FAIL', what); assert.ok(r2.problems.some((p) => p.includes(what)), what + ' :: ' + JSON.stringify(r2.problems)); }
});
test('the command line accepts --package-record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lev-')); try {
    const e = path.join(dir, 'e.json'), r = path.join(dir, 'r.json'), run = () => spawnSync(process.execPath, [path.join(__dirname, 'linux-evidence-check.cjs'), e, '--package-record', r], { encoding: 'utf8' });
    fs.writeFileSync(e, JSON.stringify(good())); fs.writeFileSync(r, JSON.stringify(rec())); assert.equal(run().status, 0, run().stdout);
    const un = rec(); un.approvedBy = ''; fs.writeFileSync(r, JSON.stringify(un)); assert.equal(run().status, 3); fs.writeFileSync(r, '{ nope'); assert.equal(run().status, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
