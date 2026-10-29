# Qorlla Voice v1.9 RC2: evidence plan

**Release decision today: BLOCKED.** This plan says exactly what must be run, on what, by whom, with what pass criteria, and how each result becomes an entry in `certification-evidence.json` for `npm run release:gate`. Nothing below has been run on real devices, separate hosts or a failover cluster yet; the "already have" lines are single-machine evidence only.

The Meet audio bridge (QVE-15) is a **separate project** and is not part of RC2.

## 0. Ground rules for every run
- **Pin the build.** Record the git SHA (`git rev-parse HEAD`) and the Docker image digest. Evidence for a different SHA is rejected by the gate (`--revision`).
- **Two people.** An *operator* runs it, a *reviewer* (a different person) checks the artifacts. QVE-11/12/14 require a reviewer; use one for all gates anyway.
- **Environment is named** in the evidence entry: `staging`, `production-like` or `production`. A developer machine cannot pass QVE-04/05/09/10/12/15.
- **Artifacts are kept**, not summarised: logs, exported statistics, screen recordings, dashboard screenshots with timestamps, the exact commands. Store under `evidence/<QVE-id>/<date>/` and put the path in the entry's `evidence` text.
- **A failed run is evidence too.** Record it, fix, re-run on the new SHA; do not edit the old result.
- **Stop rules.** Stop a run and record FAIL when: any acknowledged operation is lost, a call is stuck "busy" after both people hang up, a microphone stays on after hang-up, a secret appears in a log, or an unexpected 5xx rate above 1%.

## 1. Staging topology to build (P0 prerequisite)
| Component | Minimum for RC2 |
|---|---|
| Voice replicas | 2 hosts (different machines/availability zones), built from the same image (`Dockerfile`), app database role only |
| Load balancer | A real one (HAProxy, a cloud LB, or nginx Plus) with TLS, WSS, active health check on `/v1/voice/operational/readiness`; example in `deploy/nginx.staging.conf` |
| PostgreSQL | Primary + synchronous standby with automatic failover (Patroni or a managed service); roles from `deploy/roles.sql`; backups on |
| Redis | Password + ACL user from `deploy/redis-acl.example.conf` over TLS (`rediss://`), private network; Sentinel or managed HA if you want to test Redis failover |
| coturn | Public IP, UDP 3478 + TLS 5349, `use-auth-secret`, relay port range open, `TURN_URLS`/`TURN_SHARED_SECRET` set on the engine |
| Main app | Qorlla main with `QORLLA_VOICE_ENABLED=true` for the test accounts only |
| Monitoring | Prometheus + Alertmanager + Grafana; scrape config and rules below |
| Test clients | The device matrix in section 2 |

Done so far: a two-container staging on one machine (`deploy/docker-compose.staging.yml`, 15 smoke checks), a coturn container, a Redis container. None of it replaces this table.

## 2. P0: physical devices (QVE-09, QVE-08, QVE-13, QVE-06)
**Matrix** (each cell = one recorded run; a pair means both ends):
| Device A | Device B | Networks |
|---|---|---|
| Android phone, Chrome | Windows laptop, Edge/Chrome | A on cellular (LTE/5G), B on Wi-Fi |
| iPhone, Safari | macOS laptop, Safari | A on cellular, B on Wi-Fi |
| Android, Chrome | iPhone, Safari | both cellular, different carriers |
| Windows, Firefox | Android, Chrome | both Wi-Fi, different networks |
| Any | Any | one side behind a UDP-blocking firewall (forces TURN/TCP/TLS) |
| 4-6 mixed devices | | group call, mixed networks |

**Scenarios per pair** (record start/finish time, pass/fail, notes):
1. Ring, answer, 5 minutes of two-way speech, hang up from each side in turn.
2. Mute/unmute both ways; the other side hears silence while muted.
3. **30-minute soak** (once per pair type): no drop, no one-way audio.
4. **Network switch mid-call** (Wi-Fi to cellular, then back): audio returns without the user doing anything.
5. **Airplane mode for 20 s** then back: call recovers or ends cleanly with the right message.
6. **Screen lock / app in background 60 s** (iOS and Android): what happens is documented (browsers may suspend audio); pass = no crash, clear message, recovery on return.
7. **Take over on a second device**: the first stops sound and microphone immediately.
8. **Permission**: microphone denied at the prompt; revoked mid-call; Bluetooth headset connected/disconnected mid-call.
9. **Incoming call while another app uses the microphone** (phone call, video app).
10. **Group call** with 4-6 mixed devices: everyone hears everyone; one leaves; host ends it.
11. **After every hang-up**: the OS microphone indicator is off (screenshot).
12. **Accessibility** (QVE-13): screen reader (TalkBack/VoiceOver/NVDA) can answer, decline, mute, end, join a group call; keyboard-only on desktop; 200% zoom.

