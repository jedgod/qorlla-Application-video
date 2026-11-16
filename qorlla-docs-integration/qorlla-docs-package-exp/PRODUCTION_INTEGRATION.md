# Qorlla Docs production integration contract

This package is NOT a production-certified replacement for Qorlla's existing Docs. The Windows repository and deployed PostgreSQL schema are not accessible here. It is unsafe to pretend a drop-in replacement is production ready without them.

## Required deployment order

1. Create an isolated worktree at the target commit. Preserve the existing Portal Docs APIs and database. Back up the database and test restore.
2. Compare `001_init_workspace_schema.sql`, `006_workspace_tools.sql`, live `pg_catalog` column definitions, indexes, constraints, and privileges. The supplied migration is NOT safe to run blindly on conflicting schemas.
3. Adapt the router to existing Portal authentication, CSRF, trusted membership, subscription access control (SBACS), and per-tenant transaction context. Do not take tenant or user IDs from request headers.
4. Mount the new router on `/api/v1/docs-next` during parity testing. Existing `GET/POST/PUT /api/v1/documents` remain the source of truth. Do not create a second database of documents.
5. Replace the demonstration UI with a maintained rich-text editor such as ProseMirror/Tiptap and schema-driven document serialization; preserve the existing Qorlla navigation and styles.
6. Build an isolated, virus-scanned file import pipeline with durable object storage, MIME/magic-byte verification, limits, converter sandbox and round-trip fidelity tests. Do not expose the in-memory meeting attachment endpoint as Docs storage.
7. Build live collaboration as a separate authenticated Yjs/CRDT service with persistent update logs, snapshots, replay, revocation, authorization on every connection and reconnect, multi-node fanout, and chaos tests. Optimistic version saves are NOT real-time collaboration.
8. Keep all AI routes disabled until the private model is deployed, reachable, certified and approved. Never send documents to external AI endpoints; enforce entitlement, source permission and audit on the server.
9. Gate all premium operations using the authoritative SBACS plan/tenant entitlement response, not UI labels. On entitlement outage fail closed for premium writes. Document count quota must be enforced in one database transaction.
10. Run PostgreSQL migration tests, REST contract tests, permission matrix, cross-tenant and concurrency tests, browser E2E, load, backup/restore, downgrade, security review, and deployment rollback rehearsal before production promotion.

## Critical known limitations

- `src/docs-api.mjs` supports PostgreSQL only; the SQLite file is illustrative, not a working second backend.
- `doc` JSON blocks are supported; sheet/slide creation is deliberately refused by this router. Existing sheet/slide features must remain on their current service until parity is established.
- Import/export of DOCX/PDF, realtime collaborative editing, full text content search, templates, private model answers, full accessibility and disaster recovery are NOT implemented here.
- Some existing Portal constraints (role/membership schema, content JSON shape, audit policy) may differ. Verify compatibility before applying migrations.
- This is an integration candidate, not a verified final product. Never advertise it as production ready until the above gates pass.

## Required certification matrix

| Gate | Required evidence |
|---|---|
| Auth | Expired sessions, revoked sessions, CSRF, origin, inactive members denied |
| Tenant | Cross-workspace IDs and permission enumeration denied |
| Plans | Free/Pro/Business/Enterprise and downgrade tested at API + transaction level |
| Concurrency | Same-base simultaneous save yields one success, one 409 |
| Quota | Concurrent create/restore/duplicate cannot exceed limit |
| Durability | Data survives app/DB restarts, PITR and backup restoration |
| Collaboration | Multi-node sync, revocation, reconnect, conflict and crash recovery |
| Import | Malware, zip bombs, converter escapes, corrupt files rejected |
| AI | Private-only, disabled by default, no external egress, refusal on outage |
| Operations | Metrics, alerting, p95 latency, rate limits, rollback, secrets rotation |
