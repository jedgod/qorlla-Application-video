# Qorlla Voice Engine v1.9 — release certification

All gates require reproducible evidence with operator, timestamp, environment, build SHA and logs. A local unit-test result cannot substitute for staging certification.

| ID | Required demonstration |
|---|---|
| QVE-01 | PostgreSQL transactions atomically commit call state and outbox rows |
| QVE-02 | Redis down during call creation: event retained, later delivered |
| QVE-03 | Crash after publish before outbox acknowledgment: replay/dedupe correct |
| QVE-04 | Two voice nodes: cross-node call, answer, ICE exchange |
| QVE-05 | Server restart: missed events replay, state converges |
| QVE-06 | Device takeover: stale lease cannot signal or continue media |
| QVE-07 | Concurrent calls and idempotency under load |
| QVE-08 | Browser permission, hangup, ICE restart and TURN relay |
| QVE-09 | Two physical devices on different networks with real audio |
| QVE-10 | Redis/Postgres failure, recovery, backpressure, restart |
| QVE-11 | AuthZ, WebSocket ticket replay, rate limits, abuse tests |
| QVE-12 | Metrics, alerts, on-call and rollback drill |
| QVE-13 | Accessibility and browser compatibility matrix |
| QVE-14 | Privacy, retention, deletion, logs, secret handling review |
| QVE-15 | Qorlla Meet integration: meeting occurrence, host admission, attendance |

## Known blockers

- The supplied browser SDK must be updated for generation-fenced SDP/ICE and resume cursors.
- Device takeover must explicitly stop the old media track; signaling rejection alone is insufficient.
- Redis Pub/Sub still does not guarantee delivery; durable replay covers call-control events, not all ephemeral SDP/ICE.
- Outbox worker should be separately deployed and operated under least-privilege credentials.
- This package has no actual multi-node, PostgreSQL, Redis, browser, or physical-device certification evidence.
- The release-gate script validates evidence shape, not authenticity or technical success.

**Default release decision: BLOCKED.**
