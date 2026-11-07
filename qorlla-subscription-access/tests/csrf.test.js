import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCsrf, csrfTokenFor } from '../src/csrf.js';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const token = 'sessiontoken-0123456789abcdef';
const req = (o = {}) => ({ headers: { host: 'app.example', cookie: `qs=${token}`, ...o.headers } });
const run = (csrf, r) => { let status = 200, body, nexted = false; csrf.require(r, { status(n) { status = n; return this; }, json(b) { body = b; return this; } }, () => { nexted = true; }); return { status, body, nexted }; };

test('the token is bound to one session and is never computable without it', () => {
  const csrf = createCsrf();
  const t = csrf.tokenFor(req());
  assert.equal(t, csrfTokenFor(sha(token)));
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.notEqual(t, csrfTokenFor(sha(token + 'x')), 'another session, another token');
  assert.equal(csrf.tokenFor({ headers: {} }), null, 'no session, no token');
});

test('a request is allowed only with the right token; every other shape is a 403 and next() is never called', () => {
  const csrf = createCsrf(); const good = csrf.tokenFor(req());
  assert.equal(run(csrf, req({ headers: { 'x-csrf-token': good } })).nexted, true);
  for (const bad of [undefined, '', 'x', good.slice(0, -1), good + '0', good.toUpperCase(), csrfTokenFor(sha('other'))]) {
    const r = run(csrf, req({ headers: { 'x-csrf-token': bad } }));
    assert.deepEqual([r.status, r.nexted], [403, false], String(bad));
  }
  assert.equal(run(csrf, { headers: { host: 'app.example', 'x-csrf-token': good } }).status, 403, 'no session cookie at all');
});

test('a cross-site Origin is refused even with a valid token; the same site and configured origins pass', () => {
  const csrf = createCsrf({ allowedOrigins: ['https://admin.example'] }); const good = csrf.tokenFor(req());
  const withOrigin = (origin) => run(csrf, req({ headers: { origin, 'x-csrf-token': good } }));
  assert.equal(withOrigin('https://evil.example').status, 403);
  assert.equal(withOrigin('null').status, 403);
  assert.equal(withOrigin('not a url').status, 403);
  assert.equal(withOrigin('http://app.example').nexted, true, 'same host');
  assert.equal(withOrigin('https://admin.example').nexted, true, 'explicitly allowed');
  assert.equal(run(csrf, req({ headers: { 'sec-fetch-site': 'cross-site', 'x-csrf-token': good } })).status, 403, 'no Origin header but the browser says cross-site');
});

test('a custom cookie name is honoured', () => {
  const csrf = createCsrf({ cookieName: 'sid' });
  const r = { headers: { host: 'a', cookie: `sid=${token}` } };
  assert.equal(csrf.tokenFor(r), csrfTokenFor(sha(token)));
  assert.equal(csrf.tokenFor(req()), null, 'the default cookie is not used');
});
