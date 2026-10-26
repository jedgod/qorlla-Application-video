# Qorlla Meet v3.8 — Final integration closure overlay

This is a **patch package**, not a certified production release. It targets the v3.5 Meet `server/index.js` and v3.7 main `meet-sync/src/worker.mjs` that were available in the conversation. The actual main app `workplace.js`, `server.js`, `qorlla.html`, Docker stack, and JSON schedules were not supplied. Do not claim those files were modified.

## Apply in staging

1. Back up both databases, JSON schedules, secrets, and source tree. Use a clean Git branch.
2. `node patches/apply-meet-recovery.mjs path/to/qorlla-meet-video/server/index.js`
3. `node patches/apply-worker-recovery.mjs path/to/meet-sync/src/worker.mjs`
4. Append `export const rotateHost = sourceId => meetBridge(\`/api/integrations/scheduled-meetings/${encodeURIComponent(sourceId)}/rotate-host\`,'POST');` to the existing `meet-sync/src/bridge.mjs` (do not replace that file). Import `rotateHost` into worker.mjs and add it to both the default bridge argument and the production bridge object. Ensure the worker's real startup invokes the patched runOne.
5. Run `node --check` on all modified files. Set strong bridge and vault secrets. Never expose the bridge secret to the browser. Protect the bridge endpoint at the network layer (private network, mTLS or workload identity recommended). Rotation invalidates prior host credentials; audit every use and restrict access to authorized main-server workloads.
6. **Critical:** remote rotation and local vault commit cannot be atomic across two databases. The retry worker handles a lost response by rotating again on the next attempt. If a vault already contains a credential but Meet rotated it during a failed attempt, a stale vault record can remain. For production, add a generation/acknowledgment protocol or perform a verified host-credential handshake and rotate again on failure. Do not claim C21 passed until this is tested.
7. `node scripts/export-legacy.mjs /path/to/legacy-schedules.json /secure/export.jsonl`; inspect, then `node meet-sync/src/backfill.mjs /secure/export.jsonl` and repeat with `--apply` after approval. The exporter supports arrays and `{schedules:[]}` only; adapt it to actual JSON shape if different. Keep legacy identifiers unchanged. Never backfill cancelled entries.
8. Repair `/index.html` only after identifying the canonical page. Prefer a same-origin 302 to `/qorlla.html` if that is the canonical entry; do not rename or delete `1index.html` without Git history review.
9. Update main dialog to send `title` and optionally `passcode` through authenticated scheduling APIs. Never place passcodes or host credentials in URL parameters. Do not display Join until status `synced`. Ensure schedule edit form uses the same versioned scheduling API.
10. Build/start real main+Meet Docker stack, both PostgreSQL databases, and worker. Execute C01–C24 and record timestamps, exact Git SHA, SQL migration versions, screenshots, HTTP results, and logs. Keep failed/blocked rows explicit.

## Release gates

- C01–C16: create, join, alias, edit, cancel, authorization, migration, routing and two-browser flows.
- C17: Meet outage → pending sync → automatic recovery.
- C18: duplicate backfill idempotency.
- C19: legacy code collision returns conflict and no incorrect mapping.
- C20: lease expiry / worker restart recovery.
- C21: crash after Meet commit but before local vault commit; rotate/recover host; verify new host login and no stale secret.
- C22: cancel wins over queued registration.
- C23: concurrent edits respect version order.
- C24: pending/cancelled meetings cannot be joined from the main page.

**Production status: blocked** until live evidence passes and unresolved credential-acknowledgment risk is closed.
