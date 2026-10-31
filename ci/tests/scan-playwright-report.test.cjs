'use strict';
// The pre-upload scan must REJECT sensitive or unreadable artifacts and must PASS clean and properly sanitized reports.
// Reports are built here with real zip archives (stored and deflated), including nested and base64-embedded ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { scan, readZip, LIMITS, DEFAULT_ALLOW } = require('../scan-playwright-report.cjs');
const CLI = path.join(__dirname, '..', 'scan-playwright-report.cjs');

// ---- test helpers
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(entries, { method = 8 } = {}) {
  const locals = [], centrals = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data), m = e.method ?? method, comp = m === 8 ? zlib.deflateRawSync(data) : data, crc = crc32(data), flags = e.flags ?? 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(m, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, comp]);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(m, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    centrals.push(Buffer.concat([ch, name])); locals.push(local); off += local.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SHA1 = 'a'.repeat(8) + '0123456789'.repeat(3) + 'ab';                       // 40 hex-like characters, as Playwright names its resources
const CLEAN = {
  trace: '{"type":"before","callId":"call@1","title":"fill getByLabel(\'Email\')","params":{"value":"qa.user1@example.com"}}\n{"type":"log","message":"navigating to http://localhost:5100/login"}\n',
  network: '{"type":"resource-snapshot","snapshot":{"request":{"url":"http://localhost:5100/api/health","method":"GET","headers":[{"name":"accept","value":"*/*"}]},"response":{"status":200,"headers":[{"name":"content-type","value":"application/json"}],"content":{"_sha1":"' + SHA1 + '"}}}}\n',
  html: '<!doctype html><html><head><title>Playwright Test Report</title></head><body><script>const f=document.forms[0]; const body={ password: $(\'password\').value, user: email.value };</script><a href="http://www.w3.org/2000/svg">svg</a> support text</body></html>',
};
/** A typical report: index.html, an asset, and one trace archive with a screenshot. `mut` can change any part. */
function build(mut = {}) {
  const parts = { trace: CLEAN.trace, network: CLEAN.network, html: CLEAN.html, image: JPEG, imageName: 'resources/' + SHA1 + '.jpeg', extraTraceEntries: [], extraFiles: {}, ...mut };
  const traceZip = zip([{ name: 'trace.trace', data: parts.trace }, { name: 'trace.network', data: parts.network }, { name: parts.imageName, data: parts.image }, ...parts.extraTraceEntries]);
  const files = { 'index.html': parts.html, 'assets/app.js': 'console.log("report ui");', 'assets/app.css': 'body{margin:0}', ['data/' + SHA1 + '.zip']: parts.traceZip || traceZip, ...parts.extraFiles };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwscan-'));
  for (const [rel, data] of Object.entries(files)) { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); }
  return dir;
}
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const run = (mut, opts = { attested: true }) => { const d = build(mut); try { return scan(d, opts); } finally { rm(d); } };
const rules = (r) => [...new Set(r.findings.map((f) => f.rule))].sort();
const expectRule = (r, rule, msg) => assert.ok(r.findings.some((f) => f.rule === rule), (msg || rule) + ' :: ' + JSON.stringify(rules(r)));

// ---- clean reports pass
test('a clean synthetic report passes: archives, a screenshot, localhost traffic and example.com users are all understood', () => {
  const r = run(); assert.deepEqual(r.findings, [], JSON.stringify(r.findings)); assert.ok(r.stats.archives >= 1 && r.stats.images >= 1 && r.stats.files >= 5, JSON.stringify(r.stats));
});
test('JavaScript source that merely mentions "password" (the report UI, an app page snapshot) is not a leaked password', () => {
  assert.deepEqual(run({ html: CLEAN.html }).findings, []); assert.deepEqual(run({ extraFiles: { 'assets/form.js': 'const payload = { password: $("password").value, token: getToken() };' } }).findings, []);
});

