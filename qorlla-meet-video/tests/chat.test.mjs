import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pg from 'pg';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerChat } from '../server/chat.mjs';

// Meeting chat upgrade (v4.25) against a REAL PostgreSQL (TEST_PG_URL; a scratch database is created and dropped). Auth/member are the same stand-ins the ASCS tests use:
// the identity comes from a header instead of a signed token, but the admitted-participant SQL is the real one.
const URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:25611/postgres';
const SQL = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const ORDER = ['schema.sql', 'v2_migration.sql', 'v3_migration.sql', 'v3_1_to_v3_5_migration.sql', '002_recovery.sql', ...readdirSync(SQL).filter((f) => /^v4_\d+_/.test(f)).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))];
const dbName = 'chat_' + Math.random().toString(36).slice(2, 10);
let admin, pool;
test.before(async () => {
  admin = new pg.Pool({ connectionString: URL, max: 1 }); await admin.query(`CREATE DATABASE ${dbName}`);
  pool = new pg.Pool({ connectionString: URL.replace(/\/[^/]*$/, '/' + dbName), max: 8 }); pool.on('error', () => {});
  for (const f of ORDER) await pool.query(readFileSync(join(SQL, f), 'utf8'));
});
test.after(async () => { await pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {}); await admin?.end(); });

async function harness(opts = {}) {
  const events = [], io = { to: (target) => ({ emit: (type, payload) => events.push({ target, type, payload }) }) }, roomOf = (id) => 'meeting:' + id;
  const fail = (res, status, error) => res.status(status).json({ error });
  const app = express(); app.use(express.json({ limit: '32kb' }));
  const auth = (req, res, next) => { try { req.user = JSON.parse(req.get('x-user')); next(); } catch { fail(res, 401, 'Authentication required'); } };
  const member = async (req, res, next) => {
    if (req.user.meetingId !== req.params.id) return fail(res, 403, 'Wrong meeting');
    const { rows } = await pool.query("SELECT m.ended_at, p.id FROM meetings m JOIN participants p ON p.meeting_id=m.id WHERE m.id=$1 AND p.id=$2 AND p.admission='admitted'", [req.params.id, req.user.participantId]);
    if (!rows.length || rows[0].ended_at) return fail(res, 403, 'Meeting unavailable'); next();
  };
  const dir = mkdtempSync(join(tmpdir(), 'chat-att-'));
  const chat = registerChat({ app, io, db: pool, auth, member, room: roomOf, fail, socketOf: (m, p) => 'sock:' + p, giphyKey: '', attachmentsEnabled: false, attachmentsDir: dir, ...opts });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); const base = 'http://127.0.0.1:' + server.address().port;
  const meeting = async () => {
    const mid = randomUUID(), host = randomUUID(), ann = randomUUID(), bo = randomUUID(), waiting = randomUUID();
    await pool.query("INSERT INTO meetings(id,title,host_secret_hash) VALUES($1,'t','x')", [mid]);
    for (const [id, role, n, adm] of [[host, 'host', 'Host', 'admitted'], [ann, 'guest', 'Ann', 'admitted'], [bo, 'guest', 'Bo', 'admitted'], [waiting, 'guest', 'Wes', 'waiting']]) await pool.query('INSERT INTO participants(id,meeting_id,display_name,role,admission) VALUES($1,$2,$3,$4,$5)', [id, mid, n, role, adm]);
    const u = (participantId, role = 'guest') => ({ meetingId: mid, participantId, role });
    return { mid, host: u(host, 'host'), ann: u(ann), bo: u(bo), waiting: u(waiting), ids: { host, ann, bo, waiting } };
  };
  const call = async (method, path, user, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'x-user': JSON.stringify(user), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    const type = r.headers.get('content-type') || ''; return { status: r.status, headers: r.headers, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  return { chat, events, call, meeting, close: async () => { await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); } };
}
const P = (m, s = '') => `/api/meetings/${m.mid}/chat${s}`;
// events are delivered per socket, only to people who are admitted right now
const reachedAll = (h, m, pred) => ['host', 'ann', 'bo'].every((k) => h.events.some((e) => e.target === 'sock:' + m.ids[k] && pred(e)));
const reachedWaiting = (h, m) => h.events.some((e) => e.target === 'sock:' + m.ids.waiting);

