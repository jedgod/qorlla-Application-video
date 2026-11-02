# Integration into Qorlla at 0b4a5af

1. Add SQL migration as `qorlla-voice-engine/sql/007_room_history_audit.sql` after existing 006. Run using the existing controlled migration runner. Take a database backup first; this migration does not recreate missing historical transitions.
2. Add `src/history.mjs` to `qorlla-voice-engine/src/history.mjs`; in `src/app.mjs`, import `mountRoomHistory` and call `mountRoomHistory(app, db, auth)` inside `createVoiceApp` after `auth` is defined, before the returned app is served. Authenticated account comes from existing `auth` middleware.
3. In room state-changing transactions, optionally call `SELECT set_config('qorlla.voice_actor',$1,true)` with the authenticated actor account before changes. Do not set a global/session-level actor: connection pooling can leak it. This enables attributable host transfer, kick, and invitation audit. If omitted, actor_id is null (not invented).
4. Existing room create/join/leave/end/kick/invite/transfer and lease-expiry mutations are observed by AFTER triggers, in the same DB transaction. Device claim is recorded as `device_claimed` without creating a new segment. Room state notifications and outbox behavior remain unchanged.
5. Update Recent Calls UI to consume `GET /v1/voice/history/rooms?limit=30&before=<nextCursor>` and `GET /v1/voice/history/rooms/:id`. Render only account-specific participation segments and audit events. A group-call history row is not a telephony call; keep the provider call history separate.
6. Before production: run PostgreSQL-backed integration tests for repeated invite/join/leave, kick, host transfer, takeover, simultaneous updates, rollback, authorization, and migration privileges. Verify DB role cannot UPDATE/DELETE/TRUNCATE audit or segments (including inherited/PUBLIC/default privileges). For strict immutability, use a separate SECURITY DEFINER writer role and deny direct writes to the runtime role; current trigger ownership does not alone enforce tamper-proof audit.
7. Release stays BLOCKED. No push, restart, or migration has been performed by this package.

## Known limits
- Existing room schema has one row per account per room, so invite/join status history before this migration cannot be reconstructed. The bootstrap of currently joined members is a snapshot and may not reflect original join cycles.
- `actor_id` requires the transaction-local actor setting for reliable attribution. Without it, the event still records the change, but not who initiated it.
- Account-scoped audit returns only room-level events and the requesting member's events, intentionally not the private event history of other members. Group roster disclosure should follow an explicit authorization policy.
- Audit is operationally durable but not tamper-proof against a database owner or superuser.
