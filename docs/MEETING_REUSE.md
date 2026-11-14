# Meeting ID + password on current and History meetings, and plan-limited re-use

Status: **implemented and tested in isolated runs; not production-certified.** Real billing is not connected in this repository: the plan comes from the account record (`plan`) or the paid list (`MEETING_LIMIT_EXEMPT_USERS`), exactly like the free-plan time limit.

## What people see

A blue **Meeting access (reusable)** card ("Use the same Meeting ID and Password to start again."):

| Part | Behaviour |
|---|---|
| Meeting ID | Shown grouped for reading (`858 9833 3712`); the copy button copies the raw digits. Everyone who can see the meeting sees it. |
| Password | **Host/organiser only.** Fetched when the card opens (a no-store request to a host-only endpoint) and shown as is. Attendees see "Ask the host for the password". If the server has no key, or the password was set before this feature, the field says "Password not stored". |
| Allow reuse | A real switch (`role="switch"`, `aria-checked`), kept on the server per meeting (ON by default). The (i) tooltip says "N of M re-uses left on your <plan> plan" (or the unlimited wording). With no re-use left, or a plan with 0, the switch is off, locked, and the Upgrade wording and link are shown. |
| Start again | In History (host): consumes one re-use and opens the existing Start screen for the same ID. Shows the remaining count; disabled when the switch is off, the limit is reached, the meeting is still open, or it is not the latest run. |

Where: the expanded card of **every History meeting** (completed, partial, missed, cancelled), the Meeting ID on every History row (`Run n` when a meeting has been re-used), and the host's **Start screen** for the current/upcoming meeting (ID + password, no Start again). The meeting card's "..." menu keeps its four actions.
The existing History structure is unchanged (expandable cards, frozen record, outcome and action items editable). Copy summary and Export report never contain the password.

## This knowingly reverses two earlier designs

1. *Hash-only passcodes.* Passwords are now ALSO kept encrypted so the host can see them again (below).
2. *Frozen History.* A finished meeting can be started again (same ID, same password). The finished run is still frozen; the new run is a separate live record.

Chosen by the owner: the password is shown to the host as is (no "Show" click). Anyone looking over the host's shoulder, or a screenshot of the History page, exposes it.

## Password storage (`meeting-passcode-vault.js`)

* AES-256-GCM, key `MEETING_PASSCODE_KEY` (at least 32 characters, from the secret manager; never in the repo). The Meeting ID is bound into the ciphertext (a value copied onto another meeting does not open; any change is detected).
* **Fail closed:** without a usable key nothing is stored, "reveal" answers 409, the meeting works exactly as before with its scrypt hash. The password is never written in clear, not even temporarily.
* Rotation: put the new key in `MEETING_PASSCODE_KEY` and the old one in `MEETING_PASSCODE_KEY_PREVIOUS`. Old values still open and are re-sealed with the new key the next time the host reveals them. Remove the old key only when every stored value has been re-sealed (or re-set).
* Who can read it: only the meeting's host (signed-in account), through `POST /api/meetings/:id/credentials/reveal` (no-store, 20 per 10 minutes per user, audited as `meeting_password_revealed` WITHOUT the password). Lists, details, CSV/JSON reports, public lookups, create responses, history summaries and server logs never carry it. `meetings.json` holds the encrypted value and the scrypt hash only.
* Trade-off: anyone holding BOTH the data file and the key can read every stored password. Keep the key out of the data volume and backups.

## Re-use (`meeting-reuse.js`, `meeting-credentials.js`)

| Plan | Re-uses per meeting (default) | Environment |
|---|---|---|
| free | 3 | `REUSE_LIMIT_FREE` |
| pro | 25 | `REUSE_LIMIT_PRO` |
| business | 100 | `REUSE_LIMIT_BUSINESS` |
| enterprise | unlimited | `REUSE_LIMIT_ENTERPRISE` |

Blank / `-1` / `unlimited` = unlimited; `0` = no re-use; anything invalid falls back to the default.

* The server decides everything: host-only; the "Allow reuse" switch (`PUT /api/meetings/:id/reuse-setting { allowed }`, turning it ON is refused when the plan has none left); the plan limit that applies is the one for the plan the host has WHEN they ask (a downgrade lowers it at once; re-uses already made keep counting); an atomic count.
* `POST /api/meetings/:id/reuse { clientRequestId }`: the same id again returns the same answer and consumes nothing. Refusals: `403 reuse_off`, `403 reuse_limit` (with `upgrade: true` and the usual "Upgrade to have full access to Qorlla packages" wording), `409 not_finished`.
* The switch from finished to new run is one synchronous step on the server, so two clicks at the same moment cannot use more re-uses than allowed. The finished run is frozen under `<id>~r<n>` (own run key in History; its password material is dropped); a fresh live record takes the ID with the same password, settings and Allow-reuse setting but **no** attendees, chat, notes, documents or Meet registration.
* Meet: each run registers a NEW Meet meeting when the host starts it (`main-<id>-r<n>`), so the new run has its own people, chat, time limit and host credential; the earlier run's Meet record is untouched and nobody from it can slip in (guest sessions revoked, admitted list cleared). No Meet change was needed: Meet never held the password.
* A cancelled meeting can be started again too (same rules).

## Not covered / known limits

* The PostgreSQL `meet-sync` worker path (used when `DATABASE_URL` is set) registers meetings itself; per-run registration is not implemented there (the built-in-room fallback applies).
* Meetings created by anonymous hosts (host key, no account) have no plan and no re-use; only signed-in hosts can see passwords or re-use.
* The Meet app's own invite popover does not show the password (skipped on purpose: it would need a host-only Meet endpoint).

## Tests

* `node --test tests/meeting-reuse.test.mjs` (vault, policy, switch, limits, atomic concurrency, authorization, no plaintext in logs/exports/data file; real `server.js` per test, isolated data directory).
* `npx playwright test tests/meeting-reuse.spec.js --project=chromium` (host sees ID and password and can copy; attendee does not; switch persists after reload; limit and zero-plan disable it; Start again consumes exactly one; 390 px has no sideways scroll; no key => "Password not stored"; cancelled meetings show the card; Start screen shows ID + password).
