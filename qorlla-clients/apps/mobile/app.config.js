// Expo configuration. The native Android project is GENERATED from this (expo prebuild) and is not committed.
// QORLLA_TEST_BUILD=1 builds a TEST artifact: it allows cleartext traffic (so a local stack on http://localhost can be used through `adb reverse`) and a debuggable WebView. Store builds never set it
// (eas.json's production profile is checked by a test), and without it cleartext traffic stays disabled by the platform default.
// QORLLA_BUILD_PROFILE = development (default) | staging | production. Staging and production REQUIRE explicit public https origins (EXPO_PUBLIC_QORLLA_URL and EXPO_PUBLIC_QORLLA_MEET_URLS), refuse the test flags and never fall back to localhost:
// an invalid combination throws here, so the build fails instead of producing an app that points somewhere unintended. See build-profile.cjs.
const profile = require('./build-profile.cjs').requireProfile(process.env);
const test = profile.testBuild;
module.exports = {
  expo: {
    name: profile.name, slug: 'qorlla', scheme: 'qorlla', version: '0.3.0', orientation: 'portrait', userInterfaceStyle: 'dark', icon: './assets/icon.png',
    ios: { bundleIdentifier: profile.iosBundle, infoPlist: { NSCameraUsageDescription: 'Qorlla uses the camera so other people in a meeting can see you.', NSMicrophoneUsageDescription: 'Qorlla uses the microphone so other people in a meeting can hear you.' } },
    android: { adaptiveIcon: { foregroundImage: './assets/adaptive-foreground.png', backgroundColor: '#001383' }, package: profile.androidPackage, versionCode: 3, allowBackup: false, permissions: ['CAMERA', 'RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS', 'INTERNET'], blockedPermissions: ['android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE', 'android.permission.SYSTEM_ALERT_WINDOW'] },
    plugins: [['expo-build-properties', { android: { usesCleartextTraffic: test } }], ['./plugins/with-release-signing.cjs', { required: profile.profile !== 'development' }]]
  }
};