test('plain and rich messages: body stays plain text, rich is canonical, script never survives', async () => {
  const h = await harness(); const m = await h.meeting();
  const a = await h.call('POST', P(m), m.ann, { body: 'hello  there ' }); assert.equal(a.status, 201); assert.equal(a.body.body, 'hello  there'); assert.equal(a.body.rich, null); assert.equal(a.body.name, 'Ann');
  const r = await h.call('POST', P(m), m.ann, { rich: '<b>bold</b> <script>alert(1)</script><img src=x onerror=alert(1)> <a href="javascript:alert(1)">x</a> & more' });
  assert.equal(r.status, 201); assert.equal(r.body.rich, '<b>bold</b>  x &amp; more'); assert.equal(r.body.body, 'bold  x & more');
  const { rows } = await pool.query('SELECT body, body_rich FROM messages WHERE id=$1', [r.body.id]); assert.equal(rows[0].body, 'bold  x & more');       // what the AI summary and the export read: no markup
  const plainOnly = await h.call('POST', P(m), m.ann, { rich: 'just <span>text</span>' }); assert.equal(plainOnly.body.rich, null); assert.equal(plainOnly.body.body, 'just text');
  assert.equal((await h.call('POST', P(m), m.ann, { body: '   ' })).status, 400);
  assert.equal((await h.call('POST', P(m), m.ann, { rich: '<b></b>' })).status, 400);
  assert.equal((await h.call('POST', P(m), m.ann, { rich: 'x'.repeat(9000) })).status, 400);
  assert.equal((await h.call('POST', P(m), m.ann, { body: 'x', kind: 'nope' })).status, 400);
  assert.ok(reachedAll(h, m, (e) => e.type === 'chat' && e.payload.body === 'hello  there')); assert.ok(!reachedWaiting(h, m));      // everybody admitted, nobody who is still waiting
  await h.close();
});

test('only admitted people of THIS meeting can use the chat; other meetings are isolated', async () => {
  const h = await harness(); const m = await h.meeting(), other = await h.meeting();
  assert.equal((await h.call('GET', P(m), m.waiting)).status, 403);                                // not admitted
  assert.equal((await h.call('POST', P(m), m.waiting, { body: 'let me in' })).status, 403);
  assert.equal((await h.call('GET', P(m), other.ann)).status, 403);                                // a token of another meeting
  assert.equal((await h.call('GET', P(m), {})).status, 403);
  const msg = (await h.call('POST', P(m), m.ann, { body: 'secret' })).body;
  for (const [method, suffix] of [['PATCH', '/' + msg.id], ['PUT', '/' + msg.id + '/bookmark'], ['PUT', '/' + msg.id + '/pin'], ['POST', '/' + msg.id + '/tasks']]) {
    const r = await h.call(method, P(other, suffix), other.host, { body: 'x', title: 'x' }); assert.equal(r.status, 404, method + suffix);   // the message exists, but not in that meeting
  }
  assert.equal((await h.call('POST', P(other), other.ann, { body: 'reply?', replyTo: msg.id })).status, 404);                 // no replying across meetings
  assert.deepEqual((await h.call('GET', P(other), other.ann)).body.messages, []);
  await h.close();
});

test('replies, quotes and the list', async () => {
  const h = await harness(); const m = await h.meeting();
  const first = (await h.call('POST', P(m), m.ann, { body: 'the plan is A' })).body;
  const reply = (await h.call('POST', P(m), m.bo, { body: 'agreed', replyTo: first.id })).body;
  assert.deepEqual(reply.replyTo, { id: first.id, name: 'Ann', text: 'the plan is A' });
  assert.equal((await h.call('POST', P(m), m.bo, { body: 'x', replyTo: 'not-a-uuid' })).status, 400);
  assert.equal((await h.call('POST', P(m), m.bo, { body: 'x', replyTo: randomUUID() })).status, 404);
  const list = (await h.call('GET', P(m), m.bo)).body; assert.deepEqual(list.messages.map((x) => x.body), ['the plan is A', 'agreed']);
  assert.deepEqual(list.features, { gif: false, attachments: false });
  await h.close();
});

test('edit: only the author, only text, plain and rich, and everyone is told', async () => {
  const h = await harness(); const m = await h.meeting();
  const msg = (await h.call('POST', P(m), m.ann, { body: 'typo' })).body;
  assert.equal((await h.call('PATCH', P(m, '/' + msg.id), m.bo, { body: 'hijack' })).status, 403);
  assert.equal((await h.call('PATCH', P(m, '/' + msg.id), m.host, { body: 'host cannot edit others' })).status, 403);
  const ok = await h.call('PATCH', P(m, '/' + msg.id), m.ann, { rich: 'fixed <i>text</i><script>1</script>' });
  assert.equal(ok.status, 200); assert.equal(ok.body.body, 'fixed text'); assert.equal(ok.body.rich, 'fixed <i>text</i>'); assert.ok(ok.body.editedAt);
  assert.ok(h.events.some((e) => e.type === 'chat-edit' && e.payload.id === msg.id && e.payload.body === 'fixed text'));
  assert.equal((await h.call('PATCH', P(m, '/' + msg.id), m.ann, { body: '  ' })).status, 400);
  assert.equal((await h.call('PATCH', P(m, '/' + randomUUID()), m.ann, { body: 'x' })).status, 404);
  assert.equal((await h.call('PATCH', P(m, '/bad'), m.ann, { body: 'x' })).status, 400);
  await pool.query("UPDATE messages SET kind='gif' WHERE id=$1", [msg.id]); assert.equal((await h.call('PATCH', P(m, '/' + msg.id), m.ann, { body: 'x' })).status, 400);
  await h.close();
});

