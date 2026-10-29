# Qorlla Phone v1.0 - release-gate report (meeting dial-in)

**Release decision: NOT READY. Real telephone calling is BLOCKED.** What exists is the complete rules layer, tested against a *test double* of a carrier. There is no telephony provider adapter, no purchased/provisioned number and no PSTN-to-WebRTC media gateway in this repository.

| Gate | Status | Evidence / blocker |
|---|---|---|
| Phone section (Dial Pad, Join Meeting, Recent, Contacts, Numbers & Settings) | PASS (UI) | `tests/phone.spec.js` page test. Contacts is a labelled placeholder, not built. |
| 11-digit meeting IDs unchanged | PASS | the IVR resolves the existing alias; no new ID scheme |
| Dial-in numbers are real, never invented | PASS | numbers only from `PHONE_DIAL_IN_NUMBERS`; junk entries dropped; empty state says none is provisioned |
| Secure, separate meeting PIN | PASS | 8 digits (crypto.randomInt), scrypt verifier, shown once, revocable, rotation kills the old PIN, distinct from the host credential and web passcode |
| IVR: meeting ID + PIN, bounded retries, generic failures | PASS (rules) | same words for wrong PIN / wrong ID / ended / locked / banned / lockout; 5 failures lock a caller (15 min, `PHONE_LOCK_MS`), another caller unaffected |
| Validate ended, locked, waiting room, bans before admission | PASS | waiting room and "host absent" hold callers; host admit/deny uses the existing waiting list; a removed caller is banned from that meeting |
| Provider webhook: signature, replay protection, idempotency | PASS for the test double | HMAC-SHA256 over `t.body`, 5-minute skew, per-event id stored with its answer; a repeat has no second effect. **A real provider (Twilio/Telnyx/Vonage) needs its own adapter and signature scheme: not implemented.** |
| Phone callers as audio-only participants, in attendance/peak/history | PASS | same participant tables and sessions; History report flags `phone` |
| Host mute / remove / disconnect | PARTIAL | remove and disconnect work (call ended, caller banned). **Mute is recorded and announced but cannot silence audio: no media bridge.** |
| Bridge telephone audio into the Meet WebRTC media | **BLOCKED** | needs a PSTN<->WebRTC gateway (SIP trunk + media server/SFU). Not built; not testable here |
| Recording notice and consent for callers | PASS (rules) | callers are counted in the recording roster, told on joining, answer by keypad (1 agree, 2 decline, 9 withdraw) into the same append-only consent records and audit. **No phone audio is captured by the current browser recorder.** |
| Meeting completion disconnects callers | PASS | host End, time-limit close and PIN revocation hang every call up |
| Call history, billing usage, fraud protection, audit | PARTIAL | call history and audit events: yes. **Billing usage metering and toll-fraud controls (spend limits, destination policy) are not built** beyond the attempt limits; the Portal's v4.3 telephony settings remain separate |
| Outbound PSTN calling, number provisioning, voicemail, caller ID, personal numbers | **BLOCKED** | `POST /api/phone/calls` and `/api/phone/numbers/provision` answer 503 by design |
| Country telephony, emergency calling, caller-ID, recording and privacy requirements | **NOT REVIEWED** | needs legal/regulatory review before any real service (emergency calling in particular) |
| Provider secrets, PINs, numbers not in logs/responses | PASS (tested) | the number appears only as a keyed hash plus last 4 digits; PIN only in the one creation response |

Run: `node scripts/start-recording-test-meet.cjs` then `npx playwright test tests/phone.spec.js` (10 tests). Regression: main suite 190 passed, Meet suites 43 passed, both Chromium only.

To make it real you need: a provider account and compliance review, a provider adapter in `server/phone.mjs` (`createProvider`), real numbers in `PHONE_DIAL_IN_NUMBERS`, a media gateway that joins callers to the meeting audio, and a billing/fraud policy. Until then keep `PHONE_PROVIDER` unset (everything answers "Telephony is not enabled").

## Phone workspace additions (Recent Calls, Contacts, Numbers & Plans)

| Area | Status | Notes |
|---|---|---|
| Contacts (add, edit, favorite, delete, search, filter) | PASS (API + UI) | `/api/workplace/contacts`, private per account, max 500, E.164 phone and email validated. |
| Call / Start meeting / Send message from a contact | PARTIAL | Call answers 503 until a carrier is connected (shown to the user). Start meeting opens the Start dialog and fills the contact's email when mail is set up. |
| Call preferences (caller ID name, missed-call alerts, forwarding, voicemail) | PARTIAL | Saved per account at `/api/workplace/phone-settings`; they take effect only when carrier calling is connected. Nothing is forwarded or recorded today. |
| `/api/phone/overview` (numbers, plan, 30-day usage) | PASS | Numbers are only the configured, provisioned dial-in numbers; no assigned personal number exists. |
| Call details, Copy Invitation | PASS | `/api/meetings/:id/invitation-text` (host only, never contains the passcode). |
| Recurrence labels | PASS | A repeating series is separate meetings (own Meeting ID, attendance, History) sharing a `seriesId`; labels show "Recurring (N occurrences)", the pattern, and "2 of N". Wall-clock times are stored as typed, so a 5:00 PM series stays 5:00 PM across daylight saving. Not built: one Meeting ID shared by the whole series, edit-whole-series, RRULE in the .ics. |
| Telephony billing, number provisioning, forwarding/voicemail delivery | BLOCKED | Need a provider. |

