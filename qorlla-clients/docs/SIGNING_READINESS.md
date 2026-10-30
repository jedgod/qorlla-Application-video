# Signing readiness (Android, Windows, macOS, iOS, Linux)

**Status: no signing infrastructure exists yet. Every build produced so far is unsigned or debug-signed and is an internal test artifact.** Release stays BLOCKED. This document is the procedure to follow after the signing infrastructure is approved; it contains no keys, passwords or certificates, and none may ever be committed (`*.jks`, `*.keystore`, `*.p12`, `*.p8`, `*.mobileprovision`, `*.cer`, `*.pfx`, `*.pem`, `*.key` are gitignored).

## Rules that apply to every platform
1. Private keys are generated and kept in a hardware-backed or managed store (HSM, cloud key service, or an offline encrypted vault with two custodians). They are never generated on, or copied to, a development PC.
2. CI receives signing material only through a **protected environment** (required reviewers, restricted to the release branch/tag), never through repository-level or pull-request-accessible secrets. Forks and draft PR runs get nothing.
3. Workflow logs must not print secrets. Use masked secrets, never `set -x`, never echo an environment, and verify with fingerprints (public) instead of showing material.
4. A successful build is not a signed build. Every release candidate is verified by a separate step against the **approved fingerprint**, and that fingerprint is recorded with the artifact's SHA-256, commit SHA and runner details.
5. Signed artifacts stay in private storage until the release gates pass. No public download, store submission or tag is created from this procedure on its own.

