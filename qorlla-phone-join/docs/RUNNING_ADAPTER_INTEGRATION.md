# SIP/RTP gateway integration and controlled rollout

The current Meet collaboration build now includes the authenticated telephone lifecycle,
restricted verification peer, stored gateway media evidence, dedicated mutual-TLS listener,
and the managed `qorlla-phone-join/src/runtime.ts` assembly. Existing Chat, More, Notes,
Polls and breakout modules are retained. Telephone calls and breakout rooms are mutually
exclusive until scoped telephone media is implemented.

## Availability is evidence, not a switch

`PHONE_GATEWAY_ENABLED=true` enables authenticated gateway transport, not public dial-in.
The managed runtime uses `MeetReadiness`; it has no lab readiness override. All six
conditions must be true before admission: carrier connection, inbound-number certification,
healthy gateway, certified two-way media, billing certification and production approval.
A signed healthy heartbeat with `mediaBridge:true` changes the bridge from disconnected
to installed/pending certification; it never certifies audio. Stale/unhealthy evidence
removes availability. A correct PIN and host approval do not count a caller as connected.
Meet must also validate encrypted, fresh bidirectional media from that call's negotiated
verification peer. Tokens are short-lived, scope- and body-bound, single-use, and bound
to the actual mutual-TLS client certificate.

SIP ingress is currently UDP with digest authentication and SRTP. SIP/TLS/SBC and carrier
interoperability remain release requirements. Internal Qorlla extensions are not public
PSTN numbers and do not satisfy the carrier gates.

## Prepare without touching the running application

1. Build/check the gateway: `cd qorlla-phone-join && npm ci && npm run build`.
2. Apply Meet migrations in order, after the existing v4.22 host controls: v4.24 phone
   lifecycle, v4.25 verification peer, v4.26 phone outbox, v4.27 phone delivery,
   v4.28 phone batches and v4.29 gateway media bridge. These are ADDITIONS alongside
   the similarly numbered chat/More/breakout migrations, not replacements. Do not apply
   `*.rollback.sql` during forward migration. Back up first. v4.24 terminates legacy
   calls that had no verified media; schedule a maintenance window with no phone calls.
3. In a separate, least-privileged gateway database/schema apply
   `qorlla-phone-join/sql/001_phone_join.sql` and `002_phone_join_lease.sql`.
   Runtime startup checks schema availability; it never migrates a live database.
4. Issue separate server/client certificates from a trusted private CA; the server
   certificate must match the gateway's Meet URL. Provision an ES256 workload signing
   key, Meet verification-peer signing key, and the server-side public key registry
   and subject scopes. No keys or real credentials belong in the repository.
5. Set `PHONE_GATEWAY_KEYS_JSON` to issuer -> kid -> public PEM and
   `PHONE_GATEWAY_SUBJECTS_JSON` to subject -> scopes. The gateway needs
   `phone.verify`, `phone.consent`, `phone.media`, `phone.end`, `phone.decision`,
   `phone.health`, `phone.readiness`, and `phone.peer`. Mutual TLS stays required.

## Gateway configuration (operator-owned file)

`GATEWAY_CONFIG_FILE` points to JSON containing:

- `instance`: stable unique instance ID, e.g. `sip-local-1`.
- `meetUrl`: `https://meet:3443` (server certificate SAN must include `meet`).
- `issuer`, `subject`, `kid`, and `signingKeyFile`: workload identity and private-key path.
- `tls`: `certFile`, `keyFile`, `caFile` paths for the gateway's client TLS identity.
- `sip.enabled`: explicit boolean; start with false until configuration review.
- `sip.sip`: `host`, `port`, `realm`, nonempty `allowedSources`, and `maxCalls`.
- `sip.media`: `bindHost`, `publicHost`, and an RTP `portRange` with at least twice maxCalls
  ports. SRTP is mandatory; no `allowPlainRtp` or `labMode` in the managed runtime.
- `sip.digestFile`: path to JSON containing `secretBase64` (32+ random bytes),
  `ha1ByUser` (precomputed digest hashes, not passwords), and `algorithms:["SHA-256"]`.

`GATEWAY_DATABASE_URL` comes from the secret environment file. Run `npm start` from
`qorlla-phone-join`. Startup sends authenticated bridge evidence; shutdown clears it,
ends legs, stops lease/reaper/media timers, and closes the database pool. Logs report
no credentials, PINs, SDP or certificate keys. Replacing TLS files updates HTTP transport;
restart the sidecar between calls to rotate the signaling certificate as well.

## Deployment boundary

`deploy/sip-gateway.compose.yml` is opt-in and keeps all public calling/number flags
false and `PHONE_FEATURES` empty. It publishes no SIP/RTP ports. Building it is safe
for the current stack; applying it recreates Meet and therefore requires a maintenance
window under the user's existing no-restart instruction. Do not run a broad compose
`up`, stop other projects, delete volumes or automatically enable certification gates.
Configure secrets and back up first, then apply only the intended Meet/gateway services.
No live migration or service restart is part of the verification scripts.

## Verification and limits

Use an isolated PostgreSQL container for tests. `scripts/verify-sip-integration.cjs`
creates one, runs authenticated server and SIP/media tests, and stops it afterward;
it deliberately retains its container/data. Tests create only disposable schemas.
Real-browser media verification additionally uses `A5_E2E=1`, `MEET_SERVER_DIR`,
`PHONE_JOIN_TEST_DATABASE_URL` and the `REAL CHROMIUM` test in e2e-chrome.test.ts.
This exercises known tones in both directions through SIP/SRTP, the gateway process,
Meet signaling and Chromium. The caller is synthetic and the carrier/readiness are lab
fixtures: success is integration evidence, not permission to enable public dial-in.
See the committed verification report for actual results and remaining blockers.
