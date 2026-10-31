'use strict';
// The ephemeral cluster environment: random, distinct, complete (against the compose file's REAL list of required variables), never printed, never inside the repository.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { generate, render, SECRETS } = require('../cluster-env.cjs');
const CLI = path.join(__dirname, '..', 'cluster-env.cjs'), REPO = path.resolve(__dirname, '..', '..');

test('every secret is random, distinct, non-empty and long enough; different on every run', () => {
  const a = generate().secrets, b = generate().secrets, vals = Object.values(a);
  assert.equal(new Set(vals).size, vals.length, 'distinct within one run'); for (const k of Object.keys(a)) assert.notEqual(a[k], b[k], k + ' must differ between runs');
  for (const k of ['MAIN_DB_PASSWORD', 'QORLLA_APP_DB_PASSWORD', 'PORTAL_DB_PASSWORD', 'MEET_DB_PASSWORD', 'MEET_APP_DB_PASSWORD']) assert.match(a[k], /^[0-9a-f]{48}$/, k + ' is 192 bits of hex (URL-safe inside postgres:// URLs)');
  for (const k of ['MEET_JWT_SECRET', 'QORLLA_BRIDGE_SECRET', 'PORTAL_INTROSPECTION_SECRET']) assert.match(a[k], /^[0-9a-f]{64}$/, k + ' is 32+ characters');
  assert.equal(Buffer.from(a.RECOVERY_ESCROW_KEY, 'base64').length, 32, 'the escrow key is base64 of exactly 32 bytes');
});
test("the generated file satisfies EVERY required variable of the repository's docker-compose.yml (a newly required variable fails this test instead of silently breaking CI)", () => {
  const compose = fs.readFileSync(path.join(REPO, 'docker-compose.yml'), 'utf8'), required = [...new Set([...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1]))];
  assert.ok(required.length >= 9, 'found the required variables: ' + required.join(', ')); const env = Object.fromEntries(render(generate()).trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  for (const k of required) assert.ok(env[k] && env[k].length >= 8, k + ' is required by docker-compose.yml but is missing or empty in the generated environment');
  for (const k of Object.keys(SECRETS)) assert.ok(required.includes(k), k + ' is generated but compose does not require it (remove it or document why)');
});
test('the command line writes a private file outside the repository and never prints a value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cenv-')), file = path.join(dir, 'ci.env'); try {
    const r = spawnSync(process.execPath, [CLI, file], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); const text = fs.readFileSync(file, 'utf8'), values = text.trim().split('\n').map((l) => l.slice(l.indexOf('=') + 1));
    assert.ok(!values.some((v) => v && (r.stdout + r.stderr).includes(v) && !/^http:/.test(v)), 'a generated secret was printed'); assert.match(r.stdout, /MAIN_DB_PASSWORD/, 'names are listed'); assert.match(r.stdout, /values are never printed/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'owner-only permissions');
    assert.ok(!text.split('\n').some((l) => /^[A-Z_]+=\s*$/.test(l)), 'no variable is empty');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('with --mask the values go ONLY into ::add-mask:: workflow commands (which the runner consumes and hides)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cenv-')), file = path.join(dir, 'ci.env'); try {
    const r = spawnSync(process.execPath, [CLI, file, '--mask'], { encoding: 'utf8' }), lines = r.stdout.split('\n').filter(Boolean), masks = lines.filter((l) => l.startsWith('::add-mask::')), others = lines.filter((l) => !l.startsWith('::add-mask::'));
    assert.equal(masks.length, Object.keys(SECRETS).length, 'one mask per secret'); const secrets = masks.map((l) => l.slice('::add-mask::'.length)); assert.ok(others.every((l) => !secrets.some((s) => l.includes(s))), 'a value appears outside an add-mask command');
    const text = fs.readFileSync(file, 'utf8'); for (const s of secrets) assert.ok(text.includes(s), 'the masked values are the ones in the file');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('it refuses to write inside the repository, and to run without a target', () => {
  const inside = path.join(REPO, 'ci', 'should-not-exist.env'); const r = spawnSync(process.execPath, [CLI, inside], { encoding: 'utf8' }); assert.equal(r.status, 2); assert.ok(!fs.existsSync(inside), 'nothing was written'); assert.match(r.stderr, /refusing to write secrets inside the repository/);
  assert.equal(spawnSync(process.execPath, [CLI], { encoding: 'utf8' }).status, 2); assert.equal(spawnSync(process.execPath, [CLI, '--mask'], { encoding: 'utf8' }).status, 2);
});
