import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocsAiService } from '../src/docs-ai.mjs';
const actor = { id: 'user1', tenantId: 'tenant1' };
const adapter = { models: ['local'], async generate() { return { text: 'Suggested', model: 'local' }; } };
const base = {
  adapter, model: 'local', enabled: true,
  authorize: async () => ({ tenantId: 'tenant1', text: 'Existing text', version: 2 }),
  authorizeSelection: async () => {},
  reserve: async () => ({ commit: async () => {}, release: async () => {} }),
  audit: async () => {},
};
const input = { actor, documentId: 'doc1', mode: 'summarize', requestId: 'req_123456789012' };
test('requires Portal hooks', () => assert.throws(() => createDocsAiService({ adapter, model: 'local' }), /portal_integration_hooks_required/));
test('disabled by default', async () => {
  const svc = createDocsAiService({ ...base, enabled: false });
  await assert.rejects(svc.suggest(input), { code: 'ai_disabled' });
});
test('authorized request returns suggestion, not saved document', async () => {
  let commits = 0;
  const svc = createDocsAiService({ ...base, reserve: async () => ({ commit: async () => { commits++; }, release: async () => {} }) });
  assert.deepEqual(await svc.suggest(input), { suggestion: 'Suggested', model: 'local', sourceVersion: 2, requiresUserAcceptance: true });
  assert.equal(commits, 1);
});
test('cross-tenant document refused before inference', async () => {
  const svc = createDocsAiService({ ...base, authorize: async () => ({ tenantId: 'tenant2', text: 'Secret' }) });
  await assert.rejects(svc.suggest(input), { code: 'document_access_denied' });
});
test('revocation during inference refuses output and releases quota', async () => {
  let reads = 0, releases = 0;
  const svc = createDocsAiService({ ...base,
    authorize: async () => ++reads === 1 ? { tenantId: 'tenant1', text: 'Text', version: 1 } : null,
    reserve: async () => ({ commit: async () => { throw Error('must not commit'); }, release: async () => { releases++; } }),
  });
  await assert.rejects(svc.suggest(input), { code: 'document_access_denied' });
  assert.equal(releases, 1);
});
test('selected text must be checked by Portal', async () => {
  let checked = false;
  const svc = createDocsAiService({ ...base, authorizeSelection: async () => { checked = true; } });
  await svc.suggest({ ...input, selection: 'Existing' });
  assert.equal(checked, true);
});
