# Qorlla A4.9 repository integration patch (NO-GO)

Target: https://github.com/jedgod/qorlla-Application-video
Inspected default branch: `main` @ `810e196349e00bd68befcf4b43ccdb3df80a3ae3` on 2026-11-07.

**Important: newer A5 branch already exists.** `feature/qorlla-meet-telephone-admission-meet`
contains `server/phone-peer.mjs`, `server/phone-lifecycle.mjs`, `server/phone-gateway-auth.mjs`
and `sql/v4_25_phone_verification_peer.sql`. Those are closer to the real A4
path and must remain authoritative. The installer refuses the A5 branch rather
than creating duplicate telephone participants or state machines. Read
`docs/A5_RECONCILIATION.md` first.

This patch adds a **separately gated** internal telephone-control integration to the existing
`qorlla-portal` and `qorlla-meet-video`. It **does not implement SIP/RTP**, replace the
current voice engine, deploy a carrier, enable public calling, or turn an HTTP acknowledgment
into media connectivity. It does not modify the existing Twilio-era `phone.mjs`.

## Files

- `qorlla-portal/sql/008_a49_voice.sql`: new Portal tables under `portal` schema, including
  principal, calls, nonces, events, outbox, Meet commands, carrier CDR, ratings, and gates.
- `qorlla-meet-video/sql/009_a49_meet_commands.sql`: waiting room and command receipts
  in the separate Meet database.
- `qorlla-portal/server/telephony/a49/`: ingress, authenticated event state changes,
  call-initiation API, Shield policy, host approval sync, carrier-neutral CDR ingestion,
  outbox worker and disabled A4 interface.
- `qorlla-meet-video/server/a49-integration.mjs`: host-authorized admission decisions,
  authenticated command receipts, and a strictly required media executor hook.
- `scripts/apply.mjs`: dry-run by default, validates known app/Meet anchors and refuses
  changed targets; `--apply` is the only opt-in writing mode.
- `qorlla-portal/tests/a49-*.test.mjs`: node:test checks. The transactional tests use
  a scripted DB double; **not** PostgreSQL integration tests.

## Safety / release

All these variables default OFF; none should be enabled in production from this patch:

```
A49_INTERNAL_CALLS_ENABLED=false
A49_EVENT_INGRESS_ENABLED=false
A49_MEET_CONTROLS_ENABLED=false
A49_OUTBOX_WORKER_ENABLED=false
A49_A4_ENABLED=false
A49_CARRIER_CDR_ENABLED=false
A49_EXTERNAL_CALLS_ENABLED=false
TELEPHONY_ENABLED=false
```

Database release gates `portal.a49_gates` also default disabled. No route originates PSTN.
These flags, the DB gates and Shield are independent checks; none of them represents
certification. `A49_CARRIER_CDR_ENABLED` ingests signed accounting records only.

## Apply to local repository (NOT an automatic GitHub change)

From **inside the unpacked patch**:

```bash
node scripts/apply.mjs --repo /path/to/qorlla-Application-video
node scripts/apply.mjs --repo /path/to/qorlla-Application-video --apply
```

The script checks only the two tracked target code files and refuses to replace a
non-identical destination patch file. It does not run database migrations. Review the
diff, keep the existing `auth.js`, `workplace.js`, or other uncommitted changes untouched,
and do not merge before full testing.

## Migration order — two independent databases

After backup, review and test against **a disposable PostgreSQL 16 database** with the
existing Qorlla migrations already applied. DO NOT apply Portal SQL to Meet's DB.

```
# after existing qorlla-portal/sql/001..007 on PORTAL_DB_URL:
psql "$PORTAL_DB_URL" -v ON_ERROR_STOP=1 -f qorlla-portal/sql/008_a49_voice.sql

# after existing Meet schema/recovery migrations on MEET_DB_URL:
psql "$MEET_DB_URL" -v ON_ERROR_STOP=1 -f qorlla-meet-video/sql/009_a49_meet_commands.sql
```

Migration paths deliberately avoid existing `portal.call_sessions`,
`portal.telephony_events`, meeting `participants`, and existing billing tables. Schema
objects are not automatically rolled back; reverting application code leaves them inert.

## Initial local tests

```
node --test qorlla-portal/tests/a49-*.test.mjs
node --check qorlla-meet-video/server/a49-integration.mjs
node --check qorlla-portal/server/telephony/a49/worker-main.mjs
```

To start the worker, a *separate* service with `pg` and PostgreSQL network access is needed.
The worker is disabled unless explicitly enabled and cannot originate anything without a
real A4 HTTPS adapter. It polls Meet's authoritative host decisions and re-checks Shield.

## API contracts (all disabled by default)

- `POST /api/v1/a49/internal/calls` — authenticated Portal member, `Idempotency-Key` UUID;
  `{ "destinationUserId": "<workspace-member UUID>", "meetingId": "<Meet UUID or null>" }`.
  Response is only `202 accepted`, **not connected**. Portal and Shield authorize it.
- `POST /api/v1/a49/gateway/events` — signed raw JSON, gateway ID, timestamp ms, nonce,
  HMAC-SHA256 over `POST\\n/api/v1/a49/gateway/events\\n<timestamp>.<nonce>.<raw bytes>`;
  event must match pre-bound `(callId,gatewayId,gatewaySessionId,meetingId)`.
- `POST /api/integrations/a49/waiting` — Meet dedicated service auth; persisted waiting room.
- `POST /api/meetings/:id/telephone/:callId/decision` — existing Meet host JWT + membership;
  decision `approved` or `denied`.
- `GET /api/integrations/a49/decisions/:callId` — Meet service-authenticated decision read.
- `POST /api/integrations/a49/commands` — Meet service-authenticated idempotent command;
  **fails 503 without real media-peer executor**.
- `POST /api/v1/a49/carrier/cdr` — signed CDR only; no public dialing.

## Missing deployment dependencies — critical blockers

1. The real A4 gateway must implement an authenticated idempotent `/internal/v1/calls/originate`
   contract, bind to the issued session, enforce Shield, and report verified SRTP/WebRTC audio.
2. Meet needs the **real server-controlled A4 WebRTC media-peer executor**, including host
   mute/removal/end, authoritative media termination, ICE restart, reconnect and revoke.
3. The control-plane Shield policy endpoint and gateway principal secret-management process
   must be implemented in the running stack; a static HMAC secret is not a substitute for mTLS.
4. Portal needs UI subscriptions to durable state events; `call.*` outbox events are persisted
   but not yet published to a certified event bus.
5. The wholesale carrier/SBC integration, numbering, emergency calling, fraud, tariffs,
   rated double-entry billing, CDR settlement, and regulatory certification are not implemented.
6. Real PostgreSQL 16 migrations/tests, Playwright Meet integration, physical devices,
   cross-network TURN, failover, load, penetration, privacy, operations and monitoring remain.
7. Gate activation requires an independent signed-off change; no code here should enable it.

**Verdict: NO-GO** for live calling and production deployment.
