# Qorlla Docs: architecture decision (one Docs implementation)

Status: decided, local only. Production remains NO-GO until the release gates are separately satisfied.

## Decision

Qorlla has **one** Docs implementation: `server/workspace-tools.mjs` (documents, versions, sharing, restore), `server/docs-extension.mjs`
(views, folders, stars, comments, trash, export, history window), `sql/006_workspace_tools.sql` + `sql/015_docs_extension.sql` +
`sql/016_docs_history_entitlement.sql`, and `public/assets/docs-page.js`. Both externally supplied packages were **rejected** and are not imported:

* `qorlla-docs-integration/qorlla-docs-package` (stable)
* `qorlla-docs-integration/qorlla-docs-package-exp` (experimental, a strict superset of the stable one)

The one thing the packages had that Qorlla lacked, a plan-based limit on how much version history a person can reach, was **re-designed natively**
as the entitlement `documents.history_versions` (below). No package code, migration, policy table, UI or schema was copied.

## Why both packages were rejected

| Concern | Package | Qorlla (kept) |
|---|---|---|
| Duplicate functionality | Folders, move, duplicate, stars, comments, comment resolve, soft delete/undelete, export, search | All of these already exist in `docs-extension.mjs` on the **preserved** `/api/v1/documents` and `/api/v1/document-folders` routes. Adding the package would create a second Docs. |
| Migration collision | `007_docs_extension.pg.sql` creates `portal.doc_folders`, `doc_metadata`, `doc_comments`; `starred_by jsonb` and `template` live in `doc_metadata` | Migration 015 already created tables of those names with different columns (stars are a separate `doc_stars` table; folder names are unique per owner; comments carry `workspace_id`). `CREATE TABLE IF NOT EXISTS` would silently do nothing on a database where 015 is applied, and the package code would then fail on missing columns. The number 007 is also taken (`007_billing_launch.sql`). |
| Content-format incompatibility | Documents are `{type:'doc', blocks:[...]}`; the API rejects anything else and refuses `sheet`/`slides` | Documents are `{format:'markdown', text}` (plus `sheet`/`slides` schemas). Every existing document, QorllaMate, search, AI tasks and citations depend on that. Using the package API would reject or corrupt existing documents. |
| Schema differences | Reads `portal.workspace_members` and writes its own `portal.doc_audit` | The live schema is `portal.members` and `portal.audit_events`. |
| Entitlement model | Plan limits (`free`/`pro`/`business`/`enterprise` defaults, history 10/100/500) are hard-coded in `policy.mjs`, with a `free` plan name | The authority is `portal.entitlements` read through `quotaFor()` / `workspace_effective_plan` (plans `basic`/`pro`/`business`/`enterprise`, NULL = unlimited, no row = not granted). A second policy table would let the two disagree. |
| Maturity | The packages state NO-GO themselves: no browser tests, never run against this schema, `execCommand` demo editor, plain-text blocks | The Docs page, autosave, conflict handling, quotas, rate limits and 350+ portal tests already exist and are deployed locally. |

## The history entitlement that replaced the package idea

`documents.history_versions` (migration `016_docs_history_entitlement.sql`, additive, re-runnable, rollback provided):

| Plan | Quota | Access |
|---|---|---|
| Basic | 10 | the 10 most recent versions |
| Pro | 100 | the 100 most recent versions |
| Business | 500 | the 500 most recent versions |
| Enterprise | NULL | unlimited |

Semantics (enforced server-side, in `historyWindow()` / `assertHistoryAccess()` in `server/docs-extension.mjs`):

* The window counts back from the **latest** version and **includes** it: 30 versions on Basic -> versions 21-30.
* The **current version is always open**, whatever the window; a document's current content stays governed by its normal sharing rules.
* Older versions are **kept in storage** and **listed as locked** (`locked: true`; only number, source and time are shown: no content, note or author).
* `GET /documents/:id/versions/:n`, `POST /documents/:id/restore` and the AI citation route (`GET /ai/citations/:ref`, which can reopen an older version) all refuse a version outside the window with
  `403 {code:'entitlement_required', feature, plan, limit, oldest_available, current_version}`, **after** document authorisation and workspace isolation, and **before** any content is read.
* The window is recomputed from the workspace's **current** plan on every request: an upgrade unlocks old versions at once, a downgrade (or a lapsed subscription) locks them again; nothing is deleted or rewritten.
* Autosave is unchanged: it still folds into one version, and no versions are created to satisfy a quota.
* **No row = not granted, never unlimited.** If the entitlement is not seeded in an environment the server fails closed: only the current version opens (the same fail-closed rule the comments entitlement uses).

Routes that return only current content (document, list, search, meta, duplicate, `export.txt`, `export.md`) are unchanged and are covered by tests that older content never appears in them.

## Deployment ordering (important)

Apply migration 016 **before or together with** the code. Code deployed to a database without the rows will fail closed (history locked except the current version) until 016 is applied; that is intentional, and is not a data loss. Rolling back: deploy the previous code first, then run `sql/rollback/016_docs_history_entitlement.down.sql` (it only deletes the four entitlement rows).
