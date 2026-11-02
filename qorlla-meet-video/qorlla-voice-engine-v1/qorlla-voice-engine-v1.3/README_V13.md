# Qorlla Voice Engine v1.3 — Distributed signaling patch

## Scope
This package **extends** the v1.2 reference package. It adds Redis Pub/Sub fanout for WebSocket signals and call notifications across backend replicas, plus readiness checks and tests. It does **not** certify a production VoIP service.

## Setup
- Node.js 20+, PostgreSQL, Redis with TLS and authenticated access in production, HTTPS/WSS reverse proxy, self-hosted coturn.
- Set `REDIS_URL` to a private authenticated Redis URL. Use `rediss://` for encrypted remote connections.
- Keep existing JWT, browser-origin, TURN, and PostgreSQL settings from v1.2.
- Run `npm install`, `npm run db:migrate`, `npm test`, then `npm start`.
- All replicas must use the **same** PostgreSQL and Redis deployment and the same authentication configuration.
- Route `/readyz` only to internal load-balancer health checks. Reject new WebSockets when a replica is unready.

## What is distributed
- Call notifications and signaling messages are fanned out across replicas.
- Device-targeted SDP/ICE goes only to the locally connected socket with matching device ID.
- PostgreSQL is the authoritative source for call status and device lease ownership.
- Redis Pub/Sub has **at-most-once delivery**. This implementation has no durable signaling inbox or message replay. Clients must renegotiate when a signal is lost.

## Important unresolved release blockers
1. Existing v1.2 call state transitions and device lease claims need a repository-level concurrency and security audit.
2. Add an authenticated resume protocol with event sequence numbers, PostgreSQL outbox, durable replay, and explicit resynchronization after reconnect.
3. Add lease-generation fencing and proactive shutdown of superseded media sessions; server signaling authorization alone does not terminate existing peer-to-peer audio.
4. Add graceful node draining and multi-node failover tests. Verify call status under Redis outage, reconnect storms, and worker restarts.
5. Validate real WebRTC audio between devices on distinct networks, TURN relay fallback, browser/hardware support, and ICE restarts.
6. Integrate Meet's actual media and participant model; do not equate SIP, WebRTC, and existing Meet signaling without testing.
7. Implement metrics, rate limits across replicas, audit retention, secret rotation, Redis ACLs, and deployment policy.
8. External PSTN, public numbers, emergency calling, and billing remain separate and disabled.

## Deployment safety
No Twilio account is needed for Qorlla-to-Qorlla internet calling. Do not claim that this reference implementation is production-ready or enable it for paying customers until the above gates are completed and independently certified.
