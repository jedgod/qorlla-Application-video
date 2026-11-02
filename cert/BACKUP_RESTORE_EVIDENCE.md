# Backup / restore drill

- Git HEAD: `782cd39b6e96a84ae95a1bf45a26a32e6a2e3386` (branch release/qorlla-meet-v3.9.2-production-closure; source tree DIRTY:  M cert/EVIDENCE.md,  M cert/PROXY_EVIDENCE.json,  M cert/PROXY_EVIDENCE.md,  M cert/SECURITY_EVIDENCE.json,  M cert/SECURITY_EVIDENCE.md,  M cert/evidence.json,  M cert/screenshots/C16-guest.png,  M cert/screenshots/C16-host.png,  M cert/screenshots/C24-pending.png,  M cert/screenshots/P06-proxy-passcode.png,  M cert/screenshots/P07-proxy-guest.png,  M cert/screenshots/P07-proxy-host.png)
- Backup duration (quiesced): 9.216s; RTO measured (disaster -> first successful host authentication): 45.756s; backup-to-disaster gap (RPO in this drill): 8.175s

## Artifacts (hashes only; contents not stored)
- main.dump: 13325 bytes, sha256 7796ce176cb609f8f1c8010f3ae2ccc421ddac422b19f2280f3532a5454c8707
- meet.dump: 23471 bytes, sha256 403e88e804f355d5a0aba4bc9c2eec7a351aeb8e6035e753768c50a3c8bba65f
- workspace.tgz: 41451 bytes, sha256 50b6d9653a06aa7d41eb5586d8c538eab69fd181231d09d43cb90f38f930dfb9

## Checks
| Check | Result | Detail |
|---|---|---|
| backup artifacts contain no key material or secrets | PASS | checked 4 secrets against all artifacts |
| restored MAIN data volume: pre-disaster session still valid | PASS | {"u":"bkfc63adc8"} |
| schedules restored consistently (JSON volume and PostgreSQL agree) | PASS | restored=6, marker absent in both stores |
| legacy codes still resolve to the same meetings | PASS | 6 schedules |
| post-restore host authentication with vaulted secrets | PASS | schedules 0-2 |
| completed recovery (acked pre-backup) host secret still valid | PASS | 200 |
| pending encrypted escrow recoverable after restore (same request replays same secret) | PASS | 200 |
| wrong RECOVERY_ESCROW_KEY cannot decrypt escrow (fails closed, no secret leaked) | PASS | status 503 |
| correct key (from secure backup) recovers the escrow | PASS | 200 |
| restored sync worker completes outstanding acknowledgments; no escrow left pending | PASS | pending=0 |
| audit log preserved and sequence continues (no id reuse) | PASS | before=4/4 after=12/12 |
| schedule reconciliation works after restore (edit + new schedule sync) | PASS | ok |
| measured RTO within target (900 s) | PASS | RTO 45.756s |

## Steps
- 2026-10-26T20:40:29.758Z seed: user, 5 synced schedules (1 passcode), 1 completed recovery, 2 pending recoveries (escrow pending)
- 2026-10-26T20:40:49.791Z pre-backup state: {"auditEvents":4,"escrow":[{"state":"acknowledged","c":1},{"state":"pending","c":2}],"schedules":6}
- 2026-10-26T20:40:49.793Z backup: quiesce MAIN + worker + Meet, dump both databases, archive MAIN data volume
- 2026-10-26T20:41:07.184Z DISASTER: destroy MAIN stack + volumes and Meet database container
- 2026-10-26T20:41:16.137Z restore: fresh Meet PostgreSQL, fresh MAIN PostgreSQL, MAIN data volume, services
- 2026-10-26T20:41:51.920Z verify

> RPO measured here is only the gap between this drill's backup and the simulated disaster. No automated backup schedule exists yet, so the RPO the product can actually guarantee is undefined until one is configured.
