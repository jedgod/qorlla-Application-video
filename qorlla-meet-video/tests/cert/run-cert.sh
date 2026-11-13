#!/usr/bin/env bash
# ASCS-M1.3 certification runner: brings up the disposable environment, runs every suite RUNS times (repeatability), and summarizes the evidence.
#   LAN_IP=10.0.0.176 PLAYWRIGHT_DIR=/c/Users/cj_wo/qorlla-v43 RUNS=3 tests/cert/run-cert.sh
# Never edit the code under test while this runs. Needs docker (coturn, Redis, PostgreSQL 16) and Playwright with Chromium.
set -uo pipefail
cd "$(dirname "$0")/../.."
: "${LAN_IP:?set LAN_IP}"; : "${PLAYWRIGHT_DIR:?set PLAYWRIGHT_DIR}"; RUNS="${RUNS:-3}"; export MSYS_NO_PATHCONV=1
docker inspect qascs-test-pg >/dev/null 2>&1 || docker run -d --name qascs-test-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:25690:5432 postgres:16-alpine >/dev/null
tests/cert/relay-hardened-up.sh >/dev/null
rm -f docs/evidence/m13/*.run*.json
fail=0
for n in $(seq 1 "$RUNS"); do
  echo "=== certification run $n of $RUNS ==="
  export CERT_RUN=$n
  node tests/cert/m13-turn-security.cert.mjs  > "docs/evidence/m13/turn-security.run$n.log" 2>&1 || { echo "turn-security run $n FAILED"; fail=1; }
  node tests/cert/m13-meet-security.cert.mjs  > "docs/evidence/m13/meet-security.run$n.log" 2>&1 || { echo "meet-security run $n FAILED"; fail=1; }
  [ "$n" = 1 ] && { node tests/cert/m13-load.cert.mjs > "docs/evidence/m13/load.run$n.log" 2>&1 || { echo "load run $n FAILED"; fail=1; }; }
  TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:25690/postgres node --test tests/*.test.mjs > "docs/evidence/m13/server-tests.run$n.log" 2>&1 || { echo "meet server tests run $n FAILED"; fail=1; }
  [ "$n" = 1 ] && { TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:25690/postgres ONLY=A,B,C,E,F,D node tests/e2e/ascs-browser.e2e.mjs > "docs/evidence/m13/browser-regression.run$n.log" 2>&1 || { echo "browser regression run $n FAILED"; fail=1; }; }
  RELAY_CERT=1 ONLY=H TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:25690/postgres node tests/e2e/ascs-browser.e2e.mjs > "docs/evidence/m13/browser-H.run$n.log" 2>&1 || { echo "browser H run $n FAILED"; fail=1; }
done
node tests/cert/summarize.mjs
exit $fail
