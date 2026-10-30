'use strict';
// The Debian package integration: a narrowly scoped AppArmor profile, install/upgrade/removal handling, and no setuid helper by default.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..'), read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(read('package.json')), profile = read('linux/apparmor/qorlla'), install = read('linux/after-install.sh'), remove = read('linux/after-remove.sh');
const code = (text) => text.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);

test('the AppArmor profile is attached to the one installed executable and grants only user namespaces', () => {
  const lines = code(profile);
  assert.deepEqual(lines, ['abi <abi/4.0>,', 'include <tunables/global>', 'profile qorlla /opt/Qorlla/qorlla flags=(unconfined) {', 'userns,', 'include if exists <local/qorlla>', '}'], 'any added rule must be a deliberate, reviewed change to this list');
  assert.ok(!/\bcapability\b|\bnetwork\b|\bptrace\b|\bmount\b|\bsignal\b|\bdbus\b|\bpivot_root\b|\bunix\b|\/\*\*|^\s*\/\s/m.test(lines.join('\n')), 'no capability, network, ptrace, mount, signal, dbus or file wildcard rule');
  assert.match(profile, /profile qorlla \/opt\/Qorlla\/qorlla /, 'attached by the exact executable path, not a wildcard');
  assert.ok(!/profile\s+\S+\s+\/\*|profile\s+\S+\s+\/opt\/\*/.test(profile), 'not attached to a directory or a glob');
});
test('the profile is shipped in the package and the install scripts are wired in', () => {
  assert.equal(pkg.build.deb.afterInstall, 'linux/after-install.sh'); assert.equal(pkg.build.deb.afterRemove, 'linux/after-remove.sh'); assert.equal(pkg.build.deb.packageName, 'qorlla');
  assert.deepEqual(pkg.build.linux.extraResources, [{ from: 'linux/apparmor/qorlla', to: 'apparmor/qorlla' }]);
  for (const f of ['linux/apparmor/qorlla', 'linux/after-install.sh', 'linux/after-remove.sh']) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  assert.match(install, /PROFILE_SRC='\/opt\/\$\{sanitizedProductName\}\/resources\/apparmor\/qorlla'/, 'the install script reads the profile from where extraResources puts it');
});
test('chrome-sandbox is never made setuid: the legacy 4755 logic is gone', () => {
  assert.ok(!/4755|u\+s|chmod\s+[0-7]*[4-7][0-7]{3}\b/.test(install + remove), 'no setuid chmod anywhere');
  assert.match(install, /chmod 0755 '\/opt\/\$\{sanitizedProductName\}\/chrome-sandbox'/); assert.ok(!/unshare/.test(code(install).join('\n')), 'no root-run unshare probe (it succeeds as root on hosts that refuse a normal user)');
});
test('install: the profile is installed and loaded only where AppArmor 4 exists, and a load failure is reported but does not abort', () => {
  assert.match(install, /\[ -e \/etc\/apparmor\.d\/abi\/4\.0 \]/); assert.match(install, /command -v apparmor_parser/); assert.match(install, /apparmor_parser --replace --write-cache "\$PROFILE_DST"/);
  assert.match(install, /else\s*\n\s*echo "Qorlla: WARNING: the AppArmor profile could not be loaded/); assert.ok(!/^\s*set -e/m.test(install), 'a failed profile load must not abort the installation');
  assert.match(install, /install -m 0644 "\$PROFILE_SRC" "\$PROFILE_DST"/, 'root-owned, not writable by others');
});
test('removal: the profile is unloaded and deleted on remove and purge only, never on upgrade', () => {
  const block = /case "\$1" in\n\s*(remove\|purge)\)([\s\S]*?);;\s*\nesac/.exec(remove); assert.ok(block, 'the AppArmor part is a case on $1'); assert.equal(block[1], 'remove|purge');
  assert.match(block[2], /apparmor_parser --remove \/etc\/apparmor\.d\/qorlla/); assert.match(block[2], /rm -f \/etc\/apparmor\.d\/qorlla/);
  assert.ok(!/upgrade/.test(block[0]) && !/\*\)/.test(block[0]), 'upgrade is not a removal case');
});
test('the scripts only use the placeholders electron-builder substitutes, and parse as bash', () => {
  for (const [name, text] of [['after-install', install], ['after-remove', remove]]) {
    const odd = (text.match(/\$\{[^}]*\}/g) || []).filter((m) => !['${executable}', '${sanitizedProductName}'].includes(m)); assert.deepEqual(odd, [], name + ' would break the electron-builder template');
    assert.ok(!text.includes('\r'), name + ' has CR line endings');
    const r = spawnSync('bash', ['-n'], { input: text.replace(/\$\{executable\}/g, 'qorlla').replace(/\$\{sanitizedProductName\}/g, 'Qorlla'), encoding: 'utf8' }); if (r.error) continue; assert.equal(r.status, 0, name + ': ' + r.stderr);
  }
  assert.ok(!profile.includes('\r'), 'the profile has CR line endings');
});
