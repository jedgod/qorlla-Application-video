# Decision record: how people are found and called in Qorlla (extension, verified mobile number, or both)

**Status: recommended, awaiting the owner's decision.** What exists today is the extension model only. Nothing below the "Recommendation" heading is built.
**Date:** 2026-10-29. **Applies to:** `qorlla-voice-engine` (internal internet calls and group calls) and `voice.js` / the Phone page in the main app.

## The question
Before calling is expanded, Qorlla must decide whether a person is discoverable and dialable by **Qorlla extension**, by **verified mobile number**, or **both**, and how that relates to ordinary telephone (PSTN) routing, which is a different system with different rules (carriers, cost, emergency calling, regulation, number portability).

## What exists today
- Every voice identity has one **extension** (3-8 digits, allocated from 2000, unique, issued by the engine, bound to the account). It is the engine's only routing key. The Dial Pad treats digits **without** `+` as an extension and a `+`/E.164 number as an external phone number.
- The engine never accepts a phone number: `validExtension` is digits only, and there is no PSTN, no carrier, no emergency calling. The carrier adapter is disabled.
- Discovery is a **directory**: the main app lists the accounts that have a voice identity (name and extension) to every signed-in user of that app. That fits one organisation and one tenant; it does not fit an app with several unrelated organisations or the public.
- Emergency numbers (911, 112, 999, 000, 110, 119, 100, 101, 102, 108, 122, 933) are **reserved**: they can never be provisioned as an extension, dialled as one, invited or blocked, and the Dial Pad says "Qorlla cannot place emergency calls. Use your phone's own dialer." This closes a real hazard: an extension `911` would have rung a colleague.

## Options
| | Extension only | Verified mobile number only | Both |
|---|---|---|---|
| Works today | Yes | No (needs a verification provider) | Partly |
| Fits "internal calling, no carrier" | Yes | Needs SMS/voice verification, which is a carrier-style service | Yes, number is optional |
| Privacy | Low risk: an extension is an internal handle, not personal data | A phone number is personal data and can be used to find and track people | Number only for people who opt in |
| Enumeration risk | Small space (3-8 digits): guessable inside an org, harmless if the directory is already visible | High: number lookup is a classic contact-discovery abuse | Contained by opt-in + rate limits |
| Confusion with PSTN | Low | High: the same number could mean "internet call" or "phone call" | Must be made explicit |
| Cost / regulation | None | Verification cost; consent rules; number recycling | Same, only for those who add a number |

## Recommendation
**Both, in phases, with one rule that never changes: the voice engine routes by extension only.**
1. **Now (built):** extension is the identity and the routing key. Directory discovery inside one organisation.
2. **Next, only when wanted:** a **verified mobile number as an optional, opt-in attribute of the account**, used purely for *finding* a person (search/"call by number"), never for routing inside the engine. It lives in the main app (or an account service), not in the voice engine. The main app resolves "who owns this number?" to an account, then asks the engine to call that account's **extension**. The engine stays free of phone numbers.
3. **Later, separately certified:** PSTN routing through a carrier gateway, as a different capability with its own gate.

### Rules that follow
- **The number is never the routing key in the engine.** Extension stays immutable for the life of the identity (a reissued number must not inherit someone else's call history or blocks).
- **Discoverability by number is opt-in, default off,** requires the number to be **verified** (one-time code to that number), and applies only within the user's organisation or their existing contacts unless the user chooses wider. A verified number is never shown to anyone who can't already see the person.
- **No bulk lookup.** Exact-match lookup only, rate-limited per account and per IP, no "upload your address book" matching (a known enumeration and privacy hazard).
- **Internet calls and phone calls look different and are chosen explicitly.** A call that resolves to a Qorlla account says "Internet call to <name>"; a call that would leave for the telephone network says "Phone call to +1..." and shows that it may cost money. Never silently convert one to the other. No automatic fallback from an internet call to a carrier call.
- **Dial Pad rule stays:** digits without `+` are an extension; `+` and a country-length number are a phone number. Short numbers are never treated as phone numbers.
- **Emergency numbers are reserved and refused** by the engine and the Dial Pad, and stay refused after PSTN exists unless an emergency-calling capability is separately built, regulated and certified (location, callback number and call-back rules are legal obligations, not features).
- **Multi-tenant scoping:** before a second organisation shares the engine, directory visibility and extension uniqueness must be per organisation (a tenant id on identities), not global.
- **Number lifecycle:** a number moves between people (recycling). Re-verify on a schedule, drop the association when a verification fails or the account is closed, and never treat a number as proof of identity for sign-in.

## What this decision changes in the code (when approved, not before)
1. An account-level `contact_numbers` table in the main app: E.164 value, verified_at, discoverable flag, organisation scope; unique among verified numbers.
2. A verification flow (code to the number) through a provider chosen and certified separately.
3. `voice.js`: a resolver `GET /api/voice/lookup?number=` returning `{ displayName, extension }` or nothing (same response for "no such number" and "not discoverable", to avoid confirming that a number exists).
4. Dial Pad: when a `+` number resolves to a discoverable colleague, offer "Internet call to <name>" next to (not instead of) a phone call, only when a carrier is connected.
5. Engine: no change. That is the point.

## Open questions for the owner
1. One organisation per deployment, or several sharing one? (Decides tenant scoping.)
2. Is a verified number needed for sign-in or only for discovery? (Recommendation: discovery only.)
3. Which verification provider, and who pays?
4. Is there a legal or contractual requirement for emergency calling in the markets served? If yes, PSTN routing must not ship without it.
5. Should an extension be changeable by an administrator (it is not today), and what happens to history and blocks if so?

Until these are answered, PSTN routing and number discovery stay out of scope and the internal-calling identity stays separate, as it is now.
