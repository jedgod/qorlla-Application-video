#!/usr/bin/env bash
# ASCS-M1.3: the HARDENED disposable relay used by the certification suites (containers qm13-*, ports 3479x; never touches M1.2's qm12-* or anyone else's containers).
#
#   LAN_IP=10.0.0.176 tests/cert/relay-hardened-up.sh        # up
#   tests/cert/relay-hardened-up.sh down                      # remove everything this script created
#
# Differences from the M1.2 proof-of-concept relay (tests/poc/relay-up.sh) -- each one is TESTED in tests/cert/m13-turn-security.cert.mjs:
#   * Redis requires a password (coturn's user database holds every credential key; anyone who can write it can mint a credential).
#   * The admin CLI has a long random password and listens only on the private docker network (host port bound to 127.0.0.1).
#   * PEER POLICY: every peer address is DENIED except this relay's own address -> an allocation can exchange media only with ANOTHER ALLOCATION of the same relay
#     (a revocable thing), never with a host/srflx address, loopback, the LAN or the internet. This is what removes the "direct path" from the screen channel.
#   * quotas: --user-quota (allocations per credential: the presenter uses ONE credential for all its viewer connections, so this is the largest audience one share can have (23 viewers + 1 spare)), --total-quota, --max-bps (per allocation, BYTES/s), --bps-capacity (whole server, BYTES/s).
#   * no TCP relaying (RFC 6062), no multicast peers, stale nonce after 300 s, no software attribute, TLS listener on 5349 with a throw-away certificate (the browser suites use UDP).
# Ports (host): TURN udp+tcp ${LAN_IP}:34791, TURNS tcp ${LAN_IP}:34792, CLI 127.0.0.1:35791, Redis 127.0.0.1:36391.  Realm qorlla.cert.  Secrets are written to tests/cert/.relay-secrets.env (gitignored).
set -euo pipefail
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "$0")" && pwd)"
NET=qm13-net; SUBNET=172.29.98.0/24; REDIS_IP=172.29.98.5; TURN_IP=172.29.98.10; SECRETS="$HERE/.relay-secrets.env"
if [ "${1:-up}" = "down" ]; then docker rm -f qm13-turn qm13-redis >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; rm -f "$SECRETS"; echo down; exit 0; fi
: "${LAN_IP:?set LAN_IP to the LAN address of this machine, not 127.0.0.1}"
rnd() { head -c 24 /dev/urandom | base64 | tr -d '/+=\n' | head -c 28; }
REDIS_PW="$(rnd)"; CLI_PW="$(rnd)"
printf 'RELAY_REDIS_PASSWORD=%s\nRELAY_CLI_PASSWORD=%s\nLAN_IP=%s\n' "$REDIS_PW" "$CLI_PW" "$LAN_IP" > "$SECRETS"
docker network inspect "$NET" >/dev/null 2>&1 || docker network create --subnet "$SUBNET" "$NET" >/dev/null
docker rm -f qm13-turn qm13-redis >/dev/null 2>&1 || true
docker run -d --name qm13-redis --network "$NET" --ip "$REDIS_IP" -p 127.0.0.1:36391:6379 redis:7-alpine redis-server --requirepass "$REDIS_PW" --save "" --appendonly no >/dev/null
# a throw-away certificate for the TLS listener (production uses a real one)
docker run --rm -v qm13-cert:/certs alpine:3 sh -c 'apk add -q openssl >/dev/null 2>&1; [ -f /certs/t.pem ] || openssl req -x509 -newkey rsa:2048 -nodes -keyout /certs/k.pem -out /certs/t.pem -days 2 -subj /CN=relay.cert >/dev/null 2>&1; chmod 644 /certs/*.pem' >/dev/null 2>&1 || true
docker run -d --name qm13-turn --network "$NET" --ip "$TURN_IP" -v qm13-cert:/certs:ro \
  -p "$LAN_IP:34791:3478/udp" -p "$LAN_IP:34791:3478/tcp" -p "$LAN_IP:34792:5349/tcp" -p 127.0.0.1:35791:5766/tcp coturn/coturn:latest \
  -n -V --log-file=stdout --realm=qorlla.cert --lt-cred-mech "--redis-userdb=ip=$REDIS_IP dbname=0 password=$REDIS_PW connect_timeout=5" \
  --cli --cli-max-output-sessions=5000 --cli-ip="$TURN_IP" "--cli-password=$CLI_PW" --listening-port=3478 --tls-listening-port=5349 --cert=/certs/t.pem --pkey=/certs/k.pem --no-dtls \
  --listening-ip="$TURN_IP" --relay-ip="$TURN_IP" --min-port=47500 --max-port=47700 \
  --fingerprint --no-software-attribute --no-tcp-relay --no-multicast-peers --stale-nonce=300 \
  --allowed-peer-ip="$TURN_IP" --denied-peer-ip=0.0.0.0-255.255.255.255 \
  --user-quota=24 --total-quota=4000 --max-bps=1250000 --bps-capacity=0 >/dev/null
sleep 3
docker logs qm13-turn 2>&1 | grep -E "Redis DB sync|CLI listener|ERROR|TLS" | head -5 || true
echo up
