import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshDatabase, startMainStandIn, testConfig, startApp, seedWorkspace } from './helpers.mjs';
import { startFakeLlm } from './fake-llm.mjs';
import { webhook } from './fake-twilio.mjs';
import { ORIGIN } from './helpers.mjs';

const key = () => 'idem-' + crypto.randomBytes(6).toString('hex');

describe('abuse limits: per-user rate limits on costly endpoints and request sizes that match the schemas', () => {
  let db, main, llmd, app, A, B, P;
  before(async () => {
    db = await freshDatabase(); main = await startMainStandIn(); llmd = await startFakeLlm(); P = await main.mint();
    app = await startApp({ pool: db.pool, cfg: testConfig({ env: { AI_LLM_API_KEY: 'test-llm-key', AI_LLM_API_BASE: llmd.url, PLATFORM_ADMIN_USER_IDS: P.sub }, cfg: { rateLimits: { ai: 3, draft: 2, call: 2, refund: 2, webhook: 5 } } }, main), jwks: main.jwks });
    A = await main.mint(); B = await main.mint(); for (const u of [A, B]) { const w = await seedWorkspace(db.pool, u.sub, 'Limits ' + crypto.randomBytes(2).toString('hex')); await db.pool.query(`UPDATE portal.subscriptions SET plan_slug='pro',status='active',current_period_end=now()+interval '20 days' WHERE workspace_id=$1`, [w]); }
  });
  after(async () => { await app.close(); await llmd.close(); await main.close(); await db.drop(); });

  test('QorllaMate: the 4th message in a minute is refused with 429 for that user only, and nothing is charged for the refused call', async () => {
    const a = app.client(A), b = app.client(B); const ta = (await a.post('/api/v1/assistant/threads', {})).body.id; const tb = (await b.post('/api/v1/assistant/threads', {})).body.id;
    const say = (cl, t) => cl.post(`/api/v1/assistant/threads/${t}/messages`, { content: 'hello', idempotency_key: key() });
    for (let i = 0; i < 3; i++) assert.equal((await say(a, ta)).status, 201);
    const calls = llmd.st.calls; const refused = await say(a, ta); assert.equal(refused.status, 429); assert.equal(refused.body.code, 'rate_limited'); assert.equal(llmd.st.calls, calls, 'the model is not called for a refused request');
    assert.equal((await say(b, tb)).status, 201, 'another user is unaffected');
  });
  test('AI drafts, click-to-call, provider webhooks and refunds each have their own limit', async () => {
    const a = app.client(A);
    const draft = () => a.post('/api/v1/documents/ai-draft', { kind: 'doc', prompt: 'a short brief', idempotency_key: key() });
    assert.equal((await draft()).status, 201); assert.equal((await draft()).status, 201); assert.equal((await draft()).status, 429);
    const call = () => a.post('/api/v1/phone/calls', { my_phone: '+12025550100', to: '+12025550123' });
    assert.equal((await call()).status, 503, 'telephony is off'); assert.equal((await call()).status, 503); assert.equal((await call()).status, 429, 'counted before any work is done');
    const hook = () => webhook(app.base, ORIGIN, '/api/v1/telephony/voice/inbound', { CallSid: 'CA' + 'a'.repeat(32), From: '+12025550100', To: '+12025550123' });
    for (let i = 0; i < 5; i++) assert.equal((await hook()).status, 503); assert.equal((await hook()).status, 429);
    const refund = () => app.client(P).post('/api/v1/admin/billing/refunds', { invoice_id: crypto.randomUUID(), reason: 'abuse test', idempotency_key: key() });
    const first = await refund(); assert.notEqual(first.status, 429); await refund(); assert.equal((await refund()).status, 429);
  });
  test('documents may be large (up to the schema limits) but not unbounded', async () => {
    const a = app.client(A);
    const big = (await a.post('/api/v1/documents', { kind: 'doc', title: 'Long report', content: { text: 'x'.repeat(190_000) } })); assert.equal(big.status, 201, JSON.stringify(big.body).slice(0, 200));
    assert.equal((await a.get(`/api/v1/documents/${big.body.id}`)).body.content.text.length, 190_000);
    assert.equal((await a.post('/api/v1/documents', { kind: 'doc', title: 'Too long', content: { text: 'x'.repeat(250_000) } })).status, 400, 'the schema still caps the text');
    const huge = await a.post('/api/v1/documents', { kind: 'doc', title: 'Huge', content: { text: 'y'.repeat(3_000_000) } }); assert.equal(huge.status, 413);
    const notes = await a.post('/api/v1/notes', { title: 'Other routes keep the small default', body: 'z'.repeat(200_000) }); assert.equal(notes.status, 413);
  });
});
