# Numbers & Plans authority audit and reconciliation plan (Phase A)

Scope: read-only audit of `qorlla-meet-video/server/telephony/*` and `qorlla-meet-video/sql/v4_14_telephony.sql` against the engine number module (`wip/voice-numbers` @ 4801624, `sql/010_numbers.sql`) and the supplied overlay `qorlla-shield-v2.2`. **No production behaviour was changed by this audit.**

## Decision applied
Numbers & Plans (Twilio) is the only authority for purchase, release, billing and provider lifecycle. The engine holds an assignment/authorization/routing **projection**. A number is usable only when the provider authority says `active` **and** the engine's own authorization (verified, unsuspended principal; country eligible; capability enabled) agrees.

## What Numbers & Plans stores today (`qphone_numbers`)
| Field | Meaning |
|---|---|
| `id` uuid | internal row id |
| `provider_number_id` text UNIQUE | the Twilio `PN...` SID (**the stable identifier to synchronize on**) |
| `e164` UNIQUE, `country`, `provider` | number, country, carrier name |
| `kind` | `personal` or `dialin` (shared meeting dial-in numbers; **must never be assigned to a person**) |
| `assigned_to` text | Qorlla account id (personal numbers); no uniqueness per account |
| `state` | `provisioning`, `active`, `suspended`, `releasing`, `released` |
| `caller_id_verified` | admin-set flag |
Related: `qphone_provisioning_requests` (idempotency per actor, states requested/processing/provisioned/failed/cancelled), `qphone_provider_events` (call events de-duplicated by provider event id), `qphone_usage` (provider cost vs customer charge, micros), `qphone_limits` (monthly spend), `qphone_gates` (release gates), `qphone_audit`.

Lifecycle writers found: `requestNumber` -> `runProvisioning` (buys via `provisionNumber`, inserts `active`); `setNumberState` (admin: active/suspended/released; release calls the carrier then updates the row); `reassignNumber` (admin: rewrites `assigned_to`); `setCallerIdVerified`.

## Conflicting or unsafe paths discovered
1. **Two purchase/release paths.** The engine module's worker (`voice_num_outbox` -> provider adapter) can submit and release numbers; Numbers & Plans does the same. Two authorities. *Resolution:* the engine provider adapter must be removed (or hard-disabled) in the synchronized design; the engine only consumes authority events.
2. **Two inventories and two assignment tables.** `voice_num_inventory` / `voice_num_assignments` duplicate `qphone_numbers` (`assigned_to`, `state`). *Resolution:* `voice_num_inventory` becomes a read-only projection keyed by `provider_number_id`; assignments are written only from authority events.
3. **No identifier link.** The engine module keys on its own ids; there is no `provider_number_id` column. *Resolution:* add it (UNIQUE) plus `authority_version`.
4. **`setNumberState('released')` is not atomic with the provider.** It calls Twilio, then updates the row. A crash between leaves the carrier released but `qphone_numbers.state='active'` (or a carrier failure leaves it unchanged with no `releasing` record). The `releasing` state exists in the CHECK constraint but **no code path writes it**. *Resolution:* write `releasing` (and an outbox event) in the same transaction first; finish to `released` only after the carrier confirms; reconcile against Twilio inventory.
5. **`reassignNumber` has no ownership checks.** It rewrites `assigned_to` for any text (<=64 chars) with no check that the target is a verified, unsuspended account, no uniqueness (one account can end up with several `active` personal numbers; the engine module forbids that), and no event to downstream consumers. *Resolution:* emit a versioned authority event; the engine rejects projection of a second live number per account.
6. **`assigned_to` is free text**, unverified against the account store or the shield's principal table.
7. **No `authority_version` / event outbox** in Numbers & Plans: synchronized consumers cannot order or de-duplicate changes. *Resolution:* add a monotonically increasing version per number and a signed outbox (not yet built).
8. **Dial-in numbers share the table** with personal numbers; the engine module has no concept of `kind` and would accept them. *Resolution:* projection accepts `kind='personal'` only.
9. **Caller-ID proof is a boolean set by an administrator**, not derived from provider ownership. The shield PSTN contract needs "caller ID in authorized provider inventory and owned by this account": satisfiable once the projection exists.
10. **Table name collision in the supplied overlay:** `sql/003_security_integration.sql` defines `shield_guest_admissions` with a different schema from the one already created by `sql/011_shield.sql` on `feature/security-shield-v2.2` (`CREATE TABLE IF NOT EXISTS` would silently keep the wrong one). The overlay also lacks a `TRUNCATE` guard on its audit trigger and has no media-credential issuer or replay table. *Resolution:* adopt the overlay's `number-sync` event contract and `policy` ideas, not its SQL as-is.
11. **Billing state** lives only in `qphone_usage` / `qphone_limits`; nothing links a number to a billing hold. A number whose billing is suspended is not reflected as `suspended` automatically.

## Target single lifecycle
`requested -> provisioning -> active -> suspended <-> active -> releasing -> released` (+ `failed`), written **only** by Numbers & Plans inside one transaction that also appends a versioned, signed `number.*` event to an outbox. The engine/shield projection (`provider_number_id` PK, `e164`, `kind='personal'`, `account_id`, `state`, `authority_version`) applies events idempotently (event id), monotonically (version), and refuses: unknown signature, stale version, dial-in kind, a second live number per account, an account the shield does not know or has suspended. Usable = projection `active` AND shield authorization allows. Reconciliation job compares projection with Twilio inventory and the authority table and raises (never auto-fixes) differences.

## Status of each phase
| Phase | Status |
|---|---|
| A. Authority reconciliation | **Audit complete (this document). Schema/outbox changes NOT implemented.** |
| B. Security Shield integration | Engine-side shield implemented and tested on `feature/security-shield-v2.2` (local, unpushed): workload identity, guest admission + media credentials, PSTN authorization (no dialing), suspension, tenant isolation. Not yet connected to Numbers & Plans, the main app or Meet. |
| C. Calling integration | Not started. `voice.js`, the Phone page and the gateways are unchanged; PSTN stays disabled. |
| D. Certification | Existing engine suite preserved; new shield suite 8/8. Provider-sync, duplicate-ownership and callback-replay integration tests for the **synchronized** number layer cannot be written until the projection and authority outbox exist. |

## Not done on purpose
- `VOICE_NUMBERS_ENABLED` is **not** enabled in production. The module in `wip/voice-numbers` refuses the mock provider under `NODE_ENV=production`, has no real adapter, and its authority model is being replaced by the projection above; enabling it would create a second authority.
- No change to RC2 tags, `main`, or release gates (15/15 pending).
