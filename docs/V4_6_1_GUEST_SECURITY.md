# v4.6.1 Guest Authorization and API Security

Base: `dfda463` (guest routing fix, kept independently verifiable). This work is a separate commit on the v4.6 branch.
Scope: the MAIN service (`server.js`, `docs.js`, `appointments.js`, `notifications.js`, `post-meeting.js`, `guest-sessions.js`, `index.html`, `guest.html`, `guest.js`). The Meet service (`qorlla-meet-video`) has its own join model and was **not** changed or audited here.

## Phase A - audit findings (before the change)

| Finding | Evidence | Severity |
|---|---|---|
| Joining a meeting needed only its ID; anyone could `join_room` | `join_room` looked the meeting up by client-supplied id | High |
| Host of an anonymous meeting = "whoever sends the hostId" | `isHostFor` compared a client-supplied `userId` to `meeting.hostId`; the seeded meeting's host id is a public constant | High (privilege escalation) |
| `/api/docs` fully anonymous | upload, link-to-meeting and list-by-meeting had no caller check; uploader id taken from the form; any document could be linked into any meeting | High |
| `/api/appointments` anonymous | slots and book open; unbounded bookings, no validation | Medium |
| `/api/notifications` anonymous | anyone could trigger mail to any user id; `audit-log` returned the whole system log | High |
| `/api/post-meeting` anonymous (not in the review, found in the audit) | anyone could conclude any meeting and read any summary | High |
| `/api/meetings/create` trusted a client `hostId`; meeting IDs could be enumerated with no throttle | | Medium |
| `room_state_updated` sent the full meeting record | | Low |

## Phase B/C - what changed

* **Guest sessions** (`guest-sessions.js`): 256-bit random token in an `HttpOnly; SameSite=Strict` cookie (`Secure` behind HTTPS). Only the SHA-256 is stored. Bound to one meeting, one display name, one role and a fixed capability list. 60 min idle TTL, 8 h absolute limit, refresh **rotates** the token (replay of the old token fails). Every lookup re-checks revocation, expiry and that the meeting still exists and has not ended (fails closed). The server never accepts a token from the client when issuing (no fixation); an incoming guest cookie is revoked first.
* **API** (`/api/guest`): `POST /meetings/resolve`, `POST /sessions`, `POST /sessions/refresh`, `POST /sessions/revoke`, `GET /sessions/me`. One generic 404 for unknown, ended, expired or guest-disabled meetings. JSON body and same-host `Origin` required; per-IP rate limit (30/min; meeting create 20/min, validate 60/min).
* **Eligibility**: meeting exists, not completed, `allowGuests !== false`, and within the invitation window (scheduled end + 24 h). The seeded demo meeting `858 9833 3712` is marked `evergreen` (mobile default / CI health check) and never lapses.
* **Host**: only the signed-in account that owns the meeting, or a guest session issued with the meeting's one-time **host key** (returned once by `/api/meetings/create`; only its hash is stored). A client-sent user id is never consulted. A signed-in creator is always the host account.
* **Socket admission**: `join_room` needs an account or a live guest session for *that* meeting. A second connection with the same session takes over (first is disconnected). Host-only `remove_participant` revokes a guest's session (or bars an account from re-joining). `terminate_meeting_session` revokes every guest session of the meeting.
* **Legacy endpoints**
  * `/api/docs`: caller must be an account or guest. Guests can only upload into / read from the meeting their session belongs to. Accounts: meetings they host or joined; otherwise the file is a workspace document. Documents are tagged `scope`/`meetingId`/`ownerId` (not returned to clients); a meeting document can never be linked into another meeting; "missing" and "not yours" give one answer.
  * `/api/appointments`: accounts only (guests 403). Input validation (date format, topic length, email, window of 12 months) and a per-account cap.
  * `/api/notifications`: `trigger` needs the server-to-server `NOTIFY_INTERNAL_TOKEN` header, or an account notifying **itself** with an allow-listed event; guests cannot trigger. `audit-log` is internal-only. New `GET /mine` returns only the caller's notices (guests: only for their meeting).
  * `/api/post-meeting`: `conclude` host only; `summary` participants only.
* **Client**: `index.html` obtains the session (or detects an account) before opening the socket and refreshes it every 20 minutes; shows removal / end-of-meeting messages; hosts get a **Remove** button. Pre-join creates the session so refusal is shown early. The browser no longer posts notifications for another user. Scheduling asks anonymous visitors to sign in.
* **Localization**: guest pages use the shared catalogs (es, fr, pt-PT; 55 new keys each, parity test passes) and the existing language selector. Removed the claim "you will be admitted after you join": no waiting room exists.

## Phase D/E - evidence (development environment, Chromium with fake devices)

| Gate | Result | Evidence |
|---|---|---|
| Valid guest access (API + socket + browser journey Welcome -> Join -> Pre-Join -> meeting) | PASS | `tests/guest-security.spec.js` |
| Expired and revoked sessions; rotation/replay; absolute lifetime | PASS | fake-clock store tests + live revoke test |
| Wrong-meeting denial (socket, docs, post-meeting) | PASS | |
| Cross-meeting document isolation | PASS | |
| Protected appointments / notifications / post-meeting (anonymous and guest) | PASS | |
| Meeting termination and host removal revoke sessions (and cookie cannot return) | PASS | API + browser Remove button |
| Existing authenticated behaviour | PASS | full root suite |
| Rate limiting | PASS (unit) | |
| Localization (es/fr/pt-PT) and responsive layout at 1366x768 and 390x844, no horizontal overflow | PASS | screenshots reviewed |
| Regression check that the tests can fail | PASS | against `dfda463`, 13 of the 17 original security tests fail (the other 4 are pure unit tests) |
| Real-device testing (phone/tablet cameras and microphones) | NOT DONE | needs physical devices |
| Independent security review / penetration test | NOT DONE | |

Test counts: root Playwright suite **50 passed, 0 failed** (was 30; +17 security API/unit tests, +2 browser journey tests, +1 scheduler sign-in test). No database migrations (MAIN's guest state is in memory by design).

## Unresolved limitations (do not call this production-certified)

1. **No waiting room / host admission** exists in MAIN, so "host approval" cannot be enforced; anyone with an eligible meeting ID can obtain a guest session. A removed guest can request a new session under another name (there is no ban list without a lobby or passcode). Recommended next step: passcode and/or lobby.
2. Meeting IDs are 11 random digits and are the only secret for guest entry; the rate limits slow enumeration but are per-process.
3. Session store and rate limiter are **in memory**: a restart ends every guest session (fail closed), and more than one MAIN instance is not supported without a shared store.
4. Meetings created before this change have no host key, so their anonymous host can no longer claim host. Signed-in hosts are unaffected.
5. `qorlla-api-client.js` (mobile/other clients) calls docs/appointments/notifications without credentials and will now receive 401; it needs account cookies or a guest session. Not changed here.
6. Meet (`qorlla-meet-video`) join authorization was not audited or changed.
7. Real-device and independent-review gates are open, so the **final status is not PASS**.

## Operations

* `NOTIFY_INTERNAL_TOKEN` (24+ chars): enables server-to-server notification triggers and the audit log. Unset = nobody can.
* `GUEST_SESSION_TTL_MS` (default 3 600 000), `GUEST_SESSION_MAX_MS` (default 28 800 000).
* `GUEST_RATE_LIMIT_MAX` overrides the per-IP limits (tests only).
