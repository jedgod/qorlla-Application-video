# nginx proxy certification

- Finished: 2026-10-26T19:56:17.283Z
- Git HEAD: `5af3f8e16b4b6b32cad50ebe00e65a864fcfa42c` (branch release/qorlla-meet-v3.9.2-production-closure; source tree DIRTY:  M cert/PROXY_EVIDENCE.json,  M cert/evidence.json,  M cert/screenshots/C12-independent.png,  M cert/screenshots/C12-returned.png,  M cert/screenshots/C13-prefs.png,  M cert/screenshots/C14-passcode.png,  M cert/screenshots/C16-guest.png,  M cert/screenshots/C16-host.png,  M cert/screenshots/C24-pending.png,  M cert/screenshots/P06-proxy-passcode.png,  M cert/screenshots/P07-proxy-guest.png,  M cert/screenshots/P07-proxy-host.png)
- Ports (host): MAIN http 18080 / tls 18443; Meet http 18081 / tls 18444
- Result: **11 passed, 0 failed**

| ID | Result | Check | Detail |
|---|---|---|---|
| P01 | PASS | HTTP routing: MAIN pages, assets and API through nginx |  |
| P02 | PASS | HTTPS routing: MAIN over TLS 1.2+/HSTS; legacy TLS refused | negotiated TLSv1.3 |
| P03 | PASS | Meet reachable through nginx over HTTP and HTTPS |  |
| P04 | PASS | Internal bridge/recovery/readiness endpoints are NOT reachable through the public Meet proxy | 14 probes blocked; direct private access still works |
| P06 | PASS | Scheduled, passcode-protected meeting: join from MAIN through the public proxy routes, then leave back to MAIN |  |
| P12 | PASS | Passcode enforced through the proxy API (wrong/missing 403, correct 200) |  |
| P07 | PASS | Two browsers over HTTPS: WebSocket upgrade, real media both ways, chat both ways | wss connections: 2 |
| P11 | PASS | Persistent connection survives past nginx default 60s idle (3600s proxy timeout) with no reconnect |  |
| P08 | PASS | Session reconnection: network drop, page refresh and meeting rejoin |  |
| P09 | PASS | Authentication cookies through the proxy: HttpOnly, SameSite, Secure on HTTPS |  |
| P10 | PASS | Upstream failures: Meet down -> fast 502; MAIN down -> fast 502; both recover without nginx restart | Meet 502 in 33ms; MAIN 504 in 5034ms |
