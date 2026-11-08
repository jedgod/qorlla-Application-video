# Qorlla Portal v4.1 Shared Auth

This package extends the v4 portal with a **MAIN-signed JWT verification adapter**, workspace membership authorization, and CSRF checks. Read [INTEGRATION.md](INTEGRATION.md) before deployment. The MAIN-side token issuer is not included because its source and identity schema were not supplied.

Run `npm install`, `npm run check`, `npm test`. Configure `.env` and PostgreSQL per `sql/001_portal.sql`. No development identity fallback exists.

## A4.9 accounting foundation (not enabled)

`sql/012_a49_accounting.sql` and `server/telephony/a49-accounting.mjs` provide an isolated A5 Meet call reference, ratings, carrier CDR idempotency, and reconciliation. Meet remains authoritative for admission, media, and call state; CDRs do not connect calls. The accounting module is not mounted or deployed, has no carrier or billing-ledger implementation, and requires independently authenticated Meet, carrier, and rating authorizers. The carrier authorizer must verify the signed raw CDR and the carrier's authority over the identified Meet call, not just the carrier ID. Do not treat it as certified or enable calling based on these files.

The migration is not automatically applied to existing databases. Test it only on a disposable database first. For the focused PostgreSQL test, set `A49_TEST_DATABASE_URL` to a dedicated empty database and run `node --test tests/a49-accounting.test.mjs`; the test creates schemas and tables and does not clean them up. All internal, external, PSTN, and number-provisioning release gates remain off pending integration and certification.

## A4.10 staging foundations (NO-GO)

After migration `012`, `013_a410_accounting_outbox.sql` adds an accounting-only outbox. New ratings and CDRs require this migration and enqueue notifications in the same transaction. The outbox library implements leases, fencing, retries, and dead letters; no delivery service is configured or started. Delivery is at least once, so a receiver must deduplicate `eventKey`.

The A4.11 worker library (`server/telephony/a411-worker.mjs`) polls with bounded concurrent deliveries, reports poll failures and supports a bounded drain on stop; a drain timeout is reported as an error and does not cancel in-flight delivery. Retry delays use exponential backoff with jitter. Explicit `PermanentDeliveryError` failures are dead-lettered immediately; `diagnostics()` exposes aggregate queue counts without providing an HTTP endpoint. It is not started by Portal and has no configured consumer; it is not an operational integration. A delivery must have a bounded timeout shorter than the lease, and the consumer must deduplicate the stable event key even after a timeout or crash.

`014_a410_simulated_billing.sql` and `a410-simulated-billing.mjs` add isolated, immutable simulated tariffs and balanced simulated journals. The simulation requires explicit non-production enablement and injected authorization and verified-duration callbacks. Durations round up to seconds; the staging formula rounds fractional minor-unit usage up, adds the connection fee and applies the minimum. Tax, refunds, adjustments, carrier payables, approved production tariffs and a real financial ledger are **not implemented**. These tables do not post actual charges. Meet/Shield authentication, carrier adapters, internal APIs and end-to-end event delivery remain unwired.

Migrations `012` through `014` are not applied automatically and require migration review before use on an existing database. The test command above applies all three to a disposable database. Do not enable calling, number provisioning, or billing based on these foundations.

## A4.11 validation status (NO-GO)

The Portal accounting module is still not wired to Meet, Shield or the gateway. There is no authenticated Portal event endpoint, authoritative event exporter, simulated carrier delivery consumer, or operational worker startup. Direct TLS client-certificate verification and trusted call-to-workspace and gateway-session binding must be designed and tested before exposing those paths. Review the broad default Portal database grants before granting any service access to accounting tables.

The existing Meet–Shield contract suite was exercised with a separate Meet process, the real Shield application, a test-double phone provider, and disposable PostgreSQL. It passed 17 of 18 tests; the connected-call outage test failed its outage-counter assertion, then passed when retried alone on a fresh database. The intermittent failure remains unresolved. The harness used non-mTLS transport for normal requests and did not exercise the Portal integration or an A4 gateway. Full mTLS, live gateway integration, PostgreSQL interruption, and Portal end-to-end certification remain outstanding. Keep all calling, number provisioning and live billing release flags disabled.

## A4.12 work in progress (NO-GO)

Meet now creates the phone participant, call and initial `REQUESTED` history event in one transaction. This closes an event-history gap but is not an exporter. The outage contract assertion waits for cleanup and counter updates rather than assuming they are synchronous with the state transition; the suite must still pass repeated runs before the intermittent failure is considered resolved.

