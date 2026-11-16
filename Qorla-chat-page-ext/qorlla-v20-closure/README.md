# Qorlla Meet V2.0 — distributed infrastructure and UI integration candidate

**NO-GO for production. Not connected to actual Meet/Portal repositories. No live Redis, coturn, two-process browser test, Safari/mobile certification, load certification or independent audit was performed here.**

## Contents
- `src/core.mjs`: PostgreSQL room/epoch authorization, transactional events, outbox insertion and scoped history.
- `src/bus.mjs`: Redis Streams publisher and per-connection consumer with PG inbox. Events are at-least-once, not exactly-once.
- `src/server.mjs`: two-node runnable demonstration server. Identity adapter is deliberately disabled except `LOCAL_TEST_ONLY=true`. **Never expose this mode outside loopback / isolated scratch networking.**
- `web/RoomReports.jsx`: Meet and Portal report request/status/consent React components. API facades must be wired to existing Portal meeting-ai consent and quota services. No direct model calls.
- `deploy/compose.yaml`: scratch PostgreSQL, Redis, two Meet processes and coturn. TURN uses test-only static credentials. Production must reuse Voice Engine short-lived credentials and admin telemetry.
- `scripts/browser-relay.spec.mjs`: executable browser relay-candidate check (Chromium, Firefox or WebKit via Playwright). This does not prove RTP delivery or room isolation.
- `scripts/load.mjs`: HTTP load smoke runner, not a substitute for WebRTC load tests.

## Run in disposable environment
1. Set `PG_PASSWORD`, `REDIS_PASSWORD`, `TURN_PASSWORD` to strong disposable secrets in an untracked `.env` under `deploy/`.
2. `docker compose -f deploy/compose.yaml up --build -d`. Docker must be installed. Local-only Meet ports 18081/18082.
3. `npm install && npm test` for pure Node tests.
4. For relay: install Playwright and browser binaries, set `TURN_URL=turn:127.0.0.1:3478`, `TURN_USER=test`, `TURN_PASSWORD=...`, then `node scripts/browser-relay.spec.mjs` (test with a routable coturn address for remote phones).
5. `npm run load` for basic endpoint stress. For two-node events, seed memberships on scratch PostgreSQL, connect a WS to each node and send a chat event. Verify authorized delivery to both, rejection for other rooms and old epochs, reconnect/replay, and Redis outage recovery.

## Critical integration gaps / security caveats
1. The actual Meet authentication, tenant scoping, session revocation, CSRF/origin checks and production WebSocket identity are NOT implemented. The sample's test headers must be replaced with verified Meet identity before deployment.
2. The React screens require Portal-backed endpoints and actual authenticated route wiring. The sample server intentionally returns 503 for report requests. Portal AI consent, quota, job dispatch, withdrawal and retention must be enforced server-side in the real Portal.
3. Presence here is a database membership record, not fully distributed live presence. Signaling event delivery is a foundation, but targeted peer authorization, full mesh peer negotiation and session membership mutation need existing Meet code integration. Cross-node recovery needs a durable cursor per user and atomic delivery semantics; the demo starts at `$` and can miss events published during disconnect. Use PostgreSQL scoped history on reconnect.
4. Redis Streams per-meeting stream design needs stream retention, key lifecycle, partition sizing, slow-consumer protection, and stronger consumer offset management. PG outbox retries can cause duplicate Redis publication; receivers must dedupe by event ID.
5. TURN candidate presence is only **relay observed**; it is NOT independent media verification. coturn allocation telemetry must be authenticated and correlated to participant and epoch, and cannot prove delivered media. A controlled SFU/media gateway is required for enforceable media isolation.
6. `coturn` Docker published relay port range and `--realm` are for scratch use only; NAT/public address, TLS, credential issuance, firewall and allocation telemetry must be configured for real devices.
7. Safari iOS requires physical-device testing; Playwright WebKit is NOT an adequate substitute. Conduct Android Chrome, iOS Safari, desktop Safari, low bandwidth, network handoff and reconnect tests.
8. Independent security review must be commissioned separately; no code package can claim one was completed.

## Mandatory production release gate
- Portal room reports with unanimous room consent, actual billing quota concurrency and withdrawal behavior verified.
- Authenticated two-node Meet test with live PostgreSQL/Redis and cross-room/epoch isolation.
- coturn relay-only across real browsers/devices, including Safari and phones.
- WebRTC multi-peer load, failure injection, duplicate events, Redis restart and node restart.
- Independent penetration test and privacy review, with documented findings and remediation.
- Explicit approval before any production migrations, merge, restart or deploy.