**Capture** (paste into the browser console during the call, then `copy(JSON.stringify(log))` and save):
```js
const log = []; const timer = setInterval(async () => { const s = await qorllaVoice.stats(); if (s) log.push({ t: Date.now(), ...s }); else { const r = await qorllaVoice.roomStats(); log.push({ t: Date.now(), room: r }); } }, 1000);
// when finished: clearInterval(timer); copy(JSON.stringify(log));
```
Also record: device model, OS and browser version, network type, carrier, time to first audio, subjective quality (two listeners, 1-5), `candidateType` (host/srflx/relay).

**Pass criteria (proposed; agree them before the run):** audio both ways in every run; time to connect <= 5 s p95 without relay and <= 8 s with relay; median packet loss <= 3% and no 10-second window above 15%; recovery after a network switch <= 15 s; zero one-way audio; zero stuck microphones; 30-minute soak without a drop; relay (TURN) used successfully on the restrictive-network run.
**Evidence:** per-run stats JSON, screen recordings, the device table filled in. **Maps to:** QVE-09 (main), QVE-08, QVE-06 (step 7), QVE-13 (step 12).

## 3. P0: PostgreSQL failover (QVE-10, QVE-05, QVE-01)
**Setup:** primary + synchronous standby. Start `scripts/load-test.mjs` against both replicas at a steady rate (e.g. `--pairs 30 --cycles 100`) and keep 2 group calls and 5 one-to-one calls open with real browsers.
**Procedure:**
1. Note time T0. Kill the primary (hard stop, not a clean shutdown); let the cluster promote the standby.
2. Watch `/readyz` and `/v1/voice/operational/readiness` on both replicas; record time until both are ready again (**RTO**) and how many requests failed meanwhile.
3. Confirm every operation the clients were told succeeded before T0 exists after promotion (**RPO**): export the load tool's acknowledged call ids and compare with `voice_calls`; every acknowledged call must exist with a legal status.
4. **Event continuity:** for each test account, collect the event ids the clients received, then run
   ```sql
   SELECT account_id, kind, id FROM voice_reliable_events WHERE account_id = $1 AND id > $2 ORDER BY id;
   ```
   with the account's last cursor from before T0: after reconnect + resume the client must have received every row (gaps in global ids are normal; missing rows for the account are not).
5. **Outbox:** after recovery `SELECT count(*) FROM voice_outbox WHERE delivered_at IS NULL AND dead_at IS NULL` drains to 0 and `... WHERE dead_at IS NOT NULL` is 0 (a failover must not set events aside); per account, the event ids each client received are in ascending order apart from repeats.
6. The calls that were open at T0 still hang up cleanly; no account is stuck busy; `voice_media_leases` for the open calls are intact.
7. Repeat with a **planned switchover** (clean) and with **database connections dropped** without failover (already proven locally).
**Pass:** RTO within the agreed target (propose <= 60 s); RPO = 0 acknowledged operations lost (needs synchronous replication; if asynchronous, record the measured loss and decide); zero skipped events; zero invalid state transitions (`status` machine respected); error budget during failover documented.
**Evidence:** cluster logs, the load-tool JSON, the SQL results, dashboards. **Maps to:** QVE-10 (main), QVE-05, QVE-01.

