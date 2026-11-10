// Ollama provider for Qorlla's existing AI gateway. No document routes or database tables.
// The gateway remains responsible for authentication, tenant authorization, quotas and audit.
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import { Readable } from 'node:stream';
const safeInt = (value, fallback, lo, hi) => Number.isSafeInteger(Number(value)) && Number(value) >= lo && Number(value) <= hi ? Number(value) : fallback;
export function validateOllamaEndpoint(raw, allowedHosts = ['ollama', 'localhost', '127.0.0.1']) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid Ollama URL'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname.replace(/\/$/, '') !== '/v1') throw new Error('Ollama URL must be an uncredentialed /v1 endpoint');
  if (!allowedHosts.includes(u.hostname.toLowerCase())) throw new Error('Ollama hostname is not in the operator allowlist');
  if (u.protocol === 'http:' && !['ollama', 'localhost', '127.0.0.1'].includes(u.hostname.toLowerCase())) throw new Error('Remote Ollama requires HTTPS');
  return u.toString().replace(/\/$/, '');
}

// ---- DNS-rebinding guard for plain-HTTP (private-network) endpoints ----
// A hostname allowlist is not enough: DNS can later answer with a different address (rebinding) such as a cloud metadata service or a public host.
// Plain-HTTP Ollama endpoints may therefore only connect to loopback or private addresses, and the check runs inside the connection's own lookup, so the address that is
// validated is the address that is dialled (no gap between check and use). Link-local (169.254/16, fe80::/10: cloud metadata) and public addresses are refused.
export function isPrivateAddress(addr) {
  let a = String(addr).toLowerCase(); const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a); if (m) a = m[1];
  if (net.isIPv4(a)) {
    const [p, q] = a.split('.').map(Number);
    return p === 127 || p === 10 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127);   // loopback, RFC 1918, CGNAT (private overlay networks)
  }
  if (net.isIPv6(a)) return a === '::1' || /^f[cd][0-9a-f]{2}:/.test(a);                                                                    // loopback, unique-local (fc00::/7)
  return false;
}
export function createGuardedFetch({ lookup = dns.lookup } = {}) {
  const agent = new http.Agent({ keepAlive: true });       // one pool per guard: a reused connection keeps the address that was validated when it was opened
  const guardLookup = (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIPv6(addrs) ? 6 : 4 }];
      const bad = list.find((x) => !isPrivateAddress(x.address));
      if (bad || !list.length) return cb(Object.assign(new Error('Ollama endpoint resolved to a non-private address'), { code: 'llm_endpoint_refused' }));
      if (options && options.all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
  };
  return function guardedFetch(url, { method = 'GET', headers = {}, body, signal } = {}) {
    const u = new URL(url);
    if (u.protocol !== 'http:') return fetch(url, { method, headers, body, signal });          // HTTPS: the certificate identifies the host
    return new Promise((resolve, reject) => {
      const req = http.request(u, { method, headers: { ...headers, ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}) }, lookup: guardLookup, agent, signal }, (res) => {
        const h = new Headers(); for (const [k, v] of Object.entries(res.headers)) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
        const noBody = [101, 204, 205, 304].includes(res.statusCode);
        resolve(new Response(noBody ? null : Readable.toWeb(res), { status: res.statusCode, headers: h }));
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  };
}
const guardedFetchDefault = createGuardedFetch();

export function createOllamaAdapter({ baseUrl, model, apiKey = '', allowedHosts, fetchImpl = guardedFetchDefault, timeoutMs = 30000, concurrency = 2, maxQueue = 8, maxResponseBytes = 1048576 } = {}) {
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
        if (e.code === 'llm_endpoint_refused' || e.cause?.code === 'llm_endpoint_refused') throw Object.assign(new Error('Ollama endpoint refused'), { code: 'llm_rejected', retryable: false });
        if (e.code) throw e;
        throw Object.assign(new Error('Ollama unreachable'), { code: 'llm_unreachable', retryable: true });
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); release(); }
    },
    status() { return { active, queued: waiting.length }; }
  };
}