test('bookmarks are private to the person; pins are for everyone and host only', async () => {
  const h = await harness(); const m = await h.meeting(); const msg = (await h.call('POST', P(m), m.ann, { body: 'note' })).body;
  assert.equal((await h.call('PUT', P(m, '/' + msg.id + '/bookmark'), m.bo)).status, 200);
  const bo = (await h.call('GET', P(m), m.bo)).body.messages[0], ann = (await h.call('GET', P(m), m.ann)).body.messages[0];
  assert.equal(bo.bookmarked, true); assert.equal(ann.bookmarked, false);
  assert.equal((await h.call('GET', P(m) + '?bookmarked=1', m.ann)).body.messages.length, 0); assert.equal((await h.call('GET', P(m) + '?bookmarked=1', m.bo)).body.messages.length, 1);
  assert.ok(!h.events.some((e) => e.type === 'chat-bookmark'));
  assert.equal((await h.call('DELETE', P(m, '/' + msg.id + '/bookmark'), m.bo)).status, 200); assert.equal((await h.call('GET', P(m), m.bo)).body.messages[0].bookmarked, false);
  assert.equal((await h.call('PUT', P(m, '/' + msg.id + '/pin'), m.ann)).status, 403);                         // a guest cannot pin, not even their own message
  assert.equal((await h.call('PUT', P(m, '/' + msg.id + '/pin'), m.host)).status, 200);
  assert.ok(h.events.some((e) => e.type === 'chat-pin' && e.payload.pinned === true && e.payload.id === msg.id));
  assert.equal((await h.call('GET', P(m), m.bo)).body.messages[0].pinned, true); assert.equal((await h.call('GET', P(m) + '?pinned=1', m.bo)).body.messages.length, 1);
  assert.equal((await h.call('DELETE', P(m, '/' + msg.id + '/pin'), m.bo)).status, 403);
  assert.equal((await h.call('DELETE', P(m, '/' + msg.id + '/pin'), m.host)).status, 200); assert.equal((await h.call('GET', P(m) + '?pinned=1', m.bo)).body.messages.length, 0);
  await h.close();
});

test('tasks: validated title, date and assignee; listed for the meeting', async () => {
  const h = await harness(); const m = await h.meeting(), other = await h.meeting(); const msg = (await h.call('POST', P(m), m.ann, { body: 'send the deck' })).body;
  const ok = await h.call('POST', P(m, '/' + msg.id + '/tasks'), m.bo, { title: 'Send the deck', dueDate: '2030-01-31', assigneeId: m.ids.ann });
  assert.equal(ok.status, 201); assert.equal(ok.body.assigneeId, m.ids.ann); assert.equal(ok.body.dueDate, '2030-01-31');
  assert.ok(h.events.some((e) => e.type === 'chat-task' && e.payload.title === 'Send the deck'));
  for (const bad of [{ title: '' }, { title: 'x', dueDate: '31/01/2030' }, { title: 'x', dueDate: '2030-02-31' }, { title: 'x', assigneeId: other.ids.ann }, { title: 'x', assigneeId: m.ids.waiting }, { title: 'x', assigneeId: 'nope' }])
    assert.equal((await h.call('POST', P(m, '/' + msg.id + '/tasks'), m.bo, bad)).status, 400, JSON.stringify(bad));
  const list = (await h.call('GET', P(m, '/tasks/list'), m.ann)).body.tasks; assert.equal(list.length, 1); assert.equal(list[0].dueDate, '2030-01-31');
  assert.deepEqual((await h.call('GET', P(other, '/tasks/list'), other.ann)).body.tasks, []);
  await h.close();
});

