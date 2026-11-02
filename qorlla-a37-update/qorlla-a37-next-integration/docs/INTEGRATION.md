# A3.7 integration into existing engine (not a drop-in patch)

Baseline expected: feature/number-authority-a3 at 532feea or later. No repository was provided; file paths are suggested adapter boundaries, not claims about actual code.

1. Import `classifyDial` and `createSmartDialService` into existing voice routing layer. Provide authenticated Shield principal from existing middleware; never accept client-supplied tenant or verified-country claims.
2. Bind `registry.lookup` to the engine's authoritative extension registry plus `voice_country_aliases`; preserve globally unique extension and alias constraints. Enforce tenant/relationship policy through `shield.canCall`.
3. Wire account-verification completion event to `assignCountryAlias`, only after country confirmation and authoritative extension provisioning. IP geolocation suggests country only. Retain alias on suspension and disable lookup; do not reissue.
4. Add authenticated POST /voice/dial/prepare to existing listener. Request `{dial}` only. Response contains status and internal extension ID or external quote. Existing CSRF/session/auth controls apply.
5. Add authenticated POST /voice/dial/start-internal to existing listener. Recheck eligibility and target, enforce idempotency, use engine invite path.
6. DO NOT implement /confirm-external with this pack. It must be owned by the approved wallet/payments and carrier gateway with transactional balance reservation, consent, rate quote expiry, anti-fraud, refunds, reconciliation, and licensed routes. No live external calls are enabled here.
7. Display local alias as a national number with a clear 'Qorlla-only' label. For '+' input show external call quote and explicit paid consent, never start automatically. For local input never fall back to PSTN.
8. Use `VOICE_COUNTRY_ALIAS_ENABLED=false` as new rollout flag; retain `VOICE_PSTN_ENABLED=false`, `VOICE_NUMBERS_ENABLED=false` and all existing Shield/mTLS checks.
9. Migration SQL uses TEXT IDs intentionally because the actual engine PK types are unknown. Before applying, change to real types, add foreign keys, adjust grants and integrate with existing migrations. DO NOT apply unchanged to production.
10. Replace the simplified country candidate generator with a policy-approved reserved internal namespace before deployment. National-shaped aliases can collide with real public numbers and must never be advertised as reachable on PSTN. Country profiles here are examples, not authoritative national allocation metadata.

## Required certification
- Run 155 existing engine tests + 15 Playwright subset + full E2E.
- PostgreSQL race/rollback/restart tests for alias assignment and retirement.
- Verified/unverified, tenant movement, VPN/travel, suspensions, revoked mTLS, real-process Meet/main app.
- Ensure local lookup never bills and + never initiates PSTN without confirmation.
- Carrier, wallet, scratch cards, SFU/TURN termination, failover, devices and RC2 gates remain BLOCKED.
