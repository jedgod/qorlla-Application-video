'use strict';
// Points the phone app at the SAME local stack as the desktop shell: the app on http://localhost:3200 and the Qorlla Meet video page on http://localhost:3300 (voice 4600).
// A phone only reaches "localhost" through adb reverse, so `reverse` adds those mappings; it never removes one (other tools use their own).
//   node scripts/local-stack.cjs reverse          add adb reverse for 3200, 3300 and 4600
//   node scripts/local-stack.cjs build            test build (QORLLA_TEST_BUILD) with those two origins baked in, then assembleRelease (arm64-v8a)
// Env: ANDROID_SERIAL (device), QORLLA_APP_URL / QORLLA_MEET_URLS (override the origins), JAVA_HOME (JDK 17 to 21) and ANDROID_HOME for `build`.
// Test builds only: http://localhost and a debuggable WebView are refused in staging and production profiles (see build-profile.cjs). The result is a development APK, never a release.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const app = process.env.QORLLA_APP_URL || 'http://localhost:3200/', meet = process.env.QORLLA_MEET_URLS || 'http://localhost:3300/', PORTS = [3200, 3300, 4600];
const serial = process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : [];
const run = (cmd, args, opts = {}) => { const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: path.join(__dirname, '..'), shell: process.platform === 'win32', ...opts }); if (r.status !== 0) { console.error(cmd + ' ' + args.join(' ') + ' failed (exit ' + r.status + ')'); process.exit(r.status || 1); } };

const cmd = process.argv[2];
if (cmd === 'reverse') {
  for (const p of PORTS) run('adb', [...serial, 'reverse', 'tcp:' + p, 'tcp:' + p]);
  run('adb', [...serial, 'reverse', '--list']);
} else if (cmd === 'build') {
  if (!process.env.JAVA_HOME || !process.env.ANDROID_HOME) { console.error('Set JAVA_HOME (JDK 17-21) and ANDROID_HOME first.'); process.exit(2); }
  const env = { ...process.env, QORLLA_TEST_BUILD: '1', EXPO_PUBLIC_QORLLA_TEST_BUILD: '1', EXPO_PUBLIC_QORLLA_URL: app, EXPO_PUBLIC_QORLLA_MEET_URLS: meet };
  console.log('Building a TEST app for ' + app + ' with Meet at ' + meet);
  run('npx', ['expo', 'prebuild', '--platform', 'android', '--no-install', '--clean'], { env });
  const android = path.join(__dirname, '..', 'android');                                   // called by full path: Windows does not look in the current folder
  run(path.join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'), ['assembleRelease', '-PreactNativeArchitectures=arm64-v8a', '--no-daemon', '--max-workers=2'], { env, cwd: android });
  console.log('APK: android/app/build/outputs/apk/release/app-release.apk  (test build, debug-keystore signed: not for distribution)');
} else { console.error('usage: node scripts/local-stack.cjs reverse|build'); process.exit(2); }
