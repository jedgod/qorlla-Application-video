# Qorlla A3.8 — Prepaid International Calling (integration reference)

This is an **adapter pack**, not a patch against the live `feature/number-authority-a3` repository. The source export described in conversation was not available in this execution environment. No files were changed in that repository, and nothing was pushed.

## Intent

- No leading `+`: hand off to existing internal number authority and signaling; never bill or use PSTN.
- Leading `+`: require A3.8 and PSTN flags, verified principal, server-confirmed country, destination metadata, corridor allowlist, rate quote, prepaid reservation, explicit confirmation, and approved carrier.
- `00` is not converted to `+`. Emergency, premium-rate and unknown number types are refused.
- Internal Qorlla identities are never asserted as PSTN caller ID.

## Deployment flags (default OFF)

```env
VOICE_A38_ENABLED=false
VOICE_PSTN_ENABLED=false
VOICE_A38_VOUCHERS_ENABLED=false
```

## Modules

- `src/policy.mjs`: dial classification and eligibility.
- `src/service.mjs`: quote, reserve/confirm and authenticated event settlement adapter.
- `src/vouchers.mjs`: secure PIN generation, hashing, transactional redemption adapter.
- `sql/018_a38_prepaid_international_reference.sql`: **non-runnable production reference** schema; align to engine migration order and existing wallet/outbox tables.
- `test/policy.test.mjs`: standalone unit tests.
- `docs/INTEGRATION.md`: required real-engine adapters, security and certification gates.

## Tests

`node --test test/*.test.mjs`

## Not supplied

No payment provider, real wallet ledger, real carrier connector, webhook verification, real phone parsing library, online store, voucher distributor, full API wiring or production deployment. **Do not enable either flag on production.**
