#!/bin/sh
# Renders turnserver.conf from the template using environment variables, then starts coturn. Refuses to start with a missing, short or placeholder value.
# Uses sed (not envsubst) so it works in the stock coturn image; every value is checked against a safe character set first so nothing can inject extra directives.
set -eu
# The secret arrives as a file (Docker secret) so it never appears in the process environment or in docker inspect output.
if [ -z "${TURN_SHARED_SECRET:-}" ] && [ -n "${TURN_SHARED_SECRET_FILE:-}" ] && [ -r "$TURN_SHARED_SECRET_FILE" ]; then TURN_SHARED_SECRET=$(tr -d '\r\n' < "$TURN_SHARED_SECRET_FILE"); fi
need() { eval "v=\${$1:-}"; [ -n "$v" ] || { echo "refusing to start: $1 is not set" >&2; exit 1; }; }
safe() { eval "v=\${$1}"; case "$v" in *[!A-Za-z0-9._/+=:-]*) echo "refusing to start: $1 contains characters outside A-Za-z0-9._/+=:-" >&2; exit 1;; esac; }
for n in TURN_REALM TURN_SHARED_SECRET TURN_EXTERNAL_IP TURN_CERT_FILE TURN_KEY_FILE TURN_MIN_PORT TURN_MAX_PORT; do need "$n"; safe "$n"; done
[ "${#TURN_SHARED_SECRET}" -ge 32 ] || { echo "refusing to start: TURN_SHARED_SECRET must be at least 32 characters" >&2; exit 1; }
case "$TURN_SHARED_SECRET" in *change*|*CHANGE*|*example*) echo "refusing to start: TURN_SHARED_SECRET looks like a placeholder" >&2; exit 1;; esac
case "$TURN_REALM" in localhost|*example*|*.invalid|*.test) echo "refusing to start: TURN_REALM is not a real staging hostname" >&2; exit 1;; esac
[ -r "$TURN_CERT_FILE" ] && [ -r "$TURN_KEY_FILE" ] || { echo "refusing to start: TLS certificate or key is not readable" >&2; exit 1; }
umask 077
sed -e "s|\${TURN_REALM}|$TURN_REALM|g" -e "s|\${TURN_SHARED_SECRET}|$TURN_SHARED_SECRET|g" -e "s|\${TURN_EXTERNAL_IP}|$TURN_EXTERNAL_IP|g" \
    -e "s|\${TURN_CERT_FILE}|$TURN_CERT_FILE|g" -e "s|\${TURN_KEY_FILE}|$TURN_KEY_FILE|g" -e "s|\${TURN_MIN_PORT}|$TURN_MIN_PORT|g" -e "s|\${TURN_MAX_PORT}|$TURN_MAX_PORT|g" \
    /etc/coturn/turnserver.conf.template > /run/turnserver.conf
grep -q '\${' /run/turnserver.conf && { echo "refusing to start: unresolved placeholder in the rendered config" >&2; exit 1; }
exec turnserver -c /run/turnserver.conf
