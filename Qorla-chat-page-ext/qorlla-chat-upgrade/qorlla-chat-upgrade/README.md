# Qorlla Chat upgrade — integration prototype

## Run locally

Requires Node.js 20+ and native build tools for better-sqlite3.

```bash
npm install
cp .env.example .env
npm run server
# in a second terminal:
npm run dev
```

Open http://localhost:5173. The first user is `demo-user`; the seeded room is `all-on-board`.

## Implemented in this runnable prototype

- All-on-Board and new direct/group chat; `To:` accepts Qorlla user IDs.
- Message creation, replies, quotes, edit own text, bookmarks, pin/unpin, copy, create tasks.
- Always-visible reply and More actions (including touch devices), plus rich-text composer.
- GIF search (requires GIPHY API key), insert GIFs; upload local files (PDF, text, PNG, JPEG, WebP).
- SQLite persistence, basic participant checks, authenticated attachment route, message search, pinned filter.

## Required before production integration — NOT production-ready

1. **Replace demo identity middleware** with verified Qorlla Portal session and tenant membership. The `x-demo-user` header is an intentionally insecure local-development stub; NEVER expose this server publicly.
2. Replace `all-on-board` demo membership with actual Qorlla Meet participant/Workspace membership and meeting isolation; enforce roles for pinning and tasks. Add recipient existence checks and cross-tenant denial.
3. Replace legacy `document.execCommand` formatting with the Qorlla-approved editor (TipTap/ProseMirror); sanitize rich text server-side with an allowlist before storage and rendering. Add CSP and URL validation. The prototype's DOMPurify is client-side only.
4. Add antivirus/content scanning, object-store integration, file quotas, download authorization, expiration, and retention controls. Cloud providers Dropbox/OneDrive/Google Drive/Box/SharePoint need OAuth integrations; this package intentionally does not pretend they are connected.
5. Add WebSocket event delivery, durable message pagination, indexes, per-tenant rate limits, audit logging, moderation, and idempotency. Current client uses 4-second polling.
6. Apply subscription entitlement and guest-admission policies. Private QorllaMate AI is not wired; no chat content is sent to any AI provider.
7. Add unit/integration/E2E tests with real Qorlla Portal/Meet/Shield, security review, accessible rich editor controls, and deploy/rollback gate. No tests were run as part of packaging.
8. GIPHY search uses the external GIPHY service, which receives search terms. Enable only with appropriate consent/policy. GIF assets also load externally.

This is a standalone reference implementation and **does not modify the existing Qorlla repository**.
