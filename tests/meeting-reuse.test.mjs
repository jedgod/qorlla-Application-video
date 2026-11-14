// Meeting ID + password on current and History meetings, and plan-limited re-use. node --test tests/meeting-reuse.test.mjs
// Unit tests (vault, policy) plus HTTP tests against a REAL server.js process with an isolated DATA_DIR (nothing else is touched).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url), ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const vault = require('../meeting-passcode-vault.js'), policy = require('../meeting-reuse.js');
const K1 = 'k'.repeat(40), K2 = 'q'.repeat(40);

// ---------------------------------------------------------------- vault
test('vault: round trip; nothing in clear; bound to the meeting; tampering detected', () => {
  const env = { MEETING_PASSCODE_KEY: K1 }, id = '858 9833 3712', pw = 'Sunny-Pass-42!';
  const sealed = vault.seal(id, pw, env); assert.match(sealed, /^v1\.[0-9a-f]{8}\./); assert.ok(!sealed.includes(pw) && !Buffer.from(sealed.split('.')[4], 'base64url').toString('utf8').includes(pw));
  assert.deepEqual(vault.open(id, sealed, env), { ok: true, password: pw, old: false });
  assert.notEqual(vault.seal(id, pw, env), sealed);                                          // fresh IV every time
  assert.equal(vault.open('111 2222 3333', sealed, env).reason, 'tampered');                  // copied onto another meeting: refused
  const p = sealed.split('.'); p[4] = (p[4][0] === 'A' ? 'B' : 'A') + p[4].slice(1);
  assert.equal(vault.open(id, p.join('.'), env).ok, false);                                  // a changed ciphertext
  p[4] = sealed.split('.')[4]; p[3] = (p[3][0] === 'A' ? 'B' : 'A') + p[3].slice(1);
  assert.equal(vault.open(id, p.join('.'), env).ok, false);                                  // a changed tag
  for (const junk of [undefined, null, '', 'x', 'v2.a.b.c.d', 'v1.a.b.c']) assert.equal(vault.open(id, junk, env).ok, false);
});
test('vault: no key, or a key that is too short, fails CLOSED (nothing is sealed)', () => {
  assert.equal(vault.available({}), false); assert.equal(vault.seal('858 9833 3712', 'secret-pw', {}), null);
  assert.equal(vault.seal('858 9833 3712', 'secret-pw', { MEETING_PASSCODE_KEY: 'short-key' }), null); assert.equal(vault.available({ MEETING_PASSCODE_KEY: 'x'.repeat(31) }), false);
  assert.equal(vault.available({ MEETING_PASSCODE_KEY: 'x'.repeat(32) }), true);
  const sealed = vault.seal('858 9833 3712', 'secret-pw', { MEETING_PASSCODE_KEY: K1 });
  assert.equal(vault.open('858 9833 3712', sealed, {}).reason, 'no_key'); assert.equal(vault.open('858 9833 3712', sealed, { MEETING_PASSCODE_KEY: K2 }).reason, 'unknown_key');
  assert.equal(vault.seal('858 9833 3712', '', { MEETING_PASSCODE_KEY: K1 }), null);
});
test('vault: key rotation opens old values and re-seals them under the new key', () => {
  const id = '858 9833 3712', old = vault.seal(id, 'rotate-me-77', { MEETING_PASSCODE_KEY: K1 });
  const env = { MEETING_PASSCODE_KEY: K2, MEETING_PASSCODE_KEY_PREVIOUS: K1 }, opened = vault.open(id, old, env);
  assert.deepEqual([opened.ok, opened.password, opened.old], [true, 'rotate-me-77', true]);
  const fresh = vault.resealIfOld(id, opened, env); assert.ok(fresh); assert.deepEqual(vault.open(id, fresh, { MEETING_PASSCODE_KEY: K2 }), { ok: true, password: 'rotate-me-77', old: false });
  assert.equal(vault.resealIfOld(id, vault.open(id, fresh, env), env), null);                // already current
});

