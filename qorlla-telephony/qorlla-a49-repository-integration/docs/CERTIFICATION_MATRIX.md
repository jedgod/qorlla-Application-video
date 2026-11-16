# A4.9 Certification evidence matrix — all release gates blocked

| Gate | Evidence to collect | Current result |
| --- | --- | --- |
| Portal/Meet migration | PostgreSQL16 real DB, existing migration compatibility, rollback rehearsal | NOT RUN |
| Tenant isolation | distinct workspaces/users, malformed credentials, JWT expiry, member suspension | NOT RUN |
| Gateway identity | rotated keys, mTLS, replay, wrong session, separate gateway node | UNIT ONLY |
| Atomic event processing | simultaneous duplicate/out-of-order events on PostgreSQL | DB DOUBLE ONLY |
| Host admission | actual Meet host browser, denial, locked/ended meeting | NOT RUN |
| Media bridge | real A4 WebRTC peer, SRTP in/out, one-way audio, ICE restart | NOT CONNECTED |
| Shield | real Shield service policy, revocation, outage, scope boundaries | NOT CONNECTED |
| Outbox | PostgreSQL worker fencing, lease expiry, crash/restart, delivery idempotency | NOT RUN |
| Internal client | desktop and Android/iOS physical devices, cross-network TURN | NOT RUN |
| Carrier interface | independent wholesale SIP trunk and SBC, TLS/SRTP, failover | NOT CONNECTED |
| Carrier settlement | signed real CDR, tariffs, disputes, refund/rebill, double-entry posting | NOT RUN |
| Fraud/abuse | rate limits, premium/emergency policies, destination risk and spend ceilings | NOT RUN |
| Compliance | emergency services, caller ID, privacy/recording, jurisdictions | NOT REVIEWED |
| Operations | alerts, incident runbooks, dashboards, capacity, failover and rollback | NOT REVIEWED |
| Production gate | independent approval by security, telecom operations, billing | NO-GO |

A software-only media gateway cannot provide access to the public telephone network.
No Twilio dependency is introduced by this patch. Existing Twilio-era code on `main`
remains untouched, and `TELEPHONY_ENABLED=false` must remain the production policy.
