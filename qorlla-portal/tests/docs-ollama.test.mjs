import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace, addMember } from './helpers.mjs';

// Qorlla Docs AI through the real portal routes and PostgreSQL, with a self-hosted OLLAMA endpoint.
// The "Ollama" here is a local HTTP server that speaks Ollama's OpenAI-compatible /v1/chat/completions, so the real adapter, gateway, quota, audit and apply paths run.
// It proves our request, parsing and safety rules. It does NOT prove a real model is installed or that its output quality is good (see docs/OLLAMA_INTEGRATION.md).
const key = () => 'idem-' + crypto.randomBytes(6).toString('hex');

function fakeOllama() {
  const seen = []; let mode = 'ok'; const stats = { hung: 0, dropped: 0 };
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404); return res.end(); }
      const j = JSON.parse(body); seen.push({ url: req.url, auth: req.headers.authorization || null, body: j });
      if (mode === 'hang') { stats.hung++; res.on('close', () => { if (!res.writableEnded) stats.dropped++; }); return; }      // never answers; records when the caller hangs up
      if (mode === 'down') { res.writeHead(503); return res.end('{}'); }
      if (mode === 'garbage') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: 'this is not json' } }] })); }
      const task = /QORLLA-TASK:(\w+)/.exec(j.messages[0].content)?.[1] || 'unknown';
      const input = /<input>\n([\s\S]*?)\n<\/input>/.exec(j.messages[1].content)?.[1] || '';
      const out = {
        docs_summarize: { suggestion: 'SUMMARY: ' + input.slice(0, 40), notes: ['short'], evidence: [] },
        docs_rewrite: { suggestion: 'REWRITTEN: ' + input, notes: [], evidence: [] },
        docs_proofread: { suggestion: input.replace('teh', 'the'), notes: ['fixed teh'], evidence: [] },
        docs_translate: { suggestion: 'ES: ' + input, notes: [], evidence: [] },
        docs_draft: { suggestion: '# Draft\n\n[TBD]', notes: [], evidence: [] }
      }[task] || { suggestion: 'x', notes: [], evidence: [] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: j.model, choices: [{ message: { role: 'assistant', content: JSON.stringify(out) } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, seen, setMode: (m) => { mode = m; }, stats, close: () => new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }) })));
}