// ---------------------------------------------------------------- policy
test('policy: default allowances per plan, unlimited, zero, overrides, bad values', () => {
  assert.deepEqual(['free', 'pro', 'business', 'enterprise'].map((p) => policy.limitFor(p, {})), [3, 25, 100, null]);
  assert.equal(policy.limitFor('free', { REUSE_LIMIT_FREE: '0' }), 0); assert.equal(policy.limitFor('free', { REUSE_LIMIT_FREE: '' }), null); assert.equal(policy.limitFor('free', { REUSE_LIMIT_FREE: '-1' }), null);
  assert.equal(policy.limitFor('pro', { REUSE_LIMIT_PRO: '7' }), 7); assert.equal(policy.limitFor('pro', { REUSE_LIMIT_PRO: 'lots' }), 25); assert.equal(policy.limitFor('pro', { REUSE_LIMIT_PRO: '2.5' }), 25);
  assert.equal(policy.limitFor('nonsense', {}), 3);
});
test('policy: the plan comes from the account (or the paid list); the limit that applies is the one for the plan NOW (downgrade), used re-uses still count', () => {
  assert.equal(policy.planOf(null, {}), 'free'); assert.equal(policy.planOf({ username: 'a' }, {}), 'free');
  assert.equal(policy.planOf({ username: 'a', plan: 'Business' }, {}), 'business'); assert.equal(policy.planOf({ username: 'vip-1' }, { MEETING_LIMIT_EXEMPT_USERS: 'vip*' }), 'pro');
  const used = 10, asBusiness = policy.evaluate({ plan: 'business' }, used, {}), downgraded = policy.evaluate({ plan: 'free' }, used, {});
  assert.equal(asBusiness.allowed, true); assert.equal(asBusiness.remaining, 90); assert.equal(downgraded.allowed, false); assert.equal(downgraded.remaining, 0);
  assert.equal(policy.evaluate({ plan: 'free' }, 2, {}).remaining, 1); assert.equal(policy.evaluate({ plan: 'enterprise' }, 9999, {}).remaining, null); assert.equal(policy.evaluate({ plan: 'enterprise' }, 9999, {}).allowed, true);
  assert.equal(policy.evaluate({ plan: 'free' }, 0, { REUSE_LIMIT_FREE: '0' }).allowed, false);
  assert.match(policy.refusal(policy.evaluate({ plan: 'free' }, 3, {})), /Upgrade to have full access to Qorlla packages/); assert.match(policy.refusal(policy.evaluate({ plan: 'free' }, 0, { REUSE_LIMIT_FREE: '0' })), /does not include/);
});

