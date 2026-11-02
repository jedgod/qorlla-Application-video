// Private provider adapters for the Qorlla AI Gateway. Server side only: nothing here is ever sent to a browser, an APK or an installer.
// Each adapter turns ONE request (system prompt + user content, JSON wanted back) into a provider's own API call and returns plain text plus token counts.
// Errors carry a generic message (the gateway shows people only "Qorlla AI"); the provider id travels in `provider` for administrators and the audit trail.
// Adapters follow each provider's official HTTP API. They are exercised against stubbed endpoints in tests/ai-gateway.test.mjs; a stub proves our request and parsing, NOT that a real account, quota or model works.
import { LlmError } from './llm.mjs';

const fail = (provider, message, o) => Object.assign(new LlmError(message, o), { provider });
async function post(provider, url, { headers, body, fetchImpl, timeoutMs }) {
  let res;
  try { res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw fail(provider, e && e.name === 'TimeoutError' ? 'Qorlla AI timed out' : 'Qorlla AI is unreachable', { retryable: true, code: e && e.name === 'TimeoutError' ? 'llm_timeout' : 'llm_unreachable' }); }
  if (res.status === 429 || res.status >= 500) throw fail(provider, 'Qorlla AI is busy (' + res.status + ')', { retryable: true, code: res.status === 429 ? 'llm_quota' : 'llm_busy', status: res.status });
  if (res.status === 401 || res.status === 403) throw fail(provider, 'Qorlla AI is not authorised on this server', { retryable: true, code: 'llm_auth', status: res.status });   // another provider may still work
  if (!res.ok) throw fail(provider, 'Qorlla AI rejected the request (' + res.status + ')', { retryable: false, code: 'llm_rejected', status: res.status });
  return res.json().catch(() => { throw fail(provider, 'Qorlla AI returned unreadable output', { retryable: true, code: 'invalid_model_output' }); });
}
const count = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

// OpenAI-compatible chat completions (OpenAI, xAI Grok and a self-hosted open-weight server speak the same shape)
function chatCompletions(id, { apiKey, baseUrl, model }, { fetchImpl, timeoutMs }) {
  return {
    id,
    async call({ system, user, maxTokens }) {
      const j = await post(id, baseUrl.replace(/\/$/, '') + '/chat/completions', {
        headers: apiKey ? { authorization: 'Bearer ' + apiKey } : {}, fetchImpl, timeoutMs,
        body: { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, response_format: { type: 'json_object' } }
      });
      const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (typeof text !== 'string') throw fail(id, 'Qorlla AI returned unreadable output', { retryable: true, code: 'invalid_model_output' });
      return { text, model: j.model || model, inputTokens: count(j.usage && j.usage.prompt_tokens), outputTokens: count(j.usage && j.usage.completion_tokens) };
    }
  };
}
function gemini({ apiKey, baseUrl, model }, { fetchImpl, timeoutMs }) {
  return {
    id: 'gemini',
    async call({ system, user, maxTokens }) {
      const j = await post('gemini', baseUrl.replace(/\/$/, '') + '/models/' + encodeURIComponent(model) + ':generateContent', {
        headers: { 'x-goog-api-key': apiKey }, fetchImpl, timeoutMs,
        body: { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: maxTokens } }
      });
      const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
      const text = Array.isArray(parts) ? parts.map((x) => x.text || '').join('') : '';
      if (!text) throw fail('gemini', 'Qorlla AI returned unreadable output', { retryable: true, code: 'invalid_model_output' });
      return { text, model: (j && j.modelVersion) || model, inputTokens: count(j.usageMetadata && j.usageMetadata.promptTokenCount), outputTokens: count(j.usageMetadata && j.usageMetadata.candidatesTokenCount) };
    }
  };
}
function anthropic({ apiKey, baseUrl, model }, { fetchImpl, timeoutMs }) {                // the pre-gateway path, kept so existing deployments keep working
  return {
    id: 'anthropic',
    async call({ system, user, maxTokens }) {
      const j = await post('anthropic', baseUrl.replace(/\/$/, '') + '/v1/messages', { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, fetchImpl, timeoutMs, body: { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] } });
      const text = (j && j.content ? j.content.filter((c) => c.type === 'text').map((c) => c.text).join('') : '');
      if (!text) throw fail('anthropic', 'Qorlla AI returned unreadable output', { retryable: true, code: 'invalid_model_output' });
      return { text, model: j.model || model, inputTokens: count(j.usage && j.usage.input_tokens), outputTokens: count(j.usage && j.usage.output_tokens) };
    }
  };
}

/**
 * The deterministic TEST ADAPTER. Not a model: it answers from fixed rules so the gateway, consent, quotas, review-before-apply and the Docs and QorllaMate flows can be tested offline.
 * Its output says TEST-DOUBLE on purpose, and it can only be built in an explicitly identified test environment (see config.mjs); production refuses it.
 */
