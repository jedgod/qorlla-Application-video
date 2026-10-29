# RC2 evidence record

Baseline: **b66f57d61d12ee8c6515be9857f3f1cb4476fa17** (tag `rc2-evidence-baseline`). Every record in this folder is for that exact commit.

- `certification-evidence.json`: the gate file. All 15 gates are **PENDING**: what exists is local (one machine), what is missing is listed per gate. A developer machine cannot pass QVE-04/05/09/10/12/15 and nothing here claims to.
- `gate-report.json`: output of `npm run release:gate -- evidence/rc2/certification-evidence.json --revision b66f57d61d12ee8c6515be9857f3f1cb4476fa17`. Result: **BLOCKED**, `productionApproved: false`.
- `QVE-02-11_redis-tls_local/`: three runs of the Redis-over-TLS test on a clean checkout of the baseline, with the environment.
- The live check of the running application (6 screenshots) is preserved in `.dev-stack/live-check/` (not copied; that folder is git-ignored and must not be wiped before review).

Next evidence to collect, in order: Redis TLS with a real certificate chain + TURN across networks, two replicas behind a real load balancer, PostgreSQL failover, physical devices, independent load, observability drill, security review. Run sheets: docs/VOICE_RC2_EVIDENCE_PLAN.md. Note: the later commit 1dff4b7 (emergency numbers reserved) is NOT in this baseline.
