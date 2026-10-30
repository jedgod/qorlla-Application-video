# Qorlla staging edge: HTTPS/WSS + coturn (PREPARED, NOT PROVISIONED)

**Status: nothing here is running.** These files prepare a dedicated staging VPS. Production traffic is not permitted, and all 15 production release gates stay BLOCKED. Do **not** run any of this on a development PC: it opens public ports.

## Approvals required before anything is created or exposed
1. **Hosting provider** and the monthly cost (a small VPS with a static IPv4 and unmetered or generous UDP bandwidth is enough for staging).
2. **Domain ownership**: a domain you control, with permission to create three DNS records.
3. **Deployment security review** of this directory (firewall, secrets handling, upstreams).
No paid infrastructure is provisioned and no endpoint is published until all three are approved.

## Architecture (signaling and media are separate paths)
```
Windows (Wi-Fi) ─┐                         ┌─ app.staging.<domain>  (HTTPS)   ─ main application
                 ├─ HTTPS/WSS (443) ───────┼─ meet.staging.<domain> (HTTPS+WSS) ─ Qorlla Meet  ── private: PostgreSQL, Redis, internal APIs
Galaxy A03s (LTE)┘                         └─ turn.staging.<domain>  (TLS cert only)
        └──────── media: UDP 3478 / TLS 5349 / UDP 49160-49200 ──── coturn (authenticated relay)
```
Clients fetch short-lived TURN credentials from Meet (`GET /api/meetings/:id/ice`, admitted participants only). The shared secret exists only on the VPS and in Meet's environment, never in a client, the repository or workflow logs.

## Steps after approval
1. Create a dedicated Ubuntu LTS VPS with a static public IPv4; key-only SSH restricted to your address; automatic security updates.
2. DNS: `A` records for `meet.staging.<domain>`, `app.staging.<domain>`, `turn.staging.<domain>` to the VPS address (set a low TTL first).
3. Firewall (deny by default), allow only:

| Port | Purpose |
|---|---|
| TCP 80 | certificate issuance and HTTP-to-HTTPS redirect |
| TCP 443 | HTTPS/WSS |
| UDP+TCP 3478 | TURN |
| TCP 5349 | TURN over TLS |
| UDP 49160-49200 | relay range (**sized for ~20 concurrent relayed participants; resize for load**) |

   PostgreSQL, Redis, the Meet and app listeners, SSH from the internet and the coturn admin CLI (disabled) are **not** exposed.
4. `cp .env.example .env`, fill in the real hostnames and the VPS address. Create the secret **on the VPS only**: `mkdir -p secrets && umask 077 && openssl rand -hex 32 > secrets/turn_shared_secret`. The same value goes into Meet's `TURN_SHARED_SECRET` through your secret store, never a committed file.
5. Meet environment: `TURN_URLS=turn:<TURN_HOST>:3478?transport=udp,turns:<TURN_HOST>:5349?transport=tcp`, `TURN_SHARED_SECRET`, `ICE_TRANSPORT_POLICY=all` (and `relay` for the relay-only tests), `RETURN_ORIGINS` set to the exact app origin.
6. `docker compose up -d`. Caddy obtains certificates; coturn refuses to start with a missing/short/placeholder secret, an unreadable certificate or a non-hostname realm.
7. Lint before and after: `node qorlla-clients/e2e/staging-config-check.cjs` (config only, no network).

## Certification tests to run once it is up (record numbers and redacted logs only)
Windows on Wi-Fi + Galaxy A03s on cellular: bidirectional audio/video; forced relay-only (selected candidate pair must be `relay` on both sides); TURN over UDP; TURN over TLS/TCP; invalid credentials refused; expired credentials refused for a new allocation; TURN stopped (relay-only fails closed); Wi-Fi-to-cellular handover; 30-minute meeting; three participants. Capture candidate-pair stats, audio/video byte and frame counters, packet loss, RTT and recovery times. Never log TURN passwords, access tokens or camera images.

## Known limits
Credentials cannot be revoked before they expire (default one hour). A relayed meeting longer than the credential lifetime needs an ICE restart with fresh credentials, which the client does not do yet. See `docs/MEET_TURN.md`.
