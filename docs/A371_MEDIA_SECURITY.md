# A3.7.1 Media Security & TURN Certification report

**Release status: BLOCKED. All 15 release gates remain pending. No gate is marked passed.**
**Code under test: `ef12575f1dacd76038700b23da6a1b54312c9ef5`** on `feature/a371-media-security-certification` (from `269ddf4`, the A3.7 checkpoint). Not pushed. Flags during every run: `VOICE_COUNTRY_ALIAS_ENABLED=false`, `VOICE_PSTN_ENABLED=false`, `VOICE_A38_ENABLED=false` (the engine now refuses to start with the last one `true`). The A3.7 numbering authority is untouched.
Environment: Windows 11, Docker 29.9.2, coturn 4.17.0, Redis 7, PostgreSQL (dev stack), Node 22, Chromium (Playwright).

## What was built
Suspension used to end signaling only; an established relayed (or peer-to-peer) media stream was not guaranteed to stop. The engine now controls the relay:
- `TURN_AUTH_MODE=userdb`: coturn runs `--lt-cred-mech --redis-userdb --cli`. The engine issues an opaque, short-lived (default 600 s, clamped to 5-3600 s), per-account credential stored in coturn's Redis user database. The password is `HMAC(TURN_CREDENTIAL_SECRET, username)`; Redis holds only coturn's own MD5 key, never the password.
- On principal suspension, organization suspension and administrative identity disable the engine deletes the account's credentials, then cancels every live allocation through the coturn admin CLI. A failure to do so records a critical `media_termination_failure` alert (migration `018`), never silence.
- `/v1/voice/ice` issues nothing to a suspended or disabled account (403), re-checked after the credential is written to close the race with a concurrent revocation.
- Default mode (`rest`, stateless HMAC credentials) is unchanged and **cannot** revoke before expiry; with the CLI configured it can still cancel live allocations. Production media control needs `userdb`.

Findings that shaped the design (verified on coturn 4.17.0): without `--lt-cred-mech` coturn accepts **anonymous** allocations; the CLI is off unless `--cli`; **deleting a credential does not stop an allocation that is already running** (a refresh with the deleted credential still succeeded until the session was cancelled), so the CLI cancel is the part that stops media.

## Results
| Item | Result | Evidence |
|---|---|---|
| Anonymous, wrong, tampered, foreign-account and expired TURN credentials refused (401) | **PASSED** | test 1, real coturn |
| Credentials opaque (no account id), scoped to one account, expire in Redis, password/secret never stored | **PASSED** | test 1 |
| No credential multiplication on ICE restart (same credential reused while >40% of life remains) | **PASSED** | test 1 |
| Suspension during an active relayed flow: packets delivered before, **0 after**; suspend request returned in 122 ms (budget 3000 ms) | **PASSED** | test 2, `media-evidence-ef12575.json` |
| Old credential cannot allocate or refresh after suspension; restore issues a NEW credential and the old stays dead | **PASSED** | test 2 |
| Relay shows no allocation left after suspension | **PASSED** | test 2 (coturn CLI `ps`) |
| Organization suspension and administrative disable end media; repeat is harmless | **PASSED** | test 3 |
| Engine restart (both instances killed) and two instances (B issues, A revokes): revoked credential and suspension still refused | **PASSED** | test 4 |
| Relay unreachable: credentials still deleted (no new allocation) and a critical alert is recorded; bad TURN config and `VOICE_A38_ENABLED=true` refuse to start | **PASSED** | test 5 |
| Engine regression (`npm test`) | **PASSED 176/176** (171 + 5 new), 0 skipped | run on the same code |
| Playwright regression (9 specs, chromium, 1 worker) | **PASSED 61/61** on the clean full run | first full run had 1 failure in the three-browser group-call test (`voice-reliability`), which passed 6/6 on two isolated reruns and in the clean full rerun; treat as load-sensitive, not explained |
| Browser-level (Chromium) proof that media stops with client cooperation disabled | **NOT DONE** | engine-level proof only; a Playwright relay-only media-stop spec is still to be written |
| Cross-network TURN on two physical devices, relay-only ICE evidence | **BLOCKED** | cannot be run here; `docs/A371_FIELD_TEST_RUNBOOK.md` F1-F2 |
| ICE restart, network switching, credential expiry mid-call on real devices | **BLOCKED** | runbook F3-F5 |
| Suspension during a real browser call across networks; reconnect with old credentials | **BLOCKED** | runbook F6-F8 |
| Packet capture evidence | **BLOCKED** | needs a real network path |
| Multi-host, PostgreSQL failover | **NOT STARTED** | next workstream |

## Honest limits
- The tests ran on one machine. "Two instances" are two engine processes sharing PostgreSQL and the Redis TURN database, not two hosts.
- The relay→client direction is proven (peer → relay port → client). The client→peer direction could not be observed because Docker Desktop does not let the relay reach a host-side UDP peer; the cancel acts on the whole allocation, so it covers both directions, but only one was measured.
- The measured stop time (122 ms) is the relay allocation being cancelled on a LAN; internet round trips and client behaviour add to it. The security budget (3 s) is for the server action, not for a person's phone.
- Established **peer-to-peer** media (no relay) is still not stoppable by the server. Only `VOICE_RELAY_ONLY=true` with `userdb` mode makes server-enforced termination meaningful; there is no SFU in this repository.
- The coturn CLI password and the Redis user database are high-value secrets (anyone holding them can mint or cancel allocations). Production needs network isolation, TLS, Redis ACL/auth and secret management; none of that exists here.
- The CLI session listing can show one user's allocation under several ids; revocation cancels all of them and then re-checks.

## Reproduce
`scripts/a371-turn-up.sh` (containers `a371-turn`, `a371-redis`, network `a371-net`; `... down` removes them), then in `qorlla-voice-engine`: `node --test test/turn-control.pg.test.mjs` (SKIPPED, not passed, if the containers are missing). Evidence for this SHA: `docs/evidence/a371/media-tests-ef12575.tap`, `media-evidence-ef12575.json`.

## Next
Browser-level media-stop spec; physical-device runbook execution; then multi-host and PostgreSQL failover. A3.8 prepaid calling was reviewed only and is not implemented or enabled.
