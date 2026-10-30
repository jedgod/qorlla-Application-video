// Mutual-TLS transport for workload (service-to-service) calls. The client presents ITS certificate, verifies the server against a pinned CA, and binds its workload token to that certificate (cnf thumbprint),
// so a stolen token is useless without the private key and a certificate alone grants no scope. Configuration is by file paths (never inline secrets); rotation = replace the files and restart/reload.
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import { X509Certificate, createHash } from 'node:crypto';

/** SHA-256 of the certificate's DER, base64url: the value the engine compares with the token's cnf['x5t#S256']. */
export const certThumbprint = (certPem) => createHash('sha256').update(new X509Certificate(certPem).raw).digest('base64url');

/** A fetch-shaped function over node:https with a client certificate and a pinned CA. Never disables verification. */
export function mtlsFetch({ ca, cert, key, timeoutMs = 5000, getAgent }) {
  if (!getAgent && (!ca || !cert || !key)) throw new Error('mTLS needs ca, cert and key');
  const fixed = getAgent ? null : new https.Agent({ ca, cert, key, rejectUnauthorized: true, keepAlive: true, minVersion: 'TLSv1.2' });
  return (url, init = {}) => new Promise((resolve, reject) => {
    const agent = getAgent ? getAgent() : fixed;
    const u = new URL(url); if (u.protocol !== 'https:') return reject(new Error('mTLS_requires_https'));
    const body = init.body == null ? null : Buffer.from(init.body);
    const req = https.request(u, { agent, method: init.method || 'GET', timeout: timeoutMs, headers: { ...(init.headers || {}), ...(body ? { 'content-length': body.length } : {}) } }, (res) => {
      const chunks = []; let size = 0; res.on('data', (c) => { size += c.length; if (size > 4 * 1024 * 1024) { req.destroy(new Error('response_too_large')); return; } chunks.push(c); });
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, headers: res.headers, text: async () => buf.toString('utf8'), json: async () => JSON.parse(buf.toString('utf8')) }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
    if (init.signal) init.signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    req.end(body);
  });
}

/** Credentials that follow their files. The certificate, key and CA are re-read when any file changes (checked at most every checkMs), so a rotation needs NO restart: new requests use a new agent and a token bound
 *  to the NEW certificate, while requests already in flight finish on the old one. A half-written or corrupt rotation keeps the last GOOD credentials (and is reported through onError), so a bad file drop cannot take the service down;
 *  if there never were good credentials the error is thrown. Revocation is the server's decision per request: nothing here caches an authorization. */
export function reloadableTransport({ certFile, keyFile, caFile, checkMs = 2000, onError = () => {} }) {
  let state = null, lastCheck = 0;
  const read = () => {
    const sig = [certFile, keyFile, caFile].map((f) => { const st = fs.statSync(f); return st.mtimeMs + ':' + st.size; }).join('|');
    if (state && state.sig === sig) return state;
    const cert = fs.readFileSync(certFile), key = fs.readFileSync(keyFile), ca = fs.readFileSync(caFile), thumbprint = certThumbprint(cert);       // throws on a corrupt certificate
    tls.createSecureContext({ ca, cert, key });                                                                               // throws NOW on a key that does not match the certificate (an Agent would only fail at the first handshake)
    const agent = new https.Agent({ ca, cert, key, rejectUnauthorized: true, keepAlive: true, minVersion: 'TLSv1.2' });
    const old = state; state = { sig, agent, thumbprint }; if (old) setTimeout(() => old.agent.destroy(), 30000).unref(); return state;
  };
  const current = () => { const now = Date.now(); if (!state || now - lastCheck > checkMs) { lastCheck = now; try { read(); } catch (e) { if (!state) throw e; onError(e); } } return state; };
  current();
  return { fetchImpl: mtlsFetch({ getAgent: () => current().agent }), get thumbprint() { return current().thumbprint; }, reloadNow: () => { lastCheck = 0; return current().thumbprint; } };
}

/** From SHIELD_CLIENT_CERT / SHIELD_CLIENT_KEY / SHIELD_CA (file paths). null = not configured (plain HTTP with an unbound token, only acceptable where the engine does not require mTLS). */
export function transportFromEnv(env = process.env, onError) {
  if (!env.SHIELD_CLIENT_CERT || !env.SHIELD_CLIENT_KEY || !env.SHIELD_CA) return null;
  return reloadableTransport({ certFile: env.SHIELD_CLIENT_CERT, keyFile: env.SHIELD_CLIENT_KEY, caFile: env.SHIELD_CA, checkMs: Math.max(100, Number(env.SHIELD_CERT_RELOAD_SECONDS || 5) * 1000), onError: onError || ((e) => console.error('[shield] certificate reload failed, keeping the previous credentials:', e.message)) });
}
