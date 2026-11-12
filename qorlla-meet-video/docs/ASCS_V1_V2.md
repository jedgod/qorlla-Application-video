# ASCS v1–v2 — screen sharing in Qorlla Meet

Status: **IMPLEMENTED IN AN ISOLATED BRANCH, NOT PRODUCTION CERTIFIED.** The feature is **OFF by default** (`ASCS_ENABLED` unset or not `true`).
Sources: `qorlla-ascs-v1-v10-reference` (`ascs-m1/MILESTONE.md`, `qorlla-ascs/docs/ROADMAP.md`) and its `qorlla-ascs-teams-upgrade` patch. Versions 3–10 are not part of this change.

## What it does
* One active presenter per meeting, enforced by the database (partial unique index) and a row lock — people who start at the same instant get one share and `409`s.
* The server keeps the share: who, which kind (`screen`/`window`/`tab`), a per-meeting **revision**, and a **lease** the presenter's page renews. A page that vanishes
  loses the share when the lease runs out; a meeting that ends ends its share.
* Permission is decided by the server (host, a per-person grant, or sharing switched on for everyone — the existing host controls). When that permission is withdrawn
  the share is **revoked before** pages are told the tools changed, and the presenter's page stops capturing and says why.
* The host can **Stop presenting** (revoke) and **Give the screen** to a named person (handoff: ends the current share, gives only that person the floor, removes the
  previous presenter's personal grant).
* The page asks the browser for the screen **only inside the click** that chose "Start sharing" (a browser requirement), checks that a live video track came back
  *before* telling the server, stops every captured track on cancel, refusal, revocation or leave, and ends the server share when the browser's own "Stop sharing" bar is used.
* **Optional computer audio** ("Also share computer audio, if my browser allows it"). It is a request: the page reports truthfully whether the browser actually returned an audio
  track, and says so when it did not (Firefox/Safari, or a window share).
* **Fails closed:** if the page cannot reach the server for a whole lease, the server has already ended the share, so the page stops capturing and says why instead of
  presenting without authority.
* **Reload / crash:** a share the server still lists for a person whose page is not capturing is ended by the page when it comes back; and if the same person starts again
  before that, their new share *replaces* their own old one (ended as `replaced`) in the same transaction — still exactly one active share, and nobody waits for a lease.
* Retrying a start with the same `clientRequestId` returns the same outcome, even after the share stopped; it never starts a second share.
* Every state change, its audit row and its revision are written in **one transaction**; events (`share.started|stopped|revoked|updated`) are broadcast after the commit.

## Turning it on and off
| | |
|---|---|
| Enable | `ASCS_ENABLED=true` on the Meet server (and apply `sql/v4_23_ascs_shares.sql`). Optional `ASCS_LEASE_MS` (default 30000). |
| Disable | unset it / set `false`, restart Meet. The page is told (`GET /tools` → `ascs:false`) and uses the previous Share flow; the share routes answer 404. |
| Migration | `sql/v4_23_ascs_shares.sql`, idempotent. Rollback: `DROP TABLE meeting_shares; ALTER TABLE meetings DROP COLUMN share_revision;` (written, **not yet executed in a drill**) |
| App role | the existing `005_app_role.sql` grants (`SELECT, INSERT, UPDATE`) are enough; no `DELETE` is used. Re-run it after the migration. |

Existing databases are **not** migrated by the compose files (they run `initdb.d` on a fresh volume only): apply `v4_23_ascs_shares.sql` by hand.

## API (all under `/api/meetings/:id`, also `/api/v1/meetings/:id`)
The milestone writes `/api/meet/:meetingId/...`; this Meet's existing prefix is `/api/meetings/:id`, so that is what is used.

| Call | Who | Result |
|---|---|---|
| `GET /shares/current` | any admitted participant | `{revision, share \| null}` — what a late joiner or a reconnecting page reconciles from |
| `POST /shares` `{kind, mode:"content", clientRequestId}` | host, or a guest the host allowed | `201` the share · `200` same share (retry) · `403` · `409` another presenter is active |
| `POST /shares/:sid/heartbeat` | the presenter | `{leaseExpiresAt, revision}` · `409 {state}` once it is no longer active |
| `DELETE /shares/:sid` | the presenter or the host | `{stopped, revision}` (`stopped:false` if it was already over) |
| `POST /shares/:sid/revoke` | host | `{revoked, revision}` |
| `POST /shares/handoff` `{to}` | host | `{revoked, next, revision}` |

State machine: `active → stopped | revoked | expired` (`stopped` with reason `replaced` when the same person restarts). Events carry `revision`; the page ignores an event older than the newest it has seen.
A token for another meeting is refused (`403`) on every route.

## How it was tested
* **Server** — `TEST_PG_URL=postgres://… node --test tests/ascs.test.mjs`: 20 tests on a real PostgreSQL with the real routes and the real host-controls module (flag off; idempotent
  migration and unique index; permissions and validation; one presenter; two races; idempotency after stop; monotonic revisions; stop/heartbeat/lease/expiry/ended meeting; revoke;
  permission withdrawn per person and room-wide; handoff; late-joiner snapshot; unadmitted participants; meeting isolation; reload replace).
* **Browser** — `TEST_PG_URL=… PLAYWRIGHT_DIR=<dir with node_modules/playwright> node tests/e2e/ascs-browser.e2e.mjs` (`ONLY=A,B,…` runs sections): 41 checks in real Chromium pages against this
  checkout's real Meet server, with real WebRTC between a host and guests. The screen picker cannot be automated, so `getDisplayMedia` is replaced by an animated 320×180 canvas
  (and a synthetic tone when audio is requested); cameras/microphones are Chromium's fake devices. Covered: host grant → chooser → share → host receives the picture; heartbeat
  keeps a 6 s lease alive; host revoke; handoff; a guest with **no** camera/microphone sharing; "Start video"/"Unmute" recovery after a denied permission; permission withdrawn;
  a vanished page; the old flow with the flag off; audio data reaching the host; a late joiner receiving a running share; reload; fail-closed.

## Side fix: a guest with no camera or microphone could not share
Peer connections were negotiated once, with a video slot only if the person had a camera. A guest whose camera or microphone failed therefore had **no slot to send a
screen through**: their Share button worked locally and nobody else saw anything. Every connection now always has an audio and a video slot (and, with ASCS on, a second audio
slot used only for a shared screen's sound), so a camera, microphone or screen that arrives later is sent with `replaceTrack` — no renegotiation. Remote tracks are gathered into one
stream per person, and a remote video that carries nothing yet shows the avatar instead of a black tile. Someone who joins while another person presents receives the share too.
Guests now also learn at start whether ASCS is on (before, only the host did, so a guest could silently get the old flow).

A pre-existing bug was fixed on the way: the server sends "recording-state" on every connect and join, and when recording was off the page called `rcClose()`, which closed **whatever dialog was open** (Share, Settings, the unmute request). It now closes only a recording dialog (regression check: the Share chooser survives somebody else joining).

## What the Teams-upgrade package asked for, and where it stands
| Package item | Status here |
|---|---|
| Call capture directly from the click; no awaited network call first | **Done** (and tested: the chooser opens first, capture happens on "Start sharing"). |
| Treat the capture surface as a hint | **Done.** |
| Publish audio and video separately | **Done for Chromium** (second audio slot). Receiving audio *data* is verified; listening to it is not. |
| Fail closed when the authorization channel is lost | **Done** after one lease (a short blip is tolerated, as the server's lease allows it). |
| Atomic presenter ownership in PostgreSQL; reconcile after reconnect and reload | **Done** (unique index + lock; `GET /shares/current`; replace-on-restart). Server restart: leases expire by the sweeper — **not drilled**. |
| `authorizeShare` policy (admitted, host, grant, one presenter, owner-or-host stop) | **Done in the routes**, with the same rules and tests for each. "Tenant" = the meeting here: a token for another meeting is refused. This Meet has no co-host role. |
| Do not activate presenter modes that need a compositor | **Done** (`mode` other than `content` → 400; only screen/window/tab kinds). |
| Read Portal subscription grants server-side | **Not done.** Permission comes from the host controls only. |
| SFU-side forced revocation, rejecting a malicious client that ignores "revoke" | **Not possible** in this peer-to-peer Meet; needs an SFU/bridge. |
| Transactional outbox for signals | **Not done**: the share, audit row and revision are atomic, the broadcast is best effort after commit, pages recover from `GET /shares/current`. |
| Keep the feature flag OFF until certified | **Done** (default OFF). |

Release-blocking acceptance list from the package — **none of these is closed**: Chrome/Edge/Firefox (only Chromium run) · concurrency across several Meet instances ·
TURN relay-only · ICE restart and real network loss (only an unreachable heartbeat was simulated) · browser-ended capture (the OS "Stop sharing" bar) · server restart ·
migration rollback drill · load/performance · accessibility · mobile capability matrix · security review · privacy consent · staging canary.

## NOT done — read before relying on this
* **Not production certified.** Chromium only; one machine; no load, failover, TURN or Shield run.
* **Revocation is the server ending the share and telling every page.** Screen media goes peer to peer; the server cannot cut a stream whose page ignores the message. The milestone's
  `publicationId` validation and `pending → active` step are therefore not implemented: a share is `active` as soon as the server accepts it.
* **Phones/tablets cannot capture a screen in a browser at all**; Firefox/Safari cannot share computer audio.
* Presenter modes, Slides/Docs/Whiteboard/Camera kinds, subscription entitlements and the transactional outbox are out of scope (see the table).
