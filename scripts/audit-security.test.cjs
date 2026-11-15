const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { io } = require('socket.io-client');

test('production blocks prototypes and legacy entry, enforces session CSRF, revokes sessions and throttles signup', { timeout: 120000 }, async (t) => {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    // Simulates the trusted internal HTTP hop behind the mandatory HTTPS edge.
    const publicUrl = base.replace('http:', 'https:');
    const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, NODE_ENV: 'production', PORT: String(port), DATA_DIR: mkdtempSync(path.join(os.tmpdir(), 'qorlla-audit-')), DOTENV_PATH: path.join(os.tmpdir(), 'qorlla-no-dotenv'), ENCRYPT_KEY: crypto.randomBytes(32).toString('hex'), QORLLA_BRIDGE_SECRET: crypto.randomBytes(32).toString('hex'), SIGNUP_LIMIT: '3', PUBLIC_URL: publicUrl, SMTP_URL: '', SMTP_FROM: '', DATABASE_URL: '', ENCRYPT_KEY_OLD: '' }, stdio: 'ignore' });
    t.after(() => child.kill()); // Only the disposable child created by this test.
    let ready = false;
    for (let i = 0; i < 100; i++) {
        try { ready = (await fetch(base + '/api/health')).ok; } catch {}
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.ok(ready, 'disposable production app started');
    for (const url of ['/api/docs', '/api/appointments/slots', '/api/post-meeting', '/api/notifications', '/api/meetings/validate/123']) assert.equal((await fetch(base + url)).status, 404, url);
    const socket = io(base, { transports: ['websocket'], reconnection: false });
    t.after(() => socket.disconnect());
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    const denied = new Promise(resolve => socket.once('error_response', resolve));
    socket.emit('join_room', { meetingId: '123 4567 8901' });
    assert.match((await denied).message, /disabled/);
    const page = await fetch(base + '/login.html'), html = await page.text();
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self' 'nonce-/);
    assert.doesNotMatch(csp.split(';').find(x => x.trim().startsWith('script-src')), /unsafe-inline|unsafe-eval/);
    assert.match(html, /security-fetch.js/);
    const nonce = /nonce-([^']+)/.exec(csp)[1];
    assert.ok([...html.matchAll(/<script\b[^>]*>/g)].every(([tag]) => tag.includes(`nonce="${nonce}"`)));
    const signup = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username: 'audit-user', password: 'a-long-audit-password' }) });
    assert.equal(signup.status, 201);
    const cookie = signup.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/api/auth/me', { method: 'PATCH', headers, body: JSON.stringify({ displayName: 'blocked' }) })).status, 403);
    const token = (await (await fetch(base + '/api/auth/csrf', { headers })).json()).token;
    assert.equal((await fetch(base + '/api/auth/me', { method: 'PATCH', headers: { ...headers, 'X-CSRF-Token': token }, body: JSON.stringify({ displayName: 'Allowed' }) })).status, 200);
    const sessions = (await (await fetch(base + '/api/auth/sessions', { headers })).json()).sessions;
    assert.equal(sessions.length, 1);
    assert.ok(Date.parse(sessions[0].expiresAt) - Date.now() <= 12 * 3600000);
    assert.equal((await fetch(base + '/api/auth/logout-all', { method: 'POST', headers: { ...headers, 'X-CSRF-Token': token } })).status, 200);
    assert.equal((await (await fetch(base + '/api/auth/me', { headers })).json()).user, null);
    for (let i = 0; i < 2; i++) await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal((await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 429);
});