## 4. P0: distributed staging, separate hosts, real load balancer (QVE-04, QVE-05)
1. Callers and callees on **different replicas** through the LB (the load tool does this with two `--nodes`): 100% of calls ring and connect; SDP/ICE relayed across hosts.
2. **Kill -9 a replica** during 20 open calls: sockets reconnect through the LB to the other replica; calls continue (media is peer to peer / TURN); hang-ups work; no event lost (resume).
3. **Rolling restart** one replica at a time: clients reconnect, no call ends because of it.
4. **Drain**: remove a replica from the LB, confirm no new sockets, existing calls finish.
5. **LB health**: stop Redis on one replica: `/v1/voice/operational/readiness` returns 503 there and the LB stops sending new calls to it while existing calls continue.
6. **TLS/WSS only**; plain HTTP redirects; `Origin` forwarded; query strings absent from LB logs.
7. Clock skew: set one replica's clock 20 s off; tokens still verify (5 s tolerance applies; record the actual behavior) and SDP/ICE envelopes are not rejected unexpectedly (the bus rejects envelopes older than 30 s).
**Pass:** the criteria above hold; failover time of the LB measured (propose <= 15 s for new sockets).
**Evidence:** LB config, host list, logs from each host, `GET .../admin/metrics` from both before and after. **Maps to:** QVE-04, QVE-05.

## 5. P0: security (QVE-11, QVE-14)
**Already evidenced locally:** Redis least-privilege ACL (`deploy/redis-acl.example.conf`: publish/subscribe on one channel only; GET/SET/KEYS/FLUSHALL/CONFIG/ACL and other channels denied; engine works under it; a wrong password is refused); database role with no DDL/TRUNCATE; ticket replay/expiry/origin; token forgery and `alg:none`; stranger isolation for calls, rooms, history and deletion; forged bus envelopes dropped.
**Still required:**
1. **Redis over TLS** with the ACL user, on a private network, default user disabled; verify plaintext port closed. *Local evidence exists* (`test/redis-tls.test.mjs`, private CA, three clean runs in `evidence/rc2/`). With a **private** CA the engine process needs `NODE_EXTRA_CA_CERTS=/path/ca.crt` in its environment (read at start-up; no code change); a publicly trusted certificate needs nothing. Still to do on staging: the real certificate chain, rotation, and the same checks across hosts. TURN over TLS (`turns:` on 5349) is untested: browsers must trust the certificate, so use a real one. (Bad credentials make the engine retry quietly and report `bus: down`: confirm the alert fires.)
2. **Independent security review** (not the authors) covering: authentication (token issuer/audience/expiry/rotation of the signing key), WebSocket tickets, authorization of every route (IDOR on calls, rooms, history, deletion, legal holds), rate limits and abuse (call flooding, ticket flooding, SDP size, ICE flood), TURN credential scope and lifetime, admin API exposure (must not be reachable from the internet), secrets in logs/config/images, dependency audit (`npm audit`, image scan), denial of service, privacy of signaling metadata.
3. **Pen-test rules of engagement** written down; findings tracked to closure; no high/critical open at release.
4. **Privacy review (QVE-14):** what is stored (calls, rooms, events, history), for how long (call events 7 days after delivery by default; group history 365 days by default, user-deletable; one-to-one call history is not yet covered by a retention rule: decide), who can read it (only participants; administrators via the database), deletion and legal hold procedure, log contents.
**Pass:** review signed off by someone other than the operator; no open high/critical findings; ACL/TLS verified on the real Redis. **Maps to:** QVE-11, QVE-14.

## 6. P1: load and soak (QVE-07, QVE-10)
**Tool:** `scripts/load-test.mjs` (signaling plane: dial, ring, answer, 20 relayed signals, hang up, repeat; measures time to ring, to connect, to relay, to learn the call ended; reports errors and outbox backlog). The engine must trust the tool's JWKS and have the per-account rate limits raised (`VOICE_API_RATE_PER_MIN`, `VOICE_CALL_RATE_PER_MIN`, `VOICE_ADMIN_RATE_PER_MIN`).
**Single-machine baseline (this repo, Docker PostgreSQL on Windows, the generator on the same CPU; NOT capacity figures):** 100 pairs x 3 calls x 20 signals: 300 calls, 6000 relayed signals, 0 errors, 25.6 s (11.7 calls/s). Time to ring p50 1.8 s / p95 3.0 s, to connect p50 0.8 s, signal relay p50 133 ms. Before the outbox worker was rewritten (one event at a time, three round trips each) the same run took 41.8 s with ring p50 3.2 s and connect p50 4.6 s. With 20 pairs: ring p50 0.39 s, signal p50 23 ms. The numbers are dominated by database round trips through Docker and by the generator sharing the CPU, so they are only useful as a before/after comparison on the same setup.
**RC2 runs (staging hardware):**
1. Ramp: 50 / 100 / 250 / 500 / 1000 concurrent pairs, 10 minutes each; find the knee where ring p95 passes 2 s or errors appear.
2. **Soak:** 70% of the knee for **8 hours**; watch memory (RSS slope), open connections, PostgreSQL connections and table sizes, outbox age (must stay near zero), CPU.
3. **Reconnect storm:** drop all sockets at once (restart both replicas) with 500 clients; time until all have resumed; no event lost.
4. **Backpressure:** stop Redis under load; the backlog grows and `fail closed` engages at the limit; recovery after Redis returns without manual action.
5. **Media plane (separate from this tool):** coturn bandwidth and CPU with N relayed calls (use real browsers or a WebRTC load tool); decide the TURN sizing.
**Pass (propose, then tune):** ring p95 <= 2 s and relay p95 <= 300 ms at the target load (target = expected peak x 2); zero errors; flat memory over the soak; outbox oldest age < 5 s throughout; recovery after Redis/DB failure without manual steps.
**Evidence:** the JSON output of each run, Grafana screenshots, resource graphs. **Maps to:** QVE-07, QVE-10.

