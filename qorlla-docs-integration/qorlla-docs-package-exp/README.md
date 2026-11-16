# Qorlla Docs integration package — review candidate, NOT production-certified

This package is a **code handoff**, not a deployed or certified production application. It does not claim to replace existing portal routes or to have been tested against `C:\Users\cj_wo\qv-shield` (not accessible in this environment).

## What is included

- `src/docs-api.mjs`: PostgreSQL-backed document CRUD, optimistic versioning, restore, soft delete/undelete, search/list views, stars, comments, owner-controlled permissions, audit writes, quota checks, plain-text export.
- `src/policy.mjs`: four plan defaults and feature enforcement.
- `sql/007_docs_extension.pg.sql`: additive PostgreSQL tables for metadata, folders, comments and audit. **Check exact live schema before applying**.
- `sql/sqlite_reference.sql`: SQLite local-development schema only; the shipped API does NOT support SQLite directly.
- `public/docs.html`, `public/docs-app.js`: functional baseline UI for listing, creating, editing, autosaving and deleting docs, styled to fit the Qorlla shell.
- `test/policy.test.mjs`: small deterministic policy tests.

## Mandatory integration steps

1. Work in an isolated branch/worktree; back up the database. Inspect live `portal.documents`, `portal.document_versions`, `portal.document_permissions`, and workspace membership schema. Resolve conflicts between migration 001 and 006 before running migration 007. The SQL here assumes UUID IDs and `portal.workspace_members` — adjust only after schema inspection.
2. Use existing Qorlla Portal authentication middleware. Implement `identity(req)` by validating signed session, active account, active workspace membership, and server-resolved `userId`/`workspaceId` (UUIDs). Never trust request headers for identity.
3. Implement `resolveEntitlements(req,identity)` against the **existing SBACS** service; fail closed on outages. Map the existing Basic tier to Free only after confirming product policy. Apply admin-managed plan overrides. Do not trust plan names from clients.
4. Mount `createDocsRouter` behind existing CSRF, origin checks, rate limits and security middleware. Suggested *new* path `/api/v1/docs-next` while testing. Do not overwrite `/api/v1/documents` until parity is proven.
5. Mount `public/docs.html` and `public/docs-app.js` in the existing authenticated Qorlla shell. Point the current Docs icon to `/docs` and preserve all existing navigation. Add the real CSRF token meta tag. Ensure CSP supports the application scripts.
6. Run `npm install`, `npm test`, `npm run check`, migrations in a disposable PG database, and browser tests against a real Portal stack. This handoff has no full browser E2E suite.
7. Test concurrent saves, permission revocation, tenant isolation, document quotas under concurrent requests, restore while at quota, restart recovery, history, and plan downgrade. Review every endpoint with a security engineer.
8. Keep existing `/api/docs` meeting attachments separate. Replace their in-memory storage with a real object store and durable metadata in a separate project.

## Deliberate restrictions and missing production features

- **Live collaborative editing is NOT implemented.** The current save path is conflict-safe through `base_version` and 409, but this is not a CRDT/OT implementation. Do not advertise real-time co-editing until Yjs/Automerge sync, persistent update log, auth rechecks, revocation, reconnection and load testing are integrated.
- **DOCX/PDF import/export is NOT implemented.** Only `.txt` export is implemented. Use a sandboxed LibreOffice/Collabora conversion service, malware scanning, object storage, MIME validation and round-trip tests before enabling DOCX/PDF.
- **Private AI is NOT implemented or enabled** in this package. Retain the existing Qorlla private gateway and its fail-closed flags; do not route documents to external providers.
- **Folders table exists but folder CRUD/move is not implemented.** Template authoring, duplication, permanent deletion, comment resolution, document-specific audit reporting and rich-text fidelity are incomplete.
- **The example frontend uses deprecated `document.execCommand`** for basic formatting and serializes to plain text blocks. For production fidelity, integrate TipTap/ProseMirror and sanitize imported content. No user HTML is inserted directly by the current frontend.
- **This package is PostgreSQL API only.** SQLite is provided as a reference schema, not a drop-in backend.
- **No successful deployment, production readiness, or full test certification is claimed.** The standalone bootstrap refuses to start without trusted integration adapters.

## Proposed gate

**NO-GO** for production release until all missing requirements above are implemented and certified against the real repository, databases, authentication, SBACS, browser and infrastructure.

## Expanded management endpoints (integration candidate v0.2)

The package now includes folder list/create/rename/delete (empty folders only), document move, duplicate, version detail, comment resolve, and stricter doc-block validation. These additions have not been validated against a live Portal database. See `PRODUCTION_INTEGRATION.md` for hard blockers and certification requirements. The API deliberately rejects `sheet` and `slides` writes until their existing schemas are integrated safely.
