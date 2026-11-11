TLS certificate directory for the nginx proxy: server.pem + server.key (never committed).
Generate a throwaway pair for testing with cert/run-proxy-cert.mjs, or supply a real certificate.

## HTTPS on a local network (development)
Camera and microphone work only on a trusted `https://` page (or `localhost`). A certificate warning that was clicked through does not count.
1. `MSYS_NO_PATHCONV=1 deploy/certs/make-lan-cert.sh <lan-ip> <output-dir>` (needs `openssl`); it creates a private CA (`ca.crt`, `ca.key`) and a server certificate for the LAN address, `localhost` and `127.0.0.1`. Keep `ca.key` private; nothing here is committed.
2. Install `ca.crt` on every device that should trust the stack: Windows (`certutil -user -addstore Root ca.crt`, then confirm the prompt), Android (Settings > Security > Encryption & credentials > Install a certificate > CA certificate), iOS (install the profile, then Settings > General > About > Certificate Trust Settings).
3. Add `-f deploy/docker-compose.lan-tls.yml` LAST to the usual compose files, with `LAN_IP=<lan-ip> LAN_CERT_DIR=<output-dir>`, and recreate `workspace-signaling-engine`, `meet` and `dashboard-client-proxy`. HTTPS is on `PROXY_MAIN_TLS_PORT` (main) and `PROXY_MEET_TLS_PORT` (Meet); the http ports keep working.
4. Qorlla Voice is reached through `/voice/` on the same origin (the engine's admin API is not routed). Add the https origins to the voice engine's `VOICE_ALLOWED_ORIGIN`.
5. The certificate is valid for the address it was made for (397 days): make a new one if the LAN address changes (give the machine a reserved address).
