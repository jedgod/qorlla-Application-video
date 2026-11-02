# Qorlla Security Shield v2.1 — guest isolation overlay

This package extends v2.0 with strict guest-only meeting admission policy, a guest admission library, SQL migration, negative tests, and an integration/certification checklist.

**NOT production certified.** Read `INTEGRATION_CHECKLIST.md` before deployment.

Run `npm install`, apply `sql/001_init.sql` then `sql/002_guest_isolation.sql`, and run `npm test` and `npm run build`. Actual Qorlla service wiring, real workload identity, carrier protection and media enforcement remain required.
