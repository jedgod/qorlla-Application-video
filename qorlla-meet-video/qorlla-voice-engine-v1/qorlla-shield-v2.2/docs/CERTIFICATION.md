# Certification matrix (all must be evidenced against actual services)
| Gate | Required evidence |
|---|---|
| Identity takeover | revoked token, expired MFA, stolen device rejected |
| Workload identity | no forged headers, expired cert, wrong SPIFFE ID denied |
| Guest access | valid ID+passcode only; host approval before SFU admission; no other capability |
| PSTN | premium/international restrictions, concurrent calls, spend exhaustion, ambiguous provider response |
| Caller ID | unowned and released numbers rejected |
| Tenant isolation | cross-org membership and media routes rejected |
| Replay | signed timestamp window plus durable event uniqueness |
| Suspension | immediate revocation of calls, guest/media tokens, privileged sessions |
| Provider reconciliation | stale/duplicate/out-of-order events and Twilio drift |
| Infrastructure | PostgreSQL failover, multi-host, TURN independent networks, physical devices |

Evidence per test: commit SHA, environment, commands, timestamps, expected/actual outcome, logs redacted, artifacts, reviewer. Until then: BLOCKED.
