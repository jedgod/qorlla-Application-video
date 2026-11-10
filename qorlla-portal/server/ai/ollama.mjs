// Ollama provider for Qorlla's existing AI gateway. No document routes or database tables.
// The gateway remains responsible for authentication, tenant authorization, quotas and audit.
const safeInt = (value, fallback, lo, hi) => Number.isSafeInteger(Number(value)) && Number(value) >= lo && Number(value) <= hi ? Number(value) : fallback;
export function validateOllamaEndpoint(raw, allowedHosts = ['ollama', 'localhost', '127.0.0.1']) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid Ollama URL'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname.replace(/\/$/, '') !== '/v1') throw new Error('Ollama URL must be an uncredentialed /v1 endpoint');
  if (!allowedHosts.includes(u.hostname.toLowerCase())) throw new Error('Ollama hostname is not in the operator allowlist');
  if (u.protocol === 'http:' && !['ollama', 'localhost', '127.0.0.1'].includes(u.hostname.toLowerCase())) throw new Error('Remote Ollama requires HTTPS');
  return u.toString().replace(/\/$/, '');
}
export function createOllamaAdapter({ baseUrl, model, apiKey = '', allowedHosts, fetchImpl = fetch, timeoutMs = 30000, concurrency = 2, maxQueue = 8, maxResponseBytes = 1048576 } = {}) {
  const url = validateOllamaEndpoint(baseUrl, allowedHosts);
  if (typeof model !== 'string' || !/^[\w.:-]{1,120}$/.test(model)) throw new Error('A valid installed Ollama model name is required');
  concurrency = safeInt(concurrency, 2, 1, 16);
  maxQueue = safeInt(maxQueue, 8, 0, 100);
  timeoutMs = safeInt(timeoutMs, 30000, 1000, 180000);
  maxResponseBytes = safeInt(maxResponseBytes, 1048576, 1024, 4194304);
  let active = 0;
  const waiting = [];
  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('Request cancelled'), { code: 'llm_cancelled' }));
    if (active < concurrency) { active++; return Promise.resolve(); }
    if (waiting.length >= maxQueue) return Promise.reject(Object.assign(new Error('AI queue full'), { code: 'llm_busy', retryable: true }));
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, signal, onAbort: null };
      item.onAbort = () => { const i = waiting.indexOf(item); if (i >= 0) waiting.splice(i, 1); reject(Object.assign(new Error('Request cancelled'), { code: 'llm_cancelled' })); };
      signal?.addEventListener('abort', item.onAbort, { once: true });
      waiting.push(item);
    });
  }
  function release() {
    while (waiting.length) {
      const item = waiting.shift();
      item.signal?.removeEventListener('abort', item.onAbort);
      if (item.signal?.aborted) { item.reject(Object.assign(new Error('Request cancelled'), { code: 'llm_cancelled' })); continue; }
      item.resolve(); return;
    }
    active--;
  }
  return {
    id: 'selfhosted', tier: 'local', external: false, model,
    async call({ system, user, maxTokens = 3000, signal } = {}) {
      await acquire(signal);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
      const onAbort = () => ctrl.abort('cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await fetchImpl(url + '/chat/completions', {
          method: 'POST', headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) },
          body: JSON.stringify({ model, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, response_format: { type: 'json_object' } }),
          signal: ctrl.signal
        });
        if (!response.ok) throw Object.assign(new Error('Ollama returned an unsuccessful status'), { code: response.status === 429 || response.status >= 500 ? 'llm_busy' : 'llm_rejected', retryable: response.status === 429 || response.status >= 500, status: response.status });
        const declared = Number(response.headers?.get('content-length') || 0);
        if (declared > maxResponseBytes) throw Object.assign(new Error('Ollama response too large'), { code: 'invalid_model_output' });
        // Read bounded bytes, even when content-length is absent or incorrect.
        const reader = response.body?.getReader?.();
        if (!reader) throw Object.assign(new Error('Ollama response stream unavailable'), { code: 'invalid_model_output' });
        let total = 0; const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxResponseBytes) { await reader.cancel(); throw Object.assign(new Error('Ollama response too large'), { code: 'invalid_model_output' }); }
          chunks.push(value);
        }
        const bytes = new Uint8Array(total); let offset = 0;
        for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
        let json;
        try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { throw Object.assign(new Error('Ollama response is not valid JSON'), { code: 'invalid_model_output' }); }
        const text = json?.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('Ollama returned no content'), { code: 'invalid_model_output' });
        return { text, model: json.model || model, inputTokens: Number(json.usage?.prompt_tokens) || 0, outputTokens: Number(json.usage?.completion_tokens) || 0 };
      } catch (e) {
        if (ctrl.signal.aborted) throw Object.assign(new Error('Ollama request interrupted'), { code: signal?.aborted ? 'llm_cancelled' : 'llm_timeout', retryable: !signal?.aborted });
        if (e.code) throw e;
        throw Object.assign(new Error('Ollama unreachable'), { code: 'llm_unreachable', retryable: true });
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); release(); }
    },
    status() { return { active, queued: waiting.length }; }
  };
}
