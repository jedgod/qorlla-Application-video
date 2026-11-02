# A3.7 integration contract — existing Voice Engine only

This is an integration reference, NOT a production-ready patch against commit 532feea; that repository is not available here. No branch was changed or pushed.

## Behavior
- Verified eligible accounts receive a permanent country-aware internal alias after confirmed country selection; IP only suggests country.
- Keep the engine's globally unique extension as authoritative routing identity. Alias uniqueness and lookup must be enforced atomically in the same authority, with stable account binding, never recycle retired identifiers.
- The displayed national-style alias is Qorlla-only, not a carrier-issued DID. Never imply it is reachable from PSTN.
- `+` followed by valid E.164-shape digits is an external *request*; all other accepted digits are internal-only lookups. `00` is not silently transformed into `+`.
- E.164-shape validation is not full number validity; use vetted country numbering metadata and a carrier-eligible destination check.
- Internal lookup uses confirmed country and existing tenant policy; never fall back to billable carrier routing.
- External route requires eligible account, permitted corridor, licensed carrier, rate quote, explicit user confirmation, available funds, ledger reservation, and controlled media gateway.
- Keep VOICE_PSTN_ENABLED=false and VOICE_NUMBERS_ENABLED=false until independent certification and approval. New internal alias feature should have a distinct flag such as VOICE_COUNTRY_ALIAS_ENABLED.
- Block emergency, premium-rate, suspicious and prohibited destinations according to policy; do not imply emergency calling is supported.
- On relocation, preserve identity and require an explicit change procedure. Do not silently change on VPN/IP changes.

## Suggested existing-engine API boundaries
POST /voice/dial/prepare: authenticated, returns INTERNAL_READY / NOT_FOUND / EXTERNAL_CONFIRMATION_REQUIRED / DENIED / UNAVAILABLE.
POST /voice/dial/confirm-external: authenticated, accepts server-side quote ID and idempotency key; re-check all authorization, quote expiry, rate, balance, provider availability and consent; atomic reservation before placement. Never trust price or destination supplied by client.
POST /voice/vouchers/redeem: authenticated, rate-limited, atomic one-use redemption into double-entry ledger; hash voucher secrets, do not log PIN.

## Proposed authoritative data model (adapt to existing schema; do not create a second authority)
- country_voice_aliases: account_id, extension_id, iso_country, display_national, canonical_national, status, issued_at, retired_at, unique(canonical_national), unique(account_id).
- external_rate_quotes: quote_id, account_id, e164, corridor, rate, currency, expires_at, policy_version, status.
- wallet ledger and voucher issuance/redemption in existing payments authority, not the voice engine; all state transitions idempotent.

## Must-pass certification before external release
1. Existing 155 engine tests and 15 Playwright subset stay green; run full suite.
2. Alias concurrency: one per eligible account, global uniqueness, no reuse after retirement, restart-safe.
3. Local numbers never trigger carrier or billing; malformed + inputs never place calls.
4. Country selection, VPN, travel, tenant movement and suspended/unverified behavior.
5. Quote expiry, race conditions, insufficient funds, duplicate confirmation, refunds, and webhook replay.
6. Carrier route, lawful numbering rights, tax/consumer disclosures, emergency-call limitations and geographic corridor restrictions.
7. Real TURN/SFU or relay allocation enforcement, multi-host, failover, security audit, physical devices.

All RC2 gates remain BLOCKED until independent evidence exists.
