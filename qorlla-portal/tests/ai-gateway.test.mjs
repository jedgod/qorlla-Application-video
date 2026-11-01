import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { resolveAiConfig, eligibleProviders, environmentOf } from '../server/ai/config.mjs';
import { buildAdapters } from '../server/ai/providers.mjs';
import { createAiGateway } from '../server/ai/gateway.mjs';
import { LlmError } from '../server/ai/llm.mjs';

// The gateway is tested against STUBBED provider endpoints and the labelled deterministic adapter. A pass proves our configuration rules, request building, parsing, failover, consent and audit logic;
// it does NOT prove that a real account, quota or model works. Live-provider checks are a separate, separately authorised step.
const KEYS = { QORLLA_AI_GEMINI_API_KEY: 'g-SECRET-key', QORLLA_AI_GEMINI_MODEL: 'g-model', QORLLA_AI_GEMINI_TIER: 'free', QORLLA_AI_OPENAI_API_KEY: 'o-SECRET-key', QORLLA_AI_OPENAI_MODEL: 'o-model', QORLLA_AI_XAI_API_KEY: 'x-SECRET-key', QORLLA_AI_XAI_MODEL: 'x-model', QORLLA_AI_XAI_TIER: 'free' };
const INTEGRATION = { QORLLA_AI_ENABLED: 'true', QORLLA_AI_PROVIDER: 'auto', QORLLA_AI_ALLOW_FREE_TIER: 'true', QORLLA_AI_ALLOW_PAID_FALLBACK: 'false', QORLLA_AI_TEST_ADAPTER_ENABLED: 'false', QORLLA_AI_APPROVED_PROVIDERS: 'openai,gemini,xai,selfhosted', ...KEYS };
const ids = (cfg) => eligibleProviders(cfg).map((p) => p.id);
const Out = z.object({ answer: z.string() });
const reply = (text) => ({ ok: true, status: 200, json: async () => text });
const ctx = { actorId: 'u1', workspaceId: 'w1', feature: 'docs_draft', externalProcessing: true };

