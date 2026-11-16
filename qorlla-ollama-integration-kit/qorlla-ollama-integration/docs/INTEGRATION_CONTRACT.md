# Qorlla Docs Ollama integration contract

**Status: code package; NOT production-certified or wired into the live Portal.**

## What is fixed from the uploaded prototype
- No replacement Express server, in-memory documents, stub identity, or conflicting `/api/docs` routes.
- No public Ollama port, no hardcoded 200/day quota, no external provider fallback.
- Strict model allowlist; unsupported models rejected.
- Bounded inference queue, cancellation while queued and in flight, request timeout and response size limit.
- Explicit Portal hook requirements for session/tenant authorization, document ACL, durable entitlement reservation and metadata-only audit.
- Permission checked before inference and again before returning results.
- AI disabled by default; suggestions require explicit acceptance.

## Required integration with actual Portal (NOT included)
1. Wire the adapter into the **existing** private AI gateway, not `/api/docs` meeting attachment routes.
2. Resolve actor from Portal's authenticated live session and verified tenant membership. Never accept actor/tenant from browser JSON.
3. Fetch document text server-side through the existing `portal.documents` ACL path. Validate selected text against authorized version. Enforce access at request start and before response.
4. Implement `reserve` using existing `ai.doc_generations_per_month` entitlement and durable transactional usage reservation. Handle concurrency, retries, idempotent commit/release, and subscription suspension. The placeholder hooks in unit tests are NOT a billing implementation.
5. Implement metadata-only audit with redaction and retention policy; protect tenant and model access; limit requests by account and IP.
6. Wire UI preview, explicit Insert/Replace/Discard, autosave conflict handling, and document version checks; no automatic overwrite.
7. Provide verified private network reachability, workload identity, TLS if cross-host, and egress firewall policy. `allowRemote` must only be enabled after trusted endpoint policy and network enforcement.
8. Test real installed Ollama model, restart, load, provider outage, no external egress, auth/revocation, plan quotas, request cancellation, desktop/mobile, full Portal regressions.
9. Preserve existing `/api/docs`, `/app/suite`, `/api/v1/documents`, `portal.documents`, and current migration history.
10. Do not enable flags, deploy, merge or push without separate approval.

## Operational notes
- A Docker network marked `internal: true` isolates traffic but can also prevent model pulls; provision weights out of band.
- If the Portal uses a different Docker network, explicitly attach it to the private inference network.
- A single-node in-memory queue is per-process; enforce cluster-wide quotas and rate limits in the Portal.
- Inference prompt injection cannot be eliminated solely by delimiters. Do not give the model tools or secrets.
- This package is not a standalone Qorlla Docs app. It intentionally refuses to work without real Portal hooks.
