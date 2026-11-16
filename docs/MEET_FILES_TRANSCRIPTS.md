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

## Not done / blockers before any real user
* A **real clamd** and a **real speech model** have not been run; recognition quality, latency, GPU/CPU sizing, diarization, languages: unknown.
* **Safari/iOS:** MediaRecorder format support and decoding not tested; Chromium only. Phone callers are not captured and cannot consent.
* **Presence** for "who is in the room" comes from `participant_sessions` (a crashed server can leave a ghost that keeps a session paused until the 6-hour bound).
* The browser **full** run (host + two guests, files and transcript) passes in pieces but is **flaky on this overloaded machine** (browser crashes and slow renders); the 2-browser transcript run is stable. Run it on a quiet machine.
* S3 backend (object versioning) is not implemented; the filesystem store needs encryption-at-rest and lifecycle rules from the host environment. No CDR/DLP, no per-room file quotas beyond 100/meeting.
* Independent security and privacy review, load, accessibility audit: not done. **Release: NO-GO for real users.**

## Evidence (this machine, scratch databases)
* Meet unit tests (real PostgreSQL): **101 tests**, including `files` 10/10, `transcripts` 9/9 (race, withdrawal, join, room scope, retention, hardening) and the earlier suites; the one failure seen in a full run was a timing assertion in the older Redis-bus test and was fixed.
* Real browsers: `transcript-light` **9/9** (consent prompt, nothing captured before everyone agrees, capture by the page's own microphone, words appear, withdrawal in the browser reaches the server, words deleted, no old-epoch chunk accepted afterwards); `files-transcript` full run passed all file checks and the transcript checks up to attribution in several runs, then was limited by browser crashes on this overloaded machine; existing suites: breakouts 16/16, classroom 19/19, tabs 40/41 (the old chat unread-marker check).
* Rollback `sql/rollback/v4_34.down.sql` removes the metadata and transcript tables; file objects on disk are removed separately.