// ---- network captures, traces and archived contents are rejected when sensitive
const net = (headers, extra = '') => '{"type":"resource-snapshot","snapshot":{"request":{"url":"http://localhost:5100/api/login","method":"POST","headers":[' + headers + ']' + extra + '},"response":{"status":200,"headers":[]}}}\n';
test('REJECTED: credential headers in a network capture (authorization, cookie, set-cookie, api keys)', () => {
  for (const [name, v] of [['authorization', 'Bearer abc123def456'], ['cookie', 'sid=9f8e7d6c5b4a'], ['set-cookie', 'session=zzz111aaa; HttpOnly'], ['x-api-key', 'k1234567890']])
    expectRule(run({ network: net('{"name":"' + name + '","value":"' + v + '"}') }), 'credential-header', name);
  expectRule(run({ network: net('', '').replace('"headers":[]', '"authorization":"Bearer abc123def456"') }), 'credential-header', 'object-style header');
});
test('REJECTED: tokens and keys anywhere, including inside archives', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  expectRule(run({ trace: CLEAN.trace + '{"log":"got ' + jwt + '"}\n' }), 'jwt-token'); expectRule(run({ html: CLEAN.html + '<!-- ' + jwt + ' -->' }), 'jwt-token', 'in the HTML');
  expectRule(run({ extraFiles: { 'notes.txt': '-----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIE\n-----END RSA ' + 'PRIVATE KEY-----' } }), 'private-key');
  for (const k of ['AKIA' + 'ABCDEFGHIJKLMNOP', 'ghp' + '_abcdefghijklmnopqrstuvwxyz0123456789', 'github' + '_pat_abcdefghijklmnopqrstuvwxyz0123', 'sk' + '_live_abcdefghij1234', 'xox' + 'b-1234567890-abcdefghij']) expectRule(run({ trace: CLEAN.trace + '{"log":"' + k + '"}\n' }), 'service-credential', k.slice(0, 8));
});
test('REJECTED: password values in request bodies (JSON, escaped JSON, form-encoded); redacted markers and allowlisted synthetic values pass', () => {
  expectRule(run({ network: net('', ',"postData":"{\\"email\\":\\"qa@example.com\\",\\"password\\":\\"Sup3rSecretPw!\\"}"') }), 'password-value', 'escaped JSON');
  expectRule(run({ trace: CLEAN.trace + '{"body":{"password":"Sup3rSecretPw!"}}\n' }), 'password-value', 'JSON');
  expectRule(run({ network: net('', ',"postData":"email=qa%40example.com&password=Sup3rSecretPw"') }), 'password-value', 'form');
  assert.deepEqual(run({ trace: CLEAN.trace + '{"body":{"password":"[REDACTED]"}}\n' }).findings, [], 'a redaction marker is not a secret');
  assert.deepEqual(run({ trace: CLEAN.trace + '{"body":{"password":"***"}}\n' }).findings, []);
  const d = build({ trace: CLEAN.trace + '{"body":{"password":"synthetic-ci-pass"}}\n' }); try { assert.deepEqual(scan(d, { attested: true, allow: { ...DEFAULT_ALLOW, passwords: ['synthetic-ci-pass'] } }).findings, [], 'an allowlisted synthetic password'); } finally { rm(d); }
});
test('REJECTED: URL credentials (query-string tokens, basic-auth URLs)', () => {
  expectRule(run({ network: net('', ',"queryString":[],"url2":"http://localhost:5100/cb?access_token=abcdef0123456789"') }), 'url-credential', 'query token');
  expectRule(run({ trace: CLEAN.trace + '{"log":"GET http://admin:hunter22@localhost:5100/x"}\n' }), 'url-credential', 'basic-auth');
});
test('REJECTED: e-mail addresses that are not synthetic, addresses other than loopback, and hosts the tests should never reach', () => {
  expectRule(run({ trace: CLEAN.trace + '{"log":"sent to dana.smith@acme-corp.com"}\n' }), 'real-or-unknown-email'); expectRule(run({ html: CLEAN.html + 'contact support@qorlla-real.com' }), 'real-or-unknown-email', 'in HTML');
  expectRule(run({ trace: CLEAN.trace + '{"log":"peer 203.0.113.9 connected"}\n' }), 'ip-address'); assert.deepEqual(run({ trace: CLEAN.trace + '{"log":"listening on 127.0.0.1"}\n' }).findings, [], 'loopback is fine');
  assert.deepEqual(run({ trace: CLEAN.trace + '{"log":"electron 33.4.11 chrome 130.0.6723.170"}\n' }).findings, [], 'version numbers are not addresses');
  expectRule(run({ network: net('', ',"x":"https://api.real-service.io/v1/users"') }), 'unexpected-host');
});
test('REJECTED: opaque secret-like values in captured traffic; the sha1 resource ids Playwright writes are not secrets', () => {
  expectRule(run({ network: net('', ',"body":"Zk3Jd9Qw8Lx7Vb2Nc5Mh4Gt6Ry1Uu0PaS"') }), 'opaque-secret-like-value');
  assert.deepEqual(run({ network: CLEAN.network }).findings, [], 'the clean capture already contains a 40-character _sha1');
});
test('REJECTED: archives nested inside archives are opened, and the finding shows the path through them', () => {
  const secret = '{"log":"AKIA' + 'ABCDEFGHIJKLMNOP"}\n', inner = zip([{ name: 'deep/trace.trace', data: secret }]), middle = zip([{ name: 'inner.zip', data: inner }]);
  const r = run({ extraTraceEntries: [{ name: 'middle.zip', data: middle }] }); expectRule(r, 'service-credential'); assert.ok(r.findings.some((f) => (f.file.match(/!\//g) || []).length >= 3), 'path through three archives: ' + r.findings.map((f) => f.file).join(' | '));
});
test('REJECTED: a base64 archive embedded in the HTML report is decoded and scanned; unknown embedded payloads are refused', () => {
  const emb = zip([{ name: 'report.json', data: '{"note":"AKIA' + 'ABCDEFGHIJKLMNOP", "pad":"' + 'x'.repeat(400) + '"}' }], { method: 0 });
  expectRule(run({ html: CLEAN.html + '<script>var d="data:application/zip;base64,' + emb.toString('base64') + '"</script>' }), 'service-credential', 'inside the embedded archive');
  expectRule(run({ html: CLEAN.html + '<script>var d="data:application/x-evil;base64,' + Buffer.alloc(300, 7).toString('base64') + '"</script>' }), 'embedded-payload-unknown');
});

// ---- screenshots
test('SCREENSHOTS: allowed only for an attested synthetic-only run; the image type must match; metadata strings are scanned', () => {
  expectRule(run({}, { attested: false }), 'screenshot-not-attested'); assert.deepEqual(run({}, { attested: true }).findings, []);
  expectRule(run({ image: JPEG, imageName: 'resources/x.png' }), 'image-type-mismatch');
  expectRule(run({ image: Buffer.concat([JPEG, Buffer.from('Comment: taken by dana.smith@acme-corp.com on C:/Users/dana/Desktop')]) }), 'real-or-unknown-email', 'an address in the image metadata');
  assert.deepEqual(run({ image: PNG, imageName: 'resources/y.png' }).findings, []);
});

// ---- fail-closed on anything not understood
test('FAIL-CLOSED: videos, unknown binaries, corrupt/encrypted/unsafe/oversized archives, too-deep nesting and an empty report are findings, never passes', () => {
  expectRule(run({ extraFiles: { 'video/session.webm': Buffer.from([0x1a, 0x45, 0xdf, 0xa3]) } }), 'unscannable-media');
  expectRule(run({ extraFiles: { 'blob.bin': Buffer.from([1, 2, 0, 3, 4]) } }), 'unknown-binary'); expectRule(run({ extraFiles: { 'noext': Buffer.from([0xff, 0xfe, 0, 0, 9]) } }), 'unknown-binary', 'extensionless binary');
  const good = zip([{ name: 'a.txt', data: 'hello' }]);
  expectRule(run({ extraFiles: { 'data/truncated.zip': good.subarray(0, good.length - 10) } }), 'archive-unreadable', 'truncated'); expectRule(run({ extraFiles: { 'data/fake.zip': Buffer.from('not a zip at all') } }), 'archive-unreadable', 'not a zip');
  expectRule(run({ extraFiles: { 'data/enc.zip': zip([{ name: 'a.txt', data: 'hello', flags: 1 }]) } }), 'archive-unreadable', 'encrypted');
  expectRule(run({ extraFiles: { 'data/slip.zip': zip([{ name: '../../evil.txt', data: 'x' }]) } }), 'archive-unreadable', 'path traversal'); expectRule(run({ extraFiles: { 'data/abs.zip': zip([{ name: '/etc/passwd', data: 'x' }]) } }), 'archive-unreadable', 'absolute name');
  expectRule(run({ extraFiles: { 'data/bomb.zip': zip([{ name: 'zeros.txt', data: Buffer.alloc(20 * 1024 * 1024) }]) } }), 'archive-unreadable', 'zip bomb ratio');
  let deep = zip([{ name: 'a.txt', data: 'x' }]); for (let i = 0; i < 6; i++) deep = zip([{ name: 'n' + i + '.zip', data: deep }]); expectRule(run({ extraFiles: { 'data/deep.zip': deep } }), 'archive-too-deep');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pwscan-empty-')); try { expectRule(scan(empty, { attested: true }), 'empty-report', 'an empty directory is never "clean"'); } finally { rm(empty); }
});
test('FAIL-CLOSED: symbolic links are refused (skipped where the platform will not create them)', (t) => {
  const d = build(); try { try { fs.symlinkSync(path.join(d, 'index.html'), path.join(d, 'link.html')); } catch { return t.skip('symlinks cannot be created here'); } expectRule(scan(d, { attested: true }), 'symlink'); } finally { rm(d); }
});
test('the zip reader refuses what it does not support', () => {
  assert.throws(() => readZip(Buffer.from('PK')), /not a readable zip/); const z = zip([{ name: 'a.txt', data: 'hello' }]); assert.equal(readZip(z)[0].data.toString(), 'hello');
  const stored = zip([{ name: 'a.txt', data: 'hello' }], { method: 0 }); assert.equal(readZip(stored)[0].data.toString(), 'hello'); assert.throws(() => readZip(zip([{ name: 'a.txt', data: 'x', method: 14 }])), /unsupported compression method/);
  assert.ok(LIMITS.depth >= 3 && LIMITS.ratio > 1, 'limits exist');
});

// ---- sanitized reports remain uploadable; output never contains the values
test('SANITIZED reports stay uploadable: the same traffic with every sensitive value redacted or removed passes', () => {
  const sanitized = net('{"name":"authorization","value":"[REDACTED]"},{"name":"cookie","value":"***"},{"name":"accept","value":"*/*"}', ',"postData":"{\\"email\\":\\"qa.user1@example.com\\",\\"password\\":\\"[REDACTED]\\"}"');
  const r = run({ network: sanitized, trace: CLEAN.trace + '{"log":"GET http://localhost:5100/cb?access_token=[REDACTED]"}\n' }); assert.deepEqual(r.findings, [], JSON.stringify(r.findings));
});
test('the command line: exit 0 clean, 1 findings, 2 problems; findings are listed without the matched values; the attestation is read from the environment', () => {
  const secret = 'Sup3rSecretPw9QzXk', ok = build(), bad = build({ network: net('', ',"postData":"password=' + secret + '"') });
  try {
    const env = { ...process.env, QORLLA_CI_SYNTHETIC_DATA: '1' }, cli = (args, e = env) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: e });
    const a = cli([ok]); assert.equal(a.status, 0, a.stdout + a.stderr); assert.match(a.stdout, /PLAYWRIGHT REPORT SCAN PASSED/);
    const b = cli([bad]); assert.equal(b.status, 1); assert.match(b.stdout, /SCAN FAILED/); assert.match(b.stdout, /password-value/); assert.match(b.stdout, /Nothing will be uploaded/); assert.ok(!(b.stdout + b.stderr).includes(secret), 'the secret value was printed');
    const c = cli([ok], { ...process.env, QORLLA_CI_SYNTHETIC_DATA: '' }); assert.equal(c.status, 1, 'without the attestation, screenshots fail the scan'); assert.match(c.stdout, /screenshot-not-attested/);
    assert.equal(cli([path.join(ok, 'does-not-exist')]).status, 2); assert.equal(cli([]).status, 2); assert.equal(cli([ok, '--allowlist', path.join(ok, 'missing.json')]).status, 2);
    // the allowlist file is authoritative: it REPLACES the defaults, so it lists every allowed domain
    const al = path.join(ok, 'allow.json'); fs.writeFileSync(al, JSON.stringify({ emailDomains: ['example.com', 'acme-corp.com'] })); const withMail = build({ trace: CLEAN.trace + '{"log":"dana.smith@acme-corp.com"}\n' });
    try { assert.equal(cli([withMail]).status, 1); assert.equal(cli([withMail, '--allowlist', al]).status, 0, 'an allowlisted domain is accepted'); } finally { rm(withMail); }
  } finally { rm(ok); rm(bad); }
});
test('the shipped allowlist is valid JSON, narrow, and holds no password', () => {
  const al = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifact-scan-allowlist.json'), 'utf8'));
  assert.deepEqual(al.passwords, []); assert.ok(al.emailDomains.every((d) => /^example\.(com|org|net)$/.test(d)), 'only reserved example domains'); assert.deepEqual(al.ips, ['127.0.0.1', '7.7.7.7', '8.8.8.8', '9.9.9.9', '10.0.0.9'], 'the exact simulated client addresses that tests/lockout.spec.js writes; widening this list must be a deliberate change here too'); assert.ok(al.hosts.includes('localhost'));
  // The host list is pinned EXACTLY, so adding a host is a deliberate, reviewed change to this test too: localhost and loopback; XMP/IPTC/SVG namespace URLs that appear inside screenshot metadata (identifiers, never requested);
  // the Tailwind CDN the pages load; and github.com, which Playwright's `ci` metadata links to (a public repository). No Qorlla, cloud, mail or analytics host.
  assert.deepEqual([...al.hosts].sort(), ['127.0.0.1', 'cdn.tailwindcss.com', 'cv.iptc.org', 'github.com', 'localhost', 'ns.adobe.com', 'tailwindcss.com', 'www.w3.org']);
});
test('the real report is checked against the committed Playwright configuration: git capture is off', () => {
  const cfg = fs.readFileSync(path.join(__dirname, '..', '..', 'playwright.config.js'), 'utf8');
  assert.match(cfg, /captureGitInfo:\s*\{\s*commit:\s*false,\s*diff:\s*false\s*\}/, 'the report would embed the commit author, committer and message body');
  assert.ok(!/captureGitInfo:\s*\{[^}]*true/.test(cfg));
});

test('EXTENSIONLESS attachments: a PNG or JPEG without an extension (how Playwright stores a failure screenshot) is treated as a screenshot; other binaries without an extension are still refused', () => {
  expectRule(run({ extraFiles: { 'data/attach.zip': zip([{ name: 'attachments/' + SHA1, data: PNG }]) } }, { attested: false }), 'screenshot-not-attested', 'an extensionless PNG is subject to the attestation rule');
  assert.deepEqual(run({ extraFiles: { 'data/attach.zip': zip([{ name: 'attachments/' + SHA1, data: PNG }]) } }).findings, [], 'attested, an extensionless PNG passes');
  expectRule(run({ extraFiles: { 'data/attach.zip': zip([{ name: 'attachments/' + SHA1, data: Buffer.concat([PNG, Buffer.from('taken by dana.smith@acme-corp.com')]) }]) } }), 'real-or-unknown-email', 'its metadata is scanned');
  expectRule(run({ extraFiles: { 'data/attach.zip': zip([{ name: 'attachments/' + SHA1, data: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]) }]) } }), 'unknown-binary', 'an executable without an extension is still refused');
});

