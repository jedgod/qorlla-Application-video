# Meet shared files and live transcripts (v4.34)

Branch `feature/qorlla-meet-files-transcript`. Built from `qorlla-meet-files-transcript-v21` and `qorlla-meet-live-stt-v22`, rebuilt on Meet's own token, room scope and `more_*` tables. **Both features are OFF by default and are not deployed.** Priority of this work, as requested: the immutable file-scanning pipeline and consent-safe audio capture, before either is enabled for real users.

## Enabling (nothing happens without all of it)
| Feature | Needs |
|---|---|
| Shared files | `MEET_FILES=on`, `FILES_DIR` (private directory, never served), `CLAMD_HOST` (+`CLAMD_PORT`, default 3310): a real clamd |
| Live transcript | `MEET_TRANSCRIPT=on`, `STT_URL` (the private speech engine), `STT_INTERNAL_TOKEN` (32+ characters) |
Missing any piece: the routes answer 503 and the More-tab control stays disabled. `GET /more/state` reports `features.files` / `features.transcript` from this, never from the page.

## 1. Shared files: the immutable pipeline
The package's design (pre-signed upload, scan afterwards) left a window: an unexpired upload URL could overwrite an object after it was scanned. This build has no upload URL at all.
1. The **server** streams the upload into `quarantine/<id>.<random>`, a name only it chooses, capped at 25 MB, hashed while written, then made read-only.
2. Exactly those bytes are scanned: anti-malware (clamd INSTREAM), content type **from the bytes** against a narrow allowlist (PDF, text, PNG, JPEG, .docx), and active content refused (PDF JavaScript/Launch/OpenAction/embedded files, Office macros/OLE).
3. Clean: the quarantine object is re-read and **re-hashed**; only if it still equals the scanned hash is it promoted to a **write-once, content-addressed** object `clean/<aa>/<sha256>` (`link()` refuses to replace; an existing object with that name is verified, never overwritten). Anything else: rejected, quarantine deleted.
4. A **download re-hashes** the clean object and refuses (410, file withdrawn) if it no longer matches; headers are `attachment`, `nosniff`, `CSP: sandbox`.
5. **Fail closed:** if the scanner cannot run the file stays `scanning` in quarantine, a supervised sweep retries (3 attempts, leased so two workers never scan the same file), then it is rejected `scan_unavailable`. Never clean by default. Orphaned quarantine objects are removed; expired files and their bytes are purged (an object goes only with the last file that uses it).
Access (server-side, from the token and current room): the host sees and approves everything; a guest's upload is hidden from other guests until the host approves; `room` / `meeting` (host only) / `host_only` visibility; a room's files do not exist for people outside it. Audited in `more_events`; rate limited; 100 files per meeting.

## 2. Live transcript: consent-safe capture
* **What is captured:** only each participant's **own microphone**, recorded by their own page in 4-second standalone chunks (a new recorder each time, so every chunk decodes on its own). Nothing from other people, nothing server side. Audio is held in memory for one request to the private engine and dropped. **No table has a place for audio.**
* **Who must agree:** everybody currently in the session's room scope (the main room or one breakout room), the host included. Join, move, leave or withdrawal re-evaluates; a status change **bumps the epoch**, which invalidates every chunk made under the old one.
* **Race protocol (all in PostgreSQL, so it holds across Meet instances):** a status change takes the session row `FOR UPDATE`; a chunk is accepted, and again its result is stored, in a transaction that takes it `FOR SHARE` and re-derives session active, epoch, the speaker's **own** consent, the speaker really in that scope, and every present person consenting. A change either commits first (the chunk is refused) or waits for the chunk. A person's audio is processed only while **they** consented, whatever hooks arrive late.
* **Withdrawal:** that person's words are deleted, their capture is refused (their page is told), the session pauses for everyone, in-flight engine requests are aborted and any result that returns later is discarded.
* **Who reads it:** the host and the people who agreed to that session. Retention 30 days (`more_transcript_sessions.expires_at`, swept); text export for those readers.
* Tested with a real browser, a fake microphone and a **fake** engine: capture starts only after everyone agreed, withdrawing in the browser stops capture and removes the words, and the database shows no old-epoch chunk accepted afterwards.

