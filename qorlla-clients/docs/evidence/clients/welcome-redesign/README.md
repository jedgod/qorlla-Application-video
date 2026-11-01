# Welcome / Join screen, phone tab bar, invitation flow: device evidence

Status: **validated on one device and one isolated test server only. The full web suite is NOT clean (see below). Production release gates stay BLOCKED.**

## Build identity
- Branch `feature/mobile-welcome-redesign` (local), built from the working tree on top of `fbe8eec`, itself on `a177db5` (`linux-certification`). The commit that contains this README is the source of the build; the APK was built before that commit, from the same files.
- APK: test build (`QORLLA_TEST_BUILD=1`, arm64-v8a, release, debug-keystore signed), built 2026-11-01 01:03 local time. SHA-256 `a8db8862854e5e61512f470053417aa978696a39c19626ad8931c4ef5708a19a`. Not a store or signed release build; a development APK, not a production release.
- Build: 17 minutes, exit 0, with a keep-awake request held (earlier builds died silently when the machine slept).
- Device: Samsung Galaxy A03s (SM-A037U), 720x1600 at 280 dpi (411 dp wide), system text 110%, installed over the existing app with `adb install -r` (data not cleared). Window size and settings were restored after every run.
- Server: a throwaway local server (`node server.js`, temporary data directory) reached through `adb reverse tcp:18081`; no live Qorlla service (v46: 3200/3300/4600, DB 35432) was used or changed.

## Local-stack build (same stack as the desktop shell)
- `npm run local-stack:build` in `apps/mobile` builds a test app baked to the app on `http://localhost:3200/` and Qorlla Meet on `http://localhost:3300/`, the pair `npm run dev:local` uses for the desktop shell; `npm run local-stack:reverse` adds `adb reverse` for 3200, 3300 and 4600 (it only adds, never removes).
- Current build: SHA-256 `1eb037dddd8c52dd19deaac8377edb9a9e2a376c58a8e2efabf3c61713607194`, built 2026-11-01 03:24 to 03:34 (exit 0, 10 minutes), from the working tree on top of commit `a29b4f3`. It adds a native close bar above pages that are separate documents (`/chat.html`, `/app/*`). The bundle contains `localhost:3200` and `localhost:3300` and no `localhost:18081`. An earlier build of the same script (`05976e4f...`) lacked the close bar. Development APK, not a release.
- NOT verified: reaching the Qorlla Meet video page. The v46 stack (3200/3300/4600) was not running and was not started by this work, and the 19-test device suite above ran on the 18081 build (SHA-256 `a8db8862...`), not on this one. Policy unit tests prove only that the 3200 and 3300 origins are trusted and others are not.

## New pages inside the phone app (local-stack build `05976e4f...`)
- `QORLLA_ANDROID_SERIAL=<serial> node --test e2e/android-pages.test.cjs`: **9 of 9 passed, 0 failed, 0 skipped** on the Galaxy A03s in one pass; screenshots in `pages/`.
- How: the app is built for `http://localhost:3200`. For this run only, the phone's own `adb reverse tcp:3200` was pointed at the isolated test server on the host (18081) and put back to `tcp:3200` afterwards, so nothing on the host's port 3200 was used. Test accounts exist only on that throw-away server.
- Checked in the app's WebView: the app loads its pages from `localhost:3200`; guest Welcome keeps its navigation, Explore and Help are the guest pages; the invitation page (opened by `qorlla://join`) has no navigation, the `QorllaMobile/1` marker is set, the "get the app" panel is hidden, and Join says "Video meetings are not available right now" and stays on the invitation page (never the old built-in room); after signing in the workspace has exactly Home, Chat, Phone, Docs, Clips, More in one row without scrolling, the one-tab guard is active, More has the moved pages (Schedule, Calendar, Mail, Whiteboards, Notes, History, Settings), pages opened from it have a close button that returns to the page before (More, then Home), and New meeting says video is unavailable instead of opening the old room.
- The four tab destinations (tests 6 to 9): Chat opens `/chat.html` (no horizontal scroll, signed-in person shown, the one-tab guard hands over cleanly from the workspace), the app's native close button and then hardware Back both return to the workspace; Phone opens as its own page with a close button and a dial pad of at least 12 keys; Docs (`/app/suite`) and Clips (`/app/meet`) open the portal's "Section not running" notice (the real Docs and Clips pages come from the Workplace Portal behind the reverse proxy, which this isolated server does not have), with the native close button and Back working. **The real Docs and Clips pages are NOT tested.**
- Test-method notes: the WebView skips history entries created without a user gesture when Back is pressed, so the test evaluates scripts with `userGesture: true`; an earlier "Back goes to Welcome" result was caused by script-driven navigation, not by the app.
- NOT checked: the real Qorlla Meet video page. This server has no Meet and the v46 stack was not running (and not started), so "the new video page" itself remains unverified.

