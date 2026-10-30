import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { resolveProfile, requireProfile, originProblem } = require('../build-profile.cjs');
const GOOD = { QORLLA_BUILD_PROFILE: 'staging', EXPO_PUBLIC_QORLLA_URL: 'https://app.staging.qorlla.net', EXPO_PUBLIC_QORLLA_MEET_URLS: 'https://meet.staging.qorlla.net' };
const withEnv = (env, fn) => { const keys = Object.keys(env), old = Object.fromEntries(keys.map((k) => [k, process.env[k]])); Object.assign(process.env, env); try { return fn(); } finally { for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } } };

test('development is the default and needs no origins (the app itself fails closed without them)', () => {
  const r = resolveProfile({}); assert.equal(r.profile, 'development'); assert.deepEqual(r.errors, []); assert.equal(r.name, 'Qorlla'); assert.equal(r.androidPackage, 'com.qorlla.mobile');
  assert.equal(resolveProfile({ QORLLA_TEST_BUILD: '1' }).testBuild, true);
});
test('a valid staging build is clearly identified and installs beside production', () => {
  const r = requireProfile(GOOD); assert.equal(r.name, 'Qorlla (Staging)'); assert.equal(r.androidPackage, 'com.qorlla.mobile.staging'); assert.equal(r.iosBundle, 'com.qorlla.mobile.staging'); assert.equal(r.testBuild, false);
  const p = requireProfile({ ...GOOD, QORLLA_BUILD_PROFILE: 'production' }); assert.equal(p.name, 'Qorlla'); assert.equal(p.androidPackage, 'com.qorlla.mobile');
});
test('staging and production refuse to build without explicit public https origins', () => {
  for (const profile of ['staging', 'production']) {
    assert.throws(() => requireProfile({ QORLLA_BUILD_PROFILE: profile }), /EXPO_PUBLIC_QORLLA_URL is required/);
    assert.throws(() => requireProfile({ ...GOOD, QORLLA_BUILD_PROFILE: profile, EXPO_PUBLIC_QORLLA_MEET_URLS: '' }), /EXPO_PUBLIC_QORLLA_MEET_URLS is required/);
  }
});
test('no silent fallback to localhost, cleartext, IP addresses, placeholders or unapproved shapes', () => {
  for (const bad of ['http://localhost:3310', 'https://localhost', 'https://127.0.0.1', 'http://app.staging.qorlla.net', 'https://203.0.113.9', 'https://app.invalid', 'https://app.staging.example.com', 'https://app.staging.REPLACE-WITH-YOUR-DOMAIN', 'https://intranet', 'https://u:p@app.qorlla.net', 'https://app.qorlla.net/path', 'https://app.qorlla.net/?x=1', 'not a url'])
    assert.ok(originProblem(bad), 'accepted: ' + bad);
  assert.equal(originProblem('https://app.staging.qorlla.net'), null);
  assert.throws(() => requireProfile({ ...GOOD, EXPO_PUBLIC_QORLLA_URL: 'http://localhost:3310' }), /EXPO_PUBLIC_QORLLA_URL/);
  assert.throws(() => requireProfile({ ...GOOD, EXPO_PUBLIC_QORLLA_MEET_URLS: 'https://meet.qorlla.net,http://10.0.2.2:3310' }), /EXPO_PUBLIC_QORLLA_MEET_URLS/);
});
test('release profiles cannot carry the test-build flags, and an unknown profile is rejected', () => {
  assert.throws(() => requireProfile({ ...GOOD, QORLLA_TEST_BUILD: '1' }), /test-build flags/);
  assert.throws(() => requireProfile({ ...GOOD, EXPO_PUBLIC_QORLLA_TEST_BUILD: '1' }), /test-build flags/);
  assert.throws(() => requireProfile({ QORLLA_BUILD_PROFILE: 'prod' }), /must be development, staging or production/);
});
test('app.config.js applies the profile: staging identity in, test cleartext flag out', () => {
  const cfg = () => { delete require.cache[require.resolve('../app.config.js')]; return require('../app.config.js').expo; };
  withEnv(GOOD, () => { const c = cfg(); assert.equal(c.name, 'Qorlla (Staging)'); assert.equal(c.android.package, 'com.qorlla.mobile.staging'); assert.equal(c.ios.bundleIdentifier, 'com.qorlla.mobile.staging'); assert.equal(c.plugins[0][1].android.usesCleartextTraffic, false); });
  assert.throws(() => withEnv({ QORLLA_BUILD_PROFILE: 'staging', EXPO_PUBLIC_QORLLA_URL: '', EXPO_PUBLIC_QORLLA_MEET_URLS: '' }, cfg), /Invalid Qorlla build configuration/);
});
test('eas.json: staging is its own internal APK profile with no origins, no test flags and no localhost baked in', () => {
  const eas = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8')), s = JSON.stringify(eas.build.staging);
  assert.equal(eas.build.staging.env.QORLLA_BUILD_PROFILE, 'staging'); assert.equal(eas.build.production.env.QORLLA_BUILD_PROFILE, 'production'); assert.equal(eas.build.staging.distribution, 'internal');
  assert.ok(!/TEST_BUILD|localhost|127\.0\.0\.1|http:/.test(s), 'staging profile: ' + s); assert.ok(!/EXPO_PUBLIC_QORLLA_URL/.test(s), 'origins are supplied at build time, never defaulted in the repository');
});
