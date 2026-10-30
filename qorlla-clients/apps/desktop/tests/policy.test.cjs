const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../security.cjs');

test('trusted origins: app + explicit Meet origins only, bare https, no credentials/paths/queries', () => {
  assert.deepEqual(s.trustedOrigins('https://app.qorlla.test/', 'https://meet.qorlla.test:444/, https://meet.qorlla.test:444/'), ['https://app.qorlla.test', 'https://meet.qorlla.test:444']);
  for (const bad of ['http://app.qorlla.test/', 'https://u:p@app.qorlla.test/', 'https://app.qorlla.test/path', 'https://app.qorlla.test/?x=1', 'https://app.qorlla.test/#x', 'ftp://app.qorlla.test/', '', 'not a url']) assert.throws(() => s.trustedOrigins(bad), undefined, bad);
  assert.throws(() => s.trustedOrigins('https://app.qorlla.test/', 'http://meet.qorlla.test/'), /HTTPS/, 'a Meet origin gets the same rules');
});
test('plain http is refused everywhere unless the development exception is explicitly on, and then only for localhost/127.0.0.1', () => {
  assert.throws(() => s.verifiedOrigin('http://localhost:5290/'));
  assert.equal(s.verifiedOrigin('http://localhost:5290/', { allowLocalhostHttp: true }), 'http://localhost:5290');
  assert.equal(s.verifiedOrigin('http://127.0.0.1:3310/', { allowLocalhostHttp: true }), 'http://127.0.0.1:3310');
  for (const h of ['http://example.com/', 'http://192.168.1.5/', 'http://localhost.evil.test/', 'http://10.0.2.2/']) assert.throws(() => s.verifiedOrigin(h, { allowLocalhostHttp: true }), h);
  assert.equal(s.localhostHttpAllowed({ QORLLA_DEV_ALLOW_LOCALHOST_HTTP: '1' }, false), true);
  assert.equal(s.localhostHttpAllowed({ QORLLA_DEV_ALLOW_LOCALHOST_HTTP: '1' }, true), false, 'a packaged build ignores it');
  for (const v of [undefined, '', '0', 'true', 'yes']) assert.equal(s.localhostHttpAllowed({ QORLLA_DEV_ALLOW_LOCALHOST_HTTP: v }, false), false, String(v));
});
test('navigation is allowed only to the trusted origins (exact match, https), never lookalikes', () => {
  const o = ['https://app.qorlla.test', 'https://meet.qorlla.test:444'];
  assert.ok(s.navigationAllowed('https://app.qorlla.test/guest/join-meeting?x=1', o)); assert.ok(s.navigationAllowed('https://meet.qorlla.test:444/room', o)); assert.ok(s.navigationAllowed('https://app.qorlla.test/x', 'https://app.qorlla.test'), 'a single origin string still works');
  for (const bad of ['https://app.qorlla.test.evil.test/', 'https://evil.test/https://app.qorlla.test/', 'https://meet.qorlla.test/', 'http://app.qorlla.test/', 'https://user@app.qorlla.test@evil.test/', 'file:///C:/x', 'javascript:alert(1)', 'data:text/html,x', 'qorlla://join?meeting=12345678901', '']) assert.equal(s.navigationAllowed(bad, o), false, bad);
  assert.equal(s.navigationAllowed('http://localhost:5290/x', ['http://localhost:5290']), false, 'http only with the explicit exception'); assert.equal(s.navigationAllowed('http://localhost:5290/x', ['http://localhost:5290'], { allowLocalhostHttp: true }), true);
});
test('permissions: only media, screen capture and notifications, only for trusted origins; everything else refused', () => {
  const o = ['https://app.qorlla.test', 'https://meet.qorlla.test:444'];
  for (const p of ['media', 'display-capture', 'notifications']) { assert.equal(s.permissionAllowed(p, 'https://meet.qorlla.test:444/room', o), true, p); assert.equal(s.permissionAllowed(p, 'https://evil.test/', o), false, p); }
  for (const p of ['geolocation', 'clipboard-read', 'midi', 'openExternal', 'fullscreen', 'pointerLock', 'usb', 'hid', 'serial', 'fileSystem', 'unknown']) assert.equal(s.permissionAllowed(p, 'https://meet.qorlla.test:444/room', o), false, p);
});
test('external links: plain https only', () => {
  for (const ok of ['https://qorlla.test/help', 'https://example.com/x?y=1']) assert.equal(s.externalAllowed(ok), true);
  for (const bad of ['http://x.test/', 'file:///etc/passwd', 'javascript:alert(1)', 'https://u:p@x.test/', 'mailto:a@b.co', 'ms-msdt:/id', 'search-ms:query=x', 'qorlla://join?meeting=12345678901', '']) assert.equal(s.externalAllowed(bad), false, bad);
});
test('deep links: qorlla://join?meeting=<11 digits> only; anything extra, malformed or injected is ignored', () => {
  assert.deepEqual(s.parseJoinLink('qorlla://join?meeting=12345678901'), { meetingId: '12345678901' });
  for (const bad of ['qorlla://join?meeting=1234567890', 'qorlla://join?meeting=123456789012', 'qorlla://join?meeting=abcdefghijk', 'qorlla://join', 'qorlla://join?meeting=12345678901&next=https://evil.test', 'qorlla://join?other=12345678901', 'qorlla://open?meeting=12345678901', 'qorlla://join/../x?meeting=12345678901', 'https://join?meeting=12345678901', 'qorlla://join?meeting=12345678901%0d%0a', 'qorlla://join?meeting=../../x', '', null, undefined]) assert.equal(s.parseJoinLink(bad), null, String(bad));
  assert.equal(s.prejoinUrl('https://app.qorlla.test', '12345678901'), 'https://app.qorlla.test/guest/meeting/12345678901/prejoin');
});
