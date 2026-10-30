// Expo configuration. The native Android project is GENERATED from this (expo prebuild) and is not committed.
// QORLLA_TEST_BUILD=1 builds a TEST artifact: it allows cleartext traffic (so a local stack on http://localhost can be used through `adb reverse`) and a debuggable WebView. Store builds never set it
// (eas.json's production profile is checked by a test), and without it cleartext traffic stays disabled by the platform default.
const test = process.env.QORLLA_TEST_BUILD === '1';
module.exports = {
  expo: {
    name: 'Qorlla', slug: 'qorlla', scheme: 'qorlla', version: '0.3.0', orientation: 'portrait', userInterfaceStyle: 'dark',
    ios: { bundleIdentifier: 'com.qorlla.mobile', infoPlist: { NSCameraUsageDescription: 'Qorlla uses the camera so other people in a meeting can see you.', NSMicrophoneUsageDescription: 'Qorlla uses the microphone so other people in a meeting can hear you.' } },
    android: { package: 'com.qorlla.mobile', versionCode: 3, allowBackup: false, permissions: ['CAMERA', 'RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS', 'INTERNET'], blockedPermissions: ['android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE', 'android.permission.SYSTEM_ALERT_WINDOW'] },
    plugins: [['expo-build-properties', { android: { usesCleartextTraffic: test } }]]
  }
};
