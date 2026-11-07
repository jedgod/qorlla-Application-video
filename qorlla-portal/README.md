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