The existing scheduling directory maps a Meet meeting to its owner, not to an authoritative Portal workspace. Meet's verification-peer credentials are short-lived and can be superseded, so they do not by themselves define a persistent gateway session for the entire call. Neither mapping may be inferred from caller-supplied event data. A trusted provisioning/lookup contract is required before event ingestion or simulated rating can be safely enabled.

Migration `015_a412_workspace_bindings.sql` and `a412-workspace-bindings.mjs` add an unmounted provisioning foundation with immutable meeting ownership, active/suspended/revoked statuses, transactional audit and request idempotency. The module requires injected workspace authorization and authoritative meeting verification; neither adapter nor service authentication is implemented yet. It does not enforce bindings on any existing accounting path. The default `qorlla_portal_app` role is explicitly denied write access if present; a separately reviewed provisioning role and least-privilege grants are needed. Do not apply migration `015` to an existing database without review.

## A4.13 work in progress (NO-GO)

Meet migration `v4_26_phone_event_outbox.sql` captures immutable lifecycle snapshots transactionally when new `phone_call_events` are inserted. It creates no delivery worker, gateway-session binding, workspace mapping, or Portal ingestion endpoint. Existing history is not backfilled: a call already in progress when the migration is applied can have a first captured version greater than one, and must not be treated as a complete stream. Snapshots survive deletion of their source call and require a reviewed retention policy. The role script denies direct application writes to the snapshots; the capture trigger writes as the migration owner. Review migration, ownership, schema privileges and retention before applying it anywhere.

## A4.14 work in progress (NO-GO)

Meet migration `v4_27_phone_event_delivery.sql` attaches mutable delivery metadata to the v4.26 snapshots and backfills metadata for existing snapshots. `phone-event-delivery.mjs` provides per-call ordered, exclusive leases, fencing, bounded retry with jitter, dead-letter blocking and queue diagnostics. Missing lifecycle versions or an undelivered earlier event block later events for that call. The delivery adapter requires an exact event-ID acknowledgment of `accepted` or `duplicate`; only an independently authenticated receiver that commits before acknowledging may be supplied. Delivery is at least once, so the receiver must deduplicate event IDs. A delivery call must time out before its lease expires.

This library is **not wired to service startup**, and no authenticated transport or Portal receiver is configured. The ordinary Meet application role has no write access to delivery metadata; a separately reviewed delivery role is required. Review migration ownership, role grants, retention and recovery of blocked or dead-lettered streams before use. Workspace provisioning, durable gateway-session authority, and end-to-end Portal ingestion remain incomplete. The tests use an injected receiver, not evidence of service-to-service delivery. Do not apply migration v4.27 to an existing database without review.

## A4.15 trigger work (NO-GO)

Meet migration `v4_28_phone_event_batches.sql` replaces the v4.26 row trigger with a statement trigger. It locks calls in a consistent order, records batches in source-event ID order, checks transitions against the Meet lifecycle, and preserves version gaps for incomplete histories. Calls that existed without history when the migration ran receive an immutable state baseline; their first captured event starts at version 2 and remains blocked by delivery's missing-version rule. The Meet role script denies access to that baseline. The SQL transition rules must be kept in sync with `phone-lifecycle.mjs`; the PostgreSQL batch test checks every pair of states against the application rules.

The migration takes write-conflicting locks while establishing baselines and is not automatically applied. Review its locking, ownership and legacy-history handling before applying it anywhere. It validates transition structure, not the media evidence or caller identity, and does not change Meet's existing media-verification requirements.

The Portal receiver, authenticated exporter, workspace provisioning endpoint, gateway-session authority and worker integration are still missing. No Meet-to-Portal delivery, mTLS bridge, database-restart recovery or end-to-end financial-effect certification has been demonstrated. This remains a **NO-GO**.

## A4.16 runtime gate audit

These are source-code defaults and enforcement points, not observations of deployed configuration. No runtime setting was changed in this audit.

