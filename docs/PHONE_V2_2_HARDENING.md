# Qorlla Phone v2.2: hardening and telephony readiness

**Release decision: still NOT production-ready for calling.** v2.2 closes the Settings / Help verification gaps and completes the support-ticket workflow. Real telephony (carrier, numbers, audio bridge, billing) remains uncertified: see `TELEPHONY_V2.md` and `TELEPHONY_BRIDGE_ARCHITECTURE.md`. Phone Settings and Help are a finished feature milestone, not a finished Phone release.

Correction to the review's premise: commit 6eac0a7 (Settings and Help) **was pushed** to GitHub on request; the branch now also carries the Telephony v2 commit (ab50336) and the v2.2 work, which are local until you push.

## 1. Phase A: audit (source and tests versus what was reported)

| Finding | Result |
|---|---|
| Settings validation, audit trail (values never stored), PIN create/replace/revoke host-only, Help search, diagnostics reference IDs, no secrets in diagnostics | **Verified** against source and by tests. |
| Support tickets lived in one file per account, so staff could never see them | **Fixed**: shared store, staff scope, legacy import (tickets from the old files are imported once, redacted, and the old file is emptied). |
| "Reject 8-digit numbers" was the only secret guard | **Fixed**: redaction of PINs and passcodes of any length, passwords, tokens, keys, JWTs, private keys, long digit and character runs (section 2). |
| No request-size limit beyond the global 8 MB parser | **Fixed for support routes**: 20 KB limit (413). Caveat: the global parser has already read up to 8 MB when the route-level guard runs; it is an early reject, not a streaming cut-off. |
| Microphone test: tracks kept open until its own timer if you left the page; a failure while setting up audio analysis would leave the microphone open; a stream that arrived after you left was never closed | **Fixed and tested** (section 4). |
| Settings sections could be clicked before their data loaded (builder ran with no data, then was overwritten) | **Fixed** (clicks are ignored until loaded). |
| Help cards: secondary text below 4.5:1 contrast on the hover background (axe) | **Fixed**. |
| Phone tab row scrolled sideways invisibly on phones, hid "Contacts" and "Numbers & Plans", and dragged the header off-screen when tapped | **Fixed** (tabs wrap on small screens). |
| "Status history" tap target was 17 px high | **Fixed** (28 px). |
| JSON settings hashed in key order: PostgreSQL `jsonb` reorders keys, so a correct carrier state looked like drift | **Fixed** (canonical hashing). Found by the activation tests. |
| Carrier-dependent settings gave no per-setting truth | **Fixed** (section 3). |

## 2. Support operations (Phases B)

States: `open -> triaged -> assigned -> in_progress -> waiting_customer -> resolved -> closed`. Allowed moves are a fixed table (a ticket cannot jump); `closed` is final. A customer's reply moves `waiting_customer` or `resolved` back to `in_progress`.

| Who | Can |
|---|---|
| Customer | create; see **only their own** tickets and **public** messages; reply; close. Never sees internal notes, staff identities or transition notes. |
| Agent (`SUPPORT_STAFF`, role `agent`) | see tickets **only in their categories**; triage; assign **themselves**; work, reply, resolve, change priority **on tickets assigned to them**; add internal notes on any ticket in scope. |
| Lead (role `lead`) | the same in their scope, plus assign to any staff member **in scope**, act on any ticket in scope, close. |
| Anyone else | 403 on every staff route. |

`SUPPORT_STAFF` is set by the server owner, for example `[{"user":"alice","role":"lead","categories":["*"]},{"user":"bob","role":"agent","categories":["Billing"]}]`. Priority (low, normal, high, urgent), full status history (who, when, from, to, note), notifications (a push to the owner/assignee, and an email to the customer that says "there is an update" and **never includes the message**), and optional `SUPPORT_EMAIL` for new tickets. Resolution requires a note that the customer sees. Limits: 2000 characters, 40 messages per ticket, 50 open tickets per account.

**Redaction** replaces PINs and passcodes of any length, values after pin/passcode/password/secret/token/api key/otp/host key, JWTs, API keys (sk-, AKIA, ghp_, xox), private-key blocks, digit runs of 6-10 or 12-19 digits, and 32+ character token-like runs. It keeps meeting IDs (11 digits or spaced), E.164 phone numbers and dates, because support needs them. It is a safety net, not a guarantee: a bare 4-digit PIN with no keyword nearby, or a secret written as ordinary words, is not caught. The form says so and tells people never to include secrets. **Not built:** an SLA/escalation timer, attachments, per-agent workload balancing, a staff-facing audit export. The ticket content still lives in a plain JSON file (encrypted when `ENCRYPT_KEY` is set).

