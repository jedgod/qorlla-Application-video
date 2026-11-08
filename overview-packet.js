'use strict';
// The Workspace Overview assistant's context packet, MAIN side (the portal verifies it: qorlla-portal/server/ai/overview-packet.mjs, the same format; the
// portal's test suite signs with this file and verifies with that one, so the two cannot drift apart).
//
//   token  = base64url(JSON claims) + "." + base64url(HMAC-SHA256(secret, "qorlla-overview-v1." + base64url(JSON claims)))
//   claims = { v: 1, sub: <portal user id>, iat, exp (ms, at most 5 minutes after iat), sources: [labels used], text: <the data the model may read> }
// The secret is PORTAL_INTROSPECTION_SECRET, which MAIN and the portal already share. A browser relays the packet but cannot forge or alter it.
const crypto = require('crypto');

const PREFIX = 'qorlla-overview-v1';
const MAX_TEXT = 40000;

function sign(secret, claims) {
    if (!secret || String(secret).length < 32) throw new Error('A secret of at least 32 characters is required.');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return body + '.' + crypto.createHmac('sha256', secret).update(PREFIX + '.' + body).digest('base64url');
}

module.exports = { sign, PREFIX, MAX_TEXT };
