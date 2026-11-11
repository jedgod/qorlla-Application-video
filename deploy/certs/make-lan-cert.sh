#!/usr/bin/env bash
# Local-network HTTPS for a development stack: a private CA plus a server certificate for this machine's LAN address.
#   deploy/certs/make-lan-cert.sh 10.0.0.176 [output-dir]
# Writes ca.crt (install it on every device that should trust the stack), ca.key (keep private), server.pem, server.key.
# Nothing here is committed: point PROXY_CERT_DIR at the output directory and PROXY_TLS_CONF at deploy/nginx/tls.conf.
# Browsers only allow camera and microphone on https:// (or localhost): a certificate error that was clicked through does NOT count, so the CA must be installed.
set -euo pipefail
IP="${1:?usage: make-lan-cert.sh <lan-ip> [output-dir]}"; OUT="${2:-$HOME/qorlla-lan-tls}"
mkdir -p "$OUT"; cd "$OUT"
if [ ! -f ca.key ]; then
  openssl genrsa -out ca.key 4096 2>/dev/null
  openssl req -x509 -new -nodes -key ca.key -sha256 -days 1825 -subj "/O=Qorlla local development/CN=Qorlla Local Development CA" -out ca.crt
fi
openssl genrsa -out server.key 2048 2>/dev/null
cat > server.ext <<EXT
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:${IP},IP:127.0.0.1,DNS:localhost
EXT
openssl req -new -key server.key -subj "/O=Qorlla local development/CN=${IP}" -out server.csr
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 397 -sha256 -extfile server.ext 2>/dev/null
cat server.crt ca.crt > server.pem; chmod 600 ca.key server.key 2>/dev/null || true
echo "CA (install on devices): $OUT/ca.crt"; echo "Server certificate for ${IP}, localhost, 127.0.0.1: $OUT/server.pem (valid 397 days)"