## 3. Settings activation (Phase C)

A saved preference is **desired** state. It is **active** only after the carrier adapter applied it **and Qorlla read it back**.

- Registry (`server/telephony/features.mjs`): forwarding, voicemail, do-not-disturb, call waiting, spam protection, blocked numbers, caller-ID name. Each setting is evaluated live: no carrier, carrier not verified, `PHONE_FEATURES` lacks `settings`, no Qorlla number, adapter does not support it, then pending, active, drift or failed.
- Table `qphone_feature_state` (`sql/v4_15_telephony_features.sql`) keeps desired state, its hash, the carrier-side state, error code and timestamps. A worker applies, reads back, and on later passes **reconciles**: a difference becomes `drift`, is audited, and is re-applied.
- **The Twilio adapter supports none of these today** (`features` is an empty set; they would need Qorlla-hosted call logic on the voice webhook). So every one honestly shows "Saved, inactive" with the reason. The whole pipeline is tested with a fake carrier that does support forwarding and do-not-disturb: pending, applied, confirmed, drift detected and corrected, a read-back that disagrees (failed), a refused apply (failed), turning off, and retry by saving again.
- UI: each carrier-dependent control shows its own status line; the default (before the server answers, or if it cannot) is "Saved, inactive until calling is enabled".
- **Independent feature flags**: `PHONE_FEATURES` (comma list of `dialin`, `carrier`, `bridge`, `billing`, `settings`). Default: none. A capability is active only with its flag **and** its certified gate **and** live evidence. A certified-but-flagged-off gate says so.

## 4. Device privacy (Priority 3 / Phase D)

The microphone is opened only by pressing a button. Verified (synthetic device, tracks inspected): opening Audio & Devices, visiting every settings section, and running Diagnostics open **no** stream; a finished test, leaving the section, leaving the Phone view, a stream that arrives after you left, and a failure while analysing audio all end with **no live track**.

## 5. Verification matrix (what actually ran)

| Environment | What ran | Result |
|---|---|---|
| Chromium (Windows) | Full affected suites: Phone UI+API, Telephony, Hardening, sidebar, invitation email, History, Scheduler, Start meeting, Meeting limit | see section 6 |
| Firefox | Phone (16 of 17; 1 skipped: Playwright cannot grant clipboard permission in Firefox), Hardening (9) | pass |
| Microsoft Edge (installed, Chromium engine) | Hardening (9), Phone subset (5) | pass |
| WebKit (Safari's engine on Windows, **not Safari**) | Hardening, 8 of 9 (the microphone test is excluded: no synthetic microphone) | pass |
| Phone-sized touch device | Pixel 7 emulation (Chromium engine): Settings, Help, tickets, console and all five Phone tabs: no sideways overflow, nothing cut off, controls at least 24 px | pass |
| Accessibility, automated | axe-core on every Settings section, Help center/category/diagnostics/guide, tickets, ticket detail, the support console and the five Phone tabs: no serious or critical violations | pass |
| Keyboard | Arrow-key navigation of settings sections and phone tabs, Tab leaves the section list, Enter activates, search by typing | pass |
| **Real microphone and speaker hardware, device switching** | not done: tests use a synthetic device | **open** |
| **Real Safari / iOS / Android devices** | not done | **open** |
| **NVDA / VoiceOver / JAWS** | not done: axe finds a class of problems, it is not a screen-reader audit | **open** |
| Windows high-contrast, zoom 200-400%, reduced motion | not done | **open** |

## 6. Files, migrations, configuration

Migrations: `v4_14_telephony.sql`, `v4_15_telephony_features.sql` (run before `005_app_role.sql`). New: `support-tickets.js`, `server/telephony/features.mjs`, `tests/phone-hardening.spec.js`. Changed: `workplace.js` (tickets moved out; settings sync hook), `auth.js` (`getUserById`), `server.js`, `qorlla.html`, `playwright.config.js` (fake media per browser; opt-in `E2E_EDGE`, `E2E_MOBILE`, `E2E_WEBKIT`), `package.json` (dev dependency `@axe-core/playwright`). Environment: `SUPPORT_STAFF`, `SUPPORT_EMAIL`, `PHONE_FEATURES`.

## 7. Remaining blockers

Real hardware and screen-reader certification (above); the six telephony infrastructure items, each with its own flag and gate: real provider connection, genuine dial-in numbers, authorized carrier calling, confirmed business numbers, the PSTN-to-Meet audio bridge, and reconciled billing; carrier-side enforcement of forwarding, voicemail, do-not-disturb, call waiting, spam protection and blocking (needs hosted call logic); support: SLA timers, attachments, and a decision on where ticket data should live long term (a database, not a JSON file).