test('search treats % and _ literally and pagination works', async () => {
  const h = await harness(); const m = await h.meeting();
  for (const b of ['100% sure', 'a_b', 'axb', 'plain']) await h.call('POST', P(m), m.ann, { body: b });
  const q = async (s) => (await h.call('GET', P(m) + '?q=' + encodeURIComponent(s), m.bo)).body.messages.map((x) => x.body);
  assert.deepEqual(await q('%'), ['100% sure']); assert.deepEqual(await q('a_b'), ['a_b']); assert.deepEqual(await q('PLAIN'), ['plain']);
  const all = (await h.call('GET', P(m) + '?limit=2', m.bo)).body.messages; assert.deepEqual(all.map((x) => x.body), ['axb', 'plain']);
  const older = (await h.call('GET', P(m) + '?limit=2&before=' + encodeURIComponent(all[0].createdAt), m.bo)).body.messages; assert.deepEqual(older.map((x) => x.body), ['100% sure', 'a_b']);
  assert.equal((await h.call('GET', P(m) + '?before=garbage', m.bo)).status, 400);
  await h.close();
});

test('GIFs: off by default; when on, results and posts are limited to GIPHY https URLs', async () => {
  const off = await harness(); const m0 = await off.meeting();
  assert.equal((await off.call('GET', P(m0, '/gifs/search?q=cat'), m0.ann)).status, 404); assert.equal((await off.call('POST', P(m0), m0.ann, { kind: 'gif', body: 'https://media.giphy.com/media/x/giphy.gif' })).status, 404); await off.close();
  let asked = null;
  const fetchImpl = async (url) => { asked = url; return { ok: true, json: async () => ({ data: [
    { id: '1', title: 'cat', images: { fixed_height: { url: 'https://media1.giphy.com/media/abc/200.gif' }, fixed_width_small: { url: 'https://media1.giphy.com/media/abc/100w.gif' } } },
    { id: '2', title: 'evil', images: { fixed_height: { url: 'https://evil.example/x.gif' }, fixed_width_small: { url: 'https://media1.giphy.com/media/abc/100w.gif' } } },
  ] }) }; };
  const on = await harness({ giphyKey: 'k3y', fetchImpl }); const m = await on.meeting();
  assert.deepEqual((await on.call('GET', P(m), m.ann)).body.features, { gif: true, attachments: false });
  const s = await on.call('GET', P(m, '/gifs/search?q=cat'), m.ann); assert.equal(s.status, 200); assert.equal(s.body.gifs.length, 1); assert.equal(s.body.gifs[0].id, '1'); assert.ok(asked.includes('api_key=k3y') && asked.includes('rating=g'));
  assert.equal((await on.call('GET', P(m, '/gifs/search?q=cat'), m.ann)).status, 429);                                        // one search per 0.7 s per person
  assert.equal((await on.call('POST', P(m), m.ann, { kind: 'gif', body: 'https://media.giphy.com/media/xyz/giphy.gif' })).status, 201);
  for (const bad of ['http://media.giphy.com/media/x.gif', 'https://evil.example/x.gif', 'https://media.giphy.com.evil.example/x.gif', 'https://media.giphy.com/x.gif"onerror="1', 'javascript:alert(1)'])
    assert.equal((await on.call('POST', P(m), m.bo, { kind: 'gif', body: bad })).status, 400, bad);
  assert.ok(!JSON.stringify(s.body).includes('k3y'));                                                                          // the key never reaches the page
  await on.close();
});

test('attachments: off by default; when on, type by bytes, size limit, per-meeting download, one message per file', async () => {
  const off = await harness(); const m0 = await off.meeting(); assert.equal((await off.call('POST', P(m0, '/attachments'), m0.ann, Buffer.from('x'), { 'Content-Type': 'application/octet-stream' })).status, 404); await off.close();
  const on = await harness({ attachmentsEnabled: true }); const m = await on.meeting(), other = await on.meeting(); const bin = { 'Content-Type': 'application/octet-stream' };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const up = await on.call('POST', P(m, '/attachments'), m.ann, png, { ...bin, 'x-file-name': encodeURIComponent('../../etc/pass wd.png') });
  assert.equal(up.status, 201); assert.equal(up.body.type, 'image/png'); assert.ok(!up.body.name.includes('/') && !up.body.name.includes('..'.repeat(2)));
  assert.equal((await on.call('POST', P(m, '/attachments'), m.ann, Buffer.concat([Buffer.from('MZ'), Buffer.from([0x90, 0, 3, 0]), Buffer.alloc(50)]), bin)).status, 415);     // a Windows program (has NUL bytes, no allowed signature)
  assert.equal((await on.call('POST', P(m, '/attachments'), m.ann, Buffer.from('<html><script>alert(1)</script></html>'), bin)).status, 201);                                    // text is allowed but is always sent back as a download with a fixed type
  assert.equal((await on.call('POST', P(m, '/attachments'), m.ann, Buffer.alloc(11 * 1024 * 1024, 65), bin)).status, 413);
  assert.equal((await on.call('POST', P(m, '/attachments'), m.waiting, png, bin)).status, 403);
  const msg = await on.call('POST', P(m), m.ann, { kind: 'file', attachmentId: up.body.attachmentId }); assert.equal(msg.status, 201); assert.equal(msg.body.attachment.type, 'image/png');
  assert.equal((await on.call('POST', P(m), m.ann, { kind: 'file', attachmentId: up.body.attachmentId })).status, 400);        // one message per file
  const other1 = await on.call('POST', P(m, '/attachments'), m.ann, png, bin);
  assert.equal((await on.call('POST', P(m), m.bo, { kind: 'file', attachmentId: other1.body.attachmentId })).status, 400);     // somebody else's upload
  const dl = await on.call('GET', P(m, '/attachments/' + up.body.attachmentId), m.bo); assert.equal(dl.status, 200); assert.deepEqual(dl.body, png);
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="/); assert.equal(dl.headers.get('x-content-type-options'), 'nosniff'); assert.equal(dl.headers.get('content-type'), 'image/png');
  assert.equal((await on.call('GET', P(other, '/attachments/' + up.body.attachmentId), other.ann)).status, 404);               // the same id through another meeting
  assert.equal((await on.call('GET', P(m, '/attachments/' + up.body.attachmentId), m.waiting)).status, 403);
  await on.close();
});

