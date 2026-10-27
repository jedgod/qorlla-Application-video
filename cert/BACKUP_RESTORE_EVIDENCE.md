# Backup / restore drill

- Git HEAD: `16cfdc45038ed5de1f5a2da945fe4bfcaa6f8ec5` (branch release/qorlla-meet-v3.9.2-production-closure; source tree DIRTY:  M cert/SECURITY_EVIDENCE.json,  M cert/SECURITY_EVIDENCE.md)
- Backup duration (quiesced): 9.983s; RTO measured (disaster -> first successful host authentication): 45.355s; backup-to-disaster gap (RPO in this drill): 7.736s

## Artifacts (hashes only; contents not stored)
- main.dump: 74337 bytes, sha256 323aa95fa53806b32784e3f06c10a99d65a2cb636e1dfa51a986e04b17fe9467
- meet.dump: 136101 bytes, sha256 1e695125118734ad16f2077da2a5d63bb56a2633af591102ce003537563f6240
- workspace.tgz: 22862 bytes, sha256 e00e41fe4e55b9b8278c024c4fc4656d05e758715df6cc66380d36563d4df278

## Checks
| Check | Result | Detail |
|---|---|---|
| backup artifacts contain no key material or secrets | PASS | checked 4 secrets against all artifacts |
| restored MAIN data volume: pre-disaster session still valid | PASS | {"u":"bkeaee7d25"} |
| schedules restored consistently (JSON volume and PostgreSQL agree) | PASS | restored=6, marker absent in both stores |
| legacy codes still resolve to the same meetings | PASS | 6 schedules |
| post-restore host authentication with vaulted secrets | PASS | schedules 0-2 |
| completed recovery (acked pre-backup) host secret still valid | PASS | 200 |
| pending encrypted escrow recoverable after restore (same request replays same secret) | PASS | 200 |
| wrong RECOVERY_ESCROW_KEY cannot decrypt escrow (fails closed, no secret leaked) | PASS | status 503 |
| correct key (from secure backup) recovers the escrow | PASS | 200 |
| restored sync worker completes outstanding acknowledgments; no escrow left pending | PASS | pending=0 |
| audit log preserved and sequence continues (no id reuse) | PASS | before=657/657 after=665/665 |
| schedule reconciliation works after restore (edit + new schedule sync) | PASS | ok |
| measured RTO within target (900 s) | PASS | RTO 45.355s |

## Steps
- 2026-10-26T20:11:56.267Z seed: user, 5 synced schedules (1 passcode), 1 completed recovery, 2 pending recoveries (escrow pending)
- 2026-10-26T20:12:20.514Z pre-backup state: {"auditEvents":657,"escrow":[{"state":"acknowledged","c":48},{"state":"pending","c":4}],"schedules":6}
- 2026-10-26T20:12:20.515Z backup: quiesce MAIN + worker + Meet, dump both databases, archive MAIN data volume
- 2026-10-26T20:12:38.234Z DISASTER: destroy MAIN stack + volumes and Meet database container
- 2026-10-26T20:12:47.297Z restore: fresh Meet PostgreSQL, fresh MAIN PostgreSQL, MAIN data volume, services
- 2026-10-26T20:13:22.220Z verify

> RPO measured here is only the gap between this drill's backup and the simulated disaster. No automated backup schedule exists yet, so the RPO the product can actually guarantee is undefined until one is configured.
