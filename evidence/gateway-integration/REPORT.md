# SIP gateway integration verification - 2026-11-16

Status: **implemented and verified in isolation; public dial-in remains HOLD / NO-GO.**
The active qlaunch services were not restarted, migrated, or reconfigured. No Docker
containers, volumes, networks or production data were deleted. The isolated PostgreSQL
container was stopped and retained after verification.

The integration branch combines current Meet (base `5310774`) with the telephone lifecycle,
verified peer and gateway-evidence workstream (`8f97172`), and the SIP/SRTP gateway package
from workspace checkpoint `47cfc51`. It adds a managed runtime, actual mutual-TLS listener,
certificate-backed signaling, signed media-bridge heartbeats, and guarded breakout coexistence.
This is a source integration, not a merge or deployment.

## Observed results

| Check | Actual result | Limits |
|---|---|---|
| Managed runtime identity/heartbeat | 3 passed | Validates signatures/body/certificate claims and startup refusals |
| Dedicated mutual-TLS listener | 2 passed | Rejects no-certificate clients; actual verified certificate visible; unrelated routes return 404 |
| SIP/media suite | 67 passed, 0 failed, 1 skipped | Synthetic telephone and werift browser stand-ins; no carrier. Redis-dependent full-pipeline case skipped |
| Combined Meet auth/lifecycle/peer/server | 56 passed, 3 failed | Failures concern wall-clock timing on a saturated host; not counted as passes |
| Deterministic media-freshness follow-up | 1 passed | Test sets database evidence ages directly; production deadlines unchanged |
| Chat, More and breakout regressions | 41 passed, 0 failed | Includes blocking breakout start while a telephone admission exists |
| Real Chromium + separate gateway + actual Meet | 1 passed, 0 failed | Synthetic SIP/SRTP caller, HMAC-authenticated test provider and lab readiness fixture; not carrier certification |

Real-browser audio evidence is in `chrome/first-successful-call.json`. Meet accepted **PCMU,
encrypted media, 74 inbound packets and 52 outbound packets over 509 ms** before promoting
the caller through APPROVED -> MEDIA_CONNECTING -> MEDIA_CONNECTED. The phone received
the 1000 Hz and 1500 Hz browser tones; both browsers received the phone's 440 Hz tone.
Tests also checked absent self-audio and the separate meeting's 2000 Hz tone. Hang-up ended
the call, revoked its credential, released its RTP port, and left browser-to-browser audio
connected (received-packet count continued from 1051 to 1203). This is measured integration
behavior, not a latency, capacity or production interoperability certification.

## Unresolved checks and activation boundary

Two host CPU samples were **100%**. Active resource consumers included vmmemWSL, OneDrive,
MsMpEng and WmiPrvSE. The combined-server run failed a 1.2-second freshness timing assertion,
a host-decision wall-clock bound, and a 1.5-second test media-setup window. The freshness
assertion now uses controlled database ages and passed its targeted follow-up; the other
wall-clock failures remain blockers. No application timeout was increased to make tests pass.
No performance certification or load test was attempted.

The managed runtime has no readiness override. The existing no-restart instruction prevents
activating the new backend in qlaunch-meet-1 without a maintenance-window approval.
Deployment also needs operator-owned TLS/workload keys, a restricted gateway database role,
authorized SIP/trunk routing, number/provider evidence, and independently certified gates.
The present UDP SIP ingress still needs SIP/TLS/SBC and physical-phone/carrier verification
before production release. Gateway-level host mute and telephone recording-consent command
handling also require completion/certification before public enablement; the existing host
mute endpoint explicitly reports that bridge muting is unavailable rather than claiming
that it silences RTP. Recording remains subject to the existing consent gates.

Recommendation: **commit/push for review; do not enable public dial-in.** Resolve host load,
rerun the remaining timing checks, finish operator configuration and outstanding media controls,
then schedule a controlled activation and carrier/physical-phone certification. See
`qorlla-phone-join/docs/RUNNING_ADAPTER_INTEGRATION.md` for the staged rollout.
