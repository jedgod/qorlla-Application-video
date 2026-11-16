# Qorlla Meet More V4.1 — PostgreSQL + API integration source

## Status: NOT production-ready / NO-GO

This is an isolated, fail-closed backend foundation, **not** a patch against the actual Meet repository. The real Meet authentication, admission, recording, media, AI gateway, storage, and feature flags are not available here. No demo authentication or fake service success is provided.

### Integration
1. Review existing Meet DB ownership and migration naming; apply `sql/001_more.sql` **only to a disposable database first**.
2. Install dependencies with `npm ci` after creating a reviewed lockfile; run `npm test`.
3. Mount `createMoreRouter` at the Meet-approved API prefix, e.g. `app.use('/api/meet/:occurrenceId/more', createMoreRouter({db, authorize, publish, featureEnabled, services}))`.
4. `authorize(req,{occurrenceId,action})` MUST validate real Meet session token, occurrence membership and role on **every** call and return `{actorId,occurrenceId}`. Never accept identity headers or body actor IDs.
5. `publish` must use Meet's existing durable signaling/replay mechanism; `events` table provides an incremental cursor but no standalone socket gateway.
6. `featureEnabled` must be sourced from actual server flags. Disabled capabilities return HTTP 503, and their UI buttons must stay visible but disabled with a tooltip.
7. Integrate the actual service adapters for whiteboard, breakout rooms, files, transcript, private AI gateway, invites, timer, lock and recording. Missing adapters return 503; they are NOT implemented by this package.

### UI layout contract (existing five tabs stay intact)
- Collaboration list with icons: Reactions, Whiteboard, Breakout rooms, Shared files, Q&A.
- Meeting intelligence 4 compact cards: AI Summary, Live Transcript, Key Takeaways, Ask QorllaMate.
- Meeting management 5 compact cards: Invite People, Meeting Info, Meeting Settings, Roles & Permissions, Attendance.
- Security and recording 3 cards: Recording, Lock Meeting, Security Settings.
- Tools and settings 6 compact cards: Timer, Focus Mode, Layout, Background & Effects, Audio & Video, More Settings.

### Security/operations gates before production
- Verify actual Meet JWT/session authority and meeting occurrence boundaries; test revoked access and host/co-host permissions.
- Rate-limit reactions, Q&A and mutating endpoints; add idempotency keys and cross-process delivery.
- Enforce database grants, retention, data export policies and audit log protection.
- Whiteboard: operation schema validation, limits, concurrent merge, replay and abuse controls.
- Breakouts: atomic assignment, real media routing, move/return, host recall and disconnect recovery.
- Files: quarantine, malware scan, encrypted private object storage and authorized downloads.
- Q&A: moderation, upvote integrity, deletion and privacy policy.
- Transcript: consent, real media/STT pipeline, transcript retention and permissions.
- AI: consent, subscription quotas, gateway-only access, prompt-injection defense and no external provider.
- Recording: Meet media capture, consent, retention, storage and stop-on-revocation.
- Lock: server-side admission enforcement, including guest and rejoin cases.
- Meeting management: authoritative invite, settings, role, attendance and audit integrations.
- Timer: server clock and event synchronization. Device effects/layout are largely client-owned, not SQL-backed operations.
- Run PostgreSQL tests, five-tab browser regressions, load/reconnect tests, Shield/Meet tests and rollout/rollback rehearsals.

**Do not deploy, merge, or replace existing Meet routes using this package without verified repository integration.**
