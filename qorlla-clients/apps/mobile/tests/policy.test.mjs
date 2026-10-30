import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPolicy, verifiedOrigin, parseJoinLink, navigationDecision, testHooksEnabled, ANDROID_MEETING_PERMISSIONS } from '../src/policy.js';
import { safeNotificationPayload, validateDeepLink } from '../src/security/device-policy.js';

const P = () => createPolicy({ appUrl: 'https://app.qorlla.test/', meetUrls: 'https://meet.qorlla.test:444/' });
test('origins: bare https only; Meet origins get the same rules; http only for localhost in a test build', () => {
  assert.deepEqual(P().origins, ['https://app.qorlla.test', 'https://meet.qorlla.test:444']);
  for (const bad of ['http://app.qorlla.test/', 'https://u:p@app.qorlla.test/', 'https://app.qorlla.test/x', 'https://app.qorlla.test/?a=1', 'https://app.qorlla.test/#a', '', 'nope', undefined]) assert.throws(() => verifiedOrigin(bad), undefined, String(bad));
  assert.throws(() => createPolicy({ appUrl: 'https://app.qorlla.test/', meetUrls: 'http://meet.qorlla.test/' }));
  assert.throws(() => verifiedOrigin('http://localhost:5290/')); assert.equal(verifiedOrigin('http://localhost:5290/', { allowLocalhostHttp: true }), 'http://localhost:5290');
  for (const h of ['http://example.com/', 'http://10.0.2.2:5290/', 'http://localhost.evil.test/']) assert.throws(() => verifiedOrigin(h, { allowLocalhostHttp: true }), h);
});
test('test hooks (localhost http, debuggable WebView) exist only in dev or an explicit test build; the production profile can never carry them', () => {
  assert.equal(testHooksEnabled({ dev: false, testBuild: '' }), false); assert.equal(testHooksEnabled({ dev: false, testBuild: 'true' }), false); assert.equal(testHooksEnabled({ dev: false }), false); assert.equal(testHooksEnabled({ dev: true }), true); assert.equal(testHooksEnabled({ testBuild: '1' }), true);
  const eas = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8'));
  assert.ok(!JSON.stringify(eas.build.production).includes('QORLLA_TEST_BUILD')); assert.ok(!JSON.stringify(eas.build.production).includes('usesCleartext'));
});
test('navigation decisions: trusted origins load, other https goes to the system browser, everything else is blocked', () => {
  const p = P();
  assert.equal(navigationDecision(p, 'https://app.qorlla.test/guest/join-meeting'), 'allow'); assert.equal(navigationDecision(p, 'https://meet.qorlla.test:444/room'), 'allow'); assert.equal(navigationDecision(p, 'https://example.com/help'), 'external'); for (const look of ['https://app.qorlla.test.evil.test/', 'https://evil.test/https://app.qorlla.test/', 'https://meet.qorlla.test/']) assert.equal(navigationDecision(p, look), 'external', 'a lookalike is never loaded in the app: ' + look);
  for (const bad of ['http://app.qorlla.test/', 'javascript:alert(1)', 'file:///data/data/x', 'intent://scan/#Intent;scheme=zxing;end', 'content://x/y', 'data:text/html,x', 'qorlla://join?meeting=12345678901', 'market://details?id=x', 'https://u:p@evil.test/', '']) assert.equal(navigationDecision(p, bad), 'block', bad);
  const t = createPolicy({ appUrl: 'http://localhost:5290/', meetUrls: 'http://localhost:3310/', allowLocalhostHttp: true }); assert.equal(navigationDecision(t, 'http://localhost:3310/room'), 'allow'); assert.equal(navigationDecision(t, 'http://example.com/'), 'block');
});
test('deep links: only qorlla://join?meeting=<11 digits>; extras, paths and smuggled values are ignored', () => {
  assert.deepEqual(parseJoinLink('qorlla://join?meeting=12345678901'), { meetingId: '12345678901' }); assert.deepEqual(validateDeepLink('qorlla://join?meeting=12345678901'), { meetingId: '12345678901' });
  for (const bad of ['qorlla://join?meeting=1234567890', 'qorlla://join?meeting=123456789012', 'qorlla://join?meeting=abc', 'qorlla://join', 'qorlla://join?meeting=12345678901&next=https://evil.test', 'qorlla://join/../x?meeting=12345678901', 'qorlla://open?meeting=12345678901', 'https://join?meeting=12345678901', 'qorlla://u:p@join?meeting=12345678901', 'qorlla://join?meeting=12345678901#x', '', null, undefined, 42]) assert.equal(parseJoinLink(bad), null, String(bad));
  assert.equal(P().prejoinUrl('12345678901'), 'https://app.qorlla.test/guest/meeting/12345678901/prejoin'); assert.throws(() => P().prejoinUrl('../../x')); assert.throws(() => P().pathUrl('//evil')); assert.equal(P().pathUrl('/guest/help'), 'https://app.qorlla.test/guest/help');
});
test('push payloads are filtered to type + short reference; Android asks for camera and microphone only', () => {
  assert.deepEqual(safeNotificationPayload({ type: 'meeting_invite', reference: 'x'.repeat(200), body: 'secret', title: 'secret' }), { type: 'meeting_invite', reference: 'x'.repeat(80) }); assert.equal(safeNotificationPayload({ type: 'other' }), null); assert.equal(safeNotificationPayload(null), null);
  assert.deepEqual([...ANDROID_MEETING_PERMISSIONS], ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO']);
});
