# Qorlla feature/number-authority-a3: source export

**File:** `qorlla-number-authority-a3-ddef7a1.zip` (735 files, tracked files only, from `git archive`).
**Commit:** `ddef7a1` on `feature/number-authority-a3`, repository `https://github.com/jedgod/qorlla-Application-video.git`.
**Pushed state:** the remote branch is at `9f302a3` (A3.5). `ddef7a1` (A3.6: Phone page and `voice.js` wired to the Shield) is **local and not pushed**; everything in the zip is `9f302a3` plus that one commit. Nothing is merged into `main` or RC2; tags `rc2-evidence-baseline` and `-v2` are untouched. Release status: BLOCKED. `VOICE_NUMBERS_ENABLED=false`, `VOICE_PSTN_ENABLED=false`.

**Not in the zip (by design):** `node_modules`, `.dev-stack/` (database password and other dev secrets), `.env` files, any certificate or key, `test-results/`, git history and stashes. Run `npm install` in the repository root, in `qorlla-meet-video/` and in `qorlla-voice-engine/`.

## Verified at this commit
Engine suite `cd qorlla-voice-engine && npm test`: **163/163** (needs PostgreSQL; the tests read `VOICE_TEST_DATABASE_URL` or the dev stack's `.dev-stack/secrets.json`; some tests also need `openssl` and Docker). Real-browser specs `tests/voice-shield-ui.spec.js` (5/5, three consecutive passes), main-app subset (login, Meet hand-off, guest) 15/15. One long Phone Settings test is flaky under load (passes alone).

## Where things are (for adapters, e.g. the A3.7 packs)
| Area | Files |
|---|---|
| Engine app, routes, feature gates (`pstn`, `numbers`, `internal_calls`) | `qorlla-voice-engine/src/app.mjs` |
| Shield (workload identity + mTLS proof, principals/orgs, call/room guards, alerts, guest admission, PSTN authorization, meet signaling) | `qorlla-voice-engine/src/shield.mjs` |
| Call and room state, transactional outbox, replay | `src/store.mjs`, `src/rooms.mjs`, `src/outbox.mjs`, `src/reliability.mjs` |
| Number authority projection (consumer of Numbers & Plans events) | `src/number-sync.mjs` |
| Migrations (next free number: **017**) | `qorlla-voice-engine/sql/001..016_*.sql`; Meet: `qorlla-meet-video/sql/v4_16..v4_18` |
| Numbers & Plans (authority), provider contract, internal provider, mTLS transport | `qorlla-meet-video/server/telephony/*` |
| Meet signaling gate (shield-enforced) | `qorlla-meet-video/server/index.js`, `server/shield-client.mjs` |
| Main-app bridge to the Shield (account sync, workload key, hot-reloading mTLS) | `shield-bridge.js`, `auth.js`, `server.js`, `voice.js` |
| Phone page (voice states, dial pad) | `qorlla.html` (search `voiceLoadStanding`, `VOICE_ERR`, `qpDialHint`) |
| Docs | `docs/VOICE_SHIELD*.md`, `NUMBER_AUTHORITY_A3.md`, `PROVIDER_NEUTRAL_TELECOM.md`, `VOICE_INTERNAL_CALLS.md`, `A34_WORKLOAD_MTLS.md`, `A35_ALERTS.md`, `A36_PHONE_WIRING.md` |

**Real column types (the packs guessed):** `voice_identities(account_id text PRIMARY KEY, extension text UNIQUE 3-8 digits, enabled boolean)`; `shield_principals(account_id text, org_id text, verified, suspended, billing_hold, suspend_holds text[], tokens_valid_after)`; calls and rooms use `uuid` ids; accounts are TEXT (`u_<uuid>` from the main app). Call creation: `store.createCall(caller, extension, key, deviceId, guard)` where `guard = shield.callGuard` runs inside the transaction after both accounts are locked (tenant = `shield_principals.org_id`, absent = default namespace). Extensions are globally unique (stricter than per tenant).

## Notes for the A3.7 integration packs (`qorlla-a37-update`, `qorlla-a37-next-integration`)
- Adapt the alias index to `account_id text` / `extension text`, add a foreign key to `voice_identities(account_id)` and `(extension)`, never recycle (keep retired rows, `canonical_national UNIQUE`), put the migration at `sql/017_*.sql`, and gate it behind a new `VOICE_COUNTRY_ALIAS_ENABLED` (exact `true` to enable, like the other flags).
- **Do not use the pack's `candidateForCountry` as it is:** it produces random national-shaped numbers (for example UK `07…`, US 10 digits) that can equal real people's public numbers; the pack itself says to replace it with an operator-approved reserved namespace. Without such a configured namespace, alias issuance must refuse.
- `verifiedCountry` must come from a server-side record of an explicit user confirmation, never from a request or an IP lookup. External (`+`) dialing, quotes, wallet and vouchers stay out of this engine: PSTN is disabled and a `+` destination is already refused with `403 feature_disabled`.
