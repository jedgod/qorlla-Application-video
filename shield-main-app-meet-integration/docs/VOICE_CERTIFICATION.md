# Qorlla Voice: release certification (gates DR-01..DR-10 and QVE-01..QVE-15)

**Verdict: BLOCKED / NOT CERTIFIED.** Version 1.9 alone does not establish production readiness. Production approval stays blocked until the real Qorlla deployment passes integration, security, failover and real-audio testing, with evidence a person has reviewed.

"Local evidence" below means: the test ran on one developer machine against real PostgreSQL / Redis / coturn containers and headless Chromium with a synthetic microphone (plus, for deployment wiring, a two-node Docker staging on that same machine). That shows the design works; it is not a staged or field certification.

## The release gate
`npm run release:gate -- certification-evidence.json [--revision <sha>] [--record]` (in `qorlla-voice-engine/`). Copy `certification-evidence.example.json` and fill every gate. A gate counts only with: status `PASS`; an evidence description (log/report/recording, >= 20 characters); an operator; a valid past timestamp; the right revision; for QVE-04/05/09/10/12/15 an environment of `staging`, `production-like` or `production` (a developer machine cannot pass them); for QVE-11/12/14 a reviewer who is not the operator. The script cannot verify that evidence is true, so its best result is `EVIDENCE_RECORDED_REVIEW_REQUIRED` with `productionApproved: false`. Verified in `test/release-gate.test.mjs`; the shipped template is BLOCKED on all 15 gates. `--record` writes the run to `voice_certification_runs` (an audit trail, never an approval).

## QVE gates: what exists, what is missing
| Gate | Required demonstration | Local evidence | Missing for release |
|---|---|---|---|
| QVE-01 | Transactions atomically commit call state and outbox rows | `reliability.pg.test.mjs`: a database that fails the outbox insert rolls back the call, key and events; retry makes exactly one call; transitions, ring timeout, suspension write events in the same transaction | Crash of the real database process mid-COMMIT |
| QVE-02 | Redis down during call creation: event retained, later delivered | `distributed.redis.test.mjs`: Redis stopped during calls; events stay pending; backlog drains by itself after restart; **a stream of events for one account across the outage reaches a socket on the other replica complete and in order, and nothing is set aside**; **Redis over TLS (`rediss://`) with a private certificate authority and the least-privilege user: connects and carries messages; an untrusted certificate, plaintext to the TLS port and a wrong password are all refused; at engine level the node reports Redis `up`, or serves `degraded` and says so (3 runs on a clean checkout of the baseline: `evidence/rc2/QVE-02-11_redis-tls_local/`)** | A 2-minute outage under load; Redis failover |
| QVE-03 | Crash after publish before acknowledgment: replay/dedupe correct | Worker killed after publish: same event id twice, one transition; SDK applies it once; a dead worker's claim is retaken; **per-account in-order delivery with 5 racing workers (48 events across 12 accounts, then 480 across 3 workers)**; head-of-line holding on failure; poison events set aside and still replayable; hung publish times out; a database hiccup while marking is retried; the browser drops late/older events | Ordering and recovery under load on real hosts |
| QVE-04 | Two nodes: cross-node call, answer, ICE exchange | Two in-process replicas (Redis) and **two containers** (`scripts/staging-smoke.mjs`, 15 checks: call rings on the other node, SDP both ways, takeover, replay) on one machine | Two separate hosts behind a WSS load balancer |
| QVE-05 | Restart: missed events replay, state converges | Replica killed mid-call and replaced; offline device resumes on another node and gets exactly its own events; engine killed and restarted under two real browsers mid-call | A staged rolling restart with measured convergence time |
| QVE-06 | Device takeover: stale lease cannot signal or continue media | Old generation / wrong device dropped, refresh `lease_lost`, fail `device_not_owner`; in two real browsers the first device's microphone and connection stop at once | Physical devices |
| QVE-07 | Concurrent calls and idempotency under load | 12 concurrent claims, concurrent joins, idempotent retry, 40 concurrent writers vs a polling reader, concurrent deletions with reads and live activity; `scripts/load-test.mjs` run once on one machine (100 pairs, 300 calls, 6000 relayed signals, 0 errors; it exposed and led to the fix of a slow outbox worker) | **A staging load and soak test** (plan: docs/VOICE_RC2_EVIDENCE_PLAN.md) |
| QVE-08 | Browser permission, hangup, ICE restart, TURN relay | Chromium: mic refused, hangup, ICE restart (also both sides at once), relay-only call through a real coturn | Other browsers, real devices |
| QVE-09 | Two physical devices, different networks, real audio | **Not done** | Everything |
| QVE-10 | Redis/Postgres failure, recovery, backpressure, restart | Redis stop/start, all database connections killed, fail-closed backlog (503) and automatic recovery | A PostgreSQL primary failover; measured RTO/RPO |
| QVE-11 | AuthZ, ticket replay, rate limits, abuse | Ticket replay/expiry/origin, token forgery, `alg:none`, stranger isolation (calls, rooms, history, deletion), forged bus messages, per-socket and per-account limits, least-privilege database role (DDL/TRUNCATE denied) and a least-privilege Redis user (everything but publish/subscribe on one channel denied; wrong password refused), Redis TLS refusal cases | **An independent security review.** Not done |
| QVE-12 | Metrics, alerts, on-call, rollback drill | JSON and Prometheus metrics, strict readiness endpoint, alert rule template, nginx example, draft runbook | Rules loaded in a live Prometheus, dashboards, an on-call drill, a rollback rehearsal. **Not done** |
| QVE-13 | Accessibility and browser compatibility | axe on the ring dialog, call bar, takeover banner, group selection, Recent Calls with group rows and the group call detail (Chromium) | A browser/device matrix (Firefox, Safari, mobile), assistive-technology testing |
| QVE-14 | Privacy, retention, deletion, logs, secrets | SDP/ICE never stored; group history shows a person only their own calls and never names other participants; retention window; the engine log carries no secret, token or ticket (asserted); admin secret never reaches a browser | A privacy and retention review, including a retention/deletion rule for group call history |
| QVE-15 | Qorlla Meet integration: occurrence, host admission, attendance | **Not done.** `voice_rooms.meeting_ref` is unused groundwork | A server-side bridge into Meet's media plus host-admission rules |