## Android
- **Today:** `expo prebuild` signs `assembleRelease` with the public debug key (cert `CN=Android Debug`, SHA-256 `fac61745…033b9c`). The `with-release-signing` plugin (`apps/mobile/plugins/`) now makes **staging and production profiles refuse to build a release** unless the signing variables below are set and the keystore exists. Development builds are unchanged.
- **Variables** (set by the protected CI environment or the release engineer's shell, never written to a file): `QORLLA_ANDROID_KEYSTORE_FILE`, `QORLLA_ANDROID_KEYSTORE_PASSWORD`, `QORLLA_ANDROID_KEY_ALIAS`, `QORLLA_ANDROID_KEY_PASSWORD`.
- **Key plan (decision needed):** use **Play App Signing**: Google holds the app-signing key; Qorlla holds only an **upload key** (RSA 2048+ or EC), so a lost or leaked upload key can be reset with Google. For sideloaded internal builds, use a separate **internal-test key**, never the upload key.
- **Generate the upload key** offline: `keytool -genkeypair -v -keystore qorlla-upload.jks -alias qorlla-upload -keyalg RSA -keysize 4096 -validity 9125`, store the file and both passwords in the vault, record the SHA-256 certificate fingerprint as the approved fingerprint.
- **Verify every candidate:** `apksigner verify --print-certs --verbose <apk>`: it must verify, and the certificate SHA-256 must equal the approved fingerprint and must **not** be the debug certificate.
- **Staging identity:** the staging profile installs as `com.qorlla.mobile.staging` ("Qorlla (Staging)") beside production, so a staging APK can never replace or be mistaken for a production install.
- **Also needed:** `build-tools` and platform 36 on the runner (the CI job checks and fails clearly), a decision on AAB for the store and APK for internal testing, and an upload to Play only through the protected environment.

## Windows
- **Today:** unsigned NSIS installer (`Authenticode: NotSigned`), which SmartScreen warns about.
- **Options (decision needed):** (a) **Azure Trusted Signing** (cloud-held key, short-lived certificates, supported by electron-builder via `azureSignOptions`); (b) an **EV code-signing certificate on a hardware token or cloud HSM** (OV certificates build SmartScreen reputation slowly; EV historically gave immediate reputation). Local PFX files are not acceptable.
- **Procedure:** sign the installer **and** the application executable and uninstaller (electron-builder signs all three when configured), with an RFC 3161 timestamp so the signature outlives the certificate. Run signing only on a protected Windows runner.
- **Verify:** `Get-AuthenticodeSignature <installer>` must be `Valid`, the signer subject and thumbprint must equal the approved values, and a clean-VM install must show the verified publisher, no SmartScreen block, Start Menu and taskbar icon, `qorlla://join` handling, update and uninstall.
- **Open item before public distribution:** the intermittent camera-track loss in Electron 33 with default GPU settings.

## macOS
- **Today:** unsigned, un-notarized arm64 dmg ("code object is not signed at all"); Gatekeeper will block it. The icon is generated from a 512 px PNG; a proper multi-resolution `.icns` is still to be produced.
- **Needs:** an Apple Developer Program membership, a **Developer ID Application** certificate, hardened runtime with entitlements for camera and microphone (`com.apple.security.device.camera`, `com.apple.security.device.audio-input`) and nothing broader, **notarization** with `notarytool` (App Store Connect API key, held in the protected environment), then `stapler staple`.
- **Verify:** `codesign --verify --deep --strict --verbose=2`, `spctl --assess --type execute -vv`, `xcrun stapler validate`, on a clean Mac that has never seen the build.
- **Also:** an Intel (x64) or universal build decision; the current job produces arm64 only.

## iOS
- **Today:** the Xcode project compiles for the **simulator only**, unsigned. It cannot be installed on a real iPhone.
- **Needs:** Apple Developer membership, bundle identifiers (`com.qorlla.mobile`, and `.staging` for the staging profile), distribution certificate and provisioning profile (managed by EAS credentials or Xcode automatic signing on a protected Mac runner), App Store Connect record, TestFlight internal testing, and **physical-device** tests (permissions, camera/microphone, deep links, background behaviour).

## Linux
- **Today:** AppImage and deb build and pass the packaging checks; neither is installed or run in CI.
- **Signing:** GPG-sign the apt repository metadata (for the deb) and publish the public key; sign or checksum-publish the AppImage with a detached signature. Key held in the vault, not the runner image.
- **AppImage sandbox finding (BLOCKING until secure execution is demonstrated):** electron-builder's AppImage target defaults its desktop entry to `Exec=AppRun --no-sandbox %U`, which disables Chromium's sandbox (run 4 produced exactly that). **The AppImage built before this change is NOT distributable.** The deb is the preferred Linux format: its desktop entry is `/opt/Qorlla/qorlla %U`, and `postinst` sets `chrome-sandbox` to 4755 only on systems without unprivileged user namespaces, otherwise 0755.
  - *Fix applied (unverified until CI):* `build.appImage.executableArgs` is now `["--enable-sandbox"]` (an empty list would make electron-builder substitute `--no-sandbox` again; a test guards that). The app itself also refuses to start, in a packaged build, if any sandbox-disabling switch is on its command line.
  - *Mandatory CI check:* `qorlla-clients/e2e/linux-sandbox-check.cjs` inspects the **extracted deb and AppImage** (desktop entries, `AppRun` and launcher scripts) and fails the Linux job if anything disables the sandbox or sets `ELECTRON_DISABLE_SANDBOX`; its tests include negative cases that inject `--no-sandbox`.
  - *Rule:* never work around a sandbox failure by disabling protections. If the AppImage cannot be shown to run with the sandbox enabled on the supported distributions (an unprivileged-user-namespace requirement, which Ubuntu 24.04 restricts by default for unprofiled apps), exclude the AppImage from the release and certify the deb.
- **Still pending:** installation and launch on a supported distribution (for example Ubuntu 22.04 and 24.04), the installed `chrome-sandbox` permissions after a real install, and a camera/microphone meeting test.

## Blockers to start signing
| Item | Needed from the owner |
|---|---|
| Android upload key and internal-test key | approval of the key plan; a vault and custodians |
| Windows signing service | choice of Azure Trusted Signing or EV certificate; identity validation (can take days) |
| Apple Developer account | membership, Developer ID certificate, App Store Connect API key |
| Protected CI environment | create the environment with required reviewers; store the variables there |
| Approved fingerprints | record them (public values) in the release record before the first signed build |
