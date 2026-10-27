# nginx proxy certification

- Finished: 2026-10-26T20:16:36.980Z
- Git HEAD: `f3e5ef721c45cb724ab2c6387562f69e3fbc5283` (branch release/qorlla-meet-v3.9.2-production-closure; source tree DIRTY:  M cert/BACKUP_RESTORE_EVIDENCE.md,  M cert/PROXY_EVIDENCE.json,  M cert/SECURITY_EVIDENCE.json,  M cert/SECURITY_EVIDENCE.md,  M cert/screenshots/P06-proxy-passcode.png,  M cert/screenshots/P07-proxy-guest.png,  M cert/screenshots/P07-proxy-host.png, ?? qorlla-meet-video/qorlla-portal-v4/Qorlla_Workplace_v4_2_to_v4_5_Extension/)
- Ports (host): MAIN http 18080 / tls 18443; Meet http 18081 / tls 18444
- Result: **7 passed, 4 failed**

| ID | Result | Check | Detail |
|---|---|---|---|
| P01 | PASS | HTTP routing: MAIN pages, assets and API through nginx |  |
| P02 | PASS | HTTPS routing: MAIN over TLS 1.2+/HSTS; legacy TLS refused | negotiated TLSv1.3 |
| P03 | PASS | Meet reachable through nginx over HTTP and HTTPS |  |
| P04 | PASS | Internal bridge/recovery/readiness endpoints are NOT reachable through the public Meet proxy | 14 probes blocked; direct private access still works |
| P06 | PASS | Scheduled, passcode-protected meeting: join from MAIN through the public proxy routes, then leave back to MAIN |  |
| P12 | PASS | Passcode enforced through the proxy API (wrong/missing 403, correct 200) |  |
| P07 | PASS | Two browsers over HTTPS: WebSocket upgrade, real media both ways, chat both ways | wss connections: 2 |
| P11 | FAIL | Persistent connection survives past nginx default 60s idle (3600s proxy timeout) with no reconnect | a websocket closed during idle |
| P08 | FAIL | Session reconnection: network drop, page refresh and meeting rejoin | Timed out waiting for chat after reconnect (last: false) |
| P09 | FAIL | Authentication cookies through the proxy: HttpOnly, SameSite, Secure on HTTPS | fetch failed [cause: ECONNREFUSED] |
| P10 | FAIL | Upstream failures: Meet down -> fast 502; MAIN down -> fast 502; both recover without nginx restart | fetch failed [cause: ECONNREFUSED] |
