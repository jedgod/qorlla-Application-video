const {test}=require('node:test');const assert=require('node:assert/strict');const {verifiedOrigin,navigationAllowed,externalAllowed}=require('../security.cjs');
test('accepts only bare HTTPS origin',()=>{assert.equal(verifiedOrigin('https://meet.example.org/'),'https://meet.example.org');for(const x of ['http://meet.example.org/','https://meet.example.org/path','https://u:p@meet.example.org/','javascript:alert(1)'])assert.throws(()=>verifiedOrigin(x));});
test('navigation is origin confined',()=>{assert.equal(navigationAllowed('https://meet.example.org/auth','https://meet.example.org'),true);assert.equal(navigationAllowed('https://evil.example.org','https://meet.example.org'),false);});
test('external links require HTTPS',()=>{assert.equal(externalAllowed('https://example.org/help'),true);assert.equal(externalAllowed('file:///etc/passwd'),false);assert.equal(externalAllowed('mailto:a@b.com'),false);});

const sec = require('../security.cjs');
test('a packaged build refuses every Chromium switch that disables the process sandbox', () => {
  for (const bad of ['--no-sandbox', '--NO-SANDBOX', '--disable-setuid-sandbox', '--disable-gpu-sandbox', '--disable-seccomp-filter-sandbox', '--disable-namespace-sandbox', '--no-sandbox=1']) assert.equal(sec.sandboxDisabled(['/opt/Qorlla/qorlla', bad, 'qorlla://join?meeting=12345678901']), true, bad);
  for (const ok of [[], ['/opt/Qorlla/qorlla'], ['/opt/Qorlla/qorlla', '--enable-sandbox'], ['qorlla', 'qorlla://join?meeting=12345678901'], ['qorlla', '--sandbox-ok']]) assert.equal(sec.sandboxDisabled(ok), false, JSON.stringify(ok));
  assert.equal(sec.sandboxDisabled(undefined), false);
});
test('the build configuration cannot fall back to electron-builder\'s --no-sandbox AppImage launcher', () => {
  const pkg = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'package.json'), 'utf8')), args = pkg.build.appImage && pkg.build.appImage.executableArgs;
  assert.ok(Array.isArray(args) && args.length > 0, 'an EMPTY or missing executableArgs makes electron-builder substitute --no-sandbox');
  assert.equal(sec.sandboxDisabled(args), false, JSON.stringify(args));
});
