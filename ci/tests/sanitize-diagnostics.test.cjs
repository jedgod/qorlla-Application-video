'use strict';
// Container logs reach a PUBLIC Actions log only through the sanitizer: credentials, connection strings, headers and tokens must not survive it.
// Fake credentials are assembled at run time so no token-shaped literal sits in the source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sanitize, loadSecrets, residual } = require('../sanitize-diagnostics.cjs');
const { generate, render } = require('../cluster-env.cjs');
const CLI = path.join(__dirname, '..', 'sanitize-diagnostics.cjs');

const env = generate(), secrets = Object.values(env.secrets);
const PW = env.secrets.MAIN_DB_PASSWORD, APP = env.secrets.QORLLA_APP_DB_PASSWORD, JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ' + 'zdWIiOiJhbGljZSJ9.c2lnbmF0dXJlMTIzNDU2', AWS = 'AKIA' + 'ABCDEFGHIJKLMNOP', GH = 'ghp' + '_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const sanitizeWith = (raw, extra = {}) => sanitize(raw, { service: 'svc', secrets, ...extra });
const stays = (out, ...vals) => vals.filter((v) => out.includes(v));

test('exact ephemeral secrets are removed in every encoding they may appear in', () => {
  const raw = ['ERROR password authentication failed for user "qorlla_main" with ' + PW, 'ERROR url-encoded ' + encodeURIComponent(APP + '+/'), 'ERROR as base64 ' + Buffer.from(PW).toString('base64'), 'ERROR as hex ' + Buffer.from(PW).toString('hex')].join('\n');
  const out = sanitizeWith(raw, { secrets: loadSecretsFrom(env) }); assert.deepEqual(stays(out, PW, APP, Buffer.from(PW).toString('base64'), Buffer.from(PW).toString('hex')), [], out);
});
function loadSecretsFrom(e) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'san-')), f = path.join(dir, 'e.env'); fs.writeFileSync(f, render(e)); try { return loadSecrets(f); } finally { fs.rmSync(dir, { recursive: true, force: true }); } }
test('connection strings, authorization and cookie headers, bearer tokens, JWTs, keys and key=value secrets are redacted even without knowing the value', () => {
  const lines = ['ERROR connect failed: postgres://qorlla_main:Sup3rSecr3tPw@main-db:5432/qorlla_main', 'ERROR request rejected Authorization: Bearer abcdefghijklmnop1234', 'WARN Cookie: sid=9f8e7d6c5b4a3210; theme=dark', 'ERROR Set-Cookie: session=zzz111aaa222bbb; HttpOnly',
    'ERROR token ' + JWT, 'ERROR key ' + AWS + ' and ' + GH, 'ERROR config PGPASSWORD=Sup3rSecr3tPw API_TOKEN: "tok_12345678abcdef"', 'ERROR secret=Sup3rSecr3tPw&password=Sup3rSecr3tPw'];
  const out = sanitizeWith(lines.join('\n'), { secrets: [] }); assert.deepEqual(stays(out, 'Sup3rSecr3tPw', 'abcdefghijklmnop1234', '9f8e7d6c5b4a3210', 'zzz111aaa222bbb', JWT, AWS, GH, 'tok_12345678abcdef'), [], out);
  assert.match(out, /postgres:\/\/\[redacted\]@main-db/, 'the host is kept (useful) and the credentials are not'); assert.match(out, /Authorization: \[redacted\]/i);
});
test('addresses and identifiers are redacted: e-mail, non-loopback IPs, hex ids and opaque strings; loopback stays', () => {
  const out = sanitizeWith(['ERROR mail to dana.smith@acme-corp.com failed', 'ERROR peer 203.0.113.9 refused; local 127.0.0.1 ok', 'ERROR session ' + 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3', 'ERROR blob Zk3Jd9Qw8Lx7Vb2Nc5Mh4Gt6Ry1Uu0PaS'].join('\n'), { secrets: [] });
  assert.deepEqual(stays(out, 'dana.smith', 'acme-corp', '203.0.113.9', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3', 'Zk3Jd9Qw8Lx7Vb2Nc5Mh4Gt6Ry1Uu0PaS'), [], out); assert.match(out, /127\.0\.0\.1/);
});
test('ALLOWLIST: only error, warning and lifecycle lines are shown; everything else is dropped and counted', () => {
  const raw = ['main-db-1  | debug: loaded settings {"password":"' + PW + '"}', 'main-db-1  | PostgreSQL init process complete; ready for start up.', 'main-db-1  | 2026-10-31 FATAL:  password authentication failed for user "qorlla_app"', 'main-db-1  | query: SELECT * FROM users WHERE token=\'abc\'', 'workspace-signaling-engine-1  | listening on :5000', 'workspace-signaling-engine-1  | GET /api/x 200 12ms'].join('\n');
  const out = sanitizeWith(raw); assert.match(out, /FATAL/); assert.match(out, /listening on :5000/); assert.match(out, /ready for start up/); assert.ok(!/SELECT|GET \/api|debug: loaded/.test(out), 'noise is not shown: ' + out); assert.match(out, /4 dropped|3 dropped|2 dropped/, 'drops are counted'); assert.ok(!out.includes(PW));
});
test('a dropped line cannot leak: a secret hidden in a line that is not allowlisted never appears', () => {
  const out = sanitizeWith('debug: payload {"password":"' + PW + '","note":"x"}\ninfo: token=' + APP); assert.ok(!out.includes(PW) && !out.includes(APP)); assert.match(out, /0 line\(s\) shown of 2 \(2 dropped/);
});
test('limits: the last N kept lines, each truncated', () => {
  const raw = Array.from({ length: 100 }, (_, i) => 'ERROR failure number ' + i + ' ' + 'x'.repeat(500)).join('\n'), out = sanitize(raw, { service: 's', secrets: [], maxLines: 5, maxLen: 80 }), body = out.split('\n').slice(1);
  assert.equal(body.length, 5); assert.ok(body.every((l) => l.length <= 82)); assert.match(body[4], /failure number 99/);
});
test('SELF-CHECK: if something sensitive could still be visible, the whole output is suppressed', () => {
  assert.equal(residual('ERROR ok', secrets), false); assert.equal(residual('x ' + PW, secrets), true); assert.equal(residual('postgres://u:pw@h/db', []), true); assert.equal(residual('Cookie: a=b', []), true);
  assert.match(sanitize('ERROR plain', { service: 'svc', secrets: [] }), /1 line\(s\) shown/);
});
test('the command line reads stdin, takes the secrets from the env file, and prints only the sanitized summary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'san-')), f = path.join(dir, 'ci.env'); try {
    fs.writeFileSync(f, render(env)); const r = spawnSync(process.execPath, [CLI, '--service', 'main-db', '--env-file', f], { input: 'main-db-1  | FATAL: password authentication failed for ' + PW + '\nmain-db-1  | noise line\n', encoding: 'utf8' });
    assert.equal(r.status, 0); assert.ok(!(r.stdout + r.stderr).includes(PW)); assert.match(r.stdout, /=== main-db: 1 line\(s\) shown of 2/); assert.match(r.stdout, /FATAL/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