test('the three environment contracts: integration, automated test, and production off by default', () => {
  const i = resolveAiConfig(INTEGRATION); assert.deepEqual(i.problems, []); assert.equal(i.enabled, true); assert.equal(i.testAdapter, false);
  assert.deepEqual(ids(i).sort(), ['gemini', 'xai'], 'free providers only: OpenAI has no declared tier, so it counts as PAID and is excluded');
  const t = resolveAiConfig({ QORLLA_AI_ENABLED: 'true', QORLLA_AI_PROVIDER: 'test', QORLLA_AI_TEST_ADAPTER_ENABLED: 'true', QORLLA_ENVIRONMENT: 'test', QORLLA_AI_ALLOW_PAID_FALLBACK: 'false', ...KEYS });
  assert.deepEqual(t.problems, []); assert.deepEqual(ids(t), ['test']); assert.equal(environmentOf({ QORLLA_ENVIRONMENT: 'test' }), 'test');
  const p = resolveAiConfig({ NODE_ENV: 'production', ...KEYS }); assert.equal(p.enabled, false); assert.deepEqual(ids(p), []); assert.deepEqual(p.problems, []); assert.equal(p.environment, 'production');
  const none = resolveAiConfig({ QORLLA_AI_ENABLED: 'true', QORLLA_AI_PROVIDER: 'none', ...KEYS }); assert.equal(none.enabled, false);
});
test('the test adapter is refused in production and outside an explicitly identified test environment, and the server will not start with it', () => {
  const prod = resolveAiConfig({ NODE_ENV: 'production', QORLLA_AI_ENABLED: 'true', QORLLA_AI_PROVIDER: 'test', QORLLA_AI_TEST_ADAPTER_ENABLED: 'true', QORLLA_ENVIRONMENT: 'test' });
  assert.ok(prod.problems.some((x) => /refused in production/.test(x))); assert.equal(prod.testAdapter, false); assert.throws(() => createAiGateway({ config: prod }), /refused/);
  const loose = resolveAiConfig({ QORLLA_AI_ENABLED: 'true', QORLLA_AI_PROVIDER: 'test', QORLLA_AI_TEST_ADAPTER_ENABLED: 'true' }); assert.ok(loose.problems.some((x) => /QORLLA_ENVIRONMENT=test/.test(x)));
  const flagOnly = resolveAiConfig({ NODE_ENV: 'production', QORLLA_AI_TEST_ADAPTER_ENABLED: 'true' }); assert.ok(flagOnly.problems.length, 'even with AI otherwise OFF, asking for the test adapter in production is an error');
  const noFlag = resolveAiConfig({ QORLLA_AI_ENABLED: 'true', QORLLA_AI_PROVIDER: 'test', QORLLA_ENVIRONMENT: 'test' }); assert.ok(noFlag.problems.length);
});
test('paid providers need separate approval; free tier needs its own switch; a local model is always allowed; order is local, free, paid', () => {
  assert.deepEqual(ids(resolveAiConfig({ ...INTEGRATION, QORLLA_AI_ALLOW_FREE_TIER: 'false' })), [], 'free tier switched off and paid not approved: nothing is eligible');
  const paid = resolveAiConfig({ ...INTEGRATION, QORLLA_AI_ALLOW_PAID_FALLBACK: 'true', QORLLA_AI_SELFHOSTED_URL: 'http://llm.internal:8000/v1' });
  assert.deepEqual(ids(paid), ['selfhosted', 'gemini', 'xai', 'openai']); assert.equal(eligibleProviders(paid)[0].external, false);
  assert.deepEqual(ids(resolveAiConfig({ ...INTEGRATION, QORLLA_AI_PROVIDER: 'gemini' })), ['gemini']);
  assert.ok(resolveAiConfig({ ...INTEGRATION, QORLLA_AI_PROVIDER: 'openai' }).providers.openai, 'the credentials are read, but a paid provider stays ineligible: ' + ids(resolveAiConfig({ ...INTEGRATION, QORLLA_AI_PROVIDER: 'openai' })));
});
test('configuration mistakes are reported, and Aria stays blocked until an official integration is verified', () => {
  assert.ok(resolveAiConfig({ QORLLA_AI_ENABLED: 'true', QORLLA_AI_PROVIDER: 'bogus' }).problems.length);
  assert.ok(resolveAiConfig({ QORLLA_AI_ENABLED: 'true', QORLLA_AI_PROVIDER: 'auto', QORLLA_AI_OPENAI_API_KEY: 'k' }).problems.some((x) => /MODEL is required/.test(x)));
  assert.ok(resolveAiConfig({ QORLLA_AI_ENABLED: 'true', QORLLA_AI_PROVIDER: 'aria' }).problems.length, 'there is no Aria adapter to select');
  const gw = createAiGateway({ config: resolveAiConfig(INTEGRATION), adapters: [] }); assert.ok(gw.adminStatus().blocked.some((b) => b.id === 'aria' && /verified/.test(b.reason)));
});

