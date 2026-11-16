# Qorlla Docs — private Ollama integration kit

**Status: integration kit, not production-ready application or production certification.**

This is a corrected, isolated Ollama transport and Docs AI orchestration layer derived from a review of the supplied `qorlla-docs.tar.gz`. It is **not** a replacement Qorlla Portal, Docs editor, meeting attachments service, or subscription service. It contains no standalone public web server.

## Contents

- `src/ollama.mjs` — private Ollama inference adapter, strict model allowlist, bounded queue, abort handling, response limits and health check.
- `src/docs-ai.mjs` — Docs AI suggestion service with mandatory Portal integration hooks for auth/tenant/document ACL/durable quota/audit, no direct writes.
- `deploy/docker-compose.ollama.yml` — sample private-network Ollama deployment; no published host ports.
- `docs/INTEGRATION_CONTRACT.md` — integration steps and release gates.
- `tests/*.test.mjs` — unit tests with fake inference transport and mock Portal hooks.
- `.env.example` — proposed configuration; feature off by default.

## Test

`node --test tests/*.test.mjs` (Node.js 20+).

## Important

Do not copy the original archive's `server.mjs`, `documentStore.js`, frontend, schema, or `/api/docs` routes into Qorlla. Preserve existing Qorlla routes and security controls.

A production implementation requires access to the actual Qorlla Portal source and a real deployment environment. The supplied archive does not contain those sources. See `docs/INTEGRATION_CONTRACT.md` for mandatory work before enabling private AI.