describe('Qorlla Docs AI with Ollama (local endpoint, PostgreSQL)', () => {
  let db, main, app, off, ol, H, M, V, W;
  const q = async (sql, args = []) => (await db.pool.query(sql, args)).rows;
  const owner = () => app.client(H, { workspace: W });
  const mkDoc = async (text, c = owner()) => (await c.post('/api/v1/documents', { kind: 'doc', title: 'Ollama doc', content: { format: 'markdown', text } })).body;

  before(async () => {
    ol = await fakeOllama();
    db = await freshDatabase(); main = await startMainStandIn();
    H = await main.mint(); M = await main.mint(); V = await main.mint();
    const contract = { QORLLA_AI_ENABLED: 'true', QORLLA_AI_PROVIDER: 'selfhosted', QORLLA_AI_APPROVED_PROVIDERS: 'selfhosted', QORLLA_AI_SELFHOSTED_URL: `http://127.0.0.1:${ol.port}/v1`, QORLLA_AI_SELFHOSTED_OLLAMA: 'true', QORLLA_AI_SELFHOSTED_MODEL: 'qwen2.5:3b', QORLLA_AI_ALLOW_PAID_FALLBACK: 'false', QORLLA_AI_RATE_PER_MINUTE: '100000' };
    app = await startApp({ pool: db.pool, cfg: testConfig({ env: contract }, main), jwks: main.jwks });
    off = await startApp({ pool: db.pool, cfg: testConfig({ env: {} }, main), jwks: main.jwks });
    W = await seedWorkspace(db.pool, H.sub, 'Ollama Co');
    await db.pool.query(`UPDATE portal.subscriptions SET plan_slug='pro',status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [W]);
    await addMember(db.pool, W, M.sub, 'member'); await addMember(db.pool, W, V.sub, 'member');
  });
  after(async () => { await app.close(); await off.close(); await main.close(); await db.drop(); await ol.close(); });

  test('off by default: with nothing configured the Docs assistant reports unavailable and refuses (no call to any model)', async () => {
    const before = ol.seen.length; const c = off.client(H, { workspace: W });
    assert.equal((await c.get('/api/v1/assistant/status')).body.ai_provider_configured, false);
    const d = await mkDoc('hello', c); const r = await c.post('/api/v1/ai/run', { task: 'docs_summarize', document_id: d.id, idempotency_key: key() });
    assert.equal(r.status, 503); assert.equal(ol.seen.length, before);
  });

  test('configured with Ollama: status is available and shows only the product name, never the model or host', async () => {
    const st = await owner().get('/api/v1/assistant/status'); assert.equal(st.status, 200); assert.equal(st.body.ai_provider_configured, true);
    const pub = await owner().get('/api/v1/ai/status'); assert.doesNotMatch(JSON.stringify([st.body, pub.body]), /ollama|qwen|127\.0\.0\.1/i);
  });

  for (const [task, extra, expect] of [['docs_summarize', {}, /^SUMMARY: /], ['docs_rewrite', {}, /^REWRITTEN: /], ['docs_proofread', {}, /the/], ['docs_translate', { target_language: 'Spanish' }, /^ES: /]]) {
    test(`${task}: returns a review-first suggestion from Ollama and changes nothing`, async () => {
      const d = await mkDoc('We sent teh report to the team.'); const c = owner();
      const r = await c.post('/api/v1/ai/run', { task, document_id: d.id, idempotency_key: key(), ...extra });
      assert.equal(r.status, 200, JSON.stringify(r.body)); assert.match(r.body.suggestion, expect);
      assert.equal(r.body.review_required, true); assert.equal(r.body.applied, false);
      const after = (await c.get('/api/v1/documents/' + d.id)).body; assert.equal(after.current_version, 1); assert.equal(after.content.text, 'We sent teh report to the team.');
      const sent = ol.seen.at(-1); assert.equal(sent.body.model, 'qwen2.5:3b'); assert.equal(sent.body.stream, false);
      assert.match(sent.body.messages[1].content, /teh report/);   // the document text went to the private endpoint only
    });
  }

  test('draft: a new document is created only after an explicit, confirmed apply', async () => {
    const c = owner(); const r = await c.post('/api/v1/ai/run', { task: 'docs_draft', text: 'a launch plan', idempotency_key: key() });
    assert.equal(r.status, 200); assert.equal(r.body.apply.mode, 'new_document');
    const count = async () => Number((await q('SELECT count(*)::int n FROM portal.documents WHERE workspace_id=$1', [W]))[0].n); const n0 = await count();
    const noConfirm = await c.post('/api/v1/ai/apply', { task: 'docs_draft', suggestion: r.body.suggestion, apply_token: r.body.apply.token, confirm: false, idempotency_key: key() }); assert.equal(noConfirm.status, 400); assert.equal(await count(), n0);
    const ok = await c.post('/api/v1/ai/apply', { task: 'docs_draft', suggestion: r.body.suggestion, apply_token: r.body.apply.token, title: 'Launch plan', confirm: true, idempotency_key: key() });
    assert.ok([200, 201].includes(ok.status), JSON.stringify(ok.body)); assert.equal(await count(), n0 + 1);
  });

  test('apply: a rewrite replaces the text as a new AI version, and a stale or tampered suggestion is refused', async () => {
    const c = owner(); const d = await mkDoc('original words'); const r = await c.post('/api/v1/ai/run', { task: 'docs_rewrite', document_id: d.id, idempotency_key: key() });
    const bad = await c.post('/api/v1/ai/apply', { task: 'docs_rewrite', document_id: d.id, base_version: 1, suggestion: r.body.suggestion + ' tampered', apply_token: r.body.apply.token, confirm: true, idempotency_key: key() });
    assert.equal(bad.status, 400); assert.equal(bad.body.code, 'invalid_suggestion');
    const ok = await c.post('/api/v1/ai/apply', { task: 'docs_rewrite', document_id: d.id, base_version: 1, suggestion: r.body.suggestion, apply_token: r.body.apply.token, confirm: true, idempotency_key: key() }); assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const now = (await c.get('/api/v1/documents/' + d.id)).body; assert.equal(now.current_version, 2); assert.equal(now.version_source, 'ai'); assert.match(now.content.text, /REWRITTEN: original words/);
    const again = await c.post('/api/v1/ai/apply', { task: 'docs_rewrite', document_id: d.id, base_version: 1, suggestion: r.body.suggestion, apply_token: r.body.apply.token, confirm: true, idempotency_key: key() });
    assert.ok([409, 400].includes(again.status), 'applying against an old version must not overwrite');
  });

  test('permissions: a person without access to the document cannot run AI on it (404, nothing sent to Ollama)', async () => {
    const d = await mkDoc('private text'); const n0 = ol.seen.length;
    const r = await app.client(M, { workspace: W }).post('/api/v1/ai/run', { task: 'docs_summarize', document_id: d.id, idempotency_key: key() });
    assert.equal(r.status, 404); assert.equal(ol.seen.length, n0);
  });

  test('provider outage and unusable output fail cleanly with a generic message (no host, model or raw output leaked)', async () => {
    const d = await mkDoc('some text'); const c = owner();
    for (const mode of ['down', 'garbage']) {
      ol.setMode(mode); const r = await c.post('/api/v1/ai/run', { task: 'docs_summarize', document_id: d.id, idempotency_key: key() });
      assert.ok(r.status >= 500 || r.status === 502 || r.status === 503 || r.status === 422, mode + ' -> ' + r.status);
      assert.doesNotMatch(JSON.stringify(r.body), /ollama|qwen|127\.0\.0\.1|not json/i);
    }
    ol.setMode('ok'); assert.equal((await c.post('/api/v1/ai/run', { task: 'docs_summarize', document_id: d.id, idempotency_key: key() })).status, 200);
  });

  test('the monthly document-generation quota applies to Ollama suggestions and is metered', async () => {
    const c = owner(); const d = await mkDoc('quota text');
    const used0 = Number((await q(`SELECT coalesce(sum(units),0)::int n FROM portal.ai_usage_events WHERE workspace_id=$1 AND feature='doc_generation'`, [W]))[0].n);
    const r = await c.post('/api/v1/ai/run', { task: 'docs_summarize', document_id: d.id, idempotency_key: key() }); assert.equal(r.status, 200);
    const used1 = Number((await q(`SELECT coalesce(sum(units),0)::int n FROM portal.ai_usage_events WHERE workspace_id=$1 AND feature='doc_generation'`, [W]))[0].n);
    assert.equal(used1, used0 + 1);
  });
  test('cancellation reaches the model: a closed browser request aborts the Ollama call, meters nothing, and the next request still works', async () => {
    const d = await mkDoc('cancel me'); const used = async () => Number((await q(`SELECT coalesce(sum(units),0)::int n FROM portal.ai_usage_events WHERE workspace_id=$1 AND feature='doc_generation'`, [W]))[0].n);
    const u0 = await used(); const h0 = ol.stats.hung, d0 = ol.stats.dropped; ol.setMode('hang');
    const ctl = new AbortController();
    const req = fetch(app.base + '/api/v1/ai/run', { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', origin: 'https://qorlla.test', 'x-workspace-id': W, 'x-csrf-token': H.csrf, cookie: `qorlla_portal_session=${H.jwt}; qorlla_csrf=${H.csrf}` }, body: JSON.stringify({ task: 'docs_summarize', document_id: d.id, idempotency_key: key() }) }).catch((e) => e);
    for (let i = 0; i < 40 && ol.stats.hung === h0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(ol.stats.hung, h0 + 1, 'the request reached Ollama'); ctl.abort(); await req;
    for (let i = 0; i < 60 && ol.stats.dropped === d0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(ol.stats.dropped, d0 + 1, 'Ollama saw the connection close'); assert.equal(await used(), u0, 'a cancelled run is not metered');
    ol.setMode('ok'); assert.equal((await owner().post('/api/v1/ai/run', { task: 'docs_summarize', document_id: d.id, idempotency_key: key() })).status, 200);
  });

});
