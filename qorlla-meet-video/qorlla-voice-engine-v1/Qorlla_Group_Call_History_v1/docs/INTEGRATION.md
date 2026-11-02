# Qorlla Group Call History v1.0 — Integration contract

**Status:** source implementation / integration candidate. Not production-certified. No changes have been made to GitHub or the shared development stack.

## Intended integration target

Feature branch `feature/qorlla-workplace-v4.6-provider-certification` at user-reported SHA `0b4a5af`. The branch's current voice schema, event payloads, middleware, and Phone UI were not available for inspection in this package-building session. **Do not blindly run the SQL against production.** Inspect the six existing voice migrations and adapt names and event types before merging.

## Install

1. Copy `sql/001_group_call_history.sql` to the project's migration system, and run on a disposable staging database first. Apply with a migration owner role, not the restricted runtime role.
2. Add `src/*.mjs` to the voice backend. Pass the existing authenticated Express middleware and `pg.Pool` into `mountGroupHistory(app,{pool,requireAuth})`. Middleware must populate `req.auth.accountId` from a verified JWT or session; do not take this value from request parameters.
3. Adapt the **committed QVE outbox** to `projectEvent(pool,event)` in a durable worker. Map QVE event names and IDs to `source`, `event_id`, `call_id`, `type`, `occurred_at`, `account_id`, `room_id`, `room_name`, `segment_id`, `actor_account_id`. Use an authenticated internal event source, not a public HTTP projector endpoint. ACK source outbox messages only after `projectEvent` commits.
4. Import `web/GroupCallHistory.mjs` into the existing Phone Recent Calls view. Fetch with the app's verified bearer token. Render group call details; `get(callId)` only returns self-visible event data. Keep group join/re-call actions subject to current membership authorization in the voice engine.
5. Expose `/v1/voice/history` only through the existing authenticated voice proxy. Enforce rate limits and request timeouts in the host server.

## Critical integration decisions

- The schema is a **projection** of committed events. Do not let the browser write history.
- `device_claimed` intentionally does not add another history row. History identity is `(call_id, account_id)`.
- A missed invite is inferred when an invite exists, no join occurred, and the call ended. A late event arriving out of order may temporarily change the classification. For production, replay ordered per-call events from the authoritative outbox and run a reconciliation worker.
- Participation segments require a stable `segment_id` for each join; otherwise the source event id is used. A leave closes open segments; missing leave events need reconciliation at call end.
- Host transfers and kicks are auditable; only the requesting account's detailed events are returned. Never return private participant identifiers or phone numbers without a separate consent/visibility policy.
- This module does not implement voice-room membership authorization for rejoin or redial. Call those actions through existing authorized QVE endpoints.
- Room names are user-controlled content: escape text in UI and do not render as HTML.

## Missing production work

- Confirm exact v1.9 event names, payload schemas, transaction/outbox semantics, migration versioning and auth middleware against `0b4a5af`.
- Add an outbox projector checkpoint, ordered replay, reconciliation for late/out-of-order events and missed invitations; close open segments on terminal call states.
- Add integration tests with real PostgreSQL and engine event fixtures, migration upgrade/rollback drills, concurrent writers, replay, account isolation, pagination and all requested status variants.
- Add metrics/alerts for projector lag, poison messages and reconciliation drift; enforce retention and privacy deletion policies.
- No QVE release gate is approved by this module; QVE-15 remains blocked.
