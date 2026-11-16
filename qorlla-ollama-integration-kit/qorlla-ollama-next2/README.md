# Qorlla Docs / Ollama — repository-specific integration patch

Source inspected: `jedgod/qorlla-Application-video`, branch `feature/qorlla-docs-integration`, 2026-11-10.
GitHub blob SHA anchors: `server/ai/config.mjs` 61b5297c341ff5971c1203a766aaee00ef001320; `server/ai/providers.mjs` 323da69103a278e8fd3c06d9e783630f41d0013f.

## Scope
Adds a guarded Ollama adapter to the existing **selfhosted** provider selection. Does not replace existing providers, the Docs editor, Portal routes, authentication, subscriptions, audit, or meeting `/api/docs` attachments. Existing selfhosted OpenAI-compatible deployments are unchanged unless `QORLLA_AI_SELFHOSTED_OLLAMA=true`.

## Apply to a clean, isolated worktree

1. Verify the branch and compare GitHub source to the anchors above. Create a separate local integration branch. Do not apply to an active worktree owned by another coding session.
2. Run `python apply_integration.py /path/to/qorlla-repo` to check source anchors (dry run).
3. Run `python apply_integration.py /path/to/qorlla-repo --apply` to copy the adapter/tests and wire the existing provider. Inspect `git diff`.
4. Run `cd qorlla-portal && node --test tests/ollama.integration.test.mjs` and the full `npm test` suite. Check `npm run check`.
5. In a disposable environment, merge the Compose fragment into the Portal deployment's internal network, pin the image version and verify the installed model with `ollama list`/`ollama pull`. Do not publish port 11434.
6. Set the environment example values and enable AI only for a controlled test. Test the real `/app/suite` Docs AI workflow, plan quotas, revocation during generation, cancellation, multi-tenant isolation, and offline/no-egress. Validate real-model JSON quality.
7. Preserve rollback images and document the final test and deployment evidence. No production release without separate approval.

## Design and limitations

- The existing Portal gateway still enforces provider eligibility, privacy profile, request limits and audit. The adapter cannot substitute for authentication, authorization, durable usage accounting or feature flags.
- The adapter implements bounded queue/concurrency, cancellation, timeout, endpoint allowlist, response-size bound and strict JSON response decoding. It does not expose model identities to the browser.
- Hostnames in `QORLLA_AI_OLLAMA_ALLOWED_HOSTS` are operator-controlled; use dedicated DNS/network policy to prevent DNS rebinding and egress. For remote Ollama use HTTPS and authenticated proxy/mTLS.
- Existing gateway does not currently propagate HTTP-client cancellation to all model calls. This adapter supports cancellation once a signal is passed; end-to-end cancellation needs an additional gateway/API wiring change.
- The `ollama` container example is not a complete production Compose file; integrate it into the existing Portal network and operational monitoring.
- Unit tests use mocked HTTP responses; no real Ollama model, GPU, Docker, PostgreSQL, browser, or Android test has been performed here.
- This package is a **reviewable integration patch**, not a certified production build.
