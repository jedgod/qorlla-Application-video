'use strict';
// Main app -> Security Shield / Numbers & Plans: tells them, server to server, who each account is (verified? suspended?) so they can enforce it.
//   * authenticates with a SHORT-LIVED WORKLOAD CREDENTIAL (ES256 JWT, audience "qorlla-shield", one-time jti), signed with a key of its own (never the end-user token key, never a shared secret);
//     the public key is published at /.well-known/shield-workload-jwks.json for the engine to verify;
//   * pushes every account change at once and keeps retrying until it lands; a full reconcile runs at start and every few minutes, so nothing depends on one request succeeding.
// FAIL CLOSED: an account the shield has never heard of is refused by the shield, so a failure here can only delay access, never grant it.
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const b64 = (b) => Buffer.from(b).toString('base64url');

/** Mutual TLS from SHIELD_CLIENT_CERT / SHIELD_CLIENT_KEY / SHIELD_CA (file paths): a pinned CA, our client certificate, never rejectUnauthorized:false. Returns { fetchImpl, thumbprint } or null. */
function transportFromEnv(env) {
    if (!env.SHIELD_CLIENT_CERT || !env.SHIELD_CLIENT_KEY || !env.SHIELD_CA) return null;
    const cert = fs.readFileSync(env.SHIELD_CLIENT_CERT), key = fs.readFileSync(env.SHIELD_CLIENT_KEY), ca = fs.readFileSync(env.SHIELD_CA);
    const agent = new https.Agent({ ca, cert, key, rejectUnauthorized: true, keepAlive: true, minVersion: 'TLSv1.2' });
    const fetchImpl = (url, init = {}) => new Promise((resolve, reject) => {
        const u = new URL(url); if (u.protocol !== 'https:') return reject(new Error('mTLS_requires_https'));
        const body = init.body == null ? null : Buffer.from(init.body);
        const req = https.request(u, { agent, method: init.method || 'GET', timeout: 5000, headers: { ...(init.headers || {}), ...(body ? { 'content-length': body.length } : {}) } }, (res) => {
            const chunks = []; res.on('data', (c) => chunks.push(c));
            res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(buf.toString('utf8')) }); });
        });
        req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end(body);
    });
    return { fetchImpl, thumbprint: crypto.createHash('sha256').update(new crypto.X509Certificate(cert).raw).digest('base64url') };
}

