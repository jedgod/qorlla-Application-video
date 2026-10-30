#!/usr/bin/env bash
# A3.7.1: disposable coturn + Redis for the media-security tests. Our own containers (a371-*), never anyone else's. Remove with: scripts/a371-turn-up.sh down
# coturn runs with --lt-cred-mech (WITHOUT it coturn accepts anonymous allocations), the Redis user database, and the admin CLI (off unless --cli). Test credentials only.
set -euo pipefail
NET=a371-net; SUBNET=172.29.88.0/24; REDIS_IP=172.29.88.5; TURN_IP=172.29.88.10
if [ "${1:-up}" = "down" ]; then docker rm -f a371-turn a371-redis >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; echo down; exit 0; fi
docker network inspect "$NET" >/dev/null 2>&1 || docker network create --subnet "$SUBNET" "$NET" >/dev/null
docker rm -f a371-turn a371-redis >/dev/null 2>&1 || true
docker run -d --name a371-redis --network "$NET" --ip "$REDIS_IP" -p 127.0.0.1:36379:6379 redis:7-alpine >/dev/null
docker run -d --name a371-turn --network "$NET" --ip "$TURN_IP" -p 127.0.0.1:34780:3478/udp -p 127.0.0.1:35766:5766/tcp -p 127.0.0.1:47300-47330:47300-47330/udp coturn/coturn:latest \
  -n -v --log-file=stdout --realm=qorlla.test --lt-cred-mech "--redis-userdb=ip=$REDIS_IP dbname=0 connect_timeout=5" \
  --cli --cli-ip="$TURN_IP" --cli-password=clipw --listening-port=3478 --listening-ip="$TURN_IP" --relay-ip="$TURN_IP" --min-port=47300 --max-port=47330 --no-tls --fingerprint --no-software-attribute >/dev/null
sleep 2; docker logs a371-turn 2>&1 | grep -E "Redis DB sync|CLI listener" ; echo up
