# ASCS M1.3 resource cleanup inspection

Decision: HOLD / NO-GO for performance certification.

No containers were stopped, restarted, deleted, or created by this execution. No volumes, networks, or data were deleted. No merge, tag, or deployment was performed. OneDrive was not paused or terminated.

## Docker findings

All existing containers labelled with the approved candidate Compose projects were already exited at inspection:

| Project | Existing exited containers | Running |
|---|---:|---:|
| qclk | 7 | 0 |
| qbc2 | 7 | 0 |
| qiso | 7 | 0 |
| qtls | 7 | 0 |
| qsbacs | 7 | 0 |
| qai | 7 | 0 |

This differs from the supplied qsbacs count of five. No shutdown was needed or attempted, and qai isolation/inactivity was not certified. Candidate labels identify C:\Users\cj_wo\qv-shield as their Compose working directory. Mount and dependency clearance was not completed because no candidate was running and no stop action was needed.

Exact containers stopped by this execution: **none**. Already-exited state does not establish who stopped a container or why.

32 containers were running. All observed configured Docker health checks on running containers reported healthy in the initial full inspection. Preserved: qlaunch project, qlaunch-turn, qlaunch-voice, qlaunch-voice-db, qollama, qm13-turn, qm13-redis, qascs-test-pg, qnoai (7), az-ai-pipeline (2), azee-staging-local (1), qorlla-clips-dev (4), and server/Linqa (4). Several services have no Docker health check; running status alone is not application-level health evidence. Final verification is recorded separately if available.

## Actual host measurements

- Initial memory: 33,291,084 KiB total, 5,969,164 KiB free (approximately 26.06 GiB used / 31.75 GiB total).
- Later memory: 5,588,752 KiB free (approximately 26.42 GiB used).
- First CPU series: 100%, 100%, 100%, 100%, 100% at two-second intervals.
- Subsequent CPU series: 100%, 100%, 99.7077% at one-second intervals.
- No before/after cleanup improvement can be attributed: no cleanup mutation occurred.

Short process CPU sample, normalized across logical processors: explorer PID 5328 19.1%; git PID 21736 11.2%; ChatGPT PID 17376 5.8%; OneDrive PID 12488 4.8%; python PID 20816 4.3%; Code PID 25128 4.1%; Code PID 23344 3.1%; OneDrive PID 7352 2.6%; OneDrive.Sync.Service PID 3824 1.7%. This is a short sample, not a complete attribution of total CPU or a sustained profile. No process was terminated.

Docker stats showed remaining containers mostly low CPU; qnoai_proxy was the highest sampled container at 10.25% Docker CPU. Docker CPU percentages use a different denominator from normalized host process CPU. They are not directly comparable.

## OneDrive and certification

OneDrive transfer health and active edits could not be verified. Computer-use list_apps timed out twice; after resetting and reinitializing, the final attempt also timed out. Normal pause controls were unavailable. Sync was never paused, so no resume operation was required. Normal synchronization health remains unverified.

Section H: not run. The M1.3 harness was not located in the current workspace or the attempted qv-shield/qv-docs-history text searches.

Load test: not run; no latency, throughput, or resource-threshold pass claimed.

Three independent repeatability runs: not run; no pass evidence claimed.

Host saturation persisted after confirming all shutdown candidates already exited. Per the user instruction, performance certification was held. The recommended 60% baseline was not treated as a project acceptance threshold. All values above are measurements, not extrapolations.

No environment values or credential-bearing log contents were intentionally printed or saved. No files were committed.

Remaining blockers: sustained host CPU saturation; unavailable OneDrive UI/transfer verification; missing verified M1.3 test entry points and acceptance documentation; application-level checks for containers without health checks. Resolve these before issuing a GO-GO recommendation.

## Final verification
Final CPU samples were 100%, 100%, 100%. All named protected services remained running; configured health checks remained healthy, and inspected restart counts were zero. Some unrelated containers changed state between snapshots without any start/stop commands from this execution, so concurrent external activity is possible and the host was not a controlled certification environment.

## Recheck after user paused two drives

The user reported pausing two drives; the Bowie State account lacks a Pause syncing menu option and remained running. No OneDrive controls or processes were changed by this execution.

CPU: ten samples at two-second intervals, all 100%. Memory: 33,291,084 KiB total, 5,346,020 KiB free (approximately 26.65 GiB used of 31.75 GiB).

Short normalized host-process CPU sample: OneDrive.Sync.Service PID 3824 13.6%; OneDrive PID 12488 13.2%; Code PID 3276 2.9%; com.docker.backend PID 17988 2.6%; Code PID 23344 1.9%; Code PID 22248 1.4%. These top processes do not fully account for the measured host saturation; no complete attribution is claimed. Process names alone do not identify the OneDrive account associated with each PID.

All named protected containers remained running. Configured Docker health checks were healthy, with zero inspected restart counts. Application-level health for services without health checks remains unverified.

Performance certification remains HOLD / NO-GO due to sustained CPU saturation. No Section H, load, or repeatability runs were performed in this recheck. No services were stopped or restarted. User-paused drives were not resumed by this execution; the certification testing phase did not begin.