function createShieldBridge({ dataDir, env = process.env, listAccounts, fetchImpl: injected, transport: injectedTransport, log = console }) {
    const transport = injectedTransport !== undefined ? injectedTransport : transportFromEnv(env);
    const fetchImpl = injected || (transport && transport.fetchImpl) || fetch;       // talking to the Shield (and to Meet's bridge) over mutual TLS when configured
    const keyFile = path.join(dataDir, 'shield-workload.json');
    const syncUrl = () => String(env.SHIELD_SYNC_URL || '').replace(/\/+$/, '');                   // the voice engine (Security Shield)
    const meetUrl = () => String(env.MEET_INTERNAL_URL || '').replace(/\/+$/, '');                 // Numbers & Plans lives in Qorlla Meet
    const bridgeSecret = () => String(env.QORLLA_BRIDGE_SECRET || '');
    const issuer = () => env.SHIELD_WORKLOAD_ISSUER || 'qorlla-main-workload';
    const enabled = () => !!syncUrl();
    let keys = null;
    function loadKeys() {
        if (keys) return keys;
        let saved = null; try { saved = store.readJson(keyFile, null); } catch (e) { saved = null; }
        if (!saved || !saved.privateJwk || !saved.publicJwk) {
            const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }), kid = crypto.randomBytes(8).toString('hex');
            saved = { kid, privateJwk: pair.privateKey.export({ format: 'jwk' }), publicJwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' }, createdAt: new Date().toISOString() };
            store.writeJson(keyFile, saved, { durable: true });
        }
        keys = { kid: saved.kid, privateKey: crypto.createPrivateKey({ key: saved.privateJwk, format: 'jwk' }), publicJwk: saved.publicJwk };
        return keys;
    }
    function workloadToken(now = Math.floor(Date.now() / 1000)) {
        const k = loadKeys(), head = b64(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: k.kid }));
        const body = b64(JSON.stringify({ iss: issuer(), sub: 'svc:main-app', aud: 'qorlla-shield', iat: now, exp: now + 120, jti: crypto.randomUUID() + crypto.randomUUID(), ...(transport ? { cnf: { 'x5t#S256': transport.thumbprint } } : {}) }));
        return head + '.' + body + '.' + b64(crypto.sign('sha256', Buffer.from(head + '.' + body), { key: k.privateKey, dsaEncoding: 'ieee-p1363' }));
    }
    const plainFetch = injected || fetch;                                  // Meet's bridge is authenticated by its own secret over the private network; only the Shield is reached over mutual TLS
    const post = async (base, route, method, body, headers, f = fetchImpl) => {
        const r = await f(base + route, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw Object.assign(new Error('refused_' + r.status), { status: r.status }); return r.json().catch(() => ({}));
    };

    /** Pushes one account's standing everywhere it is enforced. Throws if any destination did not take it (the caller retries). */
    async function push(a) {
        const shield = { authorization: 'Bearer ' + workloadToken() };
        await post(syncUrl(), '/v1/shield/admin/principals', 'PUT', { accountId: a.id, ...(a.orgId ? { orgId: a.orgId } : {}), verified: !!a.verified, ...(typeof a.billingHold === 'boolean' ? { billingHold: a.billingHold } : {}) }, shield);
        if (a.suspended) await post(syncUrl(), '/v1/shield/admin/principals/' + encodeURIComponent(a.id) + '/suspend', 'POST', {}, { authorization: 'Bearer ' + workloadToken() });
        else await post(syncUrl(), '/v1/shield/admin/principals/' + encodeURIComponent(a.id) + '/restore', 'POST', {}, { authorization: 'Bearer ' + workloadToken() });
        if (meetUrl() && bridgeSecret().length >= 32) await post(meetUrl(), '/api/integrations/telephony/accounts/' + encodeURIComponent(a.id), 'PUT', { verified: !!a.verified, suspended: !!a.suspended, orgId: a.orgId || null, ...(typeof a.billingHold === 'boolean' ? { billingHold: a.billingHold } : {}) }, { 'x-qorlla-bridge-secret': bridgeSecret() }, plainFetch);
    }

    const pending = new Map();                                            // account id -> latest standing not yet accepted
    let timer = null, running = false;
    function queue(a) { if (!enabled() || !a || !a.id) return; pending.set(a.id, a); flushSoon(); }
    function flushSoon() { if (!timer) timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, 50); if (timer.unref) timer.unref(); }
    async function flush() {
        if (running) return; running = true; let failed = 0;
        try { for (const [id, a] of [...pending]) { try { await push(a); if (pending.get(id) === a) pending.delete(id); } catch (e) { failed++; log.warn('[shield-bridge] could not sync ' + id + ': ' + (e.message || e)); } } }
        finally { running = false; }
        if (failed) { timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, 15000); if (timer.unref) timer.unref(); }
        return { failed, remaining: pending.size };
    }
    /** Everything, from the account store: run at start and periodically. */
    async function reconcileAll() { if (!enabled()) return { skipped: true }; for (const a of listAccounts()) pending.set(a.id, a); return flush(); }
    function start({ everyMs = Math.max(1000, Number(env.SHIELD_RECONCILE_SECONDS || 300) * 1000) } = {}) { if (!enabled()) return () => {}; reconcileAll().catch(() => {}); const t = setInterval(() => reconcileAll().catch(() => {}), everyMs); if (t.unref) t.unref(); return () => clearInterval(t); }
    function register(app) { app.get('/.well-known/shield-workload-jwks.json', (req, res) => { if (!enabled()) return res.status(404).json({ error: 'shield_sync_disabled' }); res.set('Cache-Control', 'public, max-age=300').json({ keys: [loadKeys().publicJwk] }); }); }
    return { enabled, queue, flush, reconcileAll, start, register, workloadToken, publicJwk: () => loadKeys().publicJwk, pendingCount: () => pending.size };
}
module.exports = createShieldBridge;
module.exports.transportFromEnv = transportFromEnv;
