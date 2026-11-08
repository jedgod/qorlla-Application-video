// The Workspace Overview assistant's context packet. The MAIN app builds it from the person's own, source-filtered data and signs it with the secret
// MAIN and the portal already share (PORTAL_INTROSPECTION_SECRET); the portal only trusts a packet that verifies. A browser relays it but cannot forge or
// change it, and a packet made for one person is refused for anyone else (tenant and person isolation do not depend on what the page sends).
//
//   token  = base64url(JSON claims) + "." + base64url(HMAC-SHA256(secret, "qorlla-overview-v1." + base64url(JSON claims)))
//   claims = { v: 1, sub: <MAIN user id>, iat, exp (ms, at most 5 minutes after iat), sources: [labels used], text: <the data the model may read> }
// main/workplace.js implements the same format (CommonJS); tests/overview-assistant.test.mjs proves the two agree.
import crypto from 'node:crypto';

const PREFIX = 'qorlla-overview-v1';
export const MAX_PACKET_TEXT = 40000;
const fail = (code) => Object.assign(new Error('overview packet refused: ' + code), { code });

export function signOverviewPacket(secret, claims) {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', secret).update(PREFIX + '.' + body).digest('base64url');
}

/** Returns the claims, or throws an Error with a short code. Nothing about a refused packet is revealed to the caller beyond "could not be verified". */
export function verifyOverviewPacket(secret, token, { actor, now = Date.now(), maxTtlMs = 5 * 60 * 1000 } = {}) {
  if (!secret || secret.length < 32) throw fail('not_configured');
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw fail('malformed');
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(PREFIX + '.' + parts[0]).digest('base64url'));
  const got = Buffer.from(parts[1]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw fail('bad_signature');
  let c; try { c = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (e) { throw fail('malformed'); }
  if (!c || c.v !== 1 || typeof c.sub !== 'string' || typeof c.text !== 'string' || !Array.isArray(c.sources)) throw fail('malformed');
  if (c.sub.toLowerCase() !== String(actor || '').toLowerCase()) throw fail('wrong_person');
  if (!Number.isFinite(c.iat) || !Number.isFinite(c.exp) || c.exp <= now || c.iat > now + 5000 || c.exp - c.iat > maxTtlMs) throw fail('expired');
  if (c.text.length > MAX_PACKET_TEXT || c.sources.length > 10 || !c.sources.every((s) => typeof s === 'string' && s.length <= 40)) throw fail('too_large');
  return c;
}
