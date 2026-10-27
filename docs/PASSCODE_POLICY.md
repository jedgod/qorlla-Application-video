# Meeting passcode policy and lockout

Two meeting systems exist and each keeps its own passcode rules. They never validate each other's passcodes.

| | MAIN meetings (`/api/meetings/create`, guest join) | Meet meetings (`/meet/`, qorlla-meet-video) |
|---|---|---|
| Length | 4-32 characters, optional | no minimum, at most 100 characters |
| Hash | scrypt (random 16-byte salt), stored on the meeting record, never returned by any API, log or link | bcrypt (cost 10); for scheduled meetings MAIN supplies a bcrypt hash and Meet only ever holds the hash |
| Verified by | MAIN (`checkPasscode` -> `lockout.verify`) | Meet (its join endpoint: bcrypt compare + its own join-failure throttle) |
| Host bypass | host key (anonymous host) or owning account | host secret |

A future unified policy should define one canonical length/complexity rule, compatibility for existing passcodes and a single owner of verification. Until then the policies are documented as separate meeting types, and the unified-stack E2E (Meet passcode, rejoin) and the MAIN lockout tests cover each independently.

## MAIN lockout (v4.6.1)

* **Rule**: 5 failed attempts per meeting lock the passcode for 10 minutes. The lock is checked BEFORE the passcode is compared, so a correct passcode is refused while locked and a restart cannot lift it. An empty submission is refused without consuming an attempt.
* **Method**: reserve -> verify -> settle. The attempt is counted durably before the costly comparison, so concurrent attempts (threads, processes or instances) cannot exceed the budget; the sixth in-flight attempt is refused unverified. A success resets the counter unless a lock became active meanwhile (then it is refused). Expiry is a persisted UTC timestamp.
* **Stores**: PostgreSQL in the full stack (`meet-sync/sql/008_passcode_lockout.sql`, row-locked transactions, database clock; existing databases must apply this file once) and an encrypted-at-rest file store for standalone MAIN (exclusive cross-process lock directory, fsync'd atomic replace, honours `ENCRYPT_KEY`). `LOCKOUT_STORE=file|postgres` overrides the default (`postgres` when `DATABASE_URL` is set).
* **Fail closed**: an unreachable database, missing table, corrupt or undecryptable state file, or an unobtainable lock gives 503 and no session; there is no in-memory fallback.
* **Per-client brake**: 10 attempts per client address per meeting per 10 minutes (best effort, in memory). The client address is Express `req.ip` under the configured `trust proxy` hops, never a raw `X-Forwarded-For` value.
* **Residual risk**: an attacker can still spend the meeting-wide budget (a denial of service on joining). Mitigations: the per-client brake, host notification when a lock starts, and host recovery below. A host (or owning account) is never locked out of their own meeting.
* **Host recovery**: `POST /api/meetings/:id/passcode-lockout/clear`: authenticated host only, same-origin only, strict 3 per hour per host and meeting plus a coarse per-address brake, audited (event row with a truncated hash of the actor, plus a server log line). It lifts the lock only; it cannot read, change or reveal the passcode. `GET .../passcode-security` (host only) lists lock state and recent events, which contain no addresses or passcodes.
* **Join paths**: REST (`/api/guest/sessions`) is the only place a passcode is checked. The WebSocket join has no passcode path: it requires an earlier successful REST verification (account) or a guest session for that meeting, so sockets cannot be used to guess.