test('chat.post (the socket path) validates the same way', async () => {
  const h = await harness(); const m = await h.meeting();
  const ok = await h.chat.post({ meetingId: m.mid, participantId: m.ids.ann, body: 'hi', rich: '<b>hi</b>', replyTo: null }); assert.equal(ok.rich, '<b>hi</b>'); assert.equal(ok.name, 'Ann');
  await assert.rejects(h.chat.post({ meetingId: m.mid, participantId: m.ids.ann, body: '' }), /Empty/);
  await assert.rejects(h.chat.post({ meetingId: m.mid, participantId: m.ids.ann, body: 'x', kind: 'file', attachmentId: randomUUID() }), /not enabled/);
  await h.close();
});

// ---------------------------------------------------------------- v4.26: policy, private conversations, delete, Save chat, idempotency
const setPolicy = (h, m, policy) => h.call('PUT', P(m, '/policy'), m.host, { policy });
const dm = (h, m, user, ...recipients) => h.call('POST', P(m, '/conversations'), user, { recipients });

test('the host chat policy: default keeps the old behavior; only the host changes it; it is enforced on every send', async () => {
  const h = await harness(); const m = await h.meeting();
  assert.equal((await h.call('GET', P(m, '/policy'), m.ann)).body.policy, 'group'); assert.equal((await h.call('GET', P(m, '/policy'), m.ann)).body.canManage, false); assert.equal((await h.call('GET', P(m, '/policy'), m.host)).body.canManage, true);
  assert.equal((await h.call('PUT', P(m, '/policy'), m.ann, { policy: 'all' })).status, 403); assert.equal((await setPolicy(h, m, 'everything')).status, 400);
  // group (default): Everyone yes, private no
  assert.equal((await h.call('POST', P(m), m.ann, { body: 'hi all' })).status, 201); assert.equal((await dm(h, m, m.ann, m.ids.bo)).status, 403);
  // none: guests are silent, the host is not
  assert.equal((await setPolicy(h, m, 'none')).status, 200); assert.ok(reachedAll(h, m, (e) => e.type === 'chat-policy' && e.payload.policy === 'none'));
  const refused = await h.call('POST', P(m), m.ann, { body: 'hello?' }); assert.equal(refused.status, 403); assert.match(refused.body.error, /turned chat off/);
  assert.equal((await h.call('POST', P(m), m.host, { body: 'host can still talk' })).status, 201);
  // hosts: guests may chat privately with the host only
  await setPolicy(h, m, 'hosts');
  assert.equal((await h.call('POST', P(m), m.ann, { body: 'everyone?' })).status, 403);
  assert.equal((await dm(h, m, m.ann, m.ids.bo)).status, 403);
  const toHost = await dm(h, m, m.ann, m.ids.host); assert.equal(toHost.status, 201);
  assert.equal((await h.call('POST', P(m), m.ann, { body: 'question for the host', conversationId: toHost.body.id })).status, 201);
  // all: private chats with anyone
  await setPolicy(h, m, 'all'); assert.equal((await dm(h, m, m.ann, m.ids.bo)).status, 201);
  await h.close();
});

