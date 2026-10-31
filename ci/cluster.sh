#!/usr/bin/env bash
# Disposable docker-compose cluster for CI. Run from anywhere; it works from the repository root.
#   ci/cluster.sh prepare      generate the ephemeral environment (random, distinct secrets) in $RUNNER_TEMP: never in the repository, never printed
#   ci/cluster.sh check        validate the compose configuration WITHOUT printing it (resolved configuration would contain the secrets)
#   ci/cluster.sh up           build and start the cluster
#   ci/cluster.sh diagnostics  a SANITIZED summary of service states and error/lifecycle log lines (raw `docker compose logs` can carry credentials and must never reach a public log)
#   ci/cluster.sh down         ALWAYS tear down containers, networks and volumes, then delete the environment file (works even if `prepare` never ran)
# Every compose call passes the ephemeral environment explicitly (--env-file): authentication stays required, nothing falls back to an empty password, and no .env file in the workspace is read.
set -euo pipefail
cd "$(dirname "$0")/.."
ENVF="${QORLLA_CI_ENV_FILE:-${RUNNER_TEMP:-/tmp}/qorlla-ci.env}"
compose() { docker compose --env-file "$ENVF" "$@"; }

case "${1:-}" in
  prepare)
    node ci/cluster-env.cjs "$ENVF" --mask
    # Later steps need the PATH of the file only. Values are never written to GITHUB_ENV.
    if [ -n "${GITHUB_ENV:-}" ]; then echo "QORLLA_CI_ENV_FILE=$ENVF" >> "$GITHUB_ENV"; fi
    ;;
  check)
    compose config --quiet > /dev/null
    echo "docker compose configuration is valid (the resolved configuration is deliberately not printed)"
    ;;
  up)
    compose up --build -d
    ;;
  diagnostics)
    [ -f "$ENVF" ] || { echo "no ephemeral environment file: nothing to summarise"; exit 0; }
    echo "=== service states"
    compose ps -a --format '{{.Service}}: {{.State}} ({{.Status}})' 2>&1 | node ci/sanitize-diagnostics.cjs --service states --env-file "$ENVF" --max-lines 30 || true
    services="$(compose config --services 2>/dev/null || true)"
    for svc in $services; do
      # the raw log goes into the pipe and nowhere else; stderr is merged into it so an error message cannot bypass the sanitizer
      { compose logs --no-color --tail=200 "$svc" 2>&1 || true; } | node ci/sanitize-diagnostics.cjs --service "$svc" --env-file "$ENVF" --max-lines 25 || true
    done
    ;;
  down)
    # `compose down` still interpolates the required variables, so it needs an environment file even if setup failed before `prepare`.
    [ -f "$ENVF" ] || node ci/cluster-env.cjs "$ENVF" > /dev/null
    compose down --volumes --remove-orphans || true
    if command -v shred > /dev/null 2>&1; then shred -u "$ENVF" 2> /dev/null || rm -f "$ENVF"; else rm -f "$ENVF"; fi
    echo "cluster, networks and volumes removed; ephemeral environment file deleted"
    ;;
  *)
    echo "usage: ci/cluster.sh prepare|check|up|diagnostics|down" >&2; exit 2
    ;;
esac