## 7. P1: observability (QVE-12)
**Already have:** `GET /v1/voice/admin/metrics` (JSON, and `?format=prometheus` with `Authorization: Bearer <admin secret>` for scrapers), `/healthz`, `/readyz`, `/v1/voice/operational/readiness`, `deploy/alerts.example.yml` (rules not yet loaded into a live Prometheus).
**To build and prove:**
1. Prometheus scrape job per replica (admin secret as a credentials file), blackbox probe of the readiness endpoint through the LB.
2. **Dashboards:** outbox pending/oldest/failed per replica; sockets open; Redis up; fail-closed flag; legal holds and deletions waiting; engine process CPU/RSS; PostgreSQL connections, replication lag, locks, slow queries; LB 4xx/5xx and WebSocket counts; TURN allocations/bandwidth; call success rate (rings answered / dialled) from the database.
3. **Alerts** from `deploy/alerts.example.yml` loaded and validated with `promtool`, routed to an on-call channel.
4. **Drill (the evidence):** deliberately cause each alert (stop a replica; stop Redis; stall the worker; fill the backlog with `VOICE_OUTBOX_MAX_PENDING=5`; kill the primary) and record time-to-alert and time-to-page; the on-call person follows the runbook and records the time to recover.
5. **Rollback drill:** deploy the previous image while the new migrations stay (they are additive); confirm calls work; document that old SDK builds cannot connect to v1.2+.
6. Log review: no tokens, tickets, secrets or SDP in logs (grep a full day).
**Pass:** every alert fires within its target and is actionable; a person other than the author completed the runbook; rollback rehearsed. **Maps to:** QVE-12.

## 8. P1: group call history (done; re-verify in staging)
Retention (`VOICE_HISTORY_RETENTION_DAYS`, default 365, scheduled), user deletion (one call or all, ended calls only), legal holds (admin API; the database itself refuses to delete a held room) and the outbox/live-call safety are covered by tests (`retention.pg.test.mjs`, browsers). In staging: confirm the scheduled cleanup ran (metrics), delete a record through the UI on a real device, place and release a hold, and have the privacy reviewer approve the retention default.

## 9. Packaging the evidence
Per gate, fill the entry in `certification-evidence.json` (start from `certification-evidence.example.json`):
```json
"QVE-09": { "status": "PASS", "evidence": "evidence/QVE-09/2026-11-12/: 14 runs, stats JSON, recordings, device table", "operator": "name", "reviewer": "other name", "environment": "staging", "revision": "<git sha>", "timestamp": "2026-11-12T16:00:00Z" }
```
Then `npm run release:gate -- certification-evidence.json --revision <git sha> --record`. The script can only tell you the evidence is *complete*; a person must read the artifacts. The best possible outcome is `EVIDENCE_RECORDED_REVIEW_REQUIRED`: production approval is a human decision made after that review.

## 10. Suggested order and effort
1. Build the staging topology (section 1): the long pole; most of the rest needs it.
2. Security review can start immediately in parallel (it needs the code, not the hosts).
3. Physical-device runs (section 2) as soon as staging has a public address and TURN.
4. Failover, multi-host and load (3, 4, 6) once staging is stable; run the soak last (8 hours).
5. Observability drill (7) alongside the failure tests: they exercise the same alerts.
6. Assemble the evidence, review, decide.