test('a private conversation is visible to its members only: reads, live events, tasks, search, export', async () => {
  const h = await harness(); const m = await h.meeting(); await setPolicy(h, m, 'all');
  const c = (await dm(h, m, m.ann, m.ids.bo)).body; assert.equal(c.members.length, 2);
  const secret = (await h.call('POST', P(m), m.bo, { body: 'private words', conversationId: c.id })).body; assert.equal(secret.conversationId, c.id);
  // the events went to the two members' sockets and NOT to the meeting room
  const ev = h.events.filter((e) => e.type === 'chat' && e.payload.id === secret.id); assert.deepEqual(ev.map((e) => e.target).sort(), ['sock:' + m.ids.ann, 'sock:' + m.ids.bo].sort());
  assert.ok(!h.events.some((e) => e.target === 'sock:' + m.ids.host && JSON.stringify(e.payload).includes('private words')));
  assert.ok(h.events.some((e) => e.type === 'chat-conversation' && e.target === 'sock:' + m.ids.ann)); assert.ok(!h.events.some((e) => e.type === 'chat-conversation' && e.target === 'sock:' + m.ids.host));
  // the host, who is not in it, cannot see it in any way
  assert.equal((await h.call('GET', P(m) + '?conversation=' + c.id, m.host)).status, 404);
  assert.equal((await h.call('POST', P(m), m.host, { body: 'x', conversationId: c.id })).status, 404);
  assert.equal((await h.call('GET', P(m, '/export') + '?conversation=' + c.id, m.host)).status, 404);
  for (const [method, suffix] of [['PATCH', ''], ['DELETE', ''], ['PUT', '/bookmark'], ['POST', '/tasks']]) assert.equal((await h.call(method, P(m, '/' + secret.id + suffix), m.host, { body: 'x', title: 'x' })).status, 404, method + suffix);
  assert.deepEqual((await h.call('GET', P(m, '/conversations'), m.host)).body.conversations.map((x) => x.id), ['everyone']);
  assert.deepEqual((await h.call('GET', P(m, '/conversations'), m.ann)).body.conversations.map((x) => x.id), ['everyone', c.id]);
  // Everyone never contains it (list, search)
  assert.deepEqual((await h.call('GET', P(m), m.host)).body.messages, []); assert.deepEqual((await h.call('GET', P(m) + '?q=private', m.host)).body.messages, []);
  assert.equal((await h.call('GET', P(m) + '?conversation=' + c.id, m.ann)).body.messages.length, 1);
  // a task on it is private too (event and list); the assignee must be a member
  assert.equal((await h.call('POST', P(m, '/' + secret.id + '/tasks'), m.ann, { title: 'x', assigneeId: m.ids.host })).status, 400);
  const t = await h.call('POST', P(m, '/' + secret.id + '/tasks'), m.ann, { title: 'follow up', assigneeId: m.ids.bo }); assert.equal(t.status, 201);
  assert.ok(!h.events.some((e) => e.type === 'chat-task' && e.target === 'sock:' + m.ids.host)); assert.equal((await h.call('GET', P(m, '/tasks/list'), m.host)).body.tasks.length, 0); assert.equal((await h.call('GET', P(m, '/tasks/list'), m.bo)).body.tasks.length, 1);
  // pins are for Everyone only; replies stay inside their conversation
  assert.equal((await h.call('PUT', P(m, '/' + secret.id + '/pin'), m.host)).status, 404); const every = (await h.call('POST', P(m), m.ann, { body: 'public' })).body;
  assert.equal((await h.call('POST', P(m), m.ann, { body: 'cross', conversationId: c.id, replyTo: every.id })).status, 404);
  // the same set of people is ONE conversation, whoever starts it
  const again = await dm(h, m, m.bo, m.ids.ann); assert.equal(again.status, 200); assert.equal(again.body.id, c.id);
  assert.equal((await dm(h, m, m.ann, m.ids.ann)).status, 400); assert.equal((await dm(h, m, m.ann, m.ids.waiting)).status, 400); assert.equal((await dm(h, m, m.ann, 'nope')).status, 400);
  await h.close();
});