## Phone Settings, Help Center and Diagnostics (v1.1 slice)

| Area | Status | Notes |
|---|---|---|
| Phone Settings page (8 sections) | PASS (UI + API) | Calling & Caller ID, Audio & Devices, Meeting Dial-in, Privacy & Security, Notifications, Call History, Plans & Billing, Admin Controls. `GET/PUT /api/workplace/phone-settings`, validated server-side, private per account. |
| Microphone / speaker / ringtone tests | PASS (Chromium, fake devices) | Browser APIs only; nothing is captured until a test button is pressed; device names appear after the user allows access. Not run on real hardware or Safari. |
| Audit trail | PASS | `GET /api/workplace/phone-audit`: what changed and when for forwarding, voicemail, blocked numbers, spam protection and do-not-disturb. Never the numbers or text. |
| Forwarding, voicemail, blocked numbers, spam protection, call waiting, DND, caller ID name | PARTIAL | Stored and validated; they take effect only when carrier calling is connected (the page says so). |
| Telephone PIN create / replace / revoke | PASS | Host only (server-enforced), shown once. |
| Help Center (14 articles, search, categories) | PASS | `GET /api/workplace/phone-help/articles[/:slug]`, content in `phone-help.js`, written to the build's real behaviour. |
| Diagnostics | PASS | `GET /api/phone/diagnostics`: Phone API, Meet, dial-in numbers, provider, audio bridge, plus a browser audio-device check. Every `/api/phone/*` response carries `X-Correlation-Id`; failures show "(ref …)". No credentials, PINs or call content. |
| Support tickets | PARTIAL | Stored per account (`/api/workplace/phone-tickets`), PIN-like numbers rejected, emailed to `SUPPORT_EMAIL` when set and mail works. There is no support-staff console or status workflow: tickets stay "open". |
| Admin Controls (shared numbers, extensions, queues, routing, business hours, spending limits) | BLOCKED | No administrator roles exist in this build and no provider; the page lists each item as unavailable and offers no way for an individual to change organization settings. |
| Plans & billing (international calling, spending limits, invoices) | BLOCKED | No billing or provider connected. |
| Browsers | PARTIAL | Chromium all tests; Firefox: API and Help tests. Edge, Safari and a screen-reader audit not done. |

## Telephony v2 update (see `docs/TELEPHONY_V2.md`)

Supersedes the earlier "no provider adapter / no administrator roles" rows. **Release decision remains NOT READY: nothing has run against a real carrier, number, call or audio.**

| Area | Status | Notes |
|---|---|---|
| Carrier adapter (Twilio REST + webhook signature) | PARTIAL | Built and tested against a local stand-in (and Twilio's published signature example). Not run against real Twilio. |
| Provider "connected" | PASS (rule) | Needs a successful health check **and** a signed webhook; credentials alone show Not connected. |
| Number provisioning workflow | PARTIAL | Request, eligibility, async worker, idempotency, assignment, suspend/release/reassign built and tested. No real purchase; country regulatory bundles not handled. |
| Inbound dial-in IVR | PARTIAL | Reuses the existing PIN/waiting-room/consent rules. Fails closed (callers told joining is unavailable) until a bridge is installed and certified. |
| Outbound calling | BLOCKED | Backend done (gates, fraud screen, limits, idempotency, workers); no browser voice gateway exists, so no call is ever placed. |
| Billing ledger and reconciliation | PARTIAL | Provider cost vs customer charge, reconciliation, disputes, refunds, spending limits tested against the stand-in. No real usage, flat-percentage tax only, no invoice system. |
| Administrators | PARTIAL | `PHONE_ADMIN_USERS` (server owner's list), enforced server-side on every admin action; not a role system. |
| Release gates (`dialin`, `carrier`, `bridge`, `billing`) | PASS (mechanism) | Recorded only by `scripts/phone-certify.mjs` with an evidence file; none are certified. |
| PSTN-WebRTC media gateway | BLOCKED | Not built. |
| Real-carrier certification (T01-T07) | NOT STARTED | Needs a carrier account, a gateway, real phones and sign-off. |
