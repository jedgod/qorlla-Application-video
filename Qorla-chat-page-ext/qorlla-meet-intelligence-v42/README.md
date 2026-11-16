# Qorlla Meet Intelligence V4.2 — repository integration candidate

## Scope
- Four feature APIs: AI Summary, Live Transcript, Key Takeaways, Ask QorllaMate.
- Meet-occurrence-scoped consent, transcription lifecycle, ingestion, cursor-based transcript reads, asynchronous AI jobs, durable artifacts, audit events.
- Trusted background worker calling **existing private Qorlla AI gateway**, not direct Ollama.
- Requires Meet-native auth, membership, role authorization, capture/STT, quota authority, private gateway and real-time event adapter.

## Installation in isolated Meet worktree
1. Apply `sql/001_more.sql` from the earlier V4.1 package to a disposable PostgreSQL database if not already applied.
2. Apply `sql/002_intelligence.sql` using `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/002_intelligence.sql`.
3. Mount `createIntelligenceRouter(adapters)` at `/api/meet/occurrences/:occurrenceId/intelligence` **after verifying the exact existing Meet route conventions**.
4. Wire the trusted worker `createIntelligenceWorker(adapters)` to Meet's existing worker lifecycle.
5. Wire a private speech-to-text capture pipeline with explicit participant consent and server-to-server workload authentication.
6. Expose feature availability from backend `/status`; UI cards must remain disabled until all adapters are certified.
7. Run `npm install`, `npm run check`, `npm test` and the Meet repo's PostgreSQL, browser, Shield and multi-instance suites.

## Required adapters
- `authorize(req,{occurrenceId,action})`: return `{actorId,occurrenceId,active:true}` only for verified Meet members with action permission; fail closed on outages.
- `featureEnabled(feature,occurrenceId)`; `entitlement({occurrenceId,actorId,capability})`.
- `quota.reserve`, `quota.isReserved`, `quota.commit`, `quota.release`: durable idempotent quota ledger.
- `capture.verifyConsentPolicy`, `capture.start`, `capture.stop`: private audio/STT infrastructure; never capture without consent.
- `verifyCapture(req,{occurrenceId,captureId})`: strong workload identity plus capture authorization; endpoint must be network-restricted.
- `publish(occurrenceId,event)`: authenticated Meet signaling with replay from durable event log.
- `gateway.generate({occurrenceId,actorId,kind,question,context,requestId})`: Qorlla existing internal AI gateway.
- `authorizeJob(job)`: recheck Meet membership, Shield status, subscription and meeting consent at execution time.

## Security limitations / release blockers
- This is **not** a live-repository patch. Actual Meet APIs, audio capture hooks and Portal quota gateway have not been inspected.
- Audio capture/STT and real-time transport are adapter interfaces, not supplied implementations.
- Transcripts contain sensitive content; encrypt at rest, apply retention/erasure and authorization-aware export policies in the host application.
- Ingest requires an internal-only mount protected by mTLS or equivalent workload identity. Never expose `/internal/segments` on the public participant router without an upstream restriction.
- AI artifacts are currently occurrence-readable for authorized `intelligence.ai.read` principals; refine policy for participant-specific answers and consent scopes before enabling Ask QorllaMate.
- Worker lacks lease expiry/recovery, transactional quota+job atomicity, durable event outbox and retry classification. These are **production blockers**.
- `ON CONFLICT` transcript dedupe depends on existing `meet_more.transcript_segments` from V4.1.
- Host Meet DB and role contract may differ. Verify before applying migration.
- Run real PostgreSQL concurrency tests, capture consent revocation tests, Shield membership removal tests, quota atomicity, XSS, load, retention, multi-instance and five-tab browser regressions before GO.

**Release verdict: NO-GO.** No services have been activated or deployed.
