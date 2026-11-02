# Qorlla A3.4 integration reference (not a drop-in release)

Scope: internal extension voice only. Twilio, PSTN and public numbers are prohibited.

## Integrate
1. Wire `createWorkloadVerifier` into the **existing** engine's mTLS listener. Pass `socket.getPeerCertificate(true).raw` only after `socket.authorized === true`; never trust client-supplied certificate headers. Configure a real issuer/JWKS and exact workload allowlist. Protect suspension and sync with distinct scopes. Rotate and revoke certs and keys.
2. Wire `InternalVoiceService` to the existing verified user middleware, canonical principal tables, extension registry and transactional outbox. Do not expose a client-controlled accountId/tenantId. The sample migration defines reference tables only: reconcile with the actual repo schema before running.
3. The `voice.account.suspend` route must authenticate and authorize its actor before calling `suspendAccount`. Ensure all node listeners consume outbox events and terminate signaling; this does not prove P2P media has ended.
4. Recheck eligibility at acceptance, connection and relay-credential issuance, not just invitation. Use a transactional state machine, version fencing and call idempotency. Prevent self-call and stale extension mappings if required by product policy.
5. Use TURN relay-only or an SFU for enforceable media cutoff; even then, test actual revocation and credential lifetime. TURN credentials already issued may remain valid until expiry.
6. Lock down database role permissions and implement audit immutability, rate limiting, abuse controls, retries, outbox dedupe, monitoring and retention. Test PostgreSQL failover and multi-host behavior.
7. Keep PSTN routes unregistered in production, and flags disabled. Do not enable production based on this reference package.

## Run
`npm install && npm test`

Tests here are narrow smoke tests; the user's 143-test suite, integration tests and release gates remain mandatory. No existing repository files were modified by this package.
