#!/usr/bin/env bash
# ASCS-M1.2 proof of concept: DISPOSABLE coturn + Redis (our own containers, qm12-*; never anyone else's). Remove with:  relay-up.sh down
#
# coturn runs in USER-DATABASE mode:  --lt-cred-mech --redis-userdb  (long-term credentials stored in Redis, one key per credential) and the admin CLI (--cli).
#   * WITHOUT --lt-cred-mech coturn accepts ANONYMOUS allocations (verified by the voice engine's A3.7.1 work).
#   * Do NOT add --use-auth-secret: that is the stateless REST mode whose credentials cannot be revoked before they expire (measured in ASCS-M1.1).
# The TURN UDP port is published on the machine's LAN address, NOT 127.0.0.1: Chromium never uses a TURN server on a loopback address (measured in ASCS-M1.1).
# The admin CLI and Redis are published on 127.0.0.1 only (the CLI password and the Redis user database are high-value secrets: anyone holding them can mint or cancel allocations).
#
#   LAN_IP=10.0.0.176 tests/poc/relay-up.sh        # up
#   tests/poc/relay-up.sh down                      # remove everything this script created
#
# Ports (host): TURN udp ${LAN_IP}:34790, CLI tcp 127.0.0.1:35790 (password "clipw"), Redis tcp 127.0.0.1:36390.   Realm: qorlla.poc
set -euo pipefail
NET=qm12-net; SUBNET=172.29.99.0/24; REDIS_IP=172.29.99.5; TURN_IP=172.29.99.10
if [ "${1:-up}" = "down" ]; then docker rm -f qm12-turn qm12-redis >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; echo down; exit 0; fi
: "${LAN_IP:?set LAN_IP to the LAN address of this machine - not 127.0.0.1}"
docker network inspect "$NET" >/dev/null 2>&1 || docker network create --subnet "$SUBNET" "$NET" >/dev/null
docker rm -f qm12-turn qm12-redis >/dev/null 2>&1 || true
docker run -d --name qm12-redis --network "$NET" --ip "$REDIS_IP" -p 127.0.0.1:36390:6379 redis:7-alpine >/dev/null
docker run -d --name qm12-turn --network "$NET" --ip "$TURN_IP" -p "$LAN_IP:34790:3478/udp" -p 127.0.0.1:35790:5766/tcp coturn/coturn:latest \
  -n -V --log-file=stdout --realm=qorlla.poc --lt-cred-mech "--redis-userdb=ip=$REDIS_IP dbname=0 connect_timeout=5" \
  --cli --cli-ip="$TURN_IP" --cli-password=clipw --listening-port=3478 --listening-ip="$TURN_IP" --relay-ip="$TURN_IP" --min-port=47500 --max-port=47530 \
  --no-tls --no-dtls --fingerprint --no-software-attribute >/dev/null
sleep 3
docker logs qm12-turn 2>&1 | grep -E "Redis DB sync|CLI listener|ERROR" | head -4 || true
echo up