// ---------------------------------------------------------------- real server
let port = 4200 + Math.floor(Math.random() * 400);
async function startServer(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qreuse-')), p = port++, env = { ...process.env, PORT: String(p), DATA_DIR: dir, HISTORY_IDLE_MS: '1', REUSE_LIMIT_FREE: '2', MEETING_LIMIT_EXEMPT_USERS: 'vip*', ...extra };
  delete env.DATABASE_URL; for (const k of Object.keys(extra)) if (extra[k] === null) delete env[k];
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }); let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  const base = 'http://127.0.0.1:' + p;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/auth/me')).status < 500) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }
  return { base, dir, log: () => log, stop: async () => { child.kill(); await new Promise((r) => setTimeout(r, 300)); } };
}
function client(base) {
  const jar = new Map();
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie: [...jar].map(([k, v]) => k + '=' + v).join('; ') }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json, text };
  };
  return { call, get: (p) => call('GET', p), call2: call, post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), patch: (p, b) => call('PATCH', p, b ?? {}) };
}
let userSeq = 0;
async function account(base, prefix = 'u') {
  const c = client(base), username = prefix + Date.now().toString(36) + (userSeq++);
  const r = await c.post('/api/auth/register', { username, displayName: 'Host ' + username, password: 'History-pass-9917!x' }); assert.equal(r.status, 201, r.text); return c;
}
const PAST = () => new Date(Date.now() - 3 * 3600e3).toISOString();
async function missedMeeting(c, { passcode, durationMinutes = 0.02, topic = 'Weekly review' } = {}) {
  const r = await c.post('/api/meetings/create', { topic, startTime: PAST(), durationMinutes, ...(passcode ? { passcode } : {}) }); assert.equal(r.status, 201, r.text); return r.json.meeting;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// the server saves its data file shortly after a change: poll until `ok(parsed)` holds (up to 8 s) instead of sleeping a fixed time
async function snapshot(dir, ok = () => true) { let raw = ''; for (let i = 0; i < 40; i++) { try { raw = readFileSync(join(dir, 'meetings.json'), 'utf8'); if (ok(JSON.parse(raw))) return raw; } catch { /* not written yet */ } await wait(200); } return raw; }
const hist = async (c, q = '') => (await c.get('/api/history/meetings' + q)).json.meetings;
const enc = encodeURIComponent;

test('credentials: the host can see the ID and (on click) the password; nobody else can; the password is never in lists, URLs, logs or the data file', async () => {
  const s = await startServer({ MEETING_PASSCODE_KEY: K1 }); const PW = 'Sunny-Pass-42!';
  try {
    const host = await account(s.base), other = await account(s.base), anon = client(s.base);
    const m = await missedMeeting(host, { passcode: PW }); assert.equal(m.passcodeEnc, undefined); assert.equal(m.passcodeHash, undefined); assert.equal(m.reuse, undefined);       // the create answer carries neither
    const info = await host.get('/api/meetings/' + enc(m.meetingId) + '/credentials'); assert.equal(info.status, 200);
    assert.deepEqual([info.json.meetingId, info.json.passwordState, info.json.keyConfigured], [m.meetingId, 'viewable', true]); assert.ok(!info.text.includes(PW));
    const rows = await hist(host); assert.equal(rows.length, 1); assert.equal(rows[0].credentials.passwordState, 'viewable'); assert.ok(!JSON.stringify(rows).includes(PW));
    const shown = await host.post('/api/meetings/' + enc(m.meetingId) + '/credentials/reveal'); assert.equal(shown.status, 200); assert.equal(shown.json.password, PW);
    assert.equal((await host.get('/api/meetings/' + enc(m.meetingId) + '/credentials/reveal')).status === 200, false);                                                         // not reachable by GET
    for (const c of [other, anon]) for (const [method, path] of [['get', '/credentials'], ['post', '/credentials/reveal'], ['post', '/reuse']]) {
      const r = await c[method]('/api/meetings/' + enc(m.meetingId) + path, { clientRequestId: 'abcdefgh-1' }); assert.ok([401, 403].includes(r.status), method + path + ' -> ' + r.status); assert.ok(!r.text.includes(PW));
    }
    assert.equal((await host.post('/api/meetings/' + enc('000 0000 0000') + '/credentials/reveal')).status, 404);
    const snap = await snapshot(s.dir, (d) => d.some((x) => x.meetingId === m.meetingId && x.passcodeEnc));
    assert.ok(!snap.includes(PW)); const rec = JSON.parse(snap).find((x) => x.meetingId === m.meetingId); assert.match(rec.passcodeEnc, /^v1\./); assert.match(rec.passcodeHash, /^[0-9a-f]{32}:/);      // encrypted + hash, never clear
    assert.ok(!s.log().includes(PW)); assert.match(s.log(), /meeting_password_revealed/); assert.ok(!(s.log().match(/meeting_password_revealed[^\n]*/) || [''])[0].includes(PW));
  } finally { await s.stop(); }
});

test('credentials: no key => FAIL CLOSED (nothing stored, the host is told, the meeting still works)', async () => {
  const s = await startServer({ MEETING_PASSCODE_KEY: null }); const PW = 'No-Key-Pass-1!';
  try {
    const host = await account(s.base), m = await missedMeeting(host, { passcode: PW });
    const info = await host.get('/api/meetings/' + enc(m.meetingId) + '/credentials'); assert.deepEqual([info.json.passwordState, info.json.keyConfigured], ['hash_only', false]);
    const r = await host.post('/api/meetings/' + enc(m.meetingId) + '/credentials/reveal'); assert.equal(r.status, 409); assert.match(r.json.error, /one-way hash/); assert.ok(!r.text.includes(PW));
    const snap = await snapshot(s.dir, (d) => d.some((x) => x.meetingId === m.meetingId && x.passcodeHash)); assert.ok(!snap.includes(PW)); assert.ok(!snap.includes('passcodeEnc'));
    const none = await missedMeeting(host, { topic: 'No password' }); assert.equal((await host.get('/api/meetings/' + enc(none.meetingId) + '/credentials')).json.passwordState, 'none');
    assert.equal((await host.post('/api/meetings/' + enc(none.meetingId) + '/credentials/reveal')).status, 404);
  } finally { await s.stop(); }
});

test('credentials: setting, changing and removing the password through the existing route keeps the stored copy in step', async () => {
  const s = await startServer({ MEETING_PASSCODE_KEY: K1 });
  try {
    const host = await account(s.base), made = await host.post('/api/meetings/create', { topic: 'Upcoming meeting', startTime: new Date(Date.now() + 864e5).toISOString(), durationMinutes: 30 }), m = made.json.meeting, url = '/api/meetings/' + enc(m.meetingId);      // an UPCOMING meeting: a finished one is frozen and keeps its password
    assert.equal((await host.get(url + '/credentials')).json.passwordState, 'none');
    // the existing route needs the host's meeting key or account; a signed-in host is the account
    assert.equal((await host.put(url + '/passcode', { passcode: 'First-pass-11' })).status, 200); assert.equal((await host.post(url + '/credentials/reveal')).json.password, 'First-pass-11');
    assert.equal((await host.put(url + '/passcode', { passcode: 'Second-pass-22' })).status, 200); assert.equal((await host.post(url + '/credentials/reveal')).json.password, 'Second-pass-22');
    assert.equal((await host.put(url + '/passcode', { passcode: null })).status, 200); assert.equal((await host.get(url + '/credentials')).json.passwordState, 'none');
    assert.equal((await host.post(url + '/credentials/reveal')).status, 404);
  } finally { await s.stop(); }
});

test('re-use: same ID and password, a NEW run; the finished run stays frozen in History; idempotent; non-hosts refused', async () => {
  const s = await startServer({ MEETING_PASSCODE_KEY: K1 }); const PW = 'Reuse-Pass-55!';
  try {
    const host = await account(s.base), other = await account(s.base), m = await missedMeeting(host, { passcode: PW, topic: 'Frozen topic' }), id = m.meetingId, url = '/api/meetings/' + enc(id);
    const before = (await hist(host))[0]; assert.equal(before.status, 'missed'); assert.equal(before.reuse.canReuse, true); assert.deepEqual([before.reuse.used, before.reuse.limit, before.reuse.remaining, before.reuse.plan], [0, 2, 2, 'free']);
    assert.equal((await host.patch('/api/history/meetings/' + enc(before.runKey), { outcome: 'Original outcome', actionItems: [{ text: 'Keep me', owner: 'A', due: '', done: false }] })).status, 200);
    const frozen = (await hist(host))[0];
    assert.equal((await host.get('/api/meetings/validate/' + enc(id))).status, 404);                                  // before: a finished meeting cannot be joined
    assert.equal((await host.post(url + '/reuse', {})).status, 400);                                                   // a request id is required
    assert.equal((await other.post(url + '/reuse', { clientRequestId: 'other-request-1' })).status, 403);
    const r = await host.post(url + '/reuse', { clientRequestId: 'request-0001' }); assert.equal(r.status, 201, r.text); assert.deepEqual([r.json.meetingId, r.json.runIndex, r.json.reuse.used, r.json.reuse.remaining], [id, 1, 1, 1]);
    const again = await host.post(url + '/reuse', { clientRequestId: 'request-0001' }); assert.equal(again.status, 200); assert.equal(again.json.idempotent, true); assert.equal(again.json.reuse.used, 1);       // no second re-use
    // the same ID is live again with the same password
    const v = await host.get('/api/meetings/validate/' + enc(id)); assert.equal(v.status, 200); assert.equal(v.json.passcodeRequired, true);
    assert.equal((await host.post(url + '/credentials/reveal')).json.password, PW);
    // the finished run is intact, under its own key, with the same facts
    const rows = await hist(host); assert.equal(rows.length, 1); const arch = rows[0]; assert.equal(arch.runKey, id + '~r0'); assert.equal(arch.meetingId, id); assert.equal(arch.reuse.canReuse, false); assert.equal(arch.credentials.passwordState, 'archived');
    for (const k of ['title', 'topic', 'category', 'status', 'scheduledStartAt', 'actualStartAt', 'actualEndAt', 'durationSeconds', 'uniqueAttendeeCount', 'peakConcurrentCount', 'outcomeSummary', 'endReason', 'hostName']) assert.deepEqual(arch[k], frozen[k], k);
    const det = await host.get('/api/history/meetings/' + enc(arch.runKey)); assert.equal(det.status, 200); assert.equal(det.json.outcome, 'Original outcome'); assert.equal(det.json.actionItems[0].text, 'Keep me');
    assert.equal((await host.patch('/api/history/meetings/' + enc(arch.runKey), { outcome: 'Edited later' })).status, 200);                  // the outcome stays writable, as for every history record
    assert.equal((await host.get('/api/history/meetings/' + enc(id))).status, 409);                                    // the new run has not finished: it is not history yet
    // the earlier run holds no password material any more; the new run is clean
    const snap = JSON.parse(await snapshot(s.dir, (d) => d.some((x) => x.storeKey === id + '~r0') && d.some((x) => x.meetingId === id && !x.storeKey && x.reuse))); const run0 = snap.find((x) => x.storeKey === id + '~r0'), head = snap.find((x) => x.meetingId === id && !x.storeKey);
    assert.ok(run0 && head); assert.equal(run0.passcodeEnc, undefined); assert.equal(run0.passcodeHash, undefined); assert.equal(head.status, 'scheduled'); assert.deepEqual([head.reuse.index, head.attendance, head.actionItems, head.outcome], [1, undefined, undefined, undefined]);
    assert.notEqual(head.id, run0.id);
    // not finished: cannot be re-used again yet
    const busy = await host.post(url + '/reuse', { clientRequestId: 'request-0002' }); assert.equal(busy.status, 409); assert.equal(busy.json.code, 'not_finished');
    assert.ok(!s.log().includes(PW));
  } finally { await s.stop(); }
});

test('re-use: the plan limit is enforced on the server and points to Upgrade; paid users get more; unlimited has no remaining count', async () => {
  const s = await startServer({ MEETING_PASSCODE_KEY: K1 });
  try {
    const host = await account(s.base), m = await missedMeeting(host, { passcode: 'Limit-pass-9' }), url = '/api/meetings/' + enc(m.meetingId);
    for (let n = 1; n <= 2; n++) { assert.equal((await host.post(url + '/reuse', { clientRequestId: 'limit-run-' + n })).status, 201); await wait(1500); }                 // the new run (1.2 s long) is over
    const third = await host.post(url + '/reuse', { clientRequestId: 'limit-run-3' }); assert.equal(third.status, 403); assert.equal(third.json.code, 'reuse_limit'); assert.equal(third.json.upgrade, true); assert.match(third.json.error, /Upgrade to have full access to Qorlla packages/);
    assert.deepEqual([third.json.used, third.json.limit, third.json.remaining], [2, 2, 0]); const info = await host.get(url + '/credentials'); assert.deepEqual([info.json.reuse.canReuse, info.json.reuse.remaining], [false, 0]);
    assert.equal((await hist(host)).length, 3);                                                                                                                     // runs 0, 1 and 2 (run 2 has finished too) are in History, each frozen
    // a paid (listed) host has the pro allowance
    const vip = await account(s.base, 'vip'), vm = await missedMeeting(vip); const vinfo = await vip.get('/api/meetings/' + enc(vm.meetingId) + '/credentials'); assert.deepEqual([vinfo.json.reuse.plan, vinfo.json.reuse.limit], ['pro', 25]);
  } finally { await s.stop(); }
  const z = await startServer({ MEETING_PASSCODE_KEY: K1, REUSE_LIMIT_FREE: '0' });
  try { const h = await account(z.base), m = await missedMeeting(h); const r = await h.post('/api/meetings/' + enc(m.meetingId) + '/reuse', { clientRequestId: 'zero-run-0001' }); assert.equal(r.status, 403); assert.match(r.json.error, /does not include/); } finally { await z.stop(); }
  const u = await startServer({ MEETING_PASSCODE_KEY: K1, REUSE_LIMIT_FREE: '' });
  try { const h = await account(u.base), m = await missedMeeting(h); const i = await h.get('/api/meetings/' + enc(m.meetingId) + '/credentials'); assert.deepEqual([i.json.reuse.limit, i.json.reuse.remaining, i.json.reuse.allowed], [null, null, true]); } finally { await u.stop(); }
});

test('re-use: simultaneous clicks cannot use more re-uses than allowed (one wins; the same request id returns the same answer)', async () => {
  const s = await startServer({ MEETING_PASSCODE_KEY: K1, REUSE_LIMIT_FREE: '1' });
  try {
    const host = await account(s.base), m = await missedMeeting(host, { passcode: 'Race-pass-123' }), url = '/api/meetings/' + enc(m.meetingId);
    const many = await Promise.all(Array.from({ length: 6 }, (_, i) => host.post(url + '/reuse', { clientRequestId: 'race-request-' + i }))); const codes = many.map((r) => r.status).sort();
    assert.equal(codes.filter((c) => c === 201).length, 1, codes.join(',')); assert.ok(codes.every((c) => [201, 403, 409].includes(c)));
    const rows = await hist(host); assert.equal(rows.length, 1); assert.equal(rows[0].runKey, m.meetingId + '~r0');                                                  // exactly one frozen run
    const same = await Promise.all(Array.from({ length: 4 }, () => host.post(url + '/reuse', { clientRequestId: 'race-request-0' }))); assert.ok(same.every((r) => r.status === 200 && r.json.idempotent === true));
    assert.equal((await host.get(url + '/credentials')).json.reuse.used, 1);
  } finally { await s.stop(); }
});

test('History: attendees see the Meeting ID but no password, no credentials block and no re-use; history lists never carry a password', async () => {
  const s = await startServer({ MEETING_PASSCODE_KEY: K1 }); const PW = 'Attendee-Hidden-7!';
  try {
    const host = await account(s.base), m = await missedMeeting(host, { passcode: PW });
    const rows = await hist(host); assert.equal(rows[0].meetingId, m.meetingId); assert.ok(rows[0].credentials && rows[0].reuse);
    const list = await host.get('/api/history/meetings'); assert.ok(!list.text.includes(PW)); const det = await host.get('/api/history/meetings/' + enc(rows[0].runKey)); assert.ok(!det.text.includes(PW)); assert.equal(det.json.credentials.passwordState, 'viewable');
    const csv = await host.get('/api/history/meetings/' + enc(rows[0].runKey) + '/report'); assert.equal(csv.status, 200); assert.ok(!csv.text.includes(PW)); assert.ok(csv.text.includes(m.meetingId));            // the report carries the ID, never the password
    const rep = await host.get('/api/history/meetings/' + enc(rows[0].runKey) + '/report?format=json'); assert.ok(!rep.text.includes(PW));
    const pub = await host.get('/api/meetings/validate/' + enc(m.meetingId)); assert.ok(!pub.text.includes(PW));
  } finally { await s.stop(); }
});

test('Allow reuse: a per-meeting switch kept on the server; OFF forbids re-use; ON is refused when the plan has none left; host only; persisted and inherited', async () => {
  const s = await startServer({ MEETING_PASSCODE_KEY: K1 });
  try {
    const host = await account(s.base), other = await account(s.base), m = await missedMeeting(host, { passcode: 'Switch-pass-1' }), url = '/api/meetings/' + enc(m.meetingId);
    const info0 = (await host.get(url + '/credentials')).json.reuse; assert.deepEqual([info0.enabled, info0.canReuse, info0.reason], [true, true, null]);
    assert.equal((await other.put(url + '/reuse-setting', { allowed: false })).status, 403); assert.equal((await client(s.base).put(url + '/reuse-setting', { allowed: false })).status, 401);
    assert.equal((await host.put(url + '/reuse-setting', { allowed: 'no' })).status, 400); assert.equal((await host.put(url + '/reuse-setting', {})).status, 400);
    const off = await host.put(url + '/reuse-setting', { allowed: false }); assert.equal(off.status, 200); assert.deepEqual([off.json.reuse.enabled, off.json.reuse.canReuse, off.json.reuse.reason], [false, false, 'off']);
    const refused = await host.post(url + '/reuse', { clientRequestId: 'switch-off-001' }); assert.equal(refused.status, 403); assert.equal(refused.json.code, 'reuse_off');                  // the server enforces it, not the page
    assert.equal((await host.get(url + '/credentials')).json.reuse.used, 0);                                                                                                        // nothing was consumed
    assert.equal((await hist(host))[0].reuse.enabled, false);
    const snap = JSON.parse(await snapshot(s.dir, (d) => d.some((x) => x.meetingId === m.meetingId && x.reuseAllowed === false))); assert.equal(snap.find((x) => x.meetingId === m.meetingId).reuseAllowed, false);   // persisted
    assert.equal((await host.put(url + '/reuse-setting', { allowed: true })).json.reuse.enabled, true);
    assert.equal((await host.post(url + '/reuse', { clientRequestId: 'switch-on-0001' })).status, 201);
    const snap2 = JSON.parse(await snapshot(s.dir, (d) => d.some((x) => x.meetingId === m.meetingId && !x.storeKey && x.reuse))); assert.equal(snap2.find((x) => x.meetingId === m.meetingId && !x.storeKey).reuseAllowed, true);   // the new run keeps the setting
  } finally { await s.stop(); }
  const z = await startServer({ MEETING_PASSCODE_KEY: K1, REUSE_LIMIT_FREE: '0' });
  try {
    const host = await account(z.base), m = await missedMeeting(host), url = '/api/meetings/' + enc(m.meetingId);
    const info = (await host.get(url + '/credentials')).json.reuse; assert.deepEqual([info.allowed, info.reason, info.canReuse], [false, 'limit', false]);
    const on = await host.put(url + '/reuse-setting', { allowed: true }); assert.equal(on.status, 403); assert.equal(on.json.code, 'reuse_limit'); assert.match(on.json.error, /Upgrade to have full access to Qorlla packages/);
    assert.equal((await host.put(url + '/reuse-setting', { allowed: false })).status, 200);                           // OFF is always possible
  } finally { await z.stop(); }
});

test('re-use: a cancelled meeting shows in History and can be started again (same rules: switch, plan limit, host only)', async () => {
  const s = await startServer({ MEETING_PASSCODE_KEY: K1 });
  try {
    const host = await account(s.base), d = new Date(Date.now() + 864e5), ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const sc = await host.post('/api/workplace/schedule', { title: 'Will be cancelled', date: ymd, time: '10:00', duration: 30 }); assert.equal(sc.status, 201, sc.text);
    assert.equal((await host.put('/api/meetings/' + enc(sc.json.meetingId) + '/passcode', { passcode: 'Cancelled-pass-3' })).status, 200);
    assert.equal((await host.call('DELETE', '/api/workplace/schedule/' + sc.json.id)).status, 200);                    // the organiser deletes it before it starts: it becomes a cancelled history record
    const row = (await hist(host)).find((x) => x.title === 'Will be cancelled'); assert.equal(row.status, 'cancelled'); assert.equal(row.reuse.canReuse, true); assert.equal(row.credentials.passwordState, 'viewable');
    const r = await host.post('/api/meetings/' + enc(sc.json.meetingId) + '/reuse', { clientRequestId: 'cancelled-run-1' }); assert.equal(r.status, 201, r.text);
    assert.equal((await host.post('/api/meetings/' + enc(sc.json.meetingId) + '/credentials/reveal')).json.password, 'Cancelled-pass-3');
    assert.equal((await hist(host)).find((x) => x.title === 'Will be cancelled').status, 'cancelled');                  // the cancelled record itself is unchanged
  } finally { await s.stop(); }
});
