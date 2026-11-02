/**
 * MAIN -> Workplace Portal identity contract (see qorlla-portal/INTEGRATION.md).
 *
 * MAIN stays the only place that authenticates people. After a successful sign-in it issues a SHORT-LIVED (15 min)
 * RS256 JWT for the portal in an HttpOnly cookie, plus a readable CSRF cookie whose SHA-256 is bound inside the JWT.
 * The portal verifies the JWT against MAIN's public JWKS and (in production) asks MAIN whether the underlying
 * session is still alive, so logout / password change revoke portal access immediately, not after 15 minutes.
 *
 *   iss   MAIN_AUTH_ISSUER (default: origin of PUBLIC_URL)         aud   qorlla-workplace
 *   sub   MAIN user UUID (MAIN ids look like "u_<uuid>")            sid   sha256 of the MAIN session token (never the token)
 *   iat/exp   <= 15 minutes                                         csrf  sha256 hex of the qorlla_csrf cookie value
 *
 * Keys: an RSA-2048 pair is generated on first use and kept in DATA_DIR/auth (encrypted at rest when ENCRYPT_KEY is set),
 * or supplied via PORTAL_JWT_PRIVATE_KEY_PEM from a secret manager. `rotate()` retires the active key but keeps its public
 * half in the JWKS for 24 h so tokens signed just before rotation stay valid.
 */
const crypto = require('crypto');
const path = require('path');
const store = require('./store');

const TOKEN_TTL_S = 15 * 60;
const RETIRED_KEEP_MS = 24 * 3600 * 1000;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// RFC 7638 JWK thumbprint, used as the key id
function thumbprint(jwk) {
    return b64u(crypto.createHash('sha256').update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest());
}

module.exports = function createPortalTokens({ dataDir, issuer, audience = 'qorlla-workplace', now = () => Date.now() }) {
    const file = path.join(dataDir, 'auth', 'portal-jwt-keys.json');

    function generate() {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const publicJwk = publicKey.export({ format: 'jwk' });
        return { kid: thumbprint(publicJwk), privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicJwk, createdAt: now() };
    }
    function fromPem(pem) {
        const privateKey = crypto.createPrivateKey(pem);
        const publicJwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
        return { kid: thumbprint(publicJwk), privatePem: pem, publicJwk, createdAt: now() };
    }
    function load() {
        let state = store.readJson(file, null);
        if (process.env.PORTAL_JWT_PRIVATE_KEY_PEM) {
            // Key material comes from the environment/secret manager: never written to disk by us.
            const active = fromPem(process.env.PORTAL_JWT_PRIVATE_KEY_PEM.replace(/\\n/g, '\n'));
            return { active, retired: [], external: true };
        }
        if (!state || !state.active) { state = { active: generate(), retired: [] }; store.writeJson(file, state); }
        return state;
    }
    let state = load();

    function save() { if (!state.external) store.writeJson(file, state); }
    function prune() { state.retired = state.retired.filter((k) => now() - k.retiredAt < RETIRED_KEEP_MS); }

    return {
        issuer, audience, TOKEN_TTL_S,
        /** Public keys for GET /.well-known/jwks.json (active first, then recently retired). */
        jwks() {
            prune();
            const pub = (k) => ({ ...k.publicJwk, kid: k.kid, use: 'sig', alg: 'RS256' });
            return { keys: [pub(state.active), ...state.retired.map(pub)] };
        },
        rotate() {
            if (state.external) throw new Error('Key is managed externally (PORTAL_JWT_PRIVATE_KEY_PEM)');
            state.retired.unshift({ kid: state.active.kid, publicJwk: state.active.publicJwk, retiredAt: now() });
            state.active = generate(); prune(); save();
            return state.active.kid;
        },
        /** Convert a MAIN user id ("u_<uuid>") to the UUID the portal uses; null when it is not a UUID. */
        subjectFor(userId) {
            const raw = String(userId || '').replace(/^u_/, '');
            return UUID_RE.test(raw) ? raw.toLowerCase() : null;
        },
        /** @returns {{jwt:string, csrf:string}}  csrf = value for the readable qorlla_csrf cookie */
        issue({ userId, sid }) {
            const sub = this.subjectFor(userId);
            if (!sub) throw new Error('User id is not a UUID');
            const csrf = crypto.randomBytes(32).toString('base64url');
            const iat = Math.floor(now() / 1000);
            const header = { alg: 'RS256', typ: 'JWT', kid: state.active.kid };
            const payload = { iss: issuer, aud: audience, sub, iat, exp: iat + TOKEN_TTL_S, sid, csrf: sha256hex(csrf), jti: crypto.randomUUID() };
            const signingInput = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(payload));
            const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), crypto.createPrivateKey(state.active.privatePem));
            return { jwt: signingInput + '.' + b64u(sig), csrf };
        }
    };
};
module.exports.sha256hex = sha256hex;
