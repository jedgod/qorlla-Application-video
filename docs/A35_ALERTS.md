# A3.5 durable security alerts, and mTLS in the real processes

**Status: implemented and tested against the real engine, the real Meet and the real main app over real mutual TLS on PostgreSQL. Not production certified. Public numbers and PSTN stay disabled; release BLOCKED.** Branch `feature/number-authority-a3`.

## Architecture: alerts are DERIVED, not a second event authority
The evidence stays in the existing append-only `shield_events` (UPDATE/DELETE/TRUNCATE refused). A trigger on `INSERT` classifies an event and maintains the **operational view** `shield_alerts` in the SAME transaction (nothing can be recorded without being alerted, or alerted without being recorded). Notifications use a transactional outbox (`shield_alert_outbox`), delivered at least once with backoff, like the engine's other outboxes. Events can carry a `context` (workload, tenant, ip, discriminator); never tokens, keys or passcodes (tested).

| Alert kind | Raised when | Severity |
|---|---|---|
| `certificate_failure` | the mTLS listener refuses a handshake (no / untrusted / expired certificate) | medium (recorded at most once per address+error per minute; the rest only counted: `qorlla_shield_tls_refusals_dropped_total`) |
| `workload_token_binding_failure` | token not bound to the presented certificate, no binding when mTLS is required, certificate missing | high |
| `revoked_certificate_attempt` | a revoked certificate is presented (discriminator = its thumbprint) | **critical** |
| `workload_replay_rejected` | a workload token's `jti` is reused | high |
| `unauthorized_suspension_attempt` / `unauthorized_certificate_revocation` | a workload without `shield.suspend` / `shield.cert.revoke` tries it | **critical** |
| `workload_not_authorized` | any other scope violation | high |
| `cross_tenant_attempt` | a call/room/meeting/org check refuses another tenant (recorded OUTSIDE the transaction the refusal rolls back; the caller is only told "no such recipient") | high |
| `signaling_termination_failure` | suspension committed but the voice identity could not be disabled; Meet could not terminate a session | **critical** |
| `outbox_delivery_failure` | the engine's monitor sees dead events or lag; Numbers & Plans reports five failing delivery cycles in a row | high |

**Fields per alert:** severity, last event id and first event id, context (workload, account, tenant, ip, detail), occurrence count, first/last time, acknowledgement state (`open`/`acknowledged`/`resolved`, who, when, note, reopen count), escalation (`none`/`pending`/`escalated`, when).
**Deduplication without suppression:** one ACTIVE alert per key (kind + workload/account/ip + tenant + discriminator), so repeats are counted (not re-announced) but different workloads, tenants, tenant pairs, certificates or sources are always separate incidents. An acknowledged alert that **recurs is reopened and announced again**; a resolved one starts a **new** alert. Count thresholds raise severity (>= 10 -> high, >= 50 -> critical) and announce it once. 50 events produced 2 notifications, not 50.
**Escalation:** an unacknowledged high/critical alert is escalated after `SHIELD_ALERT_ESCALATE_CRITICAL_SECONDS` (default 900) / `..._HIGH_SECONDS` (3600) and a notification is queued; acknowledged alerts are not escalated.
**Delivery:** `SHIELD_ALERT_WEBHOOK_URL` (+ `SHIELD_ALERT_WEBHOOK_SECRET`: `x-qorlla-signature: sha256=HMAC(timestamp.body)`); retried with backoff; receivers de-duplicate by `notificationId`. **API** (own scopes, certificate-bound): `GET /v1/shield/alerts` (`alerts.read`), `POST .../:id/ack|resolve` (`alerts.ack`), `POST /v1/shield/report` (`alerts.report`, known kinds only). Prometheus: `qorlla_shield_alerts_active{severity}`, `..._escalated`, `..._notification_*`.

## mTLS in the real processes (`test/mtls-processes.pg.test.mjs`, 3 tests, 3 consecutive passes)
Real Meet and main-app processes, engine reachable ONLY over mutual TLS (`SHIELD_REQUIRE_MTLS=true`): account registration from the main app, Meet's per-session authorization, suspension reaching an open Meet session, no certificate alerts when healthy.
- **Rotation: no restart needed.** Meet and the main app re-read `SHIELD_CLIENT_CERT/KEY` and `SHIELD_CA` when the files change (at most every `SHIELD_CERT_RELOAD_SECONDS`, default 5). New requests use a new agent and tokens bound to the NEW certificate; requests in flight finish on the old one. Tested live: after replacing Meet's files the OLD certificate was revoked with no outage. A mismatched or corrupt drop is rejected at load (`tls.createSecureContext` validates the pair) and the last good credentials stay in use (a real gap: `https.Agent` would only have failed at the first handshake). Caveat: a request that signs its token just before a rotation lands may be refused once (retried by the callers' outboxes).
- **Revocation vs established connections.** Authorization is decided **per request** (certificate thumbprint looked up in `shield_revoked_certs` every time), so a connection that is already open gains nothing: the same reused TLS socket was refused after revocation (engine test) and the revoked processes were refused on their very next call. The engine never caches an authorization. This does not close the TLS connection itself (it carries no further authority); a CRL given to the listener only affects new handshakes.
- **Failure behaviour:** with its certificate revoked Meet issues no new sessions (fail closed) and the main app cannot register accounts; both raise a critical alert naming the certificate and recover by rotation, the main app catching up through its retry and periodic reconcile.

## Verified (engine suite and these suites)
`test/alerts.pg.test.mjs` (4 tests, 3 passes), `test/mtls.pg.test.mjs` (5 tests, 3 passes), `test/mtls-processes.pg.test.mjs` (3 tests, 3 passes), plus the earlier suites.

## NOT done (release stays BLOCKED)
- **No production PKI**: no CA, issuance automation, CRL/OCSP distribution, hardware-backed keys; revocation is by thumbprint in the Shield's database. The engine's mTLS listener, Meet and the main app were tested on one machine.
- **Alert delivery is to a webhook only**: no pager/on-call integration, no routing rules, no retention policy for `shield_events`, no alert for the absence of events (a dead monitor). The engine's alert worker runs per replica (the claim is `SKIP LOCKED`, so replicas do not double-send, but multi-host behaviour is untested).
- Cross-tenant alerts cover calls, rooms, meeting signaling and org checks; other paths that refuse tenants are not all instrumented. TLS-handshake alerts are rate limited, so a sustained flood is counted, not recorded one by one.
- **Media**: relay-only is not a media kill switch; an SFU or relay with allocation control is still required if immediate server-enforced termination is a release requirement.
- Still open: `voice.js`/Phone page wiring (A3.6), TURN across independent networks, multi-host, PostgreSQL failover, physical devices, load, penetration review. All 15 release gates remain pending.