function testAdapter(delayMs = 0) {
  return {
    id: 'test',
    async call({ system, user }) {
      if (delayMs > 0 && /QORLLA-TEST-SLOW/.test(user)) await new Promise((r) => setTimeout(r, delayMs));          // lets certification interrupt a job in the middle of the model call
      const reply = (o) => ({ text: JSON.stringify(o), model: 'test-double', inputTokens: Math.ceil(user.length / 4), outputTokens: 40 });
      if (/QorllaMate/.test(system)) {
        const um = (/User message: ([\s\S]*)$/.exec(user) || [])[1] || '', ctx = (/<context>\n([\s\S]*?)\n<\/context>/.exec(user) || [])[1] || '', actions = [];
        const nm = /create a note titled "([^"]+)"(?: saying "([^"]+)")?/i.exec(um); if (nm) actions.push({ kind: 'create_note', title: nm[1], body: nm[2] || '' });
        const dm = /create a document titled "([^"]+)"/i.exec(um); if (dm) actions.push({ kind: 'create_document', title: dm[1], body: 'TEST-DOUBLE document body' });
        const em = /send an email to (\S+)/i.exec(um); if (em) actions.push({ kind: 'send_email', title: 'Email', to: em[1], subject: 'Hello', body: 'TEST-DOUBLE body' });
        return reply({ reply: 'TEST-DOUBLE REPLY. Context: ' + (ctx.includes('(no matching') ? 'none' : ctx.replace(/\n/g, ' ').slice(0, 120)), actions });
      }
      if (/You draft workplace documents/.test(system)) {
        const title = 'TEST-DOUBLE DRAFT: ' + user.slice(0, 40);
        if (/spreadsheet/.test(system)) return reply({ title, columns: ['Item', 'Qty'], rows: [['Apples', 3], ['Pears', null]] });
        if (/slide deck/.test(system)) return reply({ title, slides: [{ title: 'Intro', bullets: ['Point one'], notes: '' }] });
        return reply({ title, text: '# Draft\n\nTEST-DOUBLE body for: ' + user.slice(0, 80) });
      }
      const task = (/QORLLA-TASK:([a-z_]+)/.exec(system) || [])[1];
      if (task) {
        const input = (/<input>\n([\s\S]*?)\n<\/input>/.exec(user) || [])[1] || '';
        const evidence = /^docs_/.test(task) ? [{ quote: (input.match(/[^\n]{8,}/) || [''])[0].slice(0, 30) }] : /^sheets_/.test(task) ? [{ range: 'A1:B2' }] : /^slides_/.test(task) ? [{ slide: 1 }] : [];
        if (/FABRICATE/.test(user)) evidence.push({ quote: 'a sentence that is nowhere in the source document' }, { range: 'ZZ99' }, { slide: 99 });       // made-up evidence: the backend must drop all of it
        return reply({ suggestion: 'TEST-DOUBLE ' + task + ': ' + input.slice(0, 120), notes: [], evidence });
      }
      const transcript = (/<transcript>\n([\s\S]*?)\n<\/transcript>/.exec(user) || [])[1] || '', lines = transcript.split('\n').filter(Boolean);
      const speakers = [...new Set(lines.map((l) => (/^([^:]{1,60}):/.exec(l) || [])[1]).filter(Boolean))];
      const items = lines.map((l) => /ACTION:\s*([A-Za-z]+)\s+to\s+(.+?)(?:\s+by\s+([A-Za-z0-9 ]+))?\.?$/i.exec(l)).filter(Boolean).map((m) => ({ title: m[2].trim(), owner_hint: m[1], due_hint: m[3] ? m[3].trim() : null }));
      return reply({ summary: `TEST-DOUBLE SUMMARY of ${lines.length} lines from ${speakers.length} speaker(s): ${speakers.join(', ') || 'unknown'}.`, decisions: lines.filter((l) => /\b(decided|decision)\b/i.test(l)).map((l) => l.replace(/^[^:]+:\s*/, '').slice(0, 200)), topics: speakers.length ? ['Discussion'] : [], action_items: items });
    }
  };
}

/** Builds the adapters for the eligible providers. `eligible` comes from eligibleProviders(cfg). */
export function buildAdapters(eligible, { fetchImpl = fetch, timeoutMs = 30_000, testDelayMs = 0 } = {}) {
  const io = { fetchImpl, timeoutMs };
  return eligible.map((p) => {
    const a = p.id === 'test' ? testAdapter(testDelayMs) : p.id === 'gemini' ? gemini(p, io) : p.id === 'anthropic' ? anthropic(p, io) : chatCompletions(p.id, p, io);
    return Object.assign(a, { tier: p.tier, external: p.external, model: p.model });
  });
}
