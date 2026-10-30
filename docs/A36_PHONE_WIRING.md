# A3.6: the Phone page and voice.js wired to the Security Shield and number state (first slice)

**Status: implemented and tested in real browsers against the real main app and the real voice engine with Shield enforcement on. Not production certified. Public numbers and PSTN stay disabled; release BLOCKED.** Branch `feature/number-authority-a3`.

## What the Phone page now knows, and where it comes from
| UI state | Source of truth | What the user sees |
|---|---|---|
| Unverified account | main app token endpoint answers 403 `verification_required` (and the engine independently refuses an unverified principal) | "Verify your email address to use Qorlla Voice (Settings, Account)"; no extension shown; dial pad cannot place a call; no retry storm |
| Ready | token issued, WebSocket connected | "Your Qorlla extension: N"; dial pad works for extensions |
| Suspended while connected | the engine closes the socket with 4003 (Shield suspension) | "Your account is suspended"; the call bar is cleared, calling disabled, **no reconnect loop**; the main app session and voice token are gone too |
| Internal calling switched off | engine `GET /v1/voice/features` (`internalCalls:false`, server configuration) | "Internal calling is switched off by your administrator"; call button disabled |
| Public telephone number typed | the UI never offers it when there is no carrier calling | "Public telephone numbers are not available: Qorlla calls internal extensions only."; emergency numbers keep their own message |
| Own public number | engine `GET /v1/voice/numbers/me`, **only if** `features.numbers` is on and the number authority says the projection is usable | shown only then; with numbers off nothing is shown and the endpoint answers `feature_disabled` |
Error codes from the engine map to plain messages (`identity_unverified`, `suspended`, `unknown_principal`, `feature_disabled`, plus the existing ones).

## Engine additions
`GET /v1/voice/features` (authenticated, booleans only: `internalCalls`, `numbers`, `pstn`); `GET /v1/voice/me` now includes the caller's OWN `standing` (`registered`, `verified`, `suspended`) when enforcement is on (never another account's, never an organization name).

## Verified (`tests/voice-shield-ui.spec.js`, 5 real-browser tests, 3 consecutive passes; regression: see the report)
Unverified account (no token, message, dial pad disabled); verified account ready, `+` numbers and emergency numbers refused in the UI, features `{internalCalls:true, numbers:false, pstn:false}`, `numbers/me` refused with `feature_disabled`, own `standing`; the page greys out calling when the server says internal calls are off; two verified accounts hold a real call under enforcement (ring, answer, connected, hang up); suspension of a connected account (message, calling disabled, no token, no sign-in).

## NOT done
- `voice.js` (the main-app module) needed no server-side change in this slice: it already refuses unverified accounts with a structured error (`SHIELD_REQUIRE_VERIFIED`). Its directory still lists accounts that used voice without consulting tenant membership: the engine refuses cross-tenant calls, but the colleague list is not tenant-filtered yet.
- The Phone page's telephony **administration** screens (numbers, plans, provider) were not changed or re-tested for the `feature_disabled` answers of the gated routes; with PSTN and numbers off they should show "not available", which is unverified.
- Group-call UI paths (rooms) were not exercised under enforcement in the browser.
- Not covered: Phone page behaviour on mobile, other browsers, accessibility re-audit of the new messages, localization (new strings fall back to English).
- Media: a suspended peer's established peer-to-peer stream is not guaranteed to stop; the server ends the call in signaling and notifies the other party. Only an SFU or relay with allocation control can cut media.
- Still open: TURN across independent networks, multi-host, PostgreSQL failover, physical devices, load, penetration review; production PKI. All 15 release gates remain pending.
