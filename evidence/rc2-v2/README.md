# RC2 evidence record v2

Baseline: **cb26ae2563ce26da181c1f4883c134b88a445ae8** (tag `rc2-evidence-baseline-v2`). It contains the emergency-number reservation (1dff4b7), the identity decision record (116a16a) and the first Redis TLS evidence (781e1e5).

The original baseline **b66f57d61d12ee8c6515be9857f3f1cb4476fa17** (tag `rc2-evidence-baseline`) and its evidence in `evidence/rc2/` are preserved unchanged: that evidence still identifies the revision it was run against and is NOT relabelled.

| File | What it is |
|---|---|
| `environment.txt` | exact SHA, clean-checkout verification, versions, certificate trust, and the load note |
| `certification-evidence.json` | the gate file: all 15 gates PENDING, with what exists locally and what is missing |
| `gate-report.json` | `npm run release:gate -- evidence/rc2-v2/certification-evidence.json --revision cb26ae2563ce26da181c1f4883c134b88a445ae8`: **BLOCKED**, `productionApproved: false` |
| `runs/engine-112-tests.tap.txt` | engine suite, 112/112 |
| `runs/redis-tls-run1..3.tap.txt` | Redis over TLS with a private CA, 3/3, three runs on this revision (positive and negative cases) |
| `runs/chromium-50-tests-PASS.txt` | Chromium: voice, group, history, TURN relay, Phone, hardening, telephony: 50/50 (one worker, 15 s assertion timeout: see below) |
| `runs/playwright.load.config.js` | the only difference from the repository's Playwright config |
| `runs/chromium-default-config-under-load-4-failed.txt`, `runs/chromium-retry-3-files-PASS.txt` | the runs that led to that override: kept, not hidden |

**Read the load note in environment.txt before relying on the Chromium result.** The machine was saturated by a background sync, the default config's timings were too tight for it, and the passing run used more patient timeouts. That is honest evidence of correctness, not of performance.

Production release: **BLOCKED**. 15 of 15 gates pending.
