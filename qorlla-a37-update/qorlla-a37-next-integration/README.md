# Qorlla A3.7 Next Integration Code

Repository-specific adapter **reference** for the existing Qorlla Voice Engine, not a replacement server or production-certified patch.

Run: `node --test tests/*.test.mjs` (Node 20+).

Files: `src/dial-routing.mjs` from prior A3.7 package, `src/country-alias.mjs` PostgreSQL adapter, `src/smart-dial-service.mjs` Shield/engine adapter, `sql/037_voice_country_aliases.sql` schema template, `docs/INTEGRATION.md` instructions, `tests/smart-dial.test.mjs` unit tests.

DO NOT deploy SQL unchanged or enable PSTN. No actual repository or live infrastructure was available to run full integration.
