# Welcome / Join screen redesign: device evidence

- Base commit: `a177db5` (branch `linux-certification`); this change is on `feature/mobile-welcome-redesign` (local, not pushed).
- APK: test build (`QORLLA_TEST_BUILD=1`, arm64-v8a, release, debug-keystore signed), SHA-256 `a6f4f95a404aeffedc577e69eed9d7b545bb5841a225c10f6f5f81e5916f3bda`. Not a store or signed release build.
- Device: Samsung Galaxy A03s (SM-A037U), 720x1600 at 280 dpi (411 dp wide), system text 110%, installed over the existing app with `adb install -r` (data not cleared).
- Server: a throwaway local server (`node server.js`, temporary data directory) reached through `adb reverse tcp:18081`; no live Qorlla service was used or changed.
- Node unit tests: `node --test tests/*.test.mjs` in `apps/mobile`, 38 of 38.
- Device UI tests: `QORLLA_ANDROID_SERIAL=<serial> node --test e2e/android-welcome.test.cjs`, 15 of 15: start screen, hero and card order, meeting-ID validation (incomplete, letters, 11 digits, 13 digits), keyboard, lower sections, language list, Continue as Guest then Back, system text 130%, widths 320/360/390/412 dp (window resized with `wm size`, always reset), and French/Spanish/Portuguese at 320 and 412 dp. The screenshots here come from that run.
- Screenshots show only this screen and the guest page (no camera preview).

Known gaps: the native text is translated for es/fr/pt-PT but the chosen language is not stored across app restarts (no storage module is installed); the hero artwork is a vector redraw, not the photographs in the mock-up; Portuguese numeric-field placeholder is cut off at 320 dp; TalkBack was not run, only accessibility labels and focus order from the UI hierarchy were checked.
