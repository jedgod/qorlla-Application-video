# Security Shield v2.2: integration into the Qorlla voice engine

**Status: implemented and tested against the running engine on real PostgreSQL; NOT production certified; release stays BLOCKED.** Branch `feature/security-shield-v2.2` (from the RC2 line). Off unless `SHIELD_ENABLED=true`; user-token enforcement is a second switch (`SHIELD_ENFORCE=true`). Nothing here dials a telephone: the PSTN part is the *authorization gateway* a carrier connector must call.

## Repository audit (what existed, what was missing)
| Area | Found in this repository | Gap closed here |
|---|---|---|
| User identity | Voice engine verifies the main app's short-lived ES256/RS256 token (`src/auth.mjs`); the voice identity has an `enabled` flag | Tokens are re-checked against the shield's principal state (unknown / suspended / issued before revocation = refused) |
| Service identity | One shared `VOICE_ADMIN_SECRET` header on every admin route | Short-lived workload credentials (JWT, own issuer/JWKS, audience `qorlla-shield`, per-workload scope allow-list, one-time `jti`, lifetime <= 5 min). `SHIELD_REQUIRE_WORKLOAD_IDENTITY=true` switches the shared secret off |
| Guest video | Main app `guest-sessions.js`: meeting-scoped sessions, passcode lockout, host removal, revocation | A separate admission authority for **media credentials**: scrypt passcode check, per-client and per-meeting limits, host approval by an authenticated host of the same organization, one-time media credential |
| PSTN | None in the engine (the older telephony module is Twilio-based, in the main app) | `pstn/authorize -> consume -> settle` with server-side destination classification, owned caller IDs, country allow-list, concurrency, rolling-hour velocity, atomic spend reservation |
| Organizations | Not modelled in the engine | `shield_orgs` / `shield_principals`; cross-tenant checks; organization suspension |
| Audit | None for security decisions | Append-only `shield_events` (update, delete and truncate refused) |