test('RESERVED NAMES (RFC 2606 / 6761) are synthetic by definition and pass; look-alikes are still flagged', () => {
  const t = (host, mail) => run({ trace: CLEAN.trace + '{"log":"GET https://' + host + '/x by ' + mail + '"}\n' });
  for (const [h, m] of [['evil.example', 'qa@example.test'], ['app.example.test', 'a.b@mail.example.org'], ['x.invalid', 'q@sub.example.net'], ['svc.localhost', 'qa@example.com']]) assert.deepEqual(t(h, m).findings, [], h + ' / ' + m);
  expectRule(t('notexample.com', 'qa@example.com'), 'unexpected-host', 'notexample.com is a different domain'); expectRule(t('example.com.evil.io', 'qa@example.com'), 'unexpected-host', 'example.com.evil.io is not under example.com');
  expectRule(t('evil.example', 'qa@notexample.org'), 'real-or-unknown-email', 'notexample.org is a different domain'); expectRule(t('evil.example', 'qa@example.org.evil.io'), 'real-or-unknown-email');
  expectRule(t('evil.example', 'qa@test.com'), 'real-or-unknown-email', 'test.com is a real domain, only the .test TLD is reserved');
});
test('WEBP screenshots (Playwright writes them for page snapshots) are recognised by their signature, with or without an extension', () => {
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);
  assert.deepEqual(run({ extraFiles: { 'data/w.zip': zip([{ name: 'resources/' + SHA1 + '.webp', data: WEBP }, { name: 'attachments/' + SHA1, data: WEBP }]) } }).findings, [], 'attested');
  expectRule(run({ extraFiles: { 'data/w.zip': zip([{ name: 'resources/x.webp', data: WEBP }]) } }, { attested: false }), 'screenshot-not-attested');
  expectRule(run({ extraFiles: { 'data/w.zip': zip([{ name: 'resources/x.webp', data: PNG }]) } }), 'image-type-mismatch', 'a PNG named .webp'); expectRule(run({ extraFiles: { 'data/w.zip': zip([{ name: 'resources/x.webp', data: Buffer.from('RIFFxxxxWAVEfmt ') }]) } }), 'image-type-mismatch', 'RIFF but not WEBP');
  expectRule(run({ extraFiles: { 'data/w.zip': zip([{ name: 'resources/x.webp', data: Buffer.concat([WEBP, Buffer.from('taken by dana.smith@acme-corp.com')]) }]) } }), 'real-or-unknown-email', 'metadata is scanned');
});
