# Number Authority Viewer (read-only) and fail-closed call features

**Status: implemented, NOT production certified. Number issuance, carrier calling, PSTN and billing activation remain disabled. Release stays BLOCKED (all 15 gates).**

## What changed
- `PHONE_NUMBER_VIEWER_USERS` (exact usernames, no wildcards) defines a read-only role. Policy: `number-viewer.js`.
- A viewer needs a verified email, is never an administrator, and is never suspended. Administrators are not downgraded or merged with it.
- The main app sends `x-qorlla-viewer` to Meet only for an opted-in GET on: numbers, number requests, snapshot, diagnostics. Every other route, and every non-GET, is sent without it.
- Meet (`assertViewer`) lets a viewer read requests, the full inventory, the snapshot and diagnostics. Every mutation still calls `assertAdmin`, which a viewer cannot satisfy (purchase, state, reassign, caller ID, usage adjustments, limits, reconcile, calls, carrier search).
- Each viewer read is audited: a JSON log line and `DATA_DIR/auth/number-authority-viewer-audit.jsonl`.
- Panel "Your Qorlla Number" shows three states: *No number assigned - carrier setup pending*, *Number reserved - activation pending*, *Active*. Reserved and Active come only from Number Authority / carrier evidence (`capabilities.number`); the page never creates them. Today the backend reports only active/unassigned, so Reserved cannot appear yet.
- Saved call preferences read "Saved - Not Active" until the carrier confirms enforcement.

## Tests (`tests/number-authority-viewer.spec.js`, 7, no database or carrier)
Policy rules; the real Meet routes against a stub database (viewer reads OK, every mutation 403 and no write reaches the database; ordinary accounts denied); all seven call features are never "active" without every proof, and the carrier in this build supports none.

## What this does NOT prove
- No call-time enforcement of forwarding, voicemail, spam protection, DND, blocked numbers or call waiting exists: there is no carrier or call-routing path. The tests prove only that nothing claims otherwise.
- The viewer path through the running main app and the panel in a browser were not exercised end to end.

## Remaining blockers
MFA is not offered by this application, so it cannot be required for the viewer. Also open: certified carrier (Twilio), Number Authority inventory/range approval/assignment, Security Shield adapters, billing entitlements and reconciliation, SIP/RTP gateway, real enforcement of each call feature, verified caller ID, security review.