## DR gates from v1.4 (same evidence, older numbering)
DR-01 = QVE-01, DR-02 = QVE-02, DR-03 = replay/resume (see QVE-05), DR-04 = QVE-03, DR-05 = QVE-06, DR-06 = QVE-04, DR-07 = QVE-10 (backpressure), DR-08 = QVE-05/10, DR-09 = QVE-09, DR-10 = QVE-12. `npm run certify` runs every test and then refuses to certify without independently recorded `DR01_...`-`DR10_...` evidence flags.

## Findings from the v1.9 audit, and what was done
1. **SDK sent SDP/ICE without lease token and generation** -> fixed; the SDK now sends the generation with every SDP/ICE message (and the server checks it against PostgreSQL for each one). The separate lease token was dropped in favor of device id + generation, which the server reads from the database.
2. **Takeover did not stop the old browser's media** -> fixed and proven in real browsers: `device_revoked` makes the old device stop its microphone and connection at once without ending the call.
3. **Lease refresh failure left the microphone on** -> fixed: `lease_lost` tears media down first.
4. **"The engine is not production certified"** -> still true, and this file says so.
5. **The real Qorlla root is a different application** -> `voice.js` is the adapter: it mints tokens from the app's own signing key (a separate key from the portal tokens), provisions identities server-to-server, and is **off unless `QORLLA_VOICE_ENABLED=true` and `VOICE_ADMIN_SECRET` are both set**.
6. **Audit blocker: "outbox ordering and replay cursors not certified under concurrent transactions"** -> real and fixed. Event ids are assigned at INSERT, not COMMIT, so a late-committing transaction could get a lower id than one already read and be skipped by a cursor. Every event writer now takes a per-account lock before inserting and holds it to COMMIT (so id order = commit order for an account), multi-account writers lock in sorted order, deadlocks are retried, and clients ignore a state older than the one they hold (call/room `version`). Proven by a deterministic two-writer test and a 40-writer stress with a polling reader (no event skipped or repeated).
7. **Least-privilege database roles** -> `deploy/roles.sql` + `scripts/apply-roles.mjs`; the whole engine (calls, rooms, outbox, replay, maintenance) is tested running as a role that has no DDL, no TRUNCATE and no access to the certification table, and the two-node staging runs that way.
8. **Outbox worker "separately deployed"** -> each replica runs a worker (`FOR UPDATE SKIP LOCKED`, safe with any number of them). A dedicated worker process is possible (`outbox: false` on the web replicas) but is not set up in the staging compose.

