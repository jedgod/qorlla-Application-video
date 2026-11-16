# Qorlla SmartRooms V1.3 — advanced integration candidate

This package adds a **Room Mission Board**, group task assignments, optimistic task versioning, room progress, teacher/group-lead submissions, host dashboard, and balanced assignment planning to V1.2. It does **not** replace or alter the Meet app by itself.

## Source and compatibility

Read the included `prior/qorlla-breakouts-v12-hardening.zip`. SQL 004 assumes migrations 001–003 and the exact `meet_breakouts` schema, including `rooms(occurrence_id,id)`, `room_lead_grants`, `outbox`, `assignments`, `sessions`, and `help_requests`. Review against the actual Meet schema before applying.

## Integration

- Use Meet's verified participant token and occurrence membership authority as `verifyActor`; fail closed on outage.
- Wire the service into existing Meet routes; enforce CSRF/origin protections for cookie-authenticated operations and token restrictions for bearer auth.
- Route `room:*` outbox events only to currently authorized room participants. Deliver through the existing V1.2 outbox worker with idempotency and event replay.
- Build the Room Mission Board and Host Command Center in the existing More tab; do not disturb Chat, People, Notes, or Polls.
- For group assignment, `balancedGroups` is only a deterministic planning helper; apply the actual moves through the V1.2 authorized move/epoch service, never by updating assignments directly.
- QorllaMate private AI is deliberately NOT implemented here; integrate the approved Portal AI gateway via authenticated server-to-server bridge, consent and entitlements.
- Media reconnection, room isolation, recording permissions and true TURN/Safari/mobile support remain V1.2 certification blockers.

## Validation

Run `node --test tests/*.test.mjs` and `node --check src/smartrooms.mjs`.

## Release status

**NO-GO**: unit tests are not PostgreSQL integration tests. No real Meet repository, media, browser or multi-server tests have been performed. The SQL and code are not deployed.
