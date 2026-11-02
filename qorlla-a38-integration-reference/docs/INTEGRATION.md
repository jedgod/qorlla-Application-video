# A3.8 integration plan — existing Voice Engine only

## Integration points

1. Keep the existing account/tenant/Shield principal. All principal values must come from authenticated server context, not request bodies.
2. Add the existing Phone page's `+` path to `POST /v1/voice/external/quotes` and `POST /v1/voice/external/calls` after explicit user confirmation. Existing internal dial route remains unchanged.
3. Plug `createA38` into the current engine router, with its existing PostgreSQL pool, event outbox and workload security. Do not run another server.
4. Implement `store.transaction` methods in `src/service.mjs` on the **existing** wallet/ledger tables with SERIALIZABLE or correctly ordered row locks, unique idempotency keys and deadlock retries.
5. Do not dispatch PSTN from the transaction. A durable outbox worker with leased retries and carrier idempotency dispatches it; no duplicate calls on worker restart.
6. `metadata.parse` must be backed by an up-to-date telephone metadata library (e.g. libphonenumber), with carrier-specific premium/fraud rules. This pack's policy rejects `premium`, `emergency` and `unknown` types.
7. `rateProvider.quote` must return a versioned, immutable, currency-specific rate snapshot; pin the quote to a permitted route and expiration. The example uses a 60-second quote TTL.
8. `carrier` must be a configured, approved provider; require signed webhooks (raw body + replay protection), provider event correlation, durable webhook inbox, independent reconciliation, and carrier-verified billable durations.
9. `identity.getAuthorizedCallerIds` must return only provider-authorized caller IDs. Never use an invented Qorlla internal alias as PSTN caller ID.
10. Vouchers are funded only when payment is irrevocably captured or a trusted authorized distributor activates stock. Hash PINs with a high-entropy secret pepper, rate-limit attempts, protect voucher inventory, and use transactional single-use redemption.

## Mandatory correction before real money

`src/service.mjs` reserves one minute as an illustrative minimum. It **must not** run an unbounded call on that reservation. A real implementation needs (a) max-call-duration enforcement by the carrier, (b) periodic atomic top-up reservations and cutoff on low funds, or (c) full maximum-duration reservation. If a carrier reports a charge above the reserved amount, the reference handler refuses automatic settlement and requires reconciliation; this is an operational exception, not a completed charge.

Add monetary ledger invariants: integer minor units, supported currency whitelist, balanced immutable double-entry journals, no negative available balance, exactly-once economic effects under at-least-once events, customer refund/chargeback paths, and reconciliation reports. Ensure merchant payments cannot be confused with wallet credits until settled.

## Required security tests

- Flag off: all `+` calls return 403 and no carrier action.
- Internal number: never reaches wallet/carrier.
- Spoofed tenant/account/country/quote/caller ID denied.
- Stale quote, changed country, suspended user, expired account denied at confirmation and again before carrier dispatch.
- Concurrent confirm with same and different idempotency keys never creates duplicate or overspending calls.
- Queue worker crash before/after carrier request does not duplicate calls; provider idempotency required.
- Duplicate, out-of-order, replayed and forged webhooks rejected or idempotently handled.
- Network failure, carrier timeout, disconnected call, partial minute, long call, FX, rate update, insufficient funds and refunds.
- Voucher brute force, stolen voucher, concurrent redemption, expired/unactivated vouchers and disputed distributor payment.
- Geo-restricted, premium, emergency, sanctions-blocked and unavailable destination attempts.
- Multi-host, PostgreSQL failover, load, physical-device and security review.

## Regulatory / product gates

Assess telecom reseller/VoIP licensing, destination-country restrictions, sanctions, consumer disclosures, prepaid calling-card rules, sales taxes, payment processing, fraud and emergency calling expectations with qualified counsel and carriers before launch. No carrier or public number is provisioned by this pack.

## Release status

`VOICE_A38_ENABLED=false` and `VOICE_PSTN_ENABLED=false`; RC2 gates remain BLOCKED. This pack's standalone tests are not real-engine, database, carrier or payment certification.