test('delete: author or host; the text really leaves the database; everybody who could see it is told', async () => {
  const h = await harness(); const m = await h.meeting(); await setPolicy(h, m, 'all');
  const mine = (await h.call('POST', P(m), m.ann, { body: 'oops wrong chat' })).body, other = (await h.call('POST', P(m), m.bo, { body: 'bo says' })).body;
  assert.equal((await h.call('DELETE', P(m, '/' + other.id), m.ann)).status, 403);                                               // a guest cannot delete somebody else's message
  assert.equal((await h.call('DELETE', P(m, '/' + mine.id), m.ann)).status, 200);
  const { rows } = await pool.query('SELECT body, body_rich, deleted_at FROM messages WHERE id=$1', [mine.id]); assert.equal(rows[0].body, ''); assert.equal(rows[0].body_rich, null); assert.ok(rows[0].deleted_at);
  assert.ok(reachedAll(h, m, (e) => e.type === 'chat-delete' && e.payload.id === mine.id));
  const listed = (await h.call('GET', P(m), m.bo)).body.messages.find((x) => x.id === mine.id); assert.equal(listed.deleted, true); assert.equal(listed.body, '');
  assert.equal((await h.call('PATCH', P(m, '/' + mine.id), m.ann, { body: 'revive' })).status, 404); assert.equal((await h.call('PUT', P(m, '/' + mine.id + '/bookmark'), m.bo)).status, 404);
  assert.equal((await h.call('DELETE', P(m, '/' + other.id), m.host)).status, 200);                                                // the host moderates Everyone
  assert.equal((await h.call('DELETE', P(m, '/' + other.id), m.host)).status, 200);                                                // idempotent
  assert.deepEqual((await h.call('GET', P(m) + '?q=oops', m.bo)).body.messages, []);
  const c = (await dm(h, m, m.ann, m.ids.bo)).body; const d = (await h.call('POST', P(m), m.ann, { body: 'dm text', conversationId: c.id })).body;
  assert.equal((await h.call('DELETE', P(m, '/' + d.id), m.host)).status, 404);                                                   // the host cannot even reach a private message
  assert.equal((await h.call('DELETE', P(m, '/' + d.id), m.bo)).status, 403); assert.equal((await h.call('DELETE', P(m, '/' + d.id), m.ann)).status, 200);
  assert.deepEqual(h.events.filter((e) => e.type === 'chat-delete' && e.payload.id === d.id).map((e) => e.target).sort(), ['sock:' + m.ids.ann, 'sock:' + m.ids.bo].sort());
  await h.close();
});

test('Save chat exports only what that person may see, as a download, without deleted messages', async () => {
  const h = await harness(); const m = await h.meeting(); await setPolicy(h, m, 'all');
  await h.call('POST', P(m), m.ann, { body: 'first' }); const gone = (await h.call('POST', P(m), m.bo, { body: 'removed one' })).body; await h.call('POST', P(m), m.bo, { rich: '<b>second</b>' });
  await h.call('DELETE', P(m, '/' + gone.id), m.bo);
  const c = (await dm(h, m, m.ann, m.ids.bo)).body; await h.call('POST', P(m), m.ann, { body: 'private note', conversationId: c.id });
  const all = await h.call('GET', P(m, '/export'), m.host); assert.equal(all.status, 200); const t = all.body.toString('utf8');
  assert.match(all.headers.get('content-disposition'), /^attachment; filename="qorlla-chat-\d{4}-\d{2}-\d{2}\.txt"$/); assert.match(all.headers.get('content-type'), /^text\/plain/);
  assert.ok(t.includes('Ann: first') && t.includes('Bo: second')); assert.ok(!t.includes('removed one') && !t.includes('private note') && !t.includes('<b>'));
  const priv = (await h.call('GET', P(m, '/export') + '?conversation=' + c.id, m.bo)).body.toString('utf8'); assert.ok(priv.includes('Ann: private note') && priv.includes('Private chat with Ann') && !priv.includes('first'));
  assert.equal((await h.call('GET', P(m, '/export') + '?conversation=' + c.id, m.host)).status, 404); assert.equal((await h.call('GET', P(m, '/export'), m.waiting)).status, 403);
  await h.close();
});

test('idempotent sends: a retry with the same key returns the same message and announces nothing twice', async () => {
  const h = await harness(); const m = await h.meeting(); const key = randomUUID();
  const a = await h.call('POST', P(m), m.ann, { body: 'once', idempotencyKey: key }); const b = await h.call('POST', P(m), m.ann, { body: 'once', idempotencyKey: key });
  assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(a.body.id, b.body.id);
  assert.equal(Number((await pool.query('SELECT count(*) FROM messages WHERE meeting_id=$1', [m.mid])).rows[0].count), 1); assert.equal(h.events.filter((e) => e.type === 'chat' && e.target === 'sock:' + m.ids.ann).length, 1);
  const race = await Promise.all([1, 2, 3, 4].map(() => h.call('POST', P(m), m.bo, { body: 'race', idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })));
  assert.equal(new Set(race.map((r) => r.body.id)).size, 1); assert.equal((await h.call('POST', P(m), m.ann, { body: 'x', idempotencyKey: 'bad' })).status, 400);
  await h.close();
});

