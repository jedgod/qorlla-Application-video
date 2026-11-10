# Private AI for Qorlla Docs with Ollama

**Status: integrated and tested locally; OFF everywhere; not certified for production (Phase 2 stays NO-GO).**

## What is in the repository
- `qorlla-portal/server/ai/ollama.mjs`: the Ollama provider for the EXISTING AI gateway (`server/ai/providers.mjs`). It is selected only when `QORLLA_AI_SELFHOSTED_OLLAMA=true`; other self-hosted OpenAI-compatible endpoints are unchanged.
  Endpoint allowlist (`/v1` only, no credentials in the URL, HTTPS for any host that is not `ollama`/`localhost`/`127.0.0.1`), strict model-name check, bounded queue and concurrency, per-request timeout and cancellation, response-size limit, strict JSON decoding.
- `qorlla-portal/server/ai/config.mjs`: the Ollama settings (`QORLLA_AI_OLLAMA_ALLOWED_HOSTS`, `_CONCURRENCY`, `_MAX_QUEUE`).
- `deploy/ollama/`: a Compose fragment (internal network, no published port, pinned image tag required, `cap_drop: ALL`) and the environment example (AI OFF).
- Docs features that now have a provider: Draft, Summarize, Rewrite, Improve, Proofread and Translate (existing routes `/api/v1/ai/run` and `/api/v1/ai/apply`, existing editor panel). They are review-first: a suggestion changes nothing until the person confirms, the server re-checks permission and document version, and every run is metered against `ai.doc_generations_per_month` and audited.

## Turning it on (isolated environment only)
1. Merge `deploy/ollama/docker-compose.ollama.example.yml` into the Portal's Compose project, attach the Portal to `qorlla_ai_private`, pin `OLLAMA_IMAGE_TAG`.
2. Provision the model weights out of band (the network is `internal`, so `ollama pull` cannot reach the internet from inside it). Confirm with `ollama list`.
3. Set the variables from `deploy/ollama/ollama.env.example` (`QORLLA_AI_ENABLED=true`, `QORLLA_AI_PROVIDER=selfhosted`, `QORLLA_AI_SELFHOSTED_MODEL=<installed model>`), and enable the `ai` feature flag for the test workspace.
4. Restart the Portal. The Docs AI card switches from "turned off" to the draft form, and the editor shows the AI actions.

## Tests
- `tests/ollama.integration.test.mjs`: adapter unit tests (from the integration kit).
- `tests/docs-ollama.test.mjs`: the real portal and PostgreSQL against a local HTTP server that speaks Ollama's `/v1/chat/completions`: off by default, status leaks no model or host, the five Docs tasks, draft/apply with confirmation, tampered or stale suggestions refused, other members refused before anything is sent, outage and garbage output fail generically, quota metering.

## Evidence gathered (2026-11-10, this development machine)
- **End-to-end cancellation: fixed and tested.** A closed browser request now aborts the model call (gateway `generateJson` takes an AbortSignal; `/api/v1/ai/run` aborts when the response closes). A cancelled call is neither a provider failure (no failover, no circuit-breaker count) nor a metered run. Test: `docs-ollama.test.mjs` #12.
- **Network isolation: verified.** A container with `cap_drop: ALL`, `no-new-privileges`, on a `--internal` Docker network, with the models volume mounted read-only, had no route to an IP address (`Network is unreachable`) and no DNS (`Temporary failure in name resolution`), published no port, and still started. Image: `ollama/ollama:0.5.13`.
- **A real model was pulled and loaded** (`qwen2.5:1.5b` and `qwen2.5:0.5b`, both Apache-2.0; chosen only as small test models, NOT a production model decision), in an isolated container never connected to the live stack.
- **Real-model quality and latency were NOT obtained.** The host is an Intel N95 (4 cores) that was already at 100 % CPU. With Ollama's default 4 threads the runner made no usable progress at all (a 12-token reply did not finish in 15 minutes; the first real-portal run timed out after 170 s on three tasks, then the circuit breaker opened, which is the designed behaviour). With `num_thread=1`, `qwen2.5:0.5b` produced 0.74 tokens/s with a 15 s prompt evaluation for about 14 tokens: far too slow for the adapter's 180 s ceiling on a real Docs prompt.
  Two operational findings follow: (1) set Ollama's `num_thread` (Modelfile `PARAMETER num_thread` or request option) to no more than the cores really free: thread oversubscription collapses llama.cpp throughput; (2) this machine cannot certify a model. `tests/docs-ollama.real.test.mjs` (skipped unless `OLLAMA_REAL_URL` and `OLLAMA_REAL_MODEL` are set) runs all five tasks through the real portal against a real Ollama and prints per-task latency: run it on the intended hardware.

## Known gaps (still open)
1. **No real-model output or latency has been captured** (see above): the model, its licence and production-representative hardware are still open decisions.
2. **Per-process queue and rate limit**: with several Portal replicas the limits multiply; a shared (database or Redis) limiter is not built.
3. **`allowedHosts` is a hostname allowlist**, not DNS-rebinding protection; the Compose `internal` network is the enforcement and was verified only as described above.
4. **Prompt injection** cannot be removed by delimiters; the model gets no tools or secrets, and output is only ever a suggestion.
5. **Not deployed or enabled anywhere**: the live local stack (4800) still has AI off. Android and desktop AI flows were not exercised.
6. The standalone kit (`qorlla-ollama-integration`) and `-next2` (identical to `-next`) were not imported.
