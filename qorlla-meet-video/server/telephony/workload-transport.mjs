// Mutual-TLS transport for workload (service-to-service) calls. The client presents ITS certificate, verifies the server against a pinned CA, and binds its workload token to that certificate (cnf thumbprint),
// so a stolen token is useless without the private key and a certificate alone grants no scope. Configuration is by file paths (never inline secrets); rotation = replace the files and restart/reload.
import https from 'node:https';
import fs from 'node:fs';
import { X509Certificate, createHash } from 'node:crypto';

/** SHA-256 of the certificate's DER, base64url: the value the engine compares with the token's cnf['x5t#S256']. */
export const certThumbprint = (certPem) => createHash('sha256').update(new X509Certificate(certPem).raw).digest('base64url');

/** A fetch-shaped function over node:https with a client certificate and a pinned CA. Never disables verification. */
export function mtlsFetch({ ca, cert, key, timeoutMs = 5000 }) {
  if (!ca || !cert || !key) throw new Error('mTLS needs ca, cert and key');
  const agent = new https.Agent({ ca, cert, key, rejectUnauthorized: true, keepAlive: true, minVersion: 'TLSv1.2' });
  return (url, init = {}) => new Promise((resolve, reject) => {
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

/** From SHIELD_CLIENT_CERT / SHIELD_CLIENT_KEY / SHIELD_CA (file paths). null = not configured (plain HTTP with an unbound token, only acceptable where the engine does not require mTLS). */
export function transportFromEnv(env = process.env) {
  if (!env.SHIELD_CLIENT_CERT || !env.SHIELD_CLIENT_KEY || !env.SHIELD_CA) return null;
  const cert = fs.readFileSync(env.SHIELD_CLIENT_CERT), key = fs.readFileSync(env.SHIELD_CLIENT_KEY), ca = fs.readFileSync(env.SHIELD_CA);
  return { fetchImpl: mtlsFetch({ ca, cert, key }), thumbprint: certThumbprint(cert) };
}
