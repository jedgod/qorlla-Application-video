import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace } from './helpers.mjs';

// The real gateway and portal routes against STUB provider servers that count what reaches them. The point of every test here is what must NOT be sent:
// content to an external provider without the workspace's authorisation, to a provider that is not approved, to a paid provider, or off the private profile.
// Stubs are not real providers: this proves our refusal logic, not that any live account works.
const key = () => 'idem-' + crypto.randomBytes(6).toString('hex');
function stub(kind, behaviour = 'ok') {
  const hits = []; const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      hits.push({ url: req.url, auth: req.headers.authorization || req.headers['x-goog-api-key'] || null, body: b });
      if (behaviour === 'down') { res.statusCode = 503; return res.end('{}'); }
      const text = JSON.stringify({ suggestion: 'STUB-reply', notes: [] }); res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(kind === 'gemini' ? { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} } : { choices: [{ message: { content: text } }], usage: {}, model: 'stub-model' }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ hits, url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((x) => server.close(x)) })));
}
const BASE = { QORLLA_AI_ENABLED: 'true', QORLLA_AI_PROVIDER: 'auto', QORLLA_AI_ALLOW_FREE_TIER: 'true', QORLLA_AI_ALLOW_PAID_FALLBACK: 'false', QORLLA_AI_TEST_ADAPTER_ENABLED: 'false', QORLLA_AI_RATE_PER_MINUTE: '100000', QORLLA_AI_BREAKER_FAILURES: '1000' };

