# Qorlla internal voice: account-to-account calls by extension (approved scope) and the PSTN lockdown

**Approved scope:** Qorlla account to Qorlla account, by internal extension. No Twilio, no public telephone numbers, no PSTN, no carrier. Production release stays **BLOCKED**.

```
Account A (verified, extension)  ->  Security Shield (identity, tenant, extension resolution, suspension, replay protection)
  ->  Voice Engine (invite, ring, accept/reject, signaling, hang up)  ->  Account B (verified, extension)
Audio: WebRTC with STUN/TURN. The engine controls signaling and authorization; a separate media relay or server may be required for stronger media enforcement.
```

## Feature gates (defense in depth, NOT permission to deploy PSTN)
| Variable | Default | Meaning |
|---|---|---|
| `VOICE_INTERNAL_CALLS_ENABLED` | **on** unless exactly `false` | kill switch for placing calls and creating/joining rooms. Hanging up, leaving and reading your own state are never blocked. |
| `VOICE_NUMBERS_ENABLED` | **off** unless exactly `true` | public-number routes (number events, reconcile, status, `numbers/me`; Numbers & Plans number routes; the outbox dispatcher) |
| `VOICE_PSTN_ENABLED` | **off** unless exactly `true` | every PSTN route: engine `pstn/authorize`, `consume`, `settle`, `terminations`; Meet telephony call routes and carrier webhooks |
Missing, empty, `false`, `TRUE`, `True`, `1`, `yes`, ` true`, `true ` all mean **off** for PSTN and numbers. The gate runs **after authentication** (an anonymous caller still gets 401; the shared admin secret is no bypass) and **before** any handler or provider operation, so a valid JWT, a PSTN scope, an administrator role or an existing session cannot bypass it. Refusal: HTTP 403 `{"error":"feature_disabled","feature":"pstn","message":"Public telephone calling is disabled."}` (numbers: `"feature":"numbers"`, internal calls: `"feature":"internal_calls"`), with no account or call details.
A destination starting with `+` (a public telephone number) is refused as PSTN by the engine whatever the flags say: it places no PSTN calls.
**Production:** set `VOICE_PSTN_ENABLED` and `VOICE_NUMBERS_ENABLED` to nothing or `false`; do not configure PSTN credentials, routes or workload scopes (`pstn.*`, `numbers.sync`). If PSTN is permanently retired, remove the route registration in production builds; the legacy code stays in the development tree. Legacy PSTN/number tests opt in explicitly in isolated test environments only.

## Who may call whom (enforced inside the call-creation transaction)
The caller is always the **authenticated account** (a body field such as `accountId`/`from`/`callerId` is ignored; tested). With `SHIELD_ENFORCE=true`, after both accounts are locked, the engine re-reads both principals: caller known, verified, not suspended, organization not suspended; callee known, verified, not suspended, **in the same tenant** (no organization = the default namespace, which is a tenant of its own). Any failure on the callee's side is reported as "no such recipient" (404, the same body as an unknown extension), so a caller learns nothing about other tenants. Extensions are the **only** call identifiers: 3-8 digits, never an emergency number, globally unique in the database (stricter than unique-per-tenant); a verified mobile number is at most an optional discovery attribute and is never a routing key.
Not yet tenant-scoped: group rooms (only the kill switch applies); this is open.

## Review of the supplied prototype (TwilioMimicGateway / QorllaInternalCallService)
Not adopted as code (the review itself says it is not a drop-in and the simulation must not enter production): the engine already has what it sketches, in a transactional, authenticated, persisted form (identity from the verified token, `crypto` ids, ringing/accept/reject/timeout/hang-up states, durable outbox delivery, both-party eligibility, suspension that ends calls and tells the peer). Adopted ideas: classify destinations by identity type (a `+` destination is PSTN and is refused; anything that is not the documented extension format is rejected, never treated as an extension), an explicit error taxonomy, and rechecking **both** principals atomically with creation.

## Verified (real PostgreSQL, real engine, real workload credentials; `test/pstn-lockdown.pg.test.mjs`, 4 tests, plus a gate test against the real Meet and main app in `shield-integration.pg.test.mjs`)
PSTN flag missing / `false` / invalid values refused on every route with the exact body; a valid PSTN-scoped workload cannot bypass; authentication still first; the exact value `true` reaches the normal checks; same rules for numbers; internal calling unaffected while PSTN is off (ring, accept, active, hang up); public numbers refused as PSTN; malformed, unknown and ambiguous destinations fail closed; duplicate extensions refused by service and database; identity substitution ignored; guests and foreign credentials refused; unverified accounts refused and uncallable; suspended accounts neither call nor receive; same tenant allowed, other tenant refused identically to an unknown extension, default namespace cannot reach a tenant; suspended organization refused; kill switch semantics.

## Limits that remain
Disconnecting signaling does not guarantee that an established peer-to-peer media connection ends (see `PROVIDER_NEUTRAL_TELECOM.md`). No media server exists here. Still open: A3.4 certificate-based workload identity, A3.5 durable alerts, A3.6 connecting `voice.js`/the Phone page to Shield state, A3.8 migration rehearsal, TURN across independent networks, multi-host, PostgreSQL failover, physical devices, load, security review.
