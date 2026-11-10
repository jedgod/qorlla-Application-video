import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace } from './helpers.mjs';

// REAL model smoke test through the real portal and PostgreSQL. Skipped unless a real Ollama is named:
//   OLLAMA_REAL_URL=http://127.0.0.1:11434/v1  OLLAMA_REAL_MODEL=qwen2.5:1.5b  node --test tests/docs-ollama.real.test.mjs
// It proves that THIS model, on THIS machine, returns output the gateway accepts for each Docs task, and records the latency.
// It does not judge writing quality beyond a few cheap checks, and it says nothing about other models or hardware.
const URL_ = process.env.OLLAMA_REAL_URL, MODEL = process.env.OLLAMA_REAL_MODEL;
const key = () => 'idem-' + crypto.randomBytes(6).toString('hex');
const TEXT = 'Our team sent teh quarterly report to the board on Monday. The revenue grew by twelve percent, and the costs stayed flat. We plan to hire two engineers next month.';

describe('Qorlla Docs AI with a REAL Ollama model', { skip: !URL_ || !MODEL ? 'set OLLAMA_REAL_URL and OLLAMA_REAL_MODEL' : false, timeout: 900000 }, () => {
  let db, main, app, H, W; const timings = [];
  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn(); H = await main.mint();
    const host = new globalThis.URL(URL_).hostname;
    const contract = { QORLLA_AI_ENABLED: 'true', QORLLA_AI_PROVIDER: 'selfhosted', QORLLA_AI_APPROVED_PROVIDERS: 'selfhosted', QORLLA_AI_SELFHOSTED_URL: URL_, QORLLA_AI_SELFHOSTED_OLLAMA: 'true', QORLLA_AI_SELFHOSTED_MODEL: MODEL, QORLLA_AI_OLLAMA_ALLOWED_HOSTS: host, QORLLA_AI_TIMEOUT_MS: '170000', QORLLA_AI_RATE_PER_MINUTE: '100000' };
    app = await startApp({ pool: db.pool, cfg: testConfig({ env: contract }, main), jwks: main.jwks });
    W = await seedWorkspace(db.pool, H.sub, 'Real Ollama Co');
    await db.pool.query(`UPDATE portal.subscriptions SET plan_slug='pro',status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [W]);
  });
  after(async () => { console.log('LATENCY ms by task:', JSON.stringify(timings)); await app.close(); await main.close(); await db.drop(); });

  for (const [task, extra] of [['docs_summarize', {}], ['docs_rewrite', {}], ['docs_proofread', {}], ['docs_translate', { target_language: 'Spanish' }], ['docs_improve', {}]]) {
    test(`${task}: the real model returns output the gateway accepts`, async () => {
      const c = app.client(H, { workspace: W }); const d = (await c.post('/api/v1/documents', { kind: 'doc', title: 'Real', content: { format: 'markdown', text: TEXT } })).body;
      const t0 = Date.now(); const r = await c.post('/api/v1/ai/run', { task, document_id: d.id, idempotency_key: key(), ...extra }); const ms = Date.now() - t0; timings.push([task, ms]);
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300)); assert.equal(typeof r.body.suggestion, 'string'); assert.ok(r.body.suggestion.trim().length > 10, 'non-trivial suggestion');
      assert.equal((await c.get('/api/v1/documents/' + d.id)).body.current_version, 1, 'nothing written');
      if (task === 'docs_proofread') assert.doesNotMatch(r.body.suggestion, /\bteh\b/i, 'typo corrected');
      if (task === 'docs_translate') assert.doesNotMatch(r.body.suggestion, /quarterly report to the board/i, 'translated, not copied');
      console.log(`[${task}] ${ms} ms: ${r.body.suggestion.replace(/\s+/g, ' ').slice(0, 160)}`);
    });
  }
});
