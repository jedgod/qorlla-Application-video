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

## Known gaps (not done, on purpose or for lack of an environment)
1. **No real model has been run.** No Ollama image was pulled and no weights were downloaded; which model and its licence are still open decisions. Output quality (valid JSON, translation, length limits) is unproven.
2. **No performance, GPU or load evidence**: queue limits (2 concurrent, 8 queued) are defaults, not measured on the target hardware.
3. **Cancellation is not end to end**: the adapter honours an abort signal, but the gateway does not yet pass the HTTP client's disconnect to the model call, so a closed browser tab does not stop inference.
4. **Per-process queue**: the queue and rate limit are per Portal process; with several Portal replicas the limits multiply.
5. **No network enforcement here**: "no external egress" is a Compose/firewall property that was not tested; `QORLLA_AI_OLLAMA_ALLOWED_HOSTS` is a hostname allowlist, not DNS-rebinding protection.
6. **Prompt injection** cannot be removed by delimiters; the model is given no tools or secrets, and output is only ever a suggestion.
7. **Not deployed anywhere**: the live local stack (4800) still has AI off. Android and desktop AI flows were not exercised.
8. The two other kit variants (`qorlla-ollama-integration`, a standalone adapter plus its own Docs AI service; and `qorlla-ollama-next2`, identical to `-next`) were not imported: the first duplicates the existing gateway and `/api/v1/ai/*` routes.
