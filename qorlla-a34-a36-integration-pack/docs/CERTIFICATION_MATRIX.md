# A3.4–A3.6 certification evidence matrix (NOT YET EXECUTED)
Every row requires tester, timestamp, commit SHA, environment, logs, packet captures where safe, and PASS/FAIL evidence.

| Gate | Procedure | Pass condition | Current |
|---|---|---|---|
| Workload mTLS | trusted CA, wrong CA, missing cert, expired cert, rotated cert; certificate-bound signed JWT | only trusted identity and matching token allowed | NOT RUN |
| Identity/tenant | cross-tenant extension, guest, unverified, suspended, forged caller | all forbidden; audited | NOT RUN |
| Group rooms | room from tenant A used by tenant B; disabled room; membership denial | no disclosure or join; kill event durable | NOT RUN |
| TURN | two physical devices on different carrier/Wi-Fi NATs; relay-only ICE candidates; packet inspection | relay selected, no direct candidate path | NOT RUN |
| Media revocation | suspend while media flows; test both clients and force-kill relay allocation | RTP stops within defined SLO, independently verified | NOT RUN |
| Multi-host | 2+ signaling nodes, distinct clients on each, kill node, duplicate events, Redis outage | consistent state, no unauthorized joins, recoverable delivery | NOT RUN |
| PostgreSQL failover | primary restart and promoted standby during invite, accept, suspend, outbox dispatch | no false success; no lost committed suspension; retries idempotent | NOT RUN |
| Physical devices | Android+iOS and desktop, background/reconnect, NAT changes, permissions, sleep/wake | stable calls and reliable revocation | NOT RUN |
| Load | concurrent calls/rooms, latency, backpressure, outbox lag, exhaustion | meet preapproved SLOs | NOT RUN |
| Penetration review | fuzz endpoints, CSRF where applicable, auth bypass, token replay, JWT/cert mismatch | zero critical/high findings | NOT RUN |

**All 15 existing RC2 gates remain BLOCKED**. This is an additional matrix, not a replacement for the repository's release matrix.
