# Meet TURN: configuration, relay-only mode and the cross-network test

**Status: configuration and enforcement are implemented and tested locally; a real relay carrying media across two networks has NOT been proven.** That needs a TURN server reachable from the public internet and a phone on cellular data (section 4). Release stays BLOCKED.

## 1. What Meet does now
- `GET /api/meetings/:id/ice` (admitted participants only: same JWT + admission check as every meeting call) returns the ICE servers for **that participant**: the static list from `ICE_SERVERS_JSON` plus, when TURN is configured, a TURN entry with **short-lived personal credentials** (coturn "REST" scheme: `username = <expiry>:<participantId>`, `credential = base64(HMAC-SHA1(TURN_SHARED_SECRET, username))`), `Cache-Control: no-store`.
- `/api/config` (public) never carries a TURN secret or credential.
- The client fetches credentials after admission, uses the server's `iceTransportPolicy` for every peer connection, and renews them at 40% of their lifetime.
- `ICE_TRANSPORT_POLICY=relay` makes **every** client use relay candidates only, so a direct connection can never be mistaken for proof that the relay works. Bad configuration refuses to start: TURN URLs without a 32+ character secret, relay-only without TURN URLs, a policy other than `all`/`relay`.

| Variable | Meaning |
|---|---|
| `TURN_URLS` | comma-separated `turn:` / `turns:` URLs, e.g. `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:443?transport=tcp` |
| `TURN_SHARED_SECRET` | the same value as coturn's `static-auth-secret` (32+ characters, random, never in `/api/config`) |
| `TURN_CREDENTIAL_TTL_SECONDS` | 60-14400, default 3600 |
| `ICE_TRANSPORT_POLICY` | `all` (default) or `relay` |

**Known limits.** REST credentials cannot be revoked before they expire (the Voice Engine's revocable Redis-backed mode, `docs/A371_MEDIA_SECURITY.md`, is not wired into Meet). A relayed call continues only while its allocation is refreshed, and refreshing needs valid credentials: a meeting longer than the credential lifetime needs an ICE restart with fresh credentials, which the client does not do yet. Keep the TTL longer than the longest meeting until it does.

## 2. Production-intended coturn configuration (sketch; review before use)
```
realm=turn.example.com
use-auth-secret
static-auth-secret=<the 32+ character secret>
fingerprint
listening-port=3478
tls-listening-port=5349            # and/or 443 for networks that only allow HTTPS
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
min-port=49152
max-port=49252
external-ip=<public IP>/<private IP if behind NAT>
no-multicast-peers
no-tcp-relay                        # WebRTC media uses UDP relay endpoints
no-cli
no-software-attribute
user-quota=6
total-quota=200
# never relay into private or special-use space (SSRF through the relay)
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=224.0.0.0-255.255.255.255
```
Never run coturn without an auth mechanism (it accepts anonymous allocations); open only UDP 3478, the TLS port and the relay range in the firewall; do not expose the admin CLI.

## 3. What is tested today (`qorlla-clients/e2e/turn-config.test.cjs`, no relay needed)
Credentials are refused without a token, with a tampered token and with a token for another meeting; they are scoped to the participant, about one hour, equal an independent HMAC computation, and absent from `/api/config`. With `ICE_TRANSPORT_POLICY=relay` and an **unreachable** TURN server, no host/srflx/prflx candidate exists and no media flows (the negative control).

## 4. The cross-network test (needs infrastructure; NOT yet run)
Needed: a TURN server with a public address (and a certificate for `turns:`), and Meet and the main app reachable by the phone over HTTPS/WSS. Phone: Galaxy A03s, Wi-Fi off, cellular data on. PC: its normal network. Run each mode and record, from both ends:
1. **Normal mode** (`ICE_TRANSPORT_POLICY=all`): selected candidate pair types (`candidate-pair` with `nominated`), `relayProtocol` of any relay candidate, audio/video counters in both directions, ICE failures. A `host`/`srflx` pair here proves nothing about TURN.
2. **Relay-only** (`ICE_TRANSPORT_POLICY=relay`): the selected pair MUST be `relay` on both sides, the TURN server's log must show allocations for `<expiry>:<participantId>` usernames, counters both ways. If it does not connect, TURN is not working.
3. **Reconnect:** phone airplane mode for 10 s and back; Wi-Fi/cellular handover; time to media recovery; ICE restarts.
4. **Credential expiry:** TTL set to 60 s; observe what happens at expiry (see the known limit above).
5. **Negative checks:** a wrong secret is refused by coturn (401); an expired username is refused; a relay to `10.x`/`127.x` peers is refused.
Keep numbers and redacted logs only (no screenshots with faces, no secrets, no device serials).