## Real Qorlla Meet video page (isolated stack)
- Stack: `scripts/dev-stack.mjs` with `DEV_DB_CONTAINER=qiso-meet-db DEV_DB_VOLUME=qiso-meet-data DEV_STATE_DIR=.dev-stack-iso MAIN_PORT=3400 MEET_PORT=3500 VOICE_PORT=4700 MEET_DB_PORT=35433 MAIL_PORT=1125 MAIL_VIEW_PORT=3325`: its own PostgreSQL container, volume, secrets and data. The v46 stack (3200/3300/4600, DB 35432, container `qorlla-meet-dev-db`, volume `qorlla-meet-dev-data`) was not started, read or changed.
- Two repo gaps found and fixed on the way: the script had no way to name its own container/volume/state folder (now `DEV_DB_CONTAINER`, `DEV_DB_VOLUME`, `DEV_STATE_DIR`, defaults unchanged), and it stopped at migration `v4_15`, so Meet answered 500 ("column host_account_id does not exist") when main registered a meeting; `v4_16` to `v4_18` (all idempotent) are now applied on every start.
- App: local-stack build for these origins, `npm run local-stack:build` with `QORLLA_APP_URL=http://localhost:3400/` and `QORLLA_MEET_URLS=http://localhost:3500/`. SHA-256 `5e84822b480f347fed5a8b318b854fb6db66c62239d374fa13e14ac441eee2ff`, built 12:51 to 13:03 (exit 0, 11 minutes); its bundle contains `localhost:3400` and `localhost:3500` and no `localhost:3200` or `18081`. Development APK, not a release.
- `QORLLA_ANDROID_SERIAL=<serial> QORLLA_STACK_APP=http://localhost:3400 QORLLA_STACK_MEET=http://localhost:3500 node --test e2e/android-real-stack.test.cjs`: **3 of 3 passed**. Starting a meeting returns `mode: "meet"` and a guest session returns a URL on the Meet origin (never `index.html`). On the Galaxy A03s an invited guest following `qorlla://join` lands on the Qorlla Meet page (title "Qorlla Meet | Collaboration", the waiting room, no navigation buttons before it), and a signed-in host starting a meeting lands in the Meet room ("Stack Host's meeting") with camera and microphone off.
- No screenshots of the Meet page were taken or committed (it asks for the camera); the checks read the page's DOM. Not covered: audio or video between participants, admitting a guest from the waiting room, Meet's own controls on a phone screen, TURN across networks.
- Still NOT verified: Docs and Clips (the Workplace Portal behind nginx; needs the full docker-compose), and anything on the v46 stack itself.

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

## Qorlla AI Gateway, Docs AI and device round (commits 4df8f3e, 64e82c1, a1a2f92)

| Check | Result | Notes |
|---|---|---|
| Gateway unit tests (`tests/ai-gateway.test.mjs`) | 18/18 PASS | stubbed provider endpoints + labelled test adapter; **not** evidence that any live account works |
| Gateway routes + PostgreSQL (`tests/ai-gateway-routes.test.mjs`) | 12/12 PASS | status, settings (owner/admin only, audited), admin-only provider/audit views, review-first `/ai/run` (13 tasks, nothing written), document-level authorisation, kill switch, append-only audit, production refuses the test adapter |
| Full portal suite on a disposable PostgreSQL | 199/199 PASS (0 failed, 0 skipped) | includes migration 008 re-run/rollback test; earlier "hung" run was only a missing test database |
| Docs AI specs on `qai` (test-adapter contract, port 3900) | 2/2 PASS + 3 AI-independent PASS (+ 2 notes/documents PASS) | 6 passed; the "no provider" spec is skipped by design on an AI stack |
| Production-default stack `qnoai` (AI OFF, port 4300) | "no provider" spec PASS; 5 passed, 2 AI specs SKIPPED | proves disabled AI actions are inaccessible and nothing is simulated |
| Galaxy A03s (SM_A037U), Meet on `qiso` | 8/8 PASS | same APK `9318f717…d214` (origin localhost:3600) |
| LG LM-S320 | BLOCKED | visible to Windows only as an MTP device; no ADB interface (USB debugging off / not authorised). Nothing was tested on it |
| Live providers (OpenAI / Gemini / xAI / self-hosted) | BLOCKED | no credentials, no authorisation |
| Aria AI | BLOCKED | no officially supported API integration verified |

Contracts verified in compose: `qai` portal = NODE_ENV=test, QORLLA_ENVIRONMENT=test, ENABLED=true, PROVIDER=test, TEST_ADAPTER=true, PAID_FALLBACK=false. Base compose (production default) renders ENABLED=false, PROVIDER=none, TEST_ADAPTER=false.
Image IDs (qai): meet `2085e939…5862`, meet-sync-worker `d366f678…6f6e`, portal `5925ff9a…0705`, main `d425b5fa…78e9`, nginx `892bb215…3d33d`, postgres `721873c3…80ea`.
Behaviour changes to note: the legacy `AI_LLM_API_KEY` alone no longer enables AI; meeting reports now record the public model name `qorlla-ai` (the real model id is only in the admin audit trail); unreadable model output no longer trips a provider's circuit breaker.
Windows reserves some TCP ranges (4024–4223 here): an isolated project needs a base port whose +0..+3, +43, +44 are outside them (4300 works).

### AI activation round 2 (commit 924e751)
- Portal suite 205/205 PASS (gateway unit 21, gateway routes 15, migrations incl. 008). `qai` (test-adapter contract): Docs AI Draft PASS, QorllaMate PASS, 4 non-AI specs PASS (6 passed, "no provider" spec skipped by design). `qnoai` (production default, AI OFF): 5 passed incl. "no provider" refusal, 2 AI specs SKIPPED.
- New controls: `QORLLA_AI_APPROVED_PROVIDERS` (a configured key is never used until the provider is named there), per-workspace daily cap (`QORLLA_AI_WORKSPACE_DAILY_REQUESTS`, default 2000, 429 `ai_quota_exceeded`), Qorlla model profiles (`qorlla-ai`, `qorlla-ai-private` = local providers only), `GET /api/v1/ai/{providers,models,usage}`, preview-only `POST /api/v1/ai/{generate,docs/draft,docs/rewrite,sheets/analyze,slides/generate,qorllamate/chat}`.
- Still BLOCKED: live OpenAI / Gemini / xAI / self-hosted calls (no approved credentials); "Arial" (no provider/API identified); LG LM-S320 (no ADB).
