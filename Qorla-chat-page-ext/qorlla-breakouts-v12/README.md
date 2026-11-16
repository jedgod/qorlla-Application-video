# Qorlla Breakouts V1.2 — hardening candidate, NOT production certified

Source-compatible extension to the supplied V1.0 and V1.1 packages. **Not integrated into Qorlla Meet's actual repository.** The user-provided package has no real Meet server/index.js or browser media source.

## Included
- `003_hardening.sql`: move epochs, lead grants, media reporting, durable outbox.
- `src/hardening.mjs`: serialized room moves; explicit untrusted client-media report; lead permissions; lease-based outbox delivery.
- Unit tests; consolidated earlier V1.0 and V1.1 packages are in `prior/`.

## Crucial media semantics
Peer-to-peer WebRTC has no trusted server-side media-ready signal. A client report is **not** proof of successful media isolation. The server must authorize every signaling recipient by current room and epoch. Client must close old peer connections before establishing new ones; enforce fresh room/epoch on offers, answers and ICE candidates; reject stale messages. A failed or disconnected transition must remain visibly pending and deny stale-room signaling. Host/participant UI may display 'Client reports connected', never 'Server verified'. Do not promise perfect enforcement against malicious clients in full-mesh P2P; consider relay-only controlled TURN or SFU if server-enforced isolation is required.

## Required repository-specific integration
1. Map migration to actual Meet schema and execute on disposable PostgreSQL first. The supplied earlier SQL has `sessions`, `rooms`, `assignments`; this migration assumes them.
2. Replace all prior direct assignment changes with `move()` or equivalent transaction using the same meeting lock and epoch. Host recall, room close, guest return and guest-to-guest moves must share this path. Ensure role/grants are revoked on moves.
3. Wire Meet's own verified tokens, signaling and real browser media coordinator. Do not trust a browser-reported role, participant ID or room ID.
4. Filter Notes, Polls, chat, reactions, Q&A and whiteboard HTTP reads/writes, exports and subscriptions by authorized room. Scope event replay too.
5. Wire lead grants to real Notes/Polls/announcements/help permissions. Never give leads host-level meeting controls.
6. `drainOutbox` needs a shared message bus (e.g. Redis) and idempotent subscribers for multiple servers. PostgreSQL outbox alone does not synchronize local peer maps or websockets. Fence worker lease renewals for slow deliveries and reconcile replay on reconnect.
7. Implement UI: room list, guest-to-guest move for host, lead grants, return-to-main, help queue and status. Add client WebRTC peer teardown/rebuild with stale-epoch checks.
8. Run real multi-browser media tests, TURN relay-only, Safari, Android/iOS, server failover, load, security review and full five-tab regressions.

## Important limitations
The included code is not a drop-in patch; it does not provide client media coordinator, server signal interception, reliable lease fencing for slow consumers, or actual multi-server event routing. Lead grants require cleanup on reassignment. These are mandatory before production.
