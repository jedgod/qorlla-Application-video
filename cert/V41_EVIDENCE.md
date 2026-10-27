# Workplace v4.1 certification evidence

- Git HEAD: `86b39ba518c255ede6d01549119b9d769b550c5b` (branch feature/qorlla-workplace-v4.6-provider-certification; source tree DIRTY:  M cert/e2e-results.json,  M cert/portal-unit.tap)
- Result: **10 passed, 1 failed**
- Payment provider = local TEST DOUBLE; real-provider verification is BLOCKED (no account/keys, no authorization to collect payments).

| ID | Result | Check | Detail |
|---|---|---|---|
| U-ALL | PASS | portal node:test suites (auth, billing lifecycle, entitlements, sales, migrations/rollback, real-MAIN contract) | 168 passed, 0 failed |
| D01 | PASS | docker compose config is valid and every long-running service has a restart policy | 7 services: dashboard-client-proxy, main-db, meet, meet-db, meet-sync-worker, qorlla-portal, workspace-signaling-engine |
| D02 | PASS | unified stack builds and every service becomes healthy (main, portal, meet, databases, nginx) | main-db=healthy meet=healthy meet-db=healthy meet-sync-worker=running qorlla-portal=healthy workspace-signaling-engine=healthy dashboard-client-proxy=healthy |
| D03 | PASS | single HTTPS entry point: only nginx listens on public interfaces; app services bind loopback or nothing | only dashboard-client-proxy (nginx) is published on 0.0.0.0 |
| D04 | PASS | containers run unprivileged; structured JSON logs from portal and nginx; no secrets in logs | 4 portal and 1 nginx JSON lines parsed |
| D05 | PASS | least-privilege roles: portal role can only touch the portal schema |  |
| D06 | PASS | portal fails closed (503) while authentication is not operational, and answers 401 once configured | 503 ["MAIN_AUTH_ISSUER","MAIN_AUTH_JWKS_URL","PORTAL_ALLOWED_ORIGIN","MAIN_INTROSPECTION_URL + PORTAL_INTROSPECTION_SECRET (>=32 chars)"] |
| D08 | PASS | a platform admin can be provisioned (configuration only) and the console + metrics are not reachable by anyone else | admin id configured; /internal/metrics is not routed publicly |
| D09 | PASS | metrics are served inside the private network only, with the bearer token, as Prometheus text with no secrets | 9 gauges |
| E2E | FAIL | browser E2E: pricing, checkout/webhook, portal auth, navigation, mobile, Meet under /meet/, meeting-to-report | 0 passed, 0 failed |
| D07 | PASS | restart resilience: portal and nginx restart cleanly and the site keeps serving |  |

## Browser E2E test titles
