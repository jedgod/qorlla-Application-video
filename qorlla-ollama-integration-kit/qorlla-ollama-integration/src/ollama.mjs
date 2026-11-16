/** Ollama transport. No document routes, authentication shortcuts or external-provider fallback. */
import { isIP } from 'node:net';

export class InferenceError extends Error {
  constructor(code, status = 503) { super(code); this.name = 'InferenceError'; this.code = code; this.status = status; }
}

function integer(value, fallback, min, max) {
  const v = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new Error('invalid_ollama_configuration');
  return v;
}

function validateUrl(input, allowRemote = false) {
  let u;
  try { u = new URL(input); } catch { throw new Error('invalid_ollama_url'); }
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || !['http:', 'https:'].includes(u.protocol)) throw new Error('invalid_ollama_url');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!allowRemote && !['ollama', 'localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('unapproved_ollama_host');
  if (allowRemote && u.protocol !== 'https:' && !['ollama', 'localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('remote_ollama_requires_https');
  // For remote deployments, pin host with firewall/DNS policy and validate TLS independently.
  return u.origin;
}

export function createOllamaAdapter(config = {}, transport = fetch) {
  const baseUrl = validateUrl(config.url ?? 'http://ollama:11434', config.allowRemote === true);
  const models = (config.models ?? 'llama3.2:3b').split(',').map(x => x.trim()).filter(Boolean);
  if (!models.length || models.some(x => !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(x)) || new Set(models).size !== models.length) throw new Error('invalid_model_allowlist');
  const timeoutMs = integer(config.timeoutMs, 60000, 1000, 300000);
  const maxConcurrent = integer(config.maxConcurrent, 2, 1, 64);
  const maxQueue = integer(config.maxQueue, 8, 0, 1000);
  const maxPromptChars = integer(config.maxPromptChars, 16000, 100, 100000);
  const maxOutputTokens = integer(config.maxOutputTokens, 2048, 1, 8192);
  const maxResponseBytes = integer(config.maxResponseBytes, 1024 * 1024, 1024, 10 * 1024 * 1024);
  let active = 0;
  const queue = [];
  const allowed = new Set(models);

  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(new InferenceError('cancelled', 499));
    if (active < maxConcurrent) { active++; return Promise.resolve(); }
    if (queue.length >= maxQueue) return Promise.reject(new InferenceError('inference_busy', 429));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: null };
      entry.onAbort = () => {
        const idx = queue.indexOf(entry);
        if (idx >= 0) { queue.splice(idx, 1); reject(new InferenceError('cancelled', 499)); }
      };
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      queue.push(entry);
    });
  }
  function release() {
    active--;
    while (queue.length) {
      const entry = queue.shift();
      entry.signal?.removeEventListener('abort', entry.onAbort);
      if (entry.signal?.aborted) { entry.reject(new InferenceError('cancelled', 499)); continue; }
      active++; entry.resolve(); break;
    }
  }
  async function request(path, body, signal, timeout = timeoutMs) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort('caller');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort('timeout'), timeout);
    try {
      if (signal?.aborted) throw new InferenceError('cancelled', 499);
      const res = await transport(`${baseUrl}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: ctrl.signal,
        redirect: 'error',
      });
      if (!res.ok) throw new InferenceError('ollama_unavailable', 503);
      const length = Number(res.headers?.get?.('content-length'));
      if (Number.isFinite(length) && length > maxResponseBytes) throw new InferenceError('response_too_large', 502);
      if (!res.body) throw new InferenceError('invalid_ollama_response', 502);
      const reader = res.body.getReader();
      const chunks = []; let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxResponseBytes) throw new InferenceError('response_too_large', 502);
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      let data;
      try { data = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks.map(c => Buffer.from(c))))); }
      catch { throw new InferenceError('invalid_ollama_response', 502); }
      return data;
    } catch (err) {
      if (err instanceof InferenceError) throw err;
      if (ctrl.signal.aborted) throw new InferenceError(signal?.aborted ? 'cancelled' : 'inference_timeout', signal?.aborted ? 499 : 504);
      throw new InferenceError('ollama_unavailable', 503);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  return Object.freeze({
    models: [...models],
    stats: () => ({ active, queued: queue.length, maxConcurrent, maxQueue }),
    async health(signal) {
      try {
        const result = await request('/api/tags', null, signal, 5000);
        const installed = new Set(Array.isArray(result.models) ? result.models.map(x => x.name) : []);
        return { ok: true, readyModels: models.filter(x => installed.has(x)) };
      } catch { return { ok: false, readyModels: [] }; }
    },
    async generate({ model, prompt, system, temperature = 0.3, maxTokens = maxOutputTokens, signal }) {
      if (!allowed.has(model)) throw new InferenceError('model_not_allowed', 400);
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > maxPromptChars) throw new InferenceError('invalid_prompt_size', 413);
      if (typeof system !== 'string' || system.length > 4000) throw new InferenceError('invalid_system_prompt', 400);
      if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) throw new InferenceError('invalid_temperature', 400);
      if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > maxOutputTokens) throw new InferenceError('invalid_token_limit', 400);
      await acquire(signal);
      try {
        const data = await request('/api/generate', { model, prompt, system, stream: false, options: { temperature, num_predict: maxTokens } }, signal);
        if (typeof data.response !== 'string' || data.done !== true || data.model !== model) throw new InferenceError('invalid_ollama_response', 502);
        return { text: data.response.trim(), model, evalCount: Number.isInteger(data.eval_count) ? data.eval_count : null };
      } finally { release(); }
    },
  });
}
