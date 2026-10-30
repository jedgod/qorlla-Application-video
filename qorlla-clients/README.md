# Qorlla installable clients

**Not a certified production release.** No signed installer, store-ready binary or app-store release exists. Read `docs/CLIENT_MEETING_CERTIFICATION.md` for exactly what was tested, on what, and what is still blocked.

## What the clients do
Both clients are thin, locked-down shells around Qorlla's existing web experience and **existing meeting media path** (Qorlla Meet): they add the native window/app, camera and microphone permissions, `qorlla://join?meeting=<11 digits>` deep links, and strict navigation rules. They do not run their own signaling or media stack.

| Client | Source | What it adds |
|---|---|---|
| Windows (Electron) | `apps/desktop` | trusted-origin allowlist (app + Meet, https only), single instance, deep link to the guest pre-join page, media permissions for trusted origins only, screen sharing only after a person-confirmed prompt |
| Android (Expo / React Native) | `apps/mobile` | in-app locked-down WebView (the meeting runs inside the app), real Android camera/microphone permission flow with a recovery path, deep link, Back handling, edge-to-edge layout |

Policy code (`apps/desktop/security.cjs`, `apps/mobile/src/policy.js`) is pure and unit tested; the browsers/emulators are driven by the end-to-end tests in `e2e/`.

## Tests
- Unit: `node --test packages/contracts/tests/*.test.cjs`, `cd apps/desktop && npm test`, `cd apps/mobile && npm test`.
- End to end (needs the dev stack: PostgreSQL, Meet on :3310, `npm install` in `apps/desktop`, Playwright at the repository root):
  - Windows: `node --test e2e/windows-meeting.test.cjs`
  - Android: an Android **emulator** attached (never a phone unless `QORLLA_ANDROID_SERIAL` names it), the test APK built as described in `docs/CLIENT_MEETING_CERTIFICATION.md`, then `node --test e2e/android-meeting.test.cjs`.
- `e2e/diagnostics/` holds the small scripts used to investigate the camera and WebView findings in the report.

## Test-only switches (ignored or absent in store builds)
Desktop: `QORLLA_DEV_ALLOW_LOCALHOST_HTTP=1` (http://localhost), `QORLLA_TEST_FAKE_MEDIA=1`, `QORLLA_DEV_USER_DATA`, `QORLLA_TEST_DISABLE_GPU=1`; all are ignored when the app is packaged. Android: a build made with `QORLLA_TEST_BUILD=1` / `EXPO_PUBLIC_QORLLA_TEST_BUILD=1` allows cleartext http to localhost and a debuggable WebView; the production profile in `eas.json` cannot carry it (checked by a test).

## Safety
PSTN, billing capture/refund, device registration and remote meeting actions remain server-authoritative and disabled until integrated and certified. No release credentials or secrets are bundled.
