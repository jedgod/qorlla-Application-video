# Qorlla Meet V2.2 — self-hosted live speech recognition + consent-gated browser audio gateway

**Integration candidate, NOT production-certified. No real Qorlla services were modified or deployed.** This folder includes the V2.1 shared-files/transcripts source and adds a runnable private speech recognition engine, HTTP audio gateway, and React microphone component.

## Architecture
- Browser `ui/LiveTranscriptCapture.tsx` records **only the local participant's microphone** in ~4-second MediaRecorder chunks. Other participants independently opt in. No server-side recording of P2P remote audio.
- Meet mounts `src/live-audio-router.mjs` behind existing authenticated routing and passes the real token reader, PostgreSQL pool, Meet authority and `transcriptService` to `liveAudioGateway`.
- Gateway checks **active room membership and unanimous consent** for the session and epoch before inference and again before accepting results. The V2.1 transcript service checks again before each segment insert.
- Engine `stt-engine/app.py` runs faster-whisper locally, with ffmpeg decoding and in-memory audio. No vendor API, no raw audio persistence.
- SQL migration `022_audio_gateway.sql` adds chunk idempotency metadata.

## Required wiring in actual Meet
```js
import {liveAudioGateway} from './src/live-audio-gateway.mjs';
import {createLiveAudioRouter} from './src/live-audio-router.mjs';
const gateway=liveAudioGateway({pool,authority,transcripts,engineUrl:process.env.STT_URL,engineToken:process.env.STT_INTERNAL_TOKEN});
app.use('/api/meet',createLiveAudioRouter({gateway,readToken:meetSessionTokenReader}));
```
`authority.verify` MUST validate a real Meet session and return server-derived tenant, participant and room identity. `authority.listActiveRoomMembers` MUST include all room participants, including guests, and must coordinate with joins, leaves, moves, and consent changes. Never take participant IDs or roles from browser headers.

## Startup
1. Apply `sql/021_collaboration.sql` and then `sql/022_audio_gateway.sql` to a **disposable PostgreSQL database**.
2. Pre-download a licensed/approved faster-whisper/CTranslate2 model to the model cache on the host. The container uses `local_files_only=True`, so it will fail to start rather than download a model from the internet. Pin and verify model hashes.
3. Set a randomly generated 32+ character `STT_INTERNAL_TOKEN`, `STT_MODEL_DIR`, `STT_MODEL` and use `docker compose -f deploy/compose.stt.yml up --build` **in a nonproduction environment**. The STT container has no public port; Meet must reach it on a deliberately configured private network. The example Compose network must be connected to the real Meet service before the hostname resolves.
4. Wire the V2.1 transcript `mediaControl` and `stt` adapters to real Meet lifecycle hooks. The browser component must be mounted only after the server reports active unanimous consent and current epoch. Consent revocation must stop capture and invalidate epochs immediately.
5. Run `node --test tests/*.test.mjs` and `node --check src/live-audio-gateway.mjs`; run a real PostgreSQL/Redis/Meet + browser integration suite before release.

## Known blockers — do not claim production readiness
- **Consent race:** the real Meet membership writer must share the same transactional room lock with transcript admission, and invalidate the epoch before admitting a new participant or changing rooms. Otherwise a join can race an in-flight audio chunk. The provided authority interface alone cannot guarantee this.
- **Multi-process revocation:** a browser already recording must receive a reliable stop event, and the gateway must check epoch on every chunk. A crashed server or network partition requires a distributed fence and reconciliation.
- **Speech chunks:** MediaRecorder fragments are not always standalone decodable containers (notably Safari). This HTTP chunk implementation is a functional baseline, **not guaranteed on Safari/mobile**. A persistent per-speaker streaming decoder or AudioWorklet PCM transport is required for full cross-browser reliability.
- **Chunk retries:** failed chunk IDs currently remain failed; retry policy, rate limits, backpressure, and bounded per-speaker queues need actual integration. Chunk timestamps are browser-relative and can drift; do not treat them as authoritative timestamps.
- **Model performance:** latency and accuracy depend on hardware and model; no GPU benchmark, speaker diarization, language coverage, accessibility or load certification has been completed.
- **Transcript privacy:** implement retention, deletion, exports, withdrawal handling, guest access policy and audited admin access. The existing V2.1 `list` endpoint is not sufficient for production consent governance.
- **Audio security:** TLS/mTLS between Meet and STT, secret rotation, SSRF-resistant fixed engine URL, host ingress limits, anti-CSRF where cookie auth applies, rate limits and security review are required.
- **V2.1 shared-files** immutable quarantine-to-clean promotion remains a separate blocker.

## Release verdict
**NO-GO** until real Qorlla integration, PostgreSQL tests, TURN relay-only browser tests, Safari/phones, load, and independent privacy/security review pass. This is actual engine and gateway source, not proof of deployed service.
