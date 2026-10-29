'use strict';
// Qorlla Voice, main-app side. The voice engine is a separate service (qorlla-voice-engine/). This module is the only thing that knows who a signed-in person is:
//   * it signs short-lived ES256 identity tokens for the engine (5 minutes, audience "qorlla-voice") and publishes the public key at /.well-known/voice-jwks.json
//   * it provisions each account's voice identity and extension in the engine, using a server-to-server secret that browsers never see
//   * it serves the browser SDK and a colleague directory (names from this app, extensions from the engine)
// Nothing here places a call. Internal internet calls only: no carrier, no Twilio, no public telephone numbers.
const crypto = require('crypto');
const path = require('path');
const store = require('./store');

const TOKEN_SECONDS = 300;
const b64 = (b) => Buffer.from(b).toString('base64url');

function createVoice({ dataDir, env = process.env }) {
    const keyFile = path.join(dataDir, 'voice-signing.json');
    const issuer = () => env.VOICE_JWT_ISSUER || 'qorlla-main', audience = () => env.VOICE_JWT_AUDIENCE || 'qorlla-voice';
    const secret = () => String(env.VOICE_ADMIN_SECRET || '');
    // SHIELD_REQUIRE_VERIFIED=true: an unverified registered account has the same communication restrictions as a guest until its email is verified (no voice identity, no token).
    const needVerified = () => String(env.SHIELD_REQUIRE_VERIFIED || '').toLowerCase() === 'true';
    // Voice is OFF unless the server owner switched it on (QORLLA_VOICE_ENABLED=true) AND configured the engine secret. The switch stays off in production until the release gate passes (docs/VOICE_CERTIFICATION.md).
    const flagOn = () => String(env.QORLLA_VOICE_ENABLED || '').toLowerCase() === 'true';
    const enabled = () => flagOn() && secret().length >= 32;
    const port = () => Number(env.VOICE_PORT || 4600);
    const internalBase = () => String(env.VOICE_INTERNAL_URL || env.VOICE_URL || 'http://127.0.0.1:' + port()).replace(/\/+$/, '');
    const publicBase = (req) => String(env.VOICE_URL || (req.protocol + '://' + req.hostname + ':' + port())).replace(/\/+$/, '');

    // ---- signing key: created on first use, stored with the app's other secrets (encrypted at rest when ENCRYPT_KEY is set)
    let keys = null;
    function loadKeys() {
        if (keys) return keys;
        let saved = null; try { saved = store.readJson(keyFile, null); } catch (e) { saved = null; }
        if (!saved || !saved.privateJwk || !saved.publicJwk) {
            const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
            const kid = crypto.randomBytes(8).toString('hex');
            saved = { kid, privateJwk: pair.privateKey.export({ format: 'jwk' }), publicJwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' }, createdAt: new Date().toISOString() };
            store.writeJson(keyFile, saved, { durable: true });
        }
        keys = { kid: saved.kid, privateKey: crypto.createPrivateKey({ key: saved.privateJwk, format: 'jwk' }), publicJwk: saved.publicJwk };
        return keys;
    }
    function signToken(accountId, now = Math.floor(Date.now() / 1000)) {
        const k = loadKeys(), header = { alg: 'ES256', typ: 'JWT', kid: k.kid };
        const payload = { iss: issuer(), aud: audience(), sub: accountId, iat: now, nbf: now - 5, exp: now + TOKEN_SECONDS, jti: crypto.randomUUID() };
        const data = b64(JSON.stringify(header)) + '.' + b64(JSON.stringify(payload));
        return data + '.' + b64(crypto.sign('sha256', Buffer.from(data), { key: k.privateKey, dsaEncoding: 'ieee-p1363' }));
    }

    // ---- the engine's provisioning API (server to server)
    async function engine(method, route, body) {
        const r = await fetch(internalBase() + '/v1/voice/admin' + route, { method, headers: { 'content-type': 'application/json', 'x-voice-admin-secret': secret() }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw Object.assign(new Error(data.error || 'engine_error'), { status: r.status });
        return data;
    }
    const known = new Map();                                                              // account id -> { extension, at }: avoids a provisioning call on every token
    async function identityFor(user) {
        const hit = known.get(user.id); if (hit && Date.now() - hit.at < 600000) return hit.extension;
        const { identity } = await engine('POST', '/identities', { accountId: user.id }); known.set(user.id, { extension: identity.extension, at: Date.now() });
        return identity.extension;
    }
    const hits = new Map();
    const tooMany = (id) => { const t = Date.now(), h = hits.get(id); if (!h || t - h.s > 60000) { hits.set(id, { s: t, n: 1 }); return false; } return ++h.n > 60; };

    function register(app, { requireUser, listUsers }) {
        app.get('/.well-known/voice-jwks.json', (req, res) => { if (!enabled()) return res.status(404).json({ error: 'voice_disabled' }); res.set('Cache-Control', 'public, max-age=300').json({ keys: [loadKeys().publicJwk] }); });
        app.get('/voice-client.js', (req, res) => { res.type('application/javascript').set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, 'qorlla-voice-engine', 'web', 'VoiceClient.mjs')); });

        app.get('/api/voice/config', requireUser, (req, res) => {
            res.set('Cache-Control', 'no-store');
            if (!enabled()) return res.json({ enabled: false, reason: flagOn() ? 'Qorlla Voice is not configured on this server (VOICE_ADMIN_SECRET).' : 'Qorlla Voice is switched off on this server (QORLLA_VOICE_ENABLED).' });
            res.json({ enabled: true, url: publicBase(req), internalCallsOnly: true, verificationRequired: needVerified() && !req.user.emailVerified });
        });
        app.post('/api/voice/token', requireUser, async (req, res) => {
            res.set('Cache-Control', 'no-store'); if (!enabled()) return res.status(503).json({ error: 'voice_disabled' });
            if (needVerified() && !req.user.emailVerified) return res.status(403).json({ error: 'verification_required' });
            if (tooMany(req.user.id)) return res.status(429).json({ error: 'rate_limited' });
            try { const extension = await identityFor(req.user); res.json({ token: signToken(req.user.id), expiresIn: TOKEN_SECONDS, extension, url: publicBase(req) }); }
            catch (e) { res.status(503).json({ error: 'voice_unavailable', detail: e.status ? 'The voice service refused the request.' : 'The voice service is not reachable.' }); }
        });
        // Colleagues you can call: display names come from this app, extensions from the engine. Only people who have used voice appear.
        app.get('/api/voice/directory', requireUser, async (req, res) => {
            res.set('Cache-Control', 'no-store'); if (!enabled()) return res.status(503).json({ error: 'voice_disabled' });
            try {
                const users = new Map(listUsers().map((u) => [u.id, u])), { identities } = await engine('GET', '/identities');
                res.json({ people: identities.filter((i) => i.enabled && users.has(i.account_id)).map((i) => ({ id: i.account_id, displayName: users.get(i.account_id).displayName, username: users.get(i.account_id).username, extension: i.extension, self: i.account_id === req.user.id })) });
            } catch (e) { res.status(503).json({ error: 'voice_unavailable' }); }
        });
        // Peer names for the call history (the engine only knows account ids).
        app.post('/api/voice/names', requireUser, (req, res) => {
            const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.slice(0, 200) : [], by = new Map(listUsers().map((u) => [u.id, u]));
            res.json({ names: Object.fromEntries(ids.filter((i) => by.has(i)).map((i) => [i, by.get(i).displayName])) });
        });
    }
    return { register, signToken, enabled, loadKeys, identityFor, _engine: engine };
}
module.exports = createVoice;
