# Meet regression comparison (kept visible in the certification report)

Controlled A/B on the same Windows host, alternating order every round, host CPU recorded per run. NEW = current Meet (with the Qorlla AI consent changes, isolated project `qai`). BASE = Meet before any of those changes (commit 5e74232, isolated project `qbase`). Traces, screenshots and console logs of every failing run are kept OUTSIDE git (230 MB) in `C:\Users\cj_wo\qv-shield-evidence\meet-regression\`; the per-test `summary.json` files are here.

| Test | NEW | BASE | Classification |
|---|---|---|---|
| Layout while sharing (`meet-controls: the video page fits the window ...`) | 3/12 passed | 2/12 passed | Existing flakiness, BASELINE-REPRODUCIBLE under host load (same assertion: a tile 497 px wide, expected > 994). Not a regression from the Meet AI changes. NOT resolved: the test is load-sensitive and needs a stability fix. |
| Screen share never mirrors itself (`meet-controls`) | 3/3 passed | 1/3 passed (2 fail on `.tile.sharing-remote` count) | Existing intermittent defect, BASELINE-REPRODUCIBLE (small sample). |
| Two browsers meet under /meet/ (`meet-route`) | 0/3 | 0/3 | Existing defect, BASELINE-REPRODUCIBLE: fails identically on the unmodified build in this environment. |

Host condition during all runs: CPU load 100% (OneDrive, Defender, WSL VM). Earlier "passes" of the layout test (14 of 14 on NEW, 8 of 8 on BASE) were taken at lower host load and are NOT treated as resolution.