## Files and tests
`server/{files,file-store,file-scanner,transcripts}.mjs`, `public/collab.js` (Shared files panel, Live Transcript card), `sql/v4_34_files_transcripts.sql` (+ `sql/rollback/v4_34.down.sql`), `stt-engine/` (the package's faster-whisper service, unchanged, needs a pre-downloaded model), tests `files` (10), `transcripts` (9), browser `transcript-light` (9) and `files-transcript` (full run).
The test scanner is a **fake clamd** (it flags a marker string; the real EICAR string is deleted by Windows Defender before a scan could run). The test engine is a **fake**.

## Review and hardening (independent read-only review, all findings addressed)
An independent reviewer read the code cold and reported 12 findings; each was traced and handled:
* **Upload revival (fixed):** a deleted or swept upload whose bytes finished arriving later could be revived into `scanning` and become clean. Every upload-path update now requires `state='uploading'`; late bytes are discarded (test: the upload is deleted mid-stream).
* **Shared-object race (fixed):** promote-with-dedupe and delete/purge of the same hash are serialized by a per-hash advisory lock; a transient read error no longer permanently withdraws a file (only a failed hash does). Test: 15 concurrent delete + re-upload rounds.
* **PDF checks (hardened):** header must be the first bytes; escaped names (`/J#61vaScript`), `/ObjStm`, `/Encrypt`, `/GoToR`, `/SubmitForm`, `/URI`, `/XFA` refused. This stays defence in depth on top of clamd, not a disarm step.
* **File names (fixed):** the extension is forced to the detected type (`update.bat` becomes `update.txt`), invisible and direction characters removed.
* **Quotas (fixed):** per-uploader and concurrent-upload limits, counted atomically with the insert under a per-meeting lock; the host is not blocked by guests' files.
* **Transcript fixes:** names cannot forge export lines (control characters stripped at join and export); the in-flight limit counts from acceptance; polling no longer locks or changes a session (the sweep does, and announces); withdrawal always works for somebody who agreed, even after a stop or after leaving; a failed chunk can be retried once, another person's chunk id is refused; a latecomer reads only what was said after they agreed.
* **Presence (fixed):** `participant_sessions.seen_at` is refreshed every 30 s by each instance; a crashed instance's ghosts stop counting after 90 s (was 6 hours).
* **Accepted limit (finding 12):** somebody who is present but not counted (a phone caller, a lost heartbeat) is not asked to consent. Only speakers are captured and each speaker is gated on their OWN consent, so no audio is processed without its owner's consent, but "everybody agreed" is weaker than it sounds for people with no browser.

## Real components, run for real (scratch containers)
* **Real ClamAV 1.5.1** (clamd with the full signature set, 3.3 million signatures): clean bytes pass; the standard EICAR string (sent over the socket, never written to disk) is found; a custom marker signature is found; the whole upload pipeline accepts a clean file and rejects the marker with nothing left in quarantine or the clean store. (`CLAMD_REAL_PORT=<port> node --test tests/files.test.mjs`)
* **Real speech engine** (the package's faster-whisper service, `tiny` model, read-only container, local model files only): real synthesized speech was transcribed correctly ("Hello everyone. This is a test of the live transcript for the design room."), the wrong token is refused (401), undecodable audio is refused (422), and the same speech went through consent, the Meet gateway and the engine into the transcript, with a withdrawal then stopping the engine being asked. **Found and fixed a package bug:** the image lacked `requests`, so the engine could not start. (`REAL_STT_URL=... node --test tests/transcripts.test.mjs`)
* **Speed:** the `tiny` model took about 13.6 s for 5 s of speech on this heavily loaded laptop (CPU only). That is **not real time here**; a faster machine, GPU or a smaller chunk strategy is needed before it feels live. Accuracy beyond one sentence was not measured.
* **Browsers:** Chromium and **Firefox** both run the full consent-to-withdrawal transcript flow in a real browser (9/9 each, `BROWSER=firefox`). Both record `audio/webm`. Playwright's Windows **WebKit has no MediaRecorder at all**, so Safari cannot be judged here (`tests/e2e/webkit-capture-support.e2e.mjs`).
* **Load** (`tests/load/files-transcripts.load.mjs`, 30 participants, one Meet process, fake scanner/engine at 20 ms, overloaded laptop): 58 concurrent 300 KB uploads all finished clean in 9 s with no stuck files; 30 consents took p50 0.7 s each; 300 audio chunks from 30 people ran at about 7 per second with p50 2.7 s / p95 7.9 s latency, a withdrawal in the middle was honoured, no 5xx, every accepted chunk produced exactly its segment (except the withdrawer's, deleted) and none was left processing. The chunk check was reduced to one query after the first run. These are Meet-side numbers on a saturated machine, not capacity claims.

## Still not done
* **Safari / iOS** (a Mac or iPhone is needed), **phone callers** (cannot consent and are not captured), diarization, languages other than a one-sentence English test, GPU sizing.
* **Recognition quality and speed** at meeting scale; the speed above is not real time on this machine.
* The browser **full** run (host + two guests, files and transcript together) still crashes or slows on this overloaded machine; the stable 2-browser run (Chromium and Firefox) and the unit/real-component tests carry the proof.
* S3 object versioning backend, encryption-at-rest and lifecycle rules (host environment), per-meeting byte quotas, disarming (CDR) of documents.
* **Independent security review by a human / outside party and a privacy review: not done.** The review above was an automated read by a separate model; it is useful, not a substitute. **Release: NO-GO for real users.**