// ---------------------------------------------------------------- adapters: the request each provider's official API expects
function recorder(answer) { const calls = []; return { calls, fetchImpl: async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return typeof answer === 'function' ? answer(url, init) : answer; } }; }
const one = (cfg, id, fetchImpl) => buildAdapters(eligibleProviders(cfg).filter((p) => p.id === id), { fetchImpl })[0];
const allow = { ...INTEGRATION, QORLLA_AI_ALLOW_PAID_FALLBACK: 'true', QORLLA_AI_SELFHOSTED_URL: 'http://llm.internal:8000/v1', QORLLA_AI_SELFHOSTED_MODEL: 'open-weights' };
test('OpenAI, xAI and self-hosted adapters send the chat-completions request and read its answer and token counts', async () => {
  for (const [id, base, key] of [['openai', 'https://api.openai.com/v1', 'Bearer o-SECRET-key'], ['xai', 'https://api.x.ai/v1', 'Bearer x-SECRET-key'], ['selfhosted', 'http://llm.internal:8000/v1', undefined]]) {
    const r = recorder(reply({ model: 'served-model', choices: [{ message: { content: '{"answer":"ok"}' } }], usage: { prompt_tokens: 11, completion_tokens: 3 } })); const out = await one(resolveAiConfig(allow), id, r.fetchImpl).call({ system: 'S', user: 'U', maxTokens: 50 });
    assert.equal(r.calls[0].url, base + '/chat/completions', id); assert.equal(r.calls[0].init.headers.authorization, key, id); assert.deepEqual(r.calls[0].body.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);
    assert.equal(r.calls[0].body.max_tokens, 50); assert.deepEqual(r.calls[0].body.response_format, { type: 'json_object' }); assert.deepEqual([out.text, out.inputTokens, out.outputTokens], ['{"answer":"ok"}', 11, 3]);
  }
});
test('the Gemini adapter keeps its key in a header (never the URL) and reads candidates and usage metadata', async () => {
  const r = recorder(reply({ candidates: [{ content: { parts: [{ text: '{"answer":' }, { text: '"ok"}' }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 }, modelVersion: 'g-model-001' })); const out = await one(resolveAiConfig(allow), 'gemini', r.fetchImpl).call({ system: 'S', user: 'U', maxTokens: 40 });
  assert.equal(r.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/g-model:generateContent'); assert.ok(!r.calls[0].url.includes('SECRET')); assert.equal(r.calls[0].init.headers['x-goog-api-key'], 'g-SECRET-key');
  assert.deepEqual(r.calls[0].body.systemInstruction, { parts: [{ text: 'S' }] }); assert.equal(r.calls[0].body.generationConfig.responseMimeType, 'application/json'); assert.deepEqual([out.text, out.inputTokens, out.outputTokens], ['{"answer":"ok"}', 7, 2]);
});
test('provider failures map to retryable or final errors with generic messages that never carry a key or a provider name', async () => {
  const cases = [[429, 'llm_quota', true], [503, 'llm_busy', true], [401, 'llm_auth', true], [400, 'llm_rejected', false]];
  for (const [status, code, retryable] of cases) {
    const a = one(resolveAiConfig(allow), 'openai', async () => ({ ok: false, status, json: async () => ({}) }));
    await assert.rejects(a.call({ system: 'S', user: 'U', maxTokens: 5 }), (e) => { assert.equal(e.code, code); assert.equal(e.retryable, retryable); assert.doesNotMatch(e.message, /openai|SECRET|gemini|grok|xai/i); assert.equal(e.provider, 'openai'); return true; });
  }
  const timeout = one(resolveAiConfig(allow), 'gemini', async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); }); await assert.rejects(timeout.call({ system: 'S', user: 'U', maxTokens: 5 }), (e) => e.code === 'llm_timeout' && e.retryable);
  const down = one(resolveAiConfig(allow), 'xai', async () => { throw new Error('ECONNREFUSED'); }); await assert.rejects(down.call({ system: 'S', user: 'U', maxTokens: 5 }), (e) => e.code === 'llm_unreachable' && e.retryable);
});

// ---------------------------------------------------------------- the gateway
const fake = (id, { external = true, tier = 'free', fn } = {}) => ({ id, external, tier, model: id + '-model', calls: 0, async call(a) { this.calls++; return fn ? fn(a, this) : { text: '{"answer":"from ' + id + '"}', model: id + '-model', inputTokens: 5, outputTokens: 2 }; } });
const cfgFor = (extra = {}) => ({ ...resolveAiConfig(INTEGRATION), ...extra });
const gw = (adapters, o = {}) => { const audits = []; let t = 1_000_000; const g = createAiGateway({ config: cfgFor(o.config), adapters, audit: async (r) => audits.push(r), consent: o.consent, now: () => t, log: { error() {} } }); return { g, audits, advance: (ms) => { t += ms; } }; };
const run = (g, c = ctx, system = 'sys', user = 'user text') => g.generateJson({ system, user, schema: Out, ctx: c });

test('a request goes to the preferred provider, and the answer is labelled Qorlla AI only', async () => {
  const a = fake('selfhosted', { external: false, tier: 'local' }), b = fake('gemini'); const { g } = gw([a, b]);
  const r = await run(g); assert.deepEqual(r.data, { answer: 'from selfhosted' }); assert.equal(r.model, 'qorlla-ai'); assert.equal(a.calls, 1); assert.equal(b.calls, 0);
  assert.equal(g.provider, 'qorlla'); assert.equal(g.available, true); assert.deepEqual(g.publicStatus(), { assistant: 'Qorlla AI', available: true });
});
test('failover: a busy, timed-out or unreadable provider is skipped and the next one answers; a final refusal is not retried elsewhere', async () => {
  const busy = fake('gemini', { fn: () => { throw new LlmError('busy', { retryable: true, code: 'llm_busy' }); } }), junk = fake('xai', { fn: () => ({ text: 'no json here', model: 'm', inputTokens: 1, outputTokens: 1 }) }), good = fake('openai');
  const { g, audits } = gw([busy, junk, good]); const r = await run(g); assert.equal(r.data.answer, 'from openai'); assert.deepEqual(audits.map((x) => [x.provider, x.outcome]), [['gemini', 'error'], ['xai', 'error'], ['openai', 'ok']]);
  const refuse = fake('gemini', { fn: () => { throw new LlmError('bad', { retryable: false, code: 'llm_rejected' }); } }), never = fake('openai'); const f = gw([refuse, never]);
  await assert.rejects(run(f.g), (e) => e.code === 'llm_rejected' && /Qorlla AI/.test(e.message) && !/gemini|openai/i.test(e.message)); assert.equal(never.calls, 0);
  const all = gw([fake('gemini', { fn: () => { throw new LlmError('x', { retryable: true, code: 'llm_busy' }); } })]); await assert.rejects(run(all.g), (e) => e.code === 'ai_unavailable' && e.retryable);
});
test('the circuit breaker stops calling a failing provider and tries it again after the cooldown', async () => {
  let fail = true; const flaky = fake('gemini', { fn: () => { if (fail) throw new LlmError('busy', { retryable: true, code: 'llm_busy' }); return { text: '{"answer":"back"}', model: 'm', inputTokens: 1, outputTokens: 1 }; } }), backup = fake('xai');
  const { g, advance } = gw([flaky, backup], { config: { breaker: { failures: 3, cooldownMs: 30_000 } } });
  for (let i = 0; i < 3; i += 1) await run(g, { ...ctx, actorId: 'u' + i }); assert.equal(flaky.calls, 3); await run(g, { ...ctx, actorId: 'u9' }); assert.equal(flaky.calls, 3, 'open: not called again'); assert.equal(g.adminStatus().providers[0].healthy, false);
  fail = false; advance(31_000); const r = await run(g, { ...ctx, actorId: 'u10' }); assert.equal(r.data.answer, 'back'); assert.equal(g.adminStatus().providers[0].healthy, true);
});
test('unreadable model output is a content problem, not an outage: it never trips the circuit breaker of the only provider', async () => {
  const junk = fake('gemini', { fn: () => ({ text: 'not json', model: 'm', inputTokens: 1, outputTokens: 1 }) }); const { g } = gw([junk], { config: { breaker: { failures: 2, cooldownMs: 30_000 } } });
  for (let i = 0; i < 5; i += 1) await assert.rejects(run(g, { ...ctx, actorId: 'u' + i }), (e) => e.code === 'invalid_model_output'); assert.equal(junk.calls, 5); assert.equal(g.adminStatus().providers[0].healthy, true);
});
test('external processing needs the workspace authorisation: otherwise only local providers are used, and with none the request is refused', async () => {
  const local = fake('selfhosted', { external: false, tier: 'local' }), ext = fake('gemini');
  const noConsent = gw([ext, local], { consent: async () => false }); assert.equal((await run(noConsent.g, { actorId: 'u', workspaceId: 'w', feature: 'x' })).data.answer, 'from selfhosted'); assert.equal(ext.calls, 0);
  const onlyExt = gw([fake('gemini')], { consent: async () => false }); await assert.rejects(run(onlyExt.g, { actorId: 'u', workspaceId: 'w', feature: 'x' }), (e) => e.code === 'consent_required' && /authorised external AI processing/.test(e.message));
  assert.equal(onlyExt.audits[0].outcome, 'consent_required'); const yes = gw([fake('gemini')], { consent: async () => true }); assert.equal((await run(yes.g, { actorId: 'u', workspaceId: 'w', feature: 'x' })).data.answer, 'from gemini');
  const nows = gw([fake('gemini')], { consent: async () => true }); await assert.rejects(run(nows.g, { actorId: 'u', feature: 'x' }), (e) => e.code === 'consent_required', 'no workspace means no authorisation to rely on');
});
test('a person who sends too many requests is slowed down, others are not', async () => {
  const { g, audits } = gw([fake('gemini')], { config: { ratePerMinute: 3 } }); for (let i = 0; i < 3; i += 1) await run(g, { ...ctx, actorId: 'busy' });
  await assert.rejects(run(g, { ...ctx, actorId: 'busy' }), (e) => e.code === 'ai_rate_limited'); assert.equal((await run(g, { ...ctx, actorId: 'calm' })).data.answer, 'from gemini'); assert.ok(audits.some((x) => x.outcome === 'rate_limited'));
});
test('the audit trail records who, what, which provider and how much, never the prompt or the answer', async () => {
  const { g, audits } = gw([fake('gemini')]); await run(g, ctx, 'SYSTEM-SECRET-PROMPT', 'Confidential board minutes: 42'); const a = audits[0]; const text = JSON.stringify(a);
  assert.deepEqual([a.feature, a.actorId, a.workspaceId, a.provider, a.tier, a.outcome], ['docs_draft', 'u1', 'w1', 'gemini', 'free', 'ok']); assert.match(a.promptHash, /^[0-9a-f]{16}$/); assert.ok(a.inputChars > 0 && a.outputChars > 0);
  assert.doesNotMatch(text, /SYSTEM-SECRET-PROMPT|Confidential|board minutes|from gemini/); assert.doesNotMatch(text, /SECRET-key/);
});
test('users never see a provider: errors, models and the public status carry only Qorlla AI; administrators see the real status', async () => {
  const { g } = gw([fake('gemini', { fn: () => { throw new LlmError('boom from gemini key g-SECRET-key', { retryable: true, code: 'llm_busy' }); } })]);
  await assert.rejects(run(g), (e) => { assert.doesNotMatch(e.message + JSON.stringify(e), /gemini|openai|grok|xai|SECRET/i); return true; });
  const pub = JSON.stringify(g.publicStatus()); assert.doesNotMatch(pub, /gemini|openai|grok|xai|model|tier/i); const admin = g.adminStatus(); assert.equal(admin.providers[0].id, 'gemini'); assert.equal(admin.providers[0].consecutiveFailures, 1);
  assert.doesNotMatch(JSON.stringify(admin), /SECRET-key/, 'even administrators never see a key');
});
test('summarize keeps the existing meeting-report shape through the gateway', async () => {
  const rep = { summary: 'S', decisions: ['d'], topics: [], action_items: [{ title: 'T', owner_hint: null, due_hint: null }] };
  const { g } = gw([fake('gemini', { fn: () => ({ text: JSON.stringify(rep), model: 'm', inputTokens: 9, outputTokens: 4 }) })]); const r = await g.summarize({ title: 'Weekly', transcript: 'Ana: we decided X', ctx });
  assert.equal(r.report.summary, 'S'); assert.equal(r.model, 'qorlla-ai'); assert.equal(r.truncated, false); assert.equal(r.inputTokens, 9);
});
test('the deterministic test adapter answers the way the Docs, QorllaMate and meeting features expect, and says TEST-DOUBLE', async () => {
  const cfg = resolveAiConfig({ QORLLA_AI_ENABLED: 'true', QORLLA_AI_PROVIDER: 'test', QORLLA_AI_TEST_ADAPTER_ENABLED: 'true', QORLLA_ENVIRONMENT: 'test' }); const g = createAiGateway({ config: cfg, log: { error() {} } });
  assert.equal(g.available, true); const draft = await g.generateJson({ system: "You draft workplace documents. For a plain document", user: 'pelican launch', schema: z.object({ title: z.string(), text: z.string() }), ctx: { actorId: 'u', feature: 'docs_draft' } });
  assert.match(draft.data.text, /TEST-DOUBLE/); const mate = await g.generateJson({ system: 'You are QorllaMate', user: 'User message: please create a note titled "Offsite" saying "book it"', schema: z.object({ reply: z.string(), actions: z.array(z.object({ kind: z.string(), title: z.string(), body: z.string().optional() }).passthrough()) }), ctx: { actorId: 'u', feature: 'assistant' } });
  assert.match(mate.data.reply, /TEST-DOUBLE REPLY/); assert.deepEqual(mate.data.actions.map((a) => [a.kind, a.title]), [['create_note', 'Offsite']]);
});
test('with nothing configured the gateway says so plainly and never invents an answer', async () => {
  const g = createAiGateway({ config: resolveAiConfig({}), log: { error() {} } }); assert.equal(g.available, false); await assert.rejects(run(g), (e) => e.code === 'no_ai_provider'); assert.deepEqual(g.publicStatus(), { assistant: 'Qorlla AI', available: false });
});

test('only approved providers are ever used: a configured but unapproved provider receives nothing and is reported to administrators', async () => {
  const none = resolveAiConfig({ ...INTEGRATION, QORLLA_AI_APPROVED_PROVIDERS: '' }); assert.deepEqual(ids(none), [], 'keys alone do not make a provider usable');
  const some = resolveAiConfig({ ...INTEGRATION, QORLLA_AI_APPROVED_PROVIDERS: 'gemini' }); assert.deepEqual(ids(some), ['gemini']);
  const gwx = createAiGateway({ config: some, adapters: [] }); assert.deepEqual(gwx.adminStatus().configuredNotApproved.sort(), ['openai', 'xai']);
  assert.ok(resolveAiConfig({ ...INTEGRATION, QORLLA_AI_PROVIDER: 'xai', QORLLA_AI_APPROVED_PROVIDERS: 'gemini' }).problems.some((x) => /not in QORLLA_AI_APPROVED_PROVIDERS/.test(x)), 'asking for an unapproved provider by name is an error');
});
test('the workspace quota stops a request before any provider is called', async () => {
  const a = fake('gemini'); const audits = []; let allowed = true; const g = createAiGateway({ config: cfgFor(), adapters: [a], audit: async (r) => audits.push(r), quota: async () => allowed, log: { error() {} } });
  assert.equal((await run(g)).data.answer, 'from gemini'); allowed = false;
  await assert.rejects(run(g), (e) => e.code === 'ai_quota_exceeded' && /Qorlla AI/.test(e.message) && !e.retryable); assert.equal(a.calls, 1); assert.equal(audits.at(-1).outcome, 'quota_exceeded');
});
test('model choices are Qorlla profiles; the private profile uses only local providers and refuses rather than sending content out', async () => {
  const local = fake('selfhosted', { external: false, tier: 'local' }), ext = fake('gemini'); const { g } = gw([local, ext]); const m = g.models();
  assert.deepEqual(m.map((x) => [x.id, x.available]), [['qorlla-ai', true], ['qorlla-ai-private', true]]); assert.doesNotMatch(JSON.stringify(m), /gemini|openai|grok|xai|selfhosted/i);
  assert.equal((await run(g, { ...ctx, profile: 'private' })).data.answer, 'from selfhosted'); assert.equal(ext.calls, 0);
  const onlyExt = gw([fake('gemini')]); assert.equal(onlyExt.g.models()[1].available, false);
  await assert.rejects(run(onlyExt.g, { ...ctx, profile: 'private' }), (e) => e.code === 'private_unavailable'); assert.equal(onlyExt.audits.at(-1).outcome, 'unavailable');
});
