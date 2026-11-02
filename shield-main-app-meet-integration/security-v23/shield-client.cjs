'use strict';
// Fail-closed adapter for the EXISTING Voice Engine shield. No client-supplied identity or privilege flags.
const https = require('node:https');
const fs = require('node:fs');
const { URL } = require('node:url');
function createShieldClient({ baseUrl = process.env.SHIELD_URL, tokenProvider, caFile = process.env.SHIELD_CA_FILE,
  certFile = process.env.SHIELD_CLIENT_CERT, keyFile = process.env.SHIELD_CLIENT_KEY, timeoutMs = 2500 } = {}) {
  if (!baseUrl) throw Error('SHIELD_URL_REQUIRED');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:') throw Error('SHIELD_HTTPS_REQUIRED');
  if (typeof tokenProvider !== 'function') throw Error('WORKLOAD_TOKEN_PROVIDER_REQUIRED');
  if (!caFile || !certFile || !keyFile) throw Error('MUTUAL_TLS_REQUIRED');
  const agent = new https.Agent({ ca: fs.readFileSync(caFile), cert: fs.readFileSync(certFile),
    key: fs.readFileSync(keyFile), rejectUnauthorized: true, keepAlive: true });
  // Use node:https directly: guarantees mutual TLS client cert is actually presented.
  async function secureCall(path, body, method = 'POST') {
    const credential = await tokenProvider(path);
    if (typeof credential !== 'string' || credential.length < 20) throw Error('WORKLOAD_IDENTITY_UNAVAILABLE');
    const endpoint = new URL(path, url);
    if (endpoint.origin !== url.origin || endpoint.protocol !== 'https:') throw Error('SHIELD_ORIGIN_MISMATCH');
    const payload = Buffer.from(JSON.stringify(body));
    if (payload.length > 16_384) throw Error('SHIELD_REQUEST_TOO_LARGE');
    return new Promise((resolve, reject) => {
      const req = https.request(endpoint, { agent, method, timeout: timeoutMs, headers: {
        authorization: `Bearer ${credential}`, 'content-type': 'application/json', 'content-length': payload.length } }, res => {
        let size = 0; const chunks = [];
        res.on('data', c => { size += c.length; if (size > 32_768) { req.destroy(Error('SHIELD_RESPONSE_TOO_LARGE')); return; } chunks.push(c); });
        res.on('end', () => { if (res.statusCode < 200 || res.statusCode >= 300) return reject(Error('SHIELD_DENIED'));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Error('SHIELD_INVALID_RESPONSE')); } });
      });
      req.on('timeout', () => req.destroy(Error('SHIELD_TIMEOUT')));
      req.on('error', reject); req.end(payload);
    });
  }
  return Object.freeze({
    requestGuest: b => secureCall('/v1/shield/guest/request', b),
    claimGuest: b => secureCall('/v1/shield/guest/claim', b),
    consumeMedia: b => secureCall('/v1/shield/media/consume', b),
    registerPrincipal: b => secureCall('/v1/shield/admin/principals', b, 'PUT'),
    registerMeeting: b => secureCall('/v1/shield/admin/meetings', b, 'PUT'),
    endMeeting: meetingId => secureCall(`/v1/shield/admin/meetings/${encodeURIComponent(meetingId)}/end`, {}),
  });
}
module.exports = { createShieldClient };