## Group call history audit (Qorlla_Group_History_Audit_RC2): gaps and what was decided
| Audit point | Status |
|---|---|
| History must come from the same transaction as the room change (the package used database triggers) | **Done, differently:** the application writes outcome, stays and timeline in the same transaction as each change. Proven by a failed-transaction test and by a randomized 160-step check of eight invariants after every operation (a joined member always has exactly one open stay, an ended room has none, a finished member always has an outcome, the host is always a joined member...). Triggers would additionally cover writers that bypass the application; there are none today. If any appear, add triggers. |
| Actor attribution (who invited, kicked, transferred the host) | **Done:** invitations, kicks, ending, leaving and host hand-overs record the actor; a lease expiry or system change honestly has none (tests assert kicks and device claims always have one). Deleted users' actor references are removed (anonymised). |
| Device claim entries | **Done:** a takeover is on the timeline for the person ("You continued this call on another device"), without adding a stay. |
| One participation segment per join, closed on every exit path | **Done and tested** (leave, kick, expiry, end, account suspension, rejoin, concurrent). |
| History before the migration cannot be reconstructed | **Same limit:** best-effort backfill from member rows (one stay per member), idempotent; documented. |
| Immutable audit (runtime role cannot UPDATE/DELETE) | **Deliberately not done:** retention and the new user-deletion workflow require DELETE, and stays must be closed with UPDATE. The runtime role cannot TRUNCATE or alter any history table (tested). Tamper-proofing against the database owner is not claimed; a SECURITY DEFINER writer role would be the next step if required. |
| Cursor precision (the package's cursor used millisecond timestamps) | **Done properly:** exact-microsecond cursor, tested with identical timestamps. |
| Other participants' privacy | **Done:** others are counted, never named; their events appear as "other". |
| Retention, user deletion, legal hold (new requirement) | **Done and tested**, see VOICE_ENGINE_V1.md. Open: one-to-one call history has no retention rule yet. |

## Re-running the evidence
```
cd qorlla-voice-engine && npm test      # 108 tests; real PostgreSQL (dev-stack database or VOICE_TEST_DATABASE_URL); Docker for Redis
npx playwright test tests/voice-engine.spec.js tests/voice-reliability.spec.js tests/voice-turn.spec.js --project=chromium
# two-node staging (needs Docker):  see deploy/docker-compose.staging.yml, then  node scripts/staging-smoke.mjs http://127.0.0.1:4601 http://127.0.0.1:4602
npm run release:gate -- certification-evidence.example.json     # -> BLOCKED
```
Tests skip, and say so, when PostgreSQL or Docker is unavailable.

## Security notes found while building this
- A Redis envelope is validated for shape and age but **not authenticated**: protect Redis (ACL + TLS, private network). Anyone who can publish can inject signaling to a connected device.
- A checked-out database connection dropped between statements would have crashed the process; the store and the outbox now absorb that error.
- With the microphone permission granted, Chromium gathers ICE per network interface, so a TURN server must be on a routable address (not only loopback).
- The staging compose is staging only: no TLS, no load balancer, no coturn, throwaway secrets from the environment.

## RC2 evidence record
The frozen baseline is `b66f57d61d12ee8c6515be9857f3f1cb4476fa17` (tag `rc2-evidence-baseline`). Its evidence folder is `evidence/rc2/`: the gate file (all 15 gates PENDING, with what is local and what is missing), the gate report (`BLOCKED`, `productionApproved: false`) and the Redis-TLS runs. Later commits (the emergency-number reservation `1dff4b7`, the identity decision record) are not in the baseline.
