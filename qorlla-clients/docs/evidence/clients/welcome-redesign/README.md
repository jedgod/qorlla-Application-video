# Welcome / Join screen, phone tab bar, invitation flow: device evidence

Status: **validated on one device and one isolated test server only. The full web suite is NOT clean (see below). Production release gates stay BLOCKED.**

## Build identity
- Branch `feature/mobile-welcome-redesign` (local), built from the working tree on top of `fbe8eec`, itself on `a177db5` (`linux-certification`). The commit that contains this README is the source of the build; the APK was built before that commit, from the same files.
- APK: test build (`QORLLA_TEST_BUILD=1`, arm64-v8a, release, debug-keystore signed), built 2026-11-01 01:03 local time. SHA-256 `a8db8862854e5e61512f470053417aa978696a39c19626ad8931c4ef5708a19a`. Not a store or signed release build; a development APK, not a production release.
- Build: 17 minutes, exit 0, with a keep-awake request held (earlier builds died silently when the machine slept).
- Device: Samsung Galaxy A03s (SM-A037U), 720x1600 at 280 dpi (411 dp wide), system text 110%, installed over the existing app with `adb install -r` (data not cleared). Window size and settings were restored after every run.
- Server: a throwaway local server (`node server.js`, temporary data directory) reached through `adb reverse tcp:18081`; no live Qorlla service (v46: 3200/3300/4600, DB 35432) was used or changed.

## Results (final code)
| Suite | Result |
| --- | --- |
| On-device UI, `e2e/android-welcome.test.cjs` | **19 of 19 passed, 0 failed, 0 skipped**, one pass |
| Mobile unit tests, `apps/mobile` | 38 of 38 |
| Desktop unit tests, `apps/desktop` | 22 of 22 |
| Desktop shell against the isolated server, `e2e/desktop-shell.test.cjs` | 3 of 3 (three runs in a row) |
| Full web suite (Playwright) | **188 passed, 20 failed, 6 skipped, 62 did not run: NOT a clean pass** |

On-device tests: start screen, one page without scrolling, hero and card order, meeting-ID validation, keyboard, language list, Continue as Guest then Back, system text 130%, widths 320/360/390/412 dp, fr/es/pt-PT at 320 and 412 dp, `qorlla://join` opens that meeting's pre-join page inside the app (the WebView reports `QorllaMobile/1` and the "get the app" panel stays hidden), six malformed or hostile links are ignored, and an invited guest sees no navigation and is never sent to the old built-in room (this server has no Qorlla Meet, so the page says video is unavailable).

### The 20 web failures (unresolved)
- 12 stop at "Qorlla Meet is not running at http://localhost:3310": `phone-hardening:120`, `phone:45, 187, 196, 226, 295`, `history:136`, `invitation-email:23, 52`, `meet-handoff:14`, `meeting-limit:37`, `start-meeting:29`.
- 7 stop at `ECONNREFUSED 127.0.0.1:35432` (the v46 database port, not used): `telephony:92, 280`, `voice-alias-ui:44`, `voice-engine:46`, `voice-reliability:42`, `voice-shield-ui:44`, `voice-turn:39`.
- 1 intermittent: `passcode-server:160` ("test server did not start within 45 s" under load; 30 of 30 on repeat). An earlier clean run had `meeting-actions:103` time out once (60 of 60 on repeat).
- These 19 never reached any page logic, so they are unverified, not passed. They need the isolated Meet and database stack, which was not started.
- A stray test Meet that this work launched (PID 28580, `.dev-stack/meet3310.log` created the same second, 3,042 errors to port 35432) polluted two earlier web runs; it was identified and stopped alone before the final runs.

## What changed
- Welcome screen: compact one-page layout scaled from window width and height, 48 dp touch targets, meeting-ID input fills its box.
- Web phone tab bar (<= 700 px): Home, Chat, Phone, Docs, Clips, More share one row without scrolling; the other pages are tiles on More. Pages opened from the tab bar have a close button (X, Escape) that returns to the page before.
- One tab per account per browser (`assets/single-tab.js`, workspace and chat share a lock). A convenience only, not a security boundary; where Web Locks do not exist nothing is enforced and `data-single-tab="unsupported"` says so.
- Invitation page: way-in options chosen for the device (app where one exists, otherwise an account); download buttons only for https URLs set in `QORLLA_DOWNLOAD_*_URL`, none by default. The guest navigation is hidden on the invitation page until the person signs in.
- Old built-in room (`/index.html`): no longer used for an invited guest or inside the mobile app. A guest goes to the Qorlla Meet video page or is told video is unavailable. It stays for web hosts. The landing on the real Meet page was NOT exercised end to end here (no Meet); it is covered by a stubbed redirect test only.
- Desktop shell: `npm run dev:local` opens one existing server; the shell has no database or server of its own.

Screenshots show only these screens (no camera preview).

Known gaps: native text is translated for es/fr/pt-PT but the chosen language is not stored across restarts; the hero artwork is a vector redraw; the Portuguese numeric-field placeholder is cut off at 320 dp; TalkBack was not run; the LG phone was never launched; downloads, installers and PSTN stay disabled and unpublished.
