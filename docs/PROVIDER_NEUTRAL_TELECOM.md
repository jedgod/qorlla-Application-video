# Provider-neutral telecommunications (A3.2 and A3.3)

**Status: implemented and tested; production public numbers and PSTN remain DISABLED; Twilio is an optional compatibility module; release BLOCKED.** Branch `feature/number-authority-a3` (local commit after the pushed `9a567c4`).

## Two numbering systems
| | Internal identities and extensions | Public telephone numbers |
|---|---|---|
| Managed by | Qorlla only (Voice Engine `voice_identities`) | Qorlla's Number Authority (Numbers & Plans), backed ONLY by authorized carrier inventory and interconnection |
| Needs a carrier / Twilio | **No** | Yes: a licensed carrier or authorized PSTN interconnection (not provided by this repository) |
| Provider | `QorllaInternalProvider` (`qorlla-meet-video/server/telephony/qorlla-internal.mjs`) | any provider declaring `publicNumbers` (+ `pstn`); the Twilio adapter is one, optional |

## The contract (`provider-contract.mjs`)
A provider **declares** capabilities: `internalExtensions`, `publicNumbers`, `pstn`. Undeclared = false. `assertProviderContract` checks it implements everything it declares (`provisionExtension/releaseExtension/extensionExists`; `listAvailableNumbers/provisionNumber/releaseNumber/numberExists/findOwnedByE164`; `startCall/endCall/fetchCall/verifyWebhook/parseWebhook`) and refuses a provider that claims PSTN without public numbers (a call needs an authorized caller ID). The service refuses what the configured provider did not declare: `PUBLIC_NUMBERS_NOT_SUPPORTED`, `PSTN_NOT_SUPPORTED` (HTTP 503). The ambiguity rules (a failed or timed-out call is not proof that nothing happened; durable operations; reconciliation) apply to every provider.

## `PHONE_CARRIER`
`internal` -> `QorllaInternalProvider` (needs `QORLLA_ENGINE_URL` or `VOICE_INTERNAL_URL`, `PHONE_ENGINE_SYNC_KEY_PEM`, `PHONE_ENGINE_SYNC_ISSUER`; otherwise inert). `twilio` -> the optional Twilio adapter (inert without credentials). Unset -> inert. Nothing is mandatory.

## QorllaInternalProvider
Talks to the engine's admin API with a **short-lived workload credential** (scope `voice.admin`), never the shared secret. `provisionExtension` is idempotent (same account, same extension; never an emergency number); `releaseExtension` disables the identity (its live calls end and its sockets close; the extension is never reissued); `extensionExists`; `healthCheck` (readiness). Public numbers and PSTN methods throw `*_NOT_SUPPORTED`. An unreachable, refusing or unauthorized engine is never reported as success and creates nothing.

## Internal call lifecycle and revocation (tested over real WebSockets, real PostgreSQL)
Authenticated endpoints, one-use tickets, device leases and fencing, durable state events. On suspension: the account's signaling socket closes (4003), its live call ends in the database (`account_disabled`) **and the other party is told**, it receives no new relay credentials (`/v1/voice/ice` refused), cannot get a ticket or place a call, nobody can call it, and restoring brings the identity back.
**Limit, stated plainly:** disconnecting signaling does **not** guarantee that an already-established peer-to-peer media connection ends. The server can end the call in signaling, notify the peer, refuse new relay credentials and let existing ones expire (relay credentials live up to 10 minutes); a peer that ignores the notice keeps its media until the connection is torn down. Only server-relayed media (a relay-only policy or an SFU, neither deployed here) can be cut by the server.

## Verified
`test/internal-provider.pg.test.mjs` (4 tests, 3 consecutive passes): the contract for the Unconfigured, Twilio and internal providers and its negative cases; the internal provider against the real engine (idempotent provisioning, release, existence, refusal with the wrong or no credential, unreachable engine, nothing created by refused calls); capability gating in the real service; the revocation lifecycle. Full engine suite 143/143 (one commit after the 139/139 run, plus these 4).

## Not done (A3 order)
- **A3.4 certificate-based workload identity (mTLS):** not started. Application-layer JWTs only. The supplied overlay's mTLS client is the reference shape; it needs a real issuer and a TLS terminator.
- **A3.5 durable security alerts and operational monitoring:** not started. Data for outbox lag, version gaps, unresolved operations, projection conflicts, refused provenance and revocations exists; metrics endpoints and alert rules are not written.
- **A3.6 `voice.js`, Phone page and gateways reading Shield and number state:** not started.
- **A3.7 external SIP carrier certification:** later, when a carrier is selected.
- **A3.8 migration rehearsal on sanitized production-like data:** not started (needs the data).
- The Twilio adapter is unchanged apart from declaring its capabilities; it is not removed. Meet's Twilio-specific Playwright specs were not re-run against the new Meet code.
