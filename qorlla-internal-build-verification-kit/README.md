# Qorlla installable clients — internal build/verification kit

Verified source branch: `integration/installable-clients`
Verified GitHub head at inspection: `839bdde0da9c8a989f909d237799df30403a615a`
Draft PR: https://github.com/jedgod/qorlla-Application-video/pull/2

## Status
This package is **build automation and verification guidance**, NOT compiled installers. No build or install test has been executed by this kit. Production release remains BLOCKED.

## Integration
Copy `.github/workflows/installable-internal-rc.yml` into the repository root `.github/workflows/`. The workflow expects the existing `qorlla-clients` tree. Do not overwrite the existing `qorlla-clients/deployment/github-actions/release.yml`; it is currently not a registered root GitHub workflow.

Run the workflow manually on the exact branch/ref and supply the **full selected commit SHA**. If the branch moves, inspect the new commit and supply its full SHA. The job rejects a mismatch.

## Important build limitations
- Windows builds an **unsigned** NSIS internal installer. Signing requires controlled certificates, protected runners and signature validation. No public download authorization.
- Android `assembleRelease` needs an Android signing configuration. A clean project may fail with missing signing credentials or use a debug key depending on generated Gradle configuration. Never interpret a successful build as a production-signed APK. Use `apksigner verify --print-certs` and compare certificate fingerprints to the approved release keystore.
- Expo's `app.config.js` does not currently expose a staging URL configuration; the mobile runtime URL and HTTPS/WSS origins must be inspected and corrected before cross-network testing. Never embed localhost in a release candidate intended for cellular tests.
- The workflow may need project-specific native dependencies, Android SDK/NDK and Expo/Gradle adjustments. Treat failures as evidence; do not bypass tests.
- Android artifacts should be stored only in private/internal CI with restricted access.
- macOS requires a macOS runner, `.icns`, Developer ID signing, notarization and Gatekeeper tests. iOS requires Apple signing, an EAS/Xcode build, physical-device tests and TestFlight review. Linux requires distro-specific AppImage/deb validation.

## Physical install test procedure (separate from CI)
1. Windows: verify SHA-256 and signing; install on a clean Windows VM, check Start Menu, taskbar icon, app launch, `qorlla://join`, audio/video, permissions, update and uninstall. Save sanitized evidence.
2. Android: verify SHA-256, signing certificate, ABI, manifest, package identity and app label; install on explicitly authorized Galaxy A03s; verify launcher masks, permission-denial 20/20 target, deep links, audio/video and uninstall. Never automatically access a user's phone.
3. TURN: relay-only selected ICE candidate pairs and bidirectional media over cellular vs Wi-Fi; fail-closed negative control; no direct path accepted as relay evidence.
4. Reliability: resolve Windows camera-track termination and demonstrate 30 consecutive default-setting runs; run 30+ minute sessions and 3+ participant tests.
5. Archive commit SHA, build runner details, test logs, artifact SHA-256, signing fingerprint, install results, and explicit release decision.

## Closure criteria
No public download, app-store release, or production tag until signing, privacy/accessibility, physical device, cross-network TURN, update/rollback, security, and applicable Qorlla platform release gates pass. External calling remains disabled.