describe('Qorlla AI refuses what must not be sent (stub providers, PostgreSQL)', () => {
  let db, main, U, W1, W2; const apps = []; let down, good, local, paid;
  const boot = async (env) => { const a = await startApp({ pool: db.pool, cfg: testConfig({ env: { ...BASE, ...env } }, main), jwks: main.jwks }); apps.push(a); return a; };
  const run = (a, ws, extra = {}) => a.client(U).post('/api/v1/ai/run', { task: 'docs_summarize', text: 'CONFIDENTIAL board minutes 4711', idempotency_key: key(), ...extra }, { 'x-workspace-id': ws });
  const allHits = () => [down, good, local, paid].reduce((n, s) => n + s.hits.length, 0);
  const reset = () => [down, good, local, paid].forEach((s) => { s.hits.length = 0; });
  const providers = (extra = {}) => ({ QORLLA_AI_GEMINI_API_KEY: 'gk', QORLLA_AI_GEMINI_MODEL: 'gm', QORLLA_AI_GEMINI_BASE_URL: down.url, QORLLA_AI_GEMINI_TIER: 'free', QORLLA_AI_XAI_API_KEY: 'xk', QORLLA_AI_XAI_MODEL: 'xm', QORLLA_AI_XAI_BASE_URL: good.url, QORLLA_AI_XAI_TIER: 'free', ...extra });

  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn(); U = await main.mint();
    down = await stub('gemini', 'down'); good = await stub('xai'); local = await stub('local'); paid = await stub('openai');
    W1 = await seedWorkspace(db.pool, U.sub, 'Consent Co'); W2 = await seedWorkspace(db.pool, U.sub, 'No Consent Co');
    for (const w of [W1, W2]) await db.pool.query(`UPDATE portal.subscriptions SET plan_slug='pro',status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [w]);
    await db.pool.query('UPDATE portal.workspace_ai_settings SET external_processing=false WHERE workspace_id IN ($1,$2)', [W1, W2]);   // the real default: not authorised
  });
  after(async () => { for (const a of apps) await a.close(); for (const s of [down, good, local, paid]) await s.close(); await main.close(); await db.drop(); });

  test('external providers receive nothing until the workspace authorises external processing, and one workspace\'s authorisation does not cover another', async () => {
    const a = await boot(providers({ QORLLA_AI_APPROVED_PROVIDERS: 'gemini,xai' })); reset();
    const refused = await run(a, W1); assert.equal(refused.status, 403); assert.equal(refused.body.code, 'consent_required'); assert.match(refused.body.error, /authorised external AI processing/); assert.equal(allHits(), 0, 'no request left the platform');
    assert.equal((await a.client(U).put('/api/v1/ai/settings', { external_processing: true }, { 'x-workspace-id': W1 })).status, 200);
    const ok = await run(a, W1); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.model, 'qorlla-ai'); assert.doesNotMatch(JSON.stringify(ok.body), /xai|gemini|stub-model|xm/i);
    const other = await run(a, W2); assert.equal(other.status, 403, 'the second workspace never authorised it'); assert.equal(other.body.code, 'consent_required');
    await a.client(U).put('/api/v1/ai/settings', { external_processing: false }, { 'x-workspace-id': W1 }); reset(); assert.equal((await run(a, W1)).status, 403, 'withdrawing the authorisation takes effect at once'); assert.equal(allHits(), 0);
    assert.equal((await db.pool.query(`SELECT count(*)::int n FROM portal.ai_gateway_audit WHERE outcome='consent_required'`)).rows[0].n >= 3, true, 'each refusal is audited');
  });

  test('Qorlla AI Private refuses when no local model exists, even for an authorised workspace, and sends nothing out', async () => {
    const a = await boot(providers({ QORLLA_AI_APPROVED_PROVIDERS: 'gemini,xai' })); await a.client(U).put('/api/v1/ai/settings', { external_processing: true }, { 'x-workspace-id': W1 }); reset();
    const models = await a.client(U).get('/api/v1/ai/models', { 'x-workspace-id': W1 }); assert.deepEqual(models.body.map((m) => [m.id, m.available]), [['qorlla-ai', true], ['qorlla-ai-private', false]]);
    const r = await run(a, W1, { model: 'qorlla-ai-private' }); assert.equal(r.status, 503); assert.equal(r.body.code, 'private_unavailable'); assert.match(r.body.error, /private/i); assert.equal(allHits(), 0, 'nothing was sent to any external provider');
    assert.equal((await run(a, W1)).status, 200, 'the automatic profile still works for an authorised workspace');
    await a.client(U).put('/api/v1/ai/settings', { external_processing: false }, { 'x-workspace-id': W1 });
  });

  test('with a local model the private profile uses only it, with no authorisation needed, and external providers stay silent', async () => {
    const a = await boot(providers({ QORLLA_AI_APPROVED_PROVIDERS: 'gemini,xai,selfhosted', QORLLA_AI_SELFHOSTED_URL: local.url, QORLLA_AI_SELFHOSTED_MODEL: 'open' })); reset();
    const m = await a.client(U).get('/api/v1/ai/models', { 'x-workspace-id': W2 }); assert.equal(m.body[1].available, true);
    const r = await run(a, W2, { model: 'qorlla-ai-private' }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(local.hits.length, 1); assert.equal(down.hits.length + good.hits.length, 0);
    const auto = await run(a, W2); assert.equal(auto.status, 200, 'an unauthorised workspace still gets the local model on the automatic profile'); assert.equal(down.hits.length + good.hits.length, 0, 'and external providers are still never contacted');
  });

  test('failover never reaches a provider that is not approved, and never a paid one', async () => {
    reset(); await db.pool.query('UPDATE portal.workspace_ai_settings SET external_processing=true WHERE workspace_id=$1', [W1]);
    const gated = await boot(providers({ QORLLA_AI_APPROVED_PROVIDERS: 'gemini', QORLLA_AI_OPENAI_API_KEY: 'ok', QORLLA_AI_OPENAI_MODEL: 'om', QORLLA_AI_OPENAI_BASE_URL: paid.url }));   // xai configured, NOT approved; openai undeclared tier = paid
    const r = await run(gated, W1); assert.equal(r.status, 503, JSON.stringify(r.body)); assert.equal(r.body.code, 'ai_unavailable'); assert.ok(down.hits.length >= 1, 'the approved provider was tried');
    assert.equal(good.hits.length, 0, 'the unapproved provider never saw the content'); assert.equal(paid.hits.length, 0, 'the paid provider never saw the content');
    assert.ok(!down.hits.concat(good.hits, paid.hits).some((h) => /sk-|ok$/.test(h.auth || '') && h.url.includes('xai')), 'no key was misdirected');
    const adm = (await gated.ai.llm.adminStatus()); assert.deepEqual(adm.configuredNotApproved.sort(), ['openai', 'xai']);
    reset(); const approved = await boot(providers({ QORLLA_AI_APPROVED_PROVIDERS: 'gemini,xai' })); const ok = await run(approved, W1); assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(down.hits.length >= 1 && good.hits.length === 1, 'once approved, failover goes to the next provider'); assert.match(good.hits[0].body, /CONFIDENTIAL/, 'the approved, authorised provider did receive the request'); assert.equal(good.hits[0].auth, 'Bearer xk');
  });

  test('paid use needs its own approval on top of the provider approval', async () => {
    reset(); const env = { QORLLA_AI_APPROVED_PROVIDERS: 'openai', QORLLA_AI_OPENAI_API_KEY: 'ok', QORLLA_AI_OPENAI_MODEL: 'om', QORLLA_AI_OPENAI_BASE_URL: paid.url };
    const noPaid = await boot(env); const r = await run(noPaid, W1); assert.equal(r.status, 503); assert.equal(paid.hits.length, 0, 'paid fallback is off');
    const withPaid = await boot({ ...env, QORLLA_AI_ALLOW_PAID_FALLBACK: 'true' }); assert.equal((await run(withPaid, W1)).status, 200); assert.equal(paid.hits.length, 1);
  });

  test('keys and content never appear in what users, administrators or the audit trail can read', async () => {
    const a = await boot(providers({ QORLLA_AI_APPROVED_PROVIDERS: 'gemini,xai' })); await run(a, W1);
    const audit = JSON.stringify((await db.pool.query('SELECT * FROM portal.ai_gateway_audit')).rows); assert.doesNotMatch(audit, /CONFIDENTIAL|4711|gk|xk|STUB-/);
    const st = JSON.stringify(a.ai.llm.adminStatus()); assert.doesNotMatch(st, /"gk"|"xk"|apiKey/);
  });
});
