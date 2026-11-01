'use strict';
// The desktop app is a window onto the one Qorlla server (localhost:3200 in development): it keeps no database and starts no server of its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sec = require('../security.cjs');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('the shell code contains no database, no server and no local data files', () => {
  for (const f of ['main.cjs', 'preload.cjs', 'security.cjs', 'dev-local.cjs']) {
    const src = read(f);
    assert.doesNotMatch(src, /require\(['"](express|pg|sqlite3?|better-sqlite3|nedb|mongodb|mongoose|lowdb|socket\.io|http-server)['"]\)/, f + ': no database or server module');
    assert.doesNotMatch(src, /createServer|\.listen\(|new Database|writeFile|appendFile|mkdirSync/, f + ': no server socket and no data files written');
    assert.doesNotMatch(src, /server\.js|data[\\/]|\.db['"]|\.sqlite/, f + ': does not start or open the Qorlla server or a data file');
  }
});
test('the packaged app ships only the shell, and has no runtime dependencies that could hold data', () => {
  assert.deepEqual(pkg.dependencies || {}, {}); assert.ok(!(pkg.build.files || []).some((f) => /server|data|db|sqlite/i.test(f)), 'build files: ' + pkg.build.files.join(','));
});
test('every page the shell opens comes from the one configured server', () => {
  const origins = sec.trustedOrigins('http://localhost:3200', '', { allowLocalhostHttp: true });
  assert.deepEqual(origins, ['http://localhost:3200']);
  assert.ok(sec.navigationAllowed('http://localhost:3200/qorlla.html', origins, { allowLocalhostHttp: true }));
  for (const other of ['http://localhost:3225/', 'http://localhost:3201/', 'http://127.0.0.1:3200/', 'file:///C:/x.html']) assert.ok(!sec.navigationAllowed(other, origins, { allowLocalhostHttp: true }), other + ' is not the Qorlla server');
});
test('the local launcher points at localhost:3200 by default, and a packaged build refuses plain http', () => {
  const launcher = read('dev-local.cjs'); assert.match(launcher, /QORLLA_APP_URL \|\| 'http:\/\/localhost:3200'/); assert.match(launcher, /QORLLA_DEV_ALLOW_LOCALHOST_HTTP: '1'/);
  assert.equal(pkg.scripts['dev:local'], 'node dev-local.cjs');
  assert.equal(sec.localhostHttpAllowed({ QORLLA_DEV_ALLOW_LOCALHOST_HTTP: '1' }, false), true); assert.equal(sec.localhostHttpAllowed({ QORLLA_DEV_ALLOW_LOCALHOST_HTTP: '1' }, true), false);
});
