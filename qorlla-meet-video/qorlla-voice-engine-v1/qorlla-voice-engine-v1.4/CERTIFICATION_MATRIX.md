# Distributed reliability certification evidence matrix

| Gate | Scenario | Passing evidence |
|---|---|---|
| DR01 | Kill transaction before COMMIT; retry | Neither event nor call state commits partially; exactly one logical transition |
| DR02 | Stop Redis for 2 min during call state changes | PostgreSQL outbox retains events; after recovery publisher drains; no lost durable events |
| DR03 | Disconnect receiver for 5 min, reconnect on different node | Receiver replays all authorized events in order; no foreign account data |
| DR04 | Kill publisher after publish but before marking delivered | Duplicate event IDs delivered but client applies once |
| DR05 | Device A replaced by device B mid-call | A cannot signal or renew; B's higher generation wins; A media is torn down |
| DR06 | Two voice replicas with distinct clients | Cross-node events delivered and replayed after a node crash |
| DR07 | Saturate outbox and Redis | Bounded backlog, alerting, no unbounded memory, fail closed on new calls if limits breached |
| DR08 | Restart node and PostgreSQL primary failover | No invalid state transitions; RTO/RPO documented and measured |
| DR09 | Real mobile and desktop on different networks | Bidirectional audio, TURN relay fallback, ICE restart, 30-min stability |
| DR10 | Rollback and operational drill | Dashboards, alerts, migration rollback plan, security review and incident runbook signed |

Record timestamps, test IDs, commit SHA, environment, logs (redacted), packet loss/jitter metrics, and operator sign-off. **No gate is marked PASS by this package.**
