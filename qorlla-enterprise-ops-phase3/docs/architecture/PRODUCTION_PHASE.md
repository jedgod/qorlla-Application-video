# Enterprise operations production phase

## Implemented in this increment
- Tenant-scoped staff directory and shift creation, ticket messages with customer-vs-internal visibility, refund request and independent approval, append-only audit, transactional outbox.
- Existing API JWT verification is reused. Routes are under `/api/enterprise`.
- No real payment execution, number issuance, or PSTN activation is provided. Refund approval creates an outbox event only.

## Mandatory integration work before release
1. Integrate real customer login tokens with `customerId` derived from **verified** claims, never request bodies; the current API authenticate middleware does not yet populate `customerId`, so customer ticket messaging is deliberately inaccessible.
2. Add durable worker consuming refund.approved with provider-specific signed calls, replay defense, reconciliation, provider lookup, currency/amount checks and idempotent provider keys.
3. Connect number authority to existing Numbers & Plans service; preserve disabled flags and operator-approved reserved ranges.
4. Connect meeting operations to the real Qorlla Meet/Voice engine with least-privilege diagnostic endpoints; never expose media content.
5. Add staff timeclock, leave requests, payroll integrations, case assignment state transitions, notification delivery, attachment malware scanning, SLA timers.
6. Deploy separate migration role and enforce application-role least privilege; apply RLS if sharing DB credentials among tenants. Audit role inheritance, PUBLIC and default grants.
7. Add per-route rate limits, CSRF protections where cookie auth is used, CORS allowlist, token revocation strategy, MFA for approvals, structured security logging, PII retention policy.
8. Implement browser portals, e2e authorization tests, load tests, database failover, CI signing, SBOM, container scans, PKI, secrets rotation, alerting and backups.

## Release gates
BLOCKED until physical device/cross-network TURN, PSTN carrier, production PKI, failover, load, penetration review and media termination controls are certified.
