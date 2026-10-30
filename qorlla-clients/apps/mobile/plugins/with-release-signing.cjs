'use strict';
// Expo config plugin: Android release signing from the ENVIRONMENT, never from the repository.
// The generated app/build.gradle signs release builds with the public debug key ("Caution! In production, you need to generate your own keystore"). For staging and production profiles this plugin:
//   - adds a `release` signingConfig whose keystore path and passwords come from QORLLA_ANDROID_KEYSTORE_FILE / _KEYSTORE_PASSWORD / _KEY_ALIAS / _KEY_PASSWORD (set by a protected CI environment or the release engineer's shell)
//   - points the release build type at it
//   - fails any release task with a clear message when one of them is missing, instead of silently shipping a debug-signed or unsigned APK
// Development builds are left exactly as generated. No key, password or path is written into any file.
const { withAppBuildGradle } = require('@expo/config-plugins');
const MARK = '// qorlla-release-signing';
const VARS = ['QORLLA_ANDROID_KEYSTORE_FILE', 'QORLLA_ANDROID_KEYSTORE_PASSWORD', 'QORLLA_ANDROID_KEY_ALIAS', 'QORLLA_ANDROID_KEY_PASSWORD'];

function patchGradle(src, { required = false } = {}) {
  if (!required || src.includes(MARK)) return src;
  const signing = `        release {  ${MARK}\n            storeFile System.getenv('${VARS[0]}') ? file(System.getenv('${VARS[0]}')) : null\n            storePassword System.getenv('${VARS[1]}')\n            keyAlias System.getenv('${VARS[2]}')\n            keyPassword System.getenv('${VARS[3]}')\n        }\n`;
  const anchor = /(signingConfigs\s*\{\s*\n\s*debug\s*\{[\s\S]*?\n\s*\}\n)/;
  if (!anchor.test(src)) throw new Error('with-release-signing: could not find the debug signingConfig in app/build.gradle (the Expo template changed); refusing to produce an unsigned or debug-signed release');
  let out = src.replace(anchor, (m) => m + signing);
  const rel = /(release\s*\{[^}]*?)signingConfig signingConfigs\.debug/;
  if (!rel.test(out)) throw new Error('with-release-signing: could not find the release build type signingConfig (the Expo template changed)');
  out = out.replace(rel, '$1signingConfig signingConfigs.release');
  out += `\n${MARK}: stop any release build that is not signed with the release key\ngradle.taskGraph.whenReady { graph ->\n    if (graph.allTasks.any { it.name.toLowerCase().contains('release') && it.project == project }) {\n        def missing = ${JSON.stringify(VARS).replace(/"/g, "'")}.findAll { !System.getenv(it) }\n        if (missing) throw new GradleException("Release signing is not configured: set " + missing.join(', ') + " (see qorlla-clients/docs/SIGNING_READINESS.md). Refusing to build a release that is not signed with the release key.")\n        if (!file(System.getenv('${VARS[0]}')).isFile()) throw new GradleException('The keystore named by ${VARS[0]} does not exist')\n    }\n}\n`;
  return out;
}
const withReleaseSigning = (config, options = {}) => withAppBuildGradle(config, (c) => { c.modResults.contents = patchGradle(c.modResults.contents, options); return c; });
module.exports = withReleaseSigning; module.exports.patchGradle = patchGradle; module.exports.VARS = VARS;
