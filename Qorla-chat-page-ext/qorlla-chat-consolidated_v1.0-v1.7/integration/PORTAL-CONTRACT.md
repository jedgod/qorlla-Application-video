# Repository-specific integration boundary (UNVERIFIED)

Do not mount this package into production until the real Qorlla source is inspected.

Required verified adapters:
1. Portal identity: token introspection, session revocation, tenant, user, and expiry.
2. Meet/Shield: authoritative membership and host permissions, guest admission, suspension, and revocation.
3. Subscription: authoritative `ai.chat` entitlement and atomic idempotent quota consumption.
4. Message store: tenant-scoped, authorized reads from PostgreSQL; no client-supplied AI context.
5. Chat router: attach `createPrivateAI()` only behind Portal auth, membership checks, CSRF/origin controls, and distributed rate limiting.
6. Ollama: private network egress allowlist, no external proxy, TLS/mTLS as required, model allowlist and logging that excludes prompts.

The older `/api/chat/conversations/:cid/ai` route in `server/index.mjs` is NOT production-safe: it accepts client messages and uses a placeholder entitlement. It must be replaced with the V1.6 orchestrator and verified Qorlla adapters. The new module is intentionally NOT wired to the old route because doing so without the real contracts would give false assurance.
