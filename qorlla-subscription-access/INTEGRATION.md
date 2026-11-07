# Integrating Subscription Access with the Qorlla main app and Meet

Status: the building blocks are implemented and tested (see PRODUCTION_READINESS.md). **Nothing in the main app or Meet calls them yet.**
This guide is the exact wiring, kept out of the product code on purpose: `auth.js` and `workplace.js` carry uncommitted changes
from other work, and Meet is released from its own branches. Apply it as one reviewed change per repository.

## What exists

| Piece | File | Proven by |
|---|---|---|
| Live session -> verified tenant (`customer_id`, `user_id`, `role`) | `src/identity.js` | `tests/identity.pg.test.js` against the **real** `auth.js` over HTTP with real cookies |
| Customers, members, roles, suspension, last-owner rule, history | `schema/005_directory.sql`, `src/directory.js` | `tests/directory.pg.test.js` |
| Platform-staff authorization for overrides, links and suspension | `src/staff.js` | `tests/directory.pg.test.js` |
| Entitlement enforcement in front of Meet | `src/meetGuard.js` | `tests/meetguard.pg.test.js` (stub mirroring Meet's real routes) |

What the main app lacked and this adds: **there was no organization model** (only users, sessions and chat memberships) and **no
multi-factor sign-in**. The directory is the organization model. MFA is a contract (below), not something this package can invent.

## 0. Two connection rules (the package enforces both)

1. **Search path.** All tables live in the schema `subscription_access`. Every connection the services use must have
   `search_path = subscription_access, pg_catalog`: create pools with `options: '-c search_path=subscription_access,pg_catalog'` (or
   `?options=-c%20search_path%3Dsubscription_access%2Cpg_catalog` in the URL). The package never alters a pool you give it, and it
   checks the setting on first use: a wrong pool makes every call fail closed with a message naming the fix. Do **not** point the main
   app's own pool at this schema.
2. **Counts are strict.** `requireFeature(..., { quantity: (req) => req.body.max_participants })` rejects a missing, text, fractional,
   zero, negative, non-finite or oversized count with a 400 *before* anything is checked, and puts the exact validated number in
   `req.validated[feature]`. Use that number to create the meeting; never re-read the raw body. There is no default.

## 1. Main app (CommonJS) -> verified tenant

The package is ESM; the main app is CommonJS. Use a dynamic import once at start-up:

```js
// server.js  (after `const auth = require('./auth')({ dataDir, mailer })`)
const sub = await import('./qorlla-subscription-access/src/index.js');
const { service, middleware } = sub.createSubscriptionAccess({ connectionString: process.env.SUB_RUNTIME_DATABASE_URL });   // role qorlla_sub_runtime
service.startSweeper();
const directory = new sub.Directory({ connectionString: process.env.SUB_RUNTIME_DATABASE_URL });                              // read-only
const identity  = sub.createIdentity({ getUser: auth.getUser, directory });

app.use('/api/meetings', identity.middleware(), middleware.requireFeature('meetings.host'));
// per route:  identity.requireRole('owner', 'admin')
```

`identity.middleware()` sets `req.auth = { customer_id, user_id, role }` or answers 401 `unauthenticated`, 403 `no_customer` /
`customer_suspended` / `not_a_member`, 409 `customer_selection_required`, 503 `access_unavailable`. A client may *name* a customer with
`X-Qorlla-Customer`; the name is honoured only if the directory confirms the membership. Nothing is cached.

### Do NOT give the web process write access to the directory

The request-path process holds `qorlla_sub_runtime`, which can only read. **Customer creation and membership changes need
`qorlla_sub_admin`; run them in a separate internal service** (or worker) that the web tier calls after its own authorization, not
in the web process. Otherwise a compromise of the web tier could add itself to any customer.

Provisioning policy you must choose: create a personal customer at sign-up (`DirectoryAdmin.createCustomer(user.id, name)`), or when
a user first creates/joins an organization. Until a user belongs to a customer they get `403 no_customer` (fail closed).

## 2. Authorization: what is checked, and when

| Check | Where | Notes |
|---|---|---|
| Session is live and unexpired | `auth.getUser` (existing) | logout deletes the session; tested: the old cookie never works again |
| Member of the customer, in what role, customer active | `identity` -> `Directory` | read live on every request; role change, removal and suspension apply on the next request, no re-login |
| Customer role for a route | `identity.requireRole(...)` | owner / admin / member |
| Plan limits | `middleware.requireFeature` / `reserve` | unchanged |
| Platform staff may change billing | `createStaff().authorize` | read live; revoking staff applies at once; staff may be limited to listed customers |
| Recent MFA for staff | `actor.mfaVerifiedAt` via `stepUp` | **see below** |

### MFA: not available in the main app today

`createStaff({ stepUp })` must return the epoch-ms time of the user's last MFA/step-up verification. The default returns `null`,
which makes `AdminService` **refuse every privileged action**. Overrides and customer links are therefore impossible until a real
second factor exists. Options: TOTP or passkeys in `auth.js` (best), or step-up through your identity provider. This is the one
Phase-2 item that needs a product decision.

Staff are rows in `platform_staff`, written only by the DBA/migrator (`INSERT INTO platform_staff (user_id, roles, all_customers, granted_by) ...`).
No application role can grant staff access, by design.

## 2b. Metered operations: the replay protocol

For any operation that consumes quota (AI summaries, clips, ...): send `Idempotency-Key`, then `reserve` -> work -> `commit` with the response
stored in the commit metadata. A retry is answered from PostgreSQL, so it holds across restarts and across any number of instances:
finished -> the stored response (`Idempotent-Replay: true`); original still running -> `409 request_in_progress` + `Retry-After`; original
failed -> `409 previous_attempt_failed` (send a new key). The work never runs twice for one key. See `examples/express-integration.js`.

## 3. Meet

Meet has no customer concept. Two changes make enforcement possible.

**a) Meet schema** (Meet's own migration): `ALTER TABLE meetings ADD COLUMN customer_id uuid;` plus an index. Existing and anonymous
meetings stay `NULL`; the guard treats them as the **free Basic plan** (configurable: `unowned: 'deny' | 'allow'`).

**b) Wire the guard** (Meet `server/index.js`):