test('attachments in a private conversation are reachable only by its members', async () => {
  const h = await harness({ attachmentsEnabled: true }); const m = await h.meeting(); await setPolicy(h, m, 'all'); const bin = { 'Content-Type': 'application/octet-stream' };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
  const c = (await dm(h, m, m.ann, m.ids.bo)).body; const up = (await h.call('POST', P(m, '/attachments'), m.ann, png, bin)).body;
  assert.equal((await h.call('GET', P(m, '/attachments/' + up.attachmentId), m.bo)).status, 404);                              // not posted yet: only the uploader
  assert.equal((await h.call('GET', P(m, '/attachments/' + up.attachmentId), m.ann)).status, 200);
  assert.equal((await h.call('POST', P(m), m.ann, { kind: 'file', attachmentId: up.attachmentId, conversationId: c.id })).status, 201);
  assert.equal((await h.call('GET', P(m, '/attachments/' + up.attachmentId), m.bo)).status, 200); assert.equal((await h.call('GET', P(m, '/attachments/' + up.attachmentId), m.host)).status, 404);
  await h.close();
});

test('a person whose admission was withdrawn stops receiving chat at once and cannot read or post with their token', async () => {
  const h = await harness(); const m = await h.meeting(); await setPolicy(h, m, 'all');
  const c = (await dm(h, m, m.ann, m.ids.bo)).body;
  await h.call('POST', P(m), m.host, { body: 'before' }); assert.ok(h.events.some((e) => e.type === 'chat' && e.target === 'sock:' + m.ids.bo && e.payload.body === 'before'));
  await pool.query("UPDATE participants SET admission='denied' WHERE id=$1", [m.ids.bo]);                       // what the Shield session guard / the host removing somebody writes
  h.events.length = 0;
  await h.call('POST', P(m), m.host, { body: 'after removal' }); await h.call('POST', P(m), m.ann, { body: 'private after removal', conversationId: c.id });
  await h.call('PUT', P(m, '/policy'), m.host, { policy: 'group' });
  assert.ok(!h.events.some((e) => e.target === 'sock:' + m.ids.bo), 'nothing may reach the removed person: ' + JSON.stringify(h.events.filter((e) => e.target === 'sock:' + m.ids.bo)));
  assert.ok(h.events.some((e) => e.target === 'sock:' + m.ids.ann && e.payload.body === 'after removal'));       // everybody else is unaffected
  for (const [method, path, body] of [['GET', P(m), undefined], ['POST', P(m), { body: 'x' }], ['GET', P(m, '/conversations'), undefined], ['GET', P(m, '/export'), undefined], ['GET', P(m, '/policy'), undefined], ['GET', P(m, '/tasks/list'), undefined]])
    assert.equal((await h.call(method, path, m.bo, body)).status, 403, method + ' ' + path);                    // their token no longer reads, posts or exports anything
  await h.close();
});

test('"who can see your messages": the audience comes from the server; no cloud-storage connector routes exist', async () => {
  const h = await harness(); const m = await h.meeting(); await setPolicy(h, m, 'all');
  const everyone = (await h.call('GET', P(m, '/audience'), m.ann)).body; assert.deepEqual(everyone, { kind: 'everyone', count: 3 });            // host, Ann, Bo (the waiting person is not counted)
  const c = (await dm(h, m, m.ann, m.ids.bo)).body;
  const direct = (await h.call('GET', P(m, '/audience') + '?conversation=' + c.id, m.ann)).body; assert.equal(direct.kind, 'direct'); assert.deepEqual(direct.members.map((x) => x.name).sort(), ['Ann', 'Bo']);
  assert.equal((await h.call('GET', P(m, '/audience') + '?conversation=' + c.id, m.host)).status, 404);                                             // the host is not in it: it does not exist for them
  assert.equal((await h.call('GET', P(m, '/audience'), m.waiting)).status, 403);
  // there is no connector code in this repo, so none of these routes may exist (the page shows those sources as disabled)
  for (const src of ['dropbox', 'onedrive', 'google-drive', 'box', 'sharepoint', 'cloud', 'connectors', 'oauth']) {
    for (const path of [P(m, '/' + src), P(m, '/cloud/' + src), P(m, '/attachments/' + src + '/authorize'), `/api/meetings/${m.mid}/${src}`]) assert.ok([404, 403].includes((await h.call('GET', path, m.ann)).status), path);
  }
  await h.close();
});

test('GIF search talks to the configured GIPHY address only, with the key on the server', async () => {
  let asked = null;
  const fetchImpl = async (url) => { asked = url; return { ok: true, json: async () => ({ data: [{ id: '1', title: 't', images: { fixed_height: { url: 'https://media1.giphy.com/media/a/200.gif' }, fixed_width_small: { url: 'https://media1.giphy.com/media/a/100w.gif' } } }] }) }; };
  const h = await harness({ giphyKey: 'k', fetchImpl, giphyBase: 'http://127.0.0.1:9' }); const m = await h.meeting();
  assert.equal((await h.call('GET', P(m, '/gifs/search?q=cat'), m.ann)).status, 200); assert.ok(asked.startsWith('http://127.0.0.1:9/v1/gifs/search?api_key=k')); await h.close();
});
