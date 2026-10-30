'use strict';
// The staging edge configuration must be safe by construction: the committed files pass, and each unsafe variation is caught.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkCoturnTemplate, checkCompose, checkEnv } = require('./staging-config-check.cjs');
const DIR = path.resolve(__dirname, '..', 'deployment', 'staging'), read = (p) => fs.readFileSync(path.join(DIR, p), 'utf8');
const GOOD_ENV = 'MEET_HOST=meet.staging.qorlla.net\nAPP_HOST=app.staging.qorlla.net\nTURN_HOST=turn.staging.qorlla.net\nTURN_EXTERNAL_IP=203.0.113.10\nQORLLA_MEET_UPSTREAM=127.0.0.1:3310\nQORLLA_APP_UPSTREAM=127.0.0.1:5290\nTURN_MIN_PORT=49160\nTURN_MAX_PORT=49200\n';

test('the committed coturn template and compose file pass', () => { assert.deepEqual(checkCoturnTemplate(read('coturn/turnserver.conf.template')), []); assert.deepEqual(checkCompose(read('docker-compose.yml')), []); });
test('the coturn template cannot lose its safety directives unnoticed', () => {
  const t = read('coturn/turnserver.conf.template');
  assert.ok(checkCoturnTemplate(t.replace('use-auth-secret\n', '')).some((p) => /use-auth-secret/.test(p)));
  assert.ok(checkCoturnTemplate(t.replace('\nlt-cred-mech\n', '\n')).some((p) => /lt-cred-mech/.test(p)), 'a template without lt-cred-mech would refuse every valid credential');
  assert.ok(checkCoturnTemplate(t.replace('denied-peer-ip=10.0.0.0-10.255.255.255\n', '')).some((p) => /10\.0\.0\.0/.test(p)));
  assert.ok(checkCoturnTemplate(t.replace('no-cli\n', '')).some((p) => /no-cli/.test(p)));
  assert.ok(checkCoturnTemplate(t + '\nno-auth\n').some((p) => /forbidden/.test(p)));
  assert.ok(checkCoturnTemplate(t + '\nallow-loopback-peers\n').some((p) => /forbidden/.test(p)));
  assert.ok(checkCoturnTemplate(t.replace('static-auth-secret=${TURN_SHARED_SECRET}', 'static-auth-secret=hunter2hunter2')).length >= 1, 'a literal secret is refused');
});
test('the compose file cannot publish a database, run privileged or inline the TURN secret', () => {
  const c = read('docker-compose.yml');
  assert.ok(checkCompose(c + '\n    ports: ["5432:5432"]\n').some((p) => /database/.test(p)));
  assert.ok(checkCompose(c.replace('    restart: unless-stopped\n', '    restart: unless-stopped\n    privileged: true\n')).some((p) => /privileged/.test(p)));
  assert.ok(checkCompose(c.replace('TURN_SHARED_SECRET_FILE: /run/secrets/turn_shared_secret', 'TURN_SHARED_SECRET: abcdefabcdefabcdefabcdefabcdefabcdef')).some((p) => /inline/.test(p)));
});
test('a real .env needs real hostnames, a public address and a bounded relay range; the example file is rejected on purpose', () => {
  assert.deepEqual(checkEnv(GOOD_ENV), []);
  assert.ok(checkEnv(read('.env.example')).length >= 3, 'placeholders are not accepted');
  assert.ok(checkEnv(GOOD_ENV.replace('203.0.113.10', '192.168.1.20')).some((p) => /public/.test(p)));
  assert.ok(checkEnv(GOOD_ENV.replace('meet.staging.qorlla.net', 'localhost')).some((p) => /MEET_HOST/.test(p)));
  assert.ok(checkEnv(GOOD_ENV.replace('app.staging.qorlla.net', 'meet.staging.qorlla.net')).some((p) => /different/.test(p)));
  assert.ok(checkEnv(GOOD_ENV.replace('TURN_MAX_PORT=49200', 'TURN_MAX_PORT=65000')).some((p) => /relay range/.test(p)));
  assert.ok(checkEnv(GOOD_ENV.replace('127.0.0.1:3310', '203.0.113.7:3310')).some((p) => /UPSTREAM/.test(p)));
  assert.ok(checkEnv(GOOD_ENV + 'TURN_SHARED_SECRET=abc\n').some((p) => /secrets/.test(p)));
});
test('no secret file is tracked in the staging directory', () => {
  const tracked = require('node:child_process').execFileSync('git', ['ls-files', '--', DIR], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(!tracked.some((f) => /secrets\/|\.env$|\.key$|\.pem$/.test(f)), 'tracked files: ' + tracked.join(', '));
});