## The four enforcement points
1. **Workload identity.** `Authorization: Bearer <workload JWT>` on every `/v1/shield/*` workload route and (optionally) on `/v1/voice/admin/*`. Required: valid signature (issuer's JWKS), issuer, audience `qorlla-shield`, `sub` on `SHIELD_WORKLOAD_ALLOWED` (`svc:name=scope|scope;...`), the route's scope, `jti`, `exp-iat <= 300 s`; each `jti` is accepted once. An end-user token is not a workload credential. Deployment must still add mTLS or a service mesh; this is the application-layer identity.
2. **Guest video admission.** `guest/request` (edge, scope `guest.admit`) takes meeting ID + passcode + display name + an edge-assigned client key; a refusal is identical for a wrong passcode, an unknown meeting and a disabled one. Limits: 5 requests/min per client key, 20/min per meeting, and a failure lock per meeting. The host (a signed-in account that is the meeting's host and in the meeting's organization) approves, denies or removes through `guest/:id/decision`. `guest/claim` trades the claim secret for **one** media credential (120 s, capability `meeting.media.join` only) once approved; the media gateway presents it once to `media/consume` for its own meeting. Credentials are random opaque values; only hashes are stored. A guest never gets an extension, number, messaging, host or organization capability, and the credential is refused by every other API.
3. **PSTN fraud gateway.** `pstn/authorize` (scope `pstn.authorize`) decides; the gateway must then call `pstn/consume` immediately before dialing (single use, bound to account + destination + caller ID, 30 s, re-checks suspension) and `pstn/settle` afterwards (idempotent; releases the unused reservation). Refusals: unknown/suspended/unverified principal, no organization or PSTN disabled, invalid or non-E.164 destination, emergency numbers, premium-rate/toll-free/personal/unclassifiable destination types, destination country not on the organization's allow-list, caller ID not registered **and owned** by that account, concurrency, rolling-hour velocity, spend limit. Client-supplied "allowed/international" flags are not part of the contract (the request is rejected).
4. **Account and organization security.** With `SHIELD_ENFORCE=true` every signed-in voice API call also requires a known, unsuspended principal in a non-suspended organization and a token issued after the last revocation. `POST /v1/shield/authorize` evaluates `voice.number.assign`, `org.access` (cross-tenant), `organization.manage`, `admin.mutate`. Emergency suspension (`.../principals/:id/suspend`, `.../orgs/:id/suspend`) revokes outstanding authorizations, lists the live PSTN calls the gateway must hang up, disables the voice identity (ending calls) and closes the open sockets.

**Fail closed:** disabled, unconfigured, unreachable database, or an unknown principal all answer "no". The engine never grants access when the shield cannot decide.

## Configuration
`SHIELD_ENABLED`, `SHIELD_ENFORCE`, `SHIELD_WORKLOAD_JWKS_URL`, `SHIELD_WORKLOAD_ISSUER`, `SHIELD_WORKLOAD_ALLOWED`, `SHIELD_REQUIRE_WORKLOAD_IDENTITY`, `SHIELD_PSTN_RESERVE_CENTS` (100), `SHIELD_AUTH_TTL_SECONDS` (30), `SHIELD_GUEST_WAIT_SECONDS` (900), `SHIELD_MEDIA_TOKEN_SECONDS` (120), `SHIELD_GUEST_CLIENT_PER_MIN` (5), `SHIELD_GUEST_MEETING_PER_MIN` (20), `SHIELD_GUEST_MEETING_FAIL_LOCK` (30 per 10 min).
**Before turning `SHIELD_ENFORCE` on in any shared environment, the main app must register every account with `PUT /v1/shield/admin/principals`** (unknown principals are refused by design).

## Certification scenarios (test/shield.pg.test.mjs, against the running engine, real PostgreSQL, real signed credentials)
| Scenario | Result expected and tested |
|---|---|
| Account takeover | unknown principal 401; suspended 403; token issued before revocation stays dead after restore; only a newer token works |
| Caller-ID spoofing | another account's number, an unregistered number: refused |
| Toll fraud | premium-rate, toll-free, unlisted country, emergency, invalid, unverified, PSTN-disabled; concurrency 2; velocity; spend limit exact under 6 simultaneous requests |
| Guest privilege escalation | extension field rejected; media credential refused on voice, tickets, calls, admin, authorize; no guest identity created |
| Meeting phishing | uniform refusal; 5/min per client; per-meeting ceiling under distributed guessing; correct passcode does not bypass the limiter |
| Organization isolation | cross-tenant access, other-organization host approval, organization suspension |
| Replay | PSTN request ID replay/reuse, ticket single use + binding + expiry + 5-way race, workload `jti`, claim secret, media credential |
| Emergency suspension | socket closed 4003, tokens refused, outstanding authorization dead, live calls listed for hang-up |
| Service identity | no/forged/wrong-audience/wrong-issuer/long-lived/unlisted/wrong-scope/end-user/replayed credentials refused; shared secret can be disabled |
| Media authorization | no credential before approval; none after deny/removal/meeting end; once; only for its meeting |

## NOT done (the release stays BLOCKED)
- **Not wired into the main app or Meet.** The main app does not yet register principals/meetings with the shield, and the Meet media server does not call `media/consume`. Until it does, the shield protects the engine and defines the contract; it does not yet gate the video media path. The existing main-app guest sessions are unchanged.
- **No mTLS / mesh identity**; workload JWTs need a real issuer (not the test one). No key rotation procedure.
- **No carrier connector.** Nothing places a call; carrier callbacks, call detail record reconciliation, emergency calling and real rates are absent. The spend estimate is a flat reservation.
- **MFA / device possession / step-up** are not enforced (the reference's `mfa_enrolled` flag was not adopted because it is not proof); this needs the identity provider to put `auth_time`/`acr`/`amr` in tokens.
- **Risk signals** are not ingested (the policy takes `risk` as 0). The edge must supply a trustworthy `clientKey`.
- The failure lock can be used to deny service to one meeting by an attacker who knows its ID (the standard trade-off); the host can recreate the meeting.
- Audit is a trigger, not tamper-proofing; no external WORM stream. Database roles must be least-privilege (`deploy/roles.sql`).
- No penetration test, no staging run, no outage drill beyond the unreachable-database test.
