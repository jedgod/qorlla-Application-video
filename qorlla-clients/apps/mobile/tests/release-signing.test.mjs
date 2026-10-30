import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { patchGradle, VARS } = require('../plugins/with-release-signing.cjs');
const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`;

test('development builds are left exactly as generated', () => { assert.equal(patchGradle(TEMPLATE, { required: false }), TEMPLATE); assert.equal(patchGradle(TEMPLATE), TEMPLATE); });
test('staging/production: a release signingConfig reads only environment variables, and the release build type uses it', () => {
  const out = patchGradle(TEMPLATE, { required: true });
  for (const v of VARS) assert.ok(out.includes("System.getenv('" + v + "')"), v);
  assert.match(out, /release \{[^}]*?signingConfig signingConfigs\.release/); assert.ok(!/release \{[^}]*?signingConfig signingConfigs\.debug/.test(out.split('buildTypes')[1]), 'release no longer uses the debug key');
  assert.ok(out.includes("storeFile file('debug.keystore')") && /debug \{\s*signingConfig signingConfigs\.debug/.test(out), 'debug builds keep the debug key');
});
test('a release task fails with a clear message when any signing variable is missing', () => {
  const out = patchGradle(TEMPLATE, { required: true });
  assert.match(out, /gradle\.taskGraph\.whenReady/); assert.match(out, /Release signing is not configured/); assert.match(out, /Refusing to build a release that is not signed with the release key/); assert.match(out, /does not exist/);
});
test('no key, password or path is ever written into the generated file, and patching twice changes nothing', () => {
  const secrets = { QORLLA_ANDROID_KEYSTORE_FILE: '/secret/path/release.jks', QORLLA_ANDROID_KEYSTORE_PASSWORD: 'hunter2-store', QORLLA_ANDROID_KEY_ALIAS: 'zz-alias-value', QORLLA_ANDROID_KEY_PASSWORD: 'hunter2-key' };
  Object.assign(process.env, secrets); try { const once = patchGradle(TEMPLATE, { required: true }); for (const s of Object.values(secrets)) assert.ok(!once.includes(s), 'leaked ' + s); assert.equal(patchGradle(once, { required: true }), once); } finally { for (const k of Object.keys(secrets)) delete process.env[k]; }
});
test('if the Expo template changes, the build stops instead of producing a debug-signed release', () => {
  assert.throws(() => patchGradle('android { buildTypes { release { } } }', { required: true }), /refusing to produce/);
  assert.throws(() => patchGradle(TEMPLATE.replace(/release \{[\s\S]*?\n        \}/, 'release {\n        }'), { required: true }), /release build type/);
});
test('the plugin is registered for release profiles only, and signing material is gitignored', () => {
  const cfg = readFileSync(new URL('../app.config.js', import.meta.url), 'utf8'); assert.match(cfg, /with-release-signing\.cjs', \{ required: profile\.profile !== 'development' \}/);
  const ignore = readFileSync(new URL('../../../.gitignore', import.meta.url), 'utf8'); for (const p of ['*.jks', '*.keystore', '*.p12', '*.p8', '*.mobileprovision']) assert.ok(ignore.includes(p), p + ' must be gitignored');
});
