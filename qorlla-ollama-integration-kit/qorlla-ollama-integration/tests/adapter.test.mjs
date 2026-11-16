import test from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaAdapter } from '../src/ollama.mjs';

const response = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
const adapter = (transport, config = {}) => createOllamaAdapter({ models: 'llama3.2:3b', ...config }, transport);
const params = { model: 'llama3.2:3b', prompt: 'Hello', system: 'Assistant' };

test('valid private inference response', async () => {
  const a = adapter(async (_url, init) => {
    assert.equal(init.redirect, 'error');
    assert.equal(JSON.parse(init.body).stream, false);
    return response({ model: params.model, response: 'Hi', done: true, eval_count: 4 });
  });
  assert.deepEqual(await a.generate(params), { text: 'Hi', model: params.model, evalCount: 4 });
});
test('rejects unauthorized model without contacting backend', async () => {
  const a = adapter(() => { throw new Error('should not call'); });
  await assert.rejects(a.generate({ ...params, model: 'not-approved' }), { code: 'model_not_allowed' });
});
test('rejects unsafe endpoint and invalid configuration', () => {
  assert.throws(() => adapter(fetch, { url: 'https://example.com' }), /unapproved_ollama_host/);
  assert.throws(() => adapter(fetch, { maxConcurrent: 0 }), /invalid_ollama_configuration/);
  assert.throws(() => adapter(fetch, { models: 'bad model' }), /invalid_model_allowlist/);
});
test('rejects truncated or mismatched response', async () => {
  const a = adapter(async () => response({ response: 'ok', model: 'different', done: true }));
  await assert.rejects(a.generate(params), { code: 'invalid_ollama_response' });
});
test('bounds queue and cancels a waiting request', async () => {
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  let started = 0;
  const a = adapter(async () => { started++; await gate; return response({ model: params.model, response: 'ok', done: true }); }, { maxConcurrent: 1, maxQueue: 1 });
  const p1 = a.generate(params);
  const controller = new AbortController();
  const p2 = a.generate({ ...params, signal: controller.signal });
  assert.equal(a.stats().queued, 1);
  await assert.rejects(a.generate(params), { code: 'inference_busy' });
  controller.abort();
  await assert.rejects(p2, { code: 'cancelled' });
  assert.equal(a.stats().queued, 0);
  unblock(); await p1;
  assert.equal(started, 1);
  assert.equal(a.stats().active, 0);
});
test('response size limit enforced', async () => {
  const a = adapter(async () => response({ model: params.model, response: 'x'.repeat(4000), done: true }), { maxResponseBytes: 1024 });
  await assert.rejects(a.generate(params), { code: 'response_too_large' });
});
test('health reports allowlisted installed models only', async () => {
  const a = adapter(async () => response({ models: [{ name: 'llama3.2:3b' }, { name: 'other' }] }));
  assert.deepEqual(await a.health(), { ok: true, readyModels: ['llama3.2:3b'] });
});
