# Backup / restore drill

- Git HEAD: `5af3f8e16b4b6b32cad50ebe00e65a864fcfa42c` (branch release/qorlla-meet-v3.9.2-production-closure; source tree DIRTY:  M cert/PROXY_EVIDENCE.json,  M cert/PROXY_EVIDENCE.md,  M cert/evidence.json,  M cert/run-security.mjs,  M cert/screenshots/C12-independent.png,  M cert/screenshots/C12-returned.png,  M cert/screenshots/C13-prefs.png,  M cert/screenshots/C14-passcode.png,  M cert/screenshots/C16-guest.png,  M cert/screenshots/C16-host.png,  M cert/screenshots/C24-pending.png,  M cert/screenshots/P06-proxy-passcode.png,  M cert/screenshots/P07-proxy-guest.png,  M cert/screenshots/P07-proxy-host.png,  M qorlla-meet-video/package-lock.json,  M qorlla-meet-video/package.json,  M qorlla-meet-video/server/index.js, ?? qorlla-meet-video/server/threadpool.js)
- Backup duration (quiesced): 11.537s; RTO measured (disaster -> first successful host authentication): 45.401s; backup-to-disaster gap (RPO in this drill): 7.671s

## Artifacts (hashes only; contents not stored)
- main.dump: 47349 bytes, sha256 1ccbea83b4bd881a90302069d0724e28fdf62e21fa41ccde9026601d0eed1f70
- meet.dump: 84251 bytes, sha256 677f19b861a4ae9b9bc6c21f6c6df151a71498e12f0975e353cc82ef87d51ad6
- workspace.tgz: 15330 bytes, sha256 06ef19184183292e8b87e53e84af677e8b1ddb25c44b2a294383f82ffd582713

## Checks
| Check | Result | Detail |
|---|---|---|
| backup artifacts contain no key material or secrets | PASS | checked 4 secrets against all artifacts |
| restored MAIN data volume: pre-disaster session still valid | PASS | {"u":"bkf676fa1c"} |
| schedules restored consistently (JSON volume and PostgreSQL agree) | PASS | restored=6, marker absent in both stores |
| legacy codes still resolve to the same meetings | PASS | 6 schedules |
| post-restore host authentication with vaulted secrets | PASS | schedules 0-2 |
| completed recovery (acked pre-backup) host secret still valid | PASS | 200 |
| pending encrypted escrow recoverable after restore (same request replays same secret) | PASS | 200 |
| wrong RECOVERY_ESCROW_KEY cannot decrypt escrow (fails closed, no secret leaked) | PASS | status 503 |
| correct key (from secure backup) recovers the escrow | PASS | 200 |
| restored sync worker completes outstanding acknowledgments; no escrow left pending | FAIL | pending=1 |
| audit log preserved and sequence continues (no id reuse) | PASS | before=344/344 after=352/352 |
| schedule reconciliation works after restore (edit + new schedule sync) | PASS | ok |
| measured RTO within target (900 s) | PASS | RTO 45.401s |

## Steps
- 2026-10-26T20:06:44.123Z seed: user, 5 synced schedules (1 passcode), 1 completed recovery, 2 pending recoveries (escrow pending)
- 2026-10-26T20:07:07.468Z pre-backup state: {"auditEvents":344,"escrow":[{"state":"acknowledged","c":25},{"state":"pending","c":3}],"schedules":6}
- 2026-10-26T20:07:07.469Z backup: quiesce MAIN + worker + Meet, dump both databases, archive MAIN data volume
- 2026-10-26T20:07:26.677Z DISASTER: destroy MAIN stack + volumes and Meet database container
- 2026-10-26T20:07:35.954Z restore: fresh Meet PostgreSQL, fresh MAIN PostgreSQL, MAIN data volume, services
- 2026-10-26T20:08:10.901Z verify

> RPO measured here is only the gap between this drill's backup and the simulated disaster. No automated backup schedule exists yet, so the RPO the product can actually guarantee is undefined until one is configured.
