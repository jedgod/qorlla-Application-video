# Qorlla Security Shield v2.1 integration and certification

## Mandatory production wiring (NOT implemented by this standalone package)
1. Discover real Qorlla authentication, meeting, media, PSTN, messaging, organization and admin services and their route contracts. Map user IDs to principal_state; reject missing/unknown principals.
2. Replace SHIELD_SERVICE_TOKEN with mTLS service identity or workload OIDC JWT (issuer, audience, workload subject, short expiry, replay protections). Require identity at both authorize and consume; do not accept client-supplied `destinationAllowed` as evidence.
3. Install fail-closed middleware at the actual media gateway, SIP/PSTN gateway, message send/attachment, organization/admin mutation and guest join endpoints. Do not rely on frontend hiding.
4. Build host-authenticated admission approval; authorize host against meeting tenant; implement lobby enforcement and denial, capacity, bans, revocation, one-time media token consumption, expiry and leave/kick propagation.
5. Replace demonstration passcode SHA-256 with slow password KDF (Argon2id), or HMAC using a server-held pepper with appropriate key management; use an edge-provided stable abuse bucket key. Rotate keys and set retention limits.
6. Verify meeting configuration from the real meeting service; never allow public direct edits to shield.meeting_guest_config. Do not copy passcodes into logs.
7. Add verified caller-ID ownership, high-risk destination blocking, atomic balance reservations, call concurrency, spend caps, post-call settlement, carrier callbacks and emergency calling policies.
8. Device possession proof, phishing-resistant MFA, recovery rate limits, step-up freshness and session revocation must be enforced by the identity provider.
9. Lock down database roles: application cannot alter security audit history; no inherited, PUBLIC or default privileges grant mutation; use separate migration role.
10. Instrument immutable security events, monitoring, incident playbooks, kill switches, privacy retention and appeals.

## Certification matrix (must run against integrated environment)
- Account takeover: stolen token, revoked session, stolen refresh token, untrusted device, stale MFA; all privileged actions denied.
- Caller ID spoofing: outbound unowned caller ID denied at gateway and carrier.
- Toll fraud: international, premium-rate, burst dialing, concurrency, balance exhaustion and worker restart; no limit bypass.
- Malicious guests: no number/extension, no create/invite/chat/PSTN/admin; only ID+passcode admission, no bypass of waiting room.
- Meeting phishing: external join warning, meeting link tamper, meeting ID guessing and passcode brute force; limits enforced.
- Organization isolation: cross-tenant access, forged org claims, suspended org and staff impersonation denied.
- Replay: media admission token, provider callback, authorization ticket and concurrent duplicate requests; once-only consumption.
- Emergency suspension: revoke active tokens/media/SIP sessions and queued operations; all gateways deny within documented SLA.

## Known limitations
This is an additive reference pack, not a claim of integration into Qorlla's actual repository. Guest admission is a database-backed library; a production host approval endpoint and media gateway verifier are still required. Existing v2.0 SHIELD_SERVICE_TOKEN remains transitional and MUST be replaced. The guest admission example uses SHA-256 and HS256 for demonstration, not hardened deployment. No production certification has been run.
