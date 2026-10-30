# Read-only review: existing `server-coturn-1` and the host's exposure (sanitized)

Scope: inspection only. Nothing was stopped, restarted, reconfigured or exposed. No credential, secret value, private address or personal path is recorded here. The container belongs to a **different project** (a compose project named `server`, not Qorlla), so remediation is the owner's decision.

## What was inspected
`docker inspect` (configuration, with sensitive values masked), the published ports of the sibling containers, listeners on the host, the Windows network profile and firewall, the compose file (secret values masked), and one protocol probe that sends **no credentials**.

## Findings: `server-coturn-1`
| Area | Finding | Severity |
|---|---|---|
| Authentication | Uses REST-style `use-auth-secret` with a secret of 32+ characters supplied through a variable. **`lt-cred-mech` is missing**: our local test showed that without it coturn rejects every correctly signed credential, so this relay probably cannot authenticate anyone, which is safe but means it does not work as intended. | info |
| Anonymous allocation | **Not possible.** An Allocate request without credentials was refused with `401` plus a realm and nonce; STUN Binding is answered, as normal. | pass |
| Peer restrictions | **No `denied-peer-ip`** ranges. If authentication did work, an authenticated user could relay traffic to loopback, private and link-local hosts behind the relay (a way into the LAN). | high |
| Limits | No `user-quota` / `total-quota`, no `no-cli`, no `no-multicast-peers`, no `no-tcp-relay`. | medium |
| TLS | None (no certificate, no TLS listener). Credentials and signalling metadata are in clear over UDP/TCP 3478. | medium |
| Advertised relay address | `external-ip` is a **private LAN address**: relay candidates it hands out are unusable from another network, so it cannot serve a cross-network test. | info |
| Runtime | Runs as `nobody`, not privileged, no extra capabilities, restart policy `unless-stopped`, image tag `latest` (unpinned). | low |
| Secret location | The secret value is in a git-ignored, untracked `.env`, **inside a OneDrive-synced folder**, so it is copied to cloud storage. It is also visible to anyone who can run `docker inspect` on this PC (it is passed on the command line). | medium |

## Findings: host exposure
- The container publishes 3478 (UDP and TCP) and the whole 49160-49200 UDP range on **all interfaces** (IPv4 and IPv6).
- The Wi-Fi network is classified **Public**, and Docker Desktop's backend has **inbound allow rules for all TCP and UDP ports on the Public profile**. Published container ports are therefore reachable by other devices on the same Wi-Fi network. Internet reachability additionally depends on the router (port forwarding or UPnP), which was **not** inspected and not changed.
- **Sibling services of the same stack are published on all interfaces as well:** PostgreSQL (55432), MinIO (9000, 9001) and Redis (6379). Databases and caches on a Public network are a more serious exposure than the relay. These need the same decision.
- Qorlla's own containers (`a371-turn`, `a371-redis`, `qviewer-dev-db`, `qorlla-meet-dev-db`, the `qv11-*` set) are published on `127.0.0.1` only.

## Recommended actions for the owner (not performed)
1. Publish the stack's ports on `127.0.0.1` (or remove the `ports:` entries for services that need no outside access: PostgreSQL, Redis, MinIO).
2. If the relay must stay reachable on the LAN: add `lt-cred-mech`, the `denied-peer-ip` private/special ranges, quotas, `no-cli`, `no-multicast-peers`, TLS, and pin the image version; set a real `external-ip` only for a deliberate test.
3. Move the `.env` out of the OneDrive-synced folder, rotate the TURN secret and any other secret in that file if it has been synced, and stop passing the secret on the command line (use a file-based secret).
4. Re-classify the Wi-Fi network as Private only if the LAN is trusted, and narrow the Docker Desktop firewall rule instead of allowing all ports.
5. Confirm at the router that no port forwarding or UPnP mapping points at this PC.

## Not established
Internet reachability, whether UPnP created any mapping, and the behaviour of the relay with valid credentials (it appears unable to authenticate because `lt-cred-mech` is absent).