| Surface | Actual control | Default and enforcement |
| --- | --- | --- |
| MAIN voice access | `QORLLA_VOICE_ENABLED` and `VOICE_ADMIN_SECRET` | Off unless the flag is true and the secret is at least 32 characters. [`voice.js`](../voice.js) gates voice configuration, token issuance and directory access. |
| Voice engine internal calls | `VOICE_INTERNAL_CALLS_ENABLED` | **On unless exactly `false`**. [`app.mjs`](../qorlla-voice-engine/src/app.mjs) gates call initiation and joining; ending calls remains available. The MAIN gate and engine gate are independent. |
| Voice engine and Meet number/PSTN APIs | `VOICE_NUMBERS_ENABLED`, `VOICE_PSTN_ENABLED` | Each is off unless exactly `true`. Enforced by the [voice engine](../qorlla-voice-engine/src/app.mjs) and [Meet telephony routes](../qorlla-meet-video/server/telephony/routes.mjs). These switches alone do not provide carrier routing or certification. |
| Meet gateway admission | `PHONE_GATEWAY_ENABLED` plus gateway keys, subject scopes, readiness, Shield and media verification | Gateway admission is off unless exactly `true`; see [`phone.mjs`](../qorlla-meet-video/server/phone.mjs) and [`phone-gateway-auth.mjs`](../qorlla-meet-video/server/phone-gateway-auth.mjs). `PHONE_PROVIDER=test` selects a test double, not a carrier. |
| Portal's separate Twilio phone features | `TELEPHONY_ENABLED`, provider configuration and `TELEPHONY_COMPLIANCE_ACK` | Off unless enabled and required credentials, origin and compliance acknowledgment are configured; enforced in [`phone.mjs`](server/phone.mjs). This is separate from the A5 event bridge. |
| Portal payment provider | `BILLING_ENABLED`, Stripe credentials, `BILLING_LIVE_AUTHORIZED` | Off unless enabled and credentials exist. Live keys also require the explicit authorization phrase; see [`config.mjs`](server/config.mjs). PostgreSQL-backed checkout, plan-change and overage switches are separate; missing switch rows default on in [`flags.mjs`](server/flags.mjs). |
| Shield | `SHIELD_ENABLED`, `SHIELD_ENFORCE`, `SHIELD_REQUIRE_MTLS`, `SHIELD_MEET_ENFORCE` | These are independent controls and default off unless exactly `true`. Meet gateway mode requires Shield even without `SHIELD_MEET_ENFORCE`. Shield's optional dedicated mTLS listener is configured in [`server.mjs`](../qorlla-voice-engine/src/server.mjs). |

`INTERNAL_CALLS_ENABLED`, `EXTERNAL_CALLS_ENABLED` and `BILLING_LIVE` are not shown to be authoritative controls for these inspected services. In particular, do not equate an unset `VOICE_INTERNAL_CALLS_ENABLED` with disabled internal calling. Confirm actual deployment configuration, network exposure and each separate gate before a release. Chargeable calling also needs an approved billing mechanism.

Portal uses MAIN session JWTs, optional/production-required session introspection, CSRF checks and database workspace membership in [`auth.mjs`](server/auth.mjs). Meet gateway authentication verifies scoped workload JWTs, body hashes, replay records and optionally socket-bound mTLS; Shield has its own workload and mTLS enforcement. These are not an authenticated Meet-to-Portal receiver. The existing Meet read-only integration uses a separate shared secret and returns meeting content; it is not an explicit workspace-ownership authority.

Migration dependencies: Meet v4.26 captures immutable events; v4.27 adds delivery metadata and backfills existing snapshots; v4.28 replaces capture and establishes incomplete legacy baselines. Portal 012 creates accounting references, 013 accounting notifications, 014 simulated journals and 015 explicit meeting bindings. None mounts the bridge. Portal's role bootstrap broadly grants writes but now re-applies migration 015's binding-table restrictions when rerun after the migration; existing installations still require a separately reviewed role update. Portal's workspace table does not itself contain a suspension state, so an authoritative workspace-suspension source is also required rather than assuming one exists.

The full Meet lifecycle suite was rerun on disposable PostgreSQL after the v4.28 fixture changes: 41 of 42 tests passed. The host-decision long-poll test expected `pending` but received `timed_out`; it remains an unresolved certification failure. The separate Meet gateway mTLS test passed, but does not test Portal bridge mTLS.

Shield maintains its own organization, principal and meeting suspension records, but this audit did not establish an authoritative mapping from those organizations to Portal workspaces. Do not equate the identifiers or use membership in a workspace as proof that an arbitrary existing meeting belongs to it. The selected direction is to extend the A4.12 Portal binding foundation with explicit, authenticated ownership provisioning and workspace suspension, reusing existing membership and Shield authority where a trusted mapping exists; that integration has not yet been implemented.