```js
const { createMeetGuard } = await import('<package>/src/index.js');
const guard = createMeetGuard({
  service,                                               // AccessService, role qorlla_sub_runtime
  lookupMeeting: async (idOrCode) => {                   // MUST count people currently in the meeting, not every row ever inserted
    const id = await resolveMeeting(idOrCode); if (!id) return null;
    const { rows } = await db.query(
      `SELECT m.customer_id, (SELECT count(*) FROM participants p WHERE p.meeting_id = m.id AND p.left_at IS NULL)::int AS n
         FROM meetings m WHERE m.id = $1 AND m.ended_at IS NULL`, [id]);
    return rows[0] ? { customerId: rows[0].customer_id, participantCount: rows[0].n } : null;
  },
});

app.post('/api/integrations/scheduled-meetings', bridgeAuth, guard.bridgeCreate(), /* existing handler: also INSERT customer_id = req.meetingCustomerId */);
app.post('/api/meetings/:id/join', guard.join(), /* existing handler */);
// future routes: guard.feature('meetings.cloud_recording', { customerOf }), 'meetings.webinar_mode', 'meetings.breakout_rooms'
```

**c) Main app side of the bridge**: when `workplace.js` sends a scheduled meeting to Meet, include `customerId` taken from
`req.auth.customer_id` (set by `identity.middleware()`), never from the request body. Optional fields the guard enforces when
present: `maxParticipants`, `durationMinutes`, `webinar`, `recording`, `breakoutRooms`.

Known limits you should accept or fix in Meet: the participant cap is a **snapshot** (two joins racing for the last seat can both
pass; make the seat insert atomic in Meet if that matters); Meet does not currently enforce `meetings.duration_minutes` while a
meeting runs (the guard checks it at creation); `POST /api/meetings` (anonymous create) has no customer, so it is Basic-limited, not blocked.

## 4. Internal calling vs PSTN

`phone.voip` (internal extension calling, free tier) and `phone.pstn` (Business+) are separate entitlements, and PSTN additionally sits
behind the operational gate `operationalGates['phone.pstn']`, which is **off by default**. A paid plan never opens it.

## 5. Order of work

1. Ship `005_directory.sql` (migrator). 2. Stand up the internal provisioning service with `qorlla_sub_admin`. 3. Add identity to the main
app behind a feature flag, log-only first (compare `identity.resolve` with current behaviour). 4. Meet migration + guard, log-only, then enforce.
5. Pick the MFA approach. 6. Billing provider adapter. 7. Alerts and failover tests. Live billing stays disabled throughout.
