# Internal numbers and recharge for external calls

## What exists today

**Internal number (extension).** Every account that signs in or registers is given an internal Qorlla number (3 to 8 digits) by the voice engine. The assignment happens on the server at sign-in
(`auth.js` -> `onAuthenticated` -> `voice.provision`), not only when someone opens a page that uses voice. It is idempotent (the engine returns the same extension every time), it never blocks or fails
a sign-in, and it follows the existing rule that an account which must verify its email first (`SHIELD_REQUIRE_VERIFIED=true`) gets none until it has. Calls between internal numbers are free and use no
carrier. The number is shown on the Dial Pad ("Your Qorlla extension") and on Phone -> Numbers & Plans -> "Your internal number". If Qorlla Voice is switched off on a server, no numbers are assigned and the
page says so.

**Recharge for external calls: structure only, switched off.** Phone -> Numbers & Plans -> Plans & usage shows a "Recharge for external calls" section with the balance ("-") and a disabled Recharge button
that explains why. The server side is `GET /api/phone/recharge` (state and reasons) and `POST /api/phone/recharge` (always 503 `recharge_unavailable`). Neither reads or writes a balance, takes a payment or
quotes a price. `available` is false **by construction**: it does not become true when a carrier is connected, only when the wallet below has been built and certified and this code is changed on purpose.

Why it is off (the three reasons the API returns):

| Reason | Meaning |
|---|---|
| `carrier_not_connected` | no licensed telephony carrier is configured; external calls cannot be placed at all |
| `billing_not_certified` | telephony billing is not certified (`capabilities.billing.status` is not `active`) |
| `prepaid_calling_not_built` | the prepaid wallet (milestone A3.8) does not exist; the voice engine refuses to start with `VOICE_A38_ENABLED=true` while it is unbuilt |

## What building recharge for real would involve (not built, for planning)

Nothing below exists; it is the shape the work should take so that money is never ambiguous.

* **Ledger, not a balance column.** An append-only `wallet_ledger` (credit, reservation, charge, release, refund) per account and currency; the balance is the sum. Unique idempotency keys on every entry
  so a retried top-up or a retried call settlement can never count twice. Row-locked reservation before a call is connected, finalized on completion, released on failure (the same reserve / finalize / release
  discipline as SBACS usage).
* **Top-up through the billing provider only.** Checkout and a signed, verified webhook credit the ledger; a browser redirect never does. Packages come from a versioned catalogue that Qorlla approves
  (no price is published by this feature until then). Live payments stay behind `billing_live` and the live-key authorization.
* **Per-call authorization.** A call is authorised only when the carrier is connected, the destination is allowed, the account is not suspended or on billing hold, the balance covers a reservation, and
  emergency numbers are refused (Qorlla cannot place emergency calls).
* **Gates before enabling.** Licensed carrier, certified telephony billing, A3.8 implementation and tests, and a separate release approval. Calls between Qorlla numbers remain free and independent of all of it.
