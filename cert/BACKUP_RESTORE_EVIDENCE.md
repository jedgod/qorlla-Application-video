# Backup / restore drill

- Git HEAD: `5499d0af0ddbd4f6953525d08a3e41cf426e9838` (branch feature/qorlla-workplace-v4.6-provider-certification; source tree clean)
- Backup duration (quiesced): 11.67s; RTO measured (disaster -> first successful host authentication): 49.949s; backup-to-disaster gap (RPO in this drill): 9.72s

## Artifacts (hashes only; contents not stored)
- main.dump: 156415 bytes, sha256 8593bb67542b2758c8da08971cd91e1aa802ce9de06d0160b28f58cf05aaa9d6
- meet.dump: 23468 bytes, sha256 7abe4c4021813f63a9355d80be05a49c01819b4ad32c59fbafdecb5084a0a730
- workspace.tgz: 3789 bytes, sha256 6317fb11f895819411caa245e123c2a456ba3e9856ac9b98e937d548c3223701

## Checks
| Check | Result | Detail |
|---|---|---|
| backup artifacts contain no key material or secrets | PASS | checked 4 secrets against all artifacts |
| restored MAIN data volume: pre-disaster session still valid | PASS | {"u":"bk0d643e5e"} |
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
| measured RTO within target (900 s) | PASS | RTO 49.949s |

## Steps
- 2026-10-27T01:40:26.262Z seed: user, 5 synced schedules (1 passcode), 1 completed recovery, 2 pending recoveries (escrow pending)
- 2026-10-27T01:40:50.259Z pre-backup state: {"auditEvents":4,"escrow":[{"state":"acknowledged","c":1},{"state":"pending","c":2}],"schedules":6}
- 2026-10-27T01:40:50.261Z backup: quiesce MAIN + worker + Meet, dump both databases, archive MAIN data volume
- 2026-10-27T01:41:11.650Z DISASTER: destroy MAIN stack + volumes and Meet database container
- 2026-10-27T01:41:22.061Z restore: fresh Meet PostgreSQL, fresh MAIN PostgreSQL, MAIN data volume, services
- 2026-10-27T01:41:59.952Z verify

> RPO measured here is only the gap between this drill's backup and the simulated disaster. No automated backup schedule exists yet, so the RPO the product can actually guarantee is undefined until one is configured.
