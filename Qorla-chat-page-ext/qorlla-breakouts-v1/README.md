# Qorlla Meet Breakout Rooms — repository integration candidate

This is NOT production-certified and does NOT implement media switching by itself.

## Integration

1. Review `sql/001_breakouts.sql` against Meet's actual schema and apply only to an isolated disposable PostgreSQL database.
2. Mount `breakoutRouter(service)` under `/api/meet/occurrences/:occurrenceId/breakouts` using Meet's existing HTTP server and real authentication. Do not accept client-supplied actor IDs.
3. Implement `meetAuthority.verifyActor(token, occurrence)` and `listParticipants(occurrence)` against Meet tokens and admission, including Shield revocations.
4. Implement `signalHub.publish(occurrence,event)` using Meet's existing event relay, plus durable replay and per-recipient filtering.
5. Implement `mediaCoordinator.transition(...)` with an ACK-based state machine: revoke old signaling scope, close old RTCPeerConnections, establish room-scoped peers, ICE/TURN negotiation, and confirm successful media. On failure remain disconnected rather than leak main-room media.
6. Route ALL WebRTC signal, chat, reactions, whiteboard, Q&A, screen share, and recording events through server-validated room scopes. The `authorizeSignal` helper is not sufficient without wiring every existing signaling entry point.
7. Host/cohost controls must use a server-verified role. Group leads may be granted explicitly scoped permissions, never automatic host privileges.
8. Implement expiry worker and reliable recall with fencing/revision checks. `closing` remains until all participants acknowledge main-room media rejoin.
9. Define explicit consent for breakout recordings/transcripts and room-level access to historical artifacts.
10. Run real Chromium/Firefox/Safari/mobile tests with 3+ participants, reconnection, concurrent moves, malicious signaling, and TURN relay-only before enabling the button.

## Current coverage

Included: SQL schema, transactional room creation/assignment/start/recall, event/audit persistence, snapshot/replay query, server-side authorization adapter contract, signaling scope helper, and media transition adapter contract.

Not included: Meet-specific integration, browser UI, real WebRTC teardown/rejoin, reliable outbox publisher, timer expiry worker, actual room-scoped messaging/recording enforcement, real media tests. These are blockers, not optional enhancements.

## Validation

`npm run check && npm test` validates syntax and a small adapter contract only. No production GO claim.
