// Meeting chat (v4.25 + v4.26): replies, quotes, editing, delete, rich text, bookmarks, pins, tasks, search, private (direct) conversations, the host's chat policy, Save chat,
// and optional GIFs / file attachments.
//
// Identity and permission come ONLY from the verified Meet token (`auth`) and the admitted-participant check (`member`); nothing here trusts a user id sent by the page.
// Conversations: a message with conversation_id NULL is "Everyone" (the meeting group chat); otherwise it belongs to a private conversation whose members are the only people
// who can read it, receive its live events, export it, or act on it. Meet has two roles (host, guest), so "host and co-hosts" in the policy means the host.
// Host policy (meetings.chat_policy): none = participants cannot chat; hosts = participants may chat privately with the host only; group = Everyone only (the default, which is
// how chat behaved before); all = Everyone and private chats with anyone. The host is never restricted by the policy.
// `messages.body` stays PLAIN TEXT (AI summary, integration export, old pages); `body_rich` holds the canonical sanitized markup (public/chat-markup.js).
// Optional features are OFF unless configured: GIFs need GIPHY_API_KEY (proxied: the key stays on the server); attachments need CHAT_ATTACHMENTS_ENABLED=true (no malware
// scanner is built in: see docs/MEET_CHAT_UPGRADE.md before switching it on).
import { randomUUID } from 'node:crypto';
import { mkdirSync, createReadStream, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import express from 'express';
import { sanitize, toPlain, hasMarkup } from './chat-markup.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GIF_URL = /^https:\/\/(?:media\d*|i)\.giphy\.com\/[A-Za-z0-9_\-./]{1,200}$/;
const MAX_FILE = 10 * 1024 * 1024, MAX_RECIPIENTS = 20;
export const POLICIES = Object.freeze(['none', 'hosts', 'group', 'all']);
// content type is decided by the BYTES, never by what the page claims
const SNIFF = [
  ['image/png', (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/webp', (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'],
  ['application/pdf', (b) => b.length > 5 && b.toString('latin1', 0, 5) === '%PDF-'],
  ['text/plain', (b) => b.length > 0 && !b.subarray(0, Math.min(b.length, 4096)).includes(0)],
];
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'txt' };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const cleanText = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '').trim().slice(0, max) : '');
const cleanName = (s) => cleanText(String(s || 'file').split(/[\\/]/).pop(), 120).replace(/[^\w.\- ()À-ɏ]/g, '_') || 'file';

export function registerChat({ app, io, db, auth, member, room, fail, socketOf = () => null, giphyKey = process.env.GIPHY_API_KEY || '', attachmentsEnabled = process.env.CHAT_ATTACHMENTS_ENABLED === 'true',
  attachmentsDir = process.env.CHAT_ATTACHMENTS_DIR || resolve('data', 'chat-attachments'), fetchImpl = globalThis.fetch }) {
  const features = Object.freeze({ gif: !!giphyKey, attachments: !!attachmentsEnabled });
  if (attachmentsEnabled) mkdirSync(attachmentsDir, { recursive: true });
  const PATHS = (suffix) => [`/api/meetings/:id/chat${suffix}`, `/api/v1/meetings/:id/chat${suffix}`];
  const handle = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
      console.error('[chat]', e.message); if (!res.headersSent) res.status(500).json({ error: 'Chat is unavailable' });
    }
  };
  const ensureUuid = (v, what = 'id') => { if (typeof v !== 'string' || !UUID.test(v)) throw new HttpError(400, 'Invalid ' + what); return v; };
  const hostOnly = (req, res, next) => (req.user.role === 'host' ? next() : fail(res, 403, 'Only the host can do this'));

  // ---------- conversations and who may do what
  const policyOf = async (meetingId) => (await db.query('SELECT chat_policy FROM meetings WHERE id=$1', [meetingId])).rows[0]?.chat_policy || 'group';
  /** cid null / 'everyone' -> the group chat; otherwise a private conversation the person belongs to (404 if not: a conversation you are not in does not exist for you). */
  async function conversationOf(meetingId, cid, participantId) {
    if (cid == null || cid === '' || cid === 'everyone') return { id: null, kind: 'everyone', members: null };
    ensureUuid(cid, 'conversation');
    const { rows } = await db.query(`SELECT c.id, cm.participant_id, p.role, p.display_name FROM chat_conversations c
      JOIN chat_members cm ON cm.conversation_id = c.id JOIN participants p ON p.id = cm.participant_id WHERE c.id = $1 AND c.meeting_id = $2`, [cid, meetingId]);
    if (!rows.length || !rows.some((r) => r.participant_id === participantId)) throw new HttpError(404, 'Conversation not found');
    return { id: cid, kind: 'direct', members: rows.map((r) => ({ id: r.participant_id, role: r.role, name: r.display_name })) };
  }
  /** may this person post in that conversation under the host's policy? (the host is never restricted; the conversation membership was already checked) */
  function mayPost(role, policy, conv) {
    if (role === 'host') return true;
    if (policy === 'none') return false;
    if (policy === 'all') return true;
    if (policy === 'group') return conv.id === null;
    if (policy === 'hosts') return conv.id !== null && conv.members.some((m) => m.role === 'host');
    return false;
  }
  const refusal = (policy) => ({ none: 'The host has turned chat off for participants', hosts: 'The host allows participants to chat privately with the host only', group: 'The host allows participants to chat in Everyone only', all: '' }[policy] || 'Chat is not allowed');
  /** deliver an event to exactly the people who may see the conversation AND are admitted right now. Delivery is per socket (never a room broadcast), so a person whose
   *  admission was withdrawn stops receiving chat at once, even if their socket has not been closed yet. */
  const EVERYONE = Object.freeze({ id: null, members: null });
  async function emitTo(meetingId, conv, type, payload) {
    const ids = conv.id === null ? null : conv.members.map((m) => m.id);
    const { rows } = await db.query("SELECT id FROM participants WHERE meeting_id=$1 AND admission='admitted'" + (ids ? ' AND id = ANY($2::uuid[])' : ''), ids ? [meetingId, ids] : [meetingId]);
    for (const r of rows) { const sid = socketOf(meetingId, r.id); if (sid) io.to(sid).emit(type, payload); }
  }

  const SELECT = `SELECT m.id, m.participant_id, p.display_name AS name, m.body, m.body_rich, m.kind, m.reply_to, m.edited_at, m.created_at, m.attachment_id, m.conversation_id, m.deleted_at,
      r.body AS reply_body, rp.display_name AS reply_name,
      a.file_name AS att_name, a.content_type AS att_type, a.size_bytes AS att_size,
      EXISTS(SELECT 1 FROM chat_pins cp WHERE cp.message_id = m.id) AS pinned,
      EXISTS(SELECT 1 FROM chat_bookmarks b WHERE b.message_id = m.id AND b.participant_id = $2) AS bookmarked
    FROM messages m JOIN participants p ON p.id = m.participant_id
    LEFT JOIN messages r ON r.id = m.reply_to AND r.deleted_at IS NULL LEFT JOIN participants rp ON rp.id = r.participant_id
    LEFT JOIN chat_attachments a ON a.id = m.attachment_id AND m.deleted_at IS NULL`;
  const shape = (r) => ({
    id: r.id, participantId: r.participant_id, name: r.name, conversationId: r.conversation_id || null,
    deleted: !!r.deleted_at, body: r.deleted_at ? '' : r.body, rich: r.deleted_at ? null : (r.body_rich || null), kind: r.kind,
    replyTo: r.reply_to && r.reply_body != null ? { id: r.reply_to, name: r.reply_name || '', text: (r.reply_body || '').slice(0, 160) } : null,
    editedAt: r.edited_at || null, createdAt: r.created_at, created_at: r.created_at,          // created_at: what older pages read
    pinned: !!r.pinned, bookmarked: !!r.bookmarked,
    attachment: r.attachment_id && !r.deleted_at ? { id: r.attachment_id, name: r.att_name, type: r.att_type, size: Number(r.att_size) } : null,
  });
  async function one(meetingId, mid, viewerId) {
    const { rows } = await db.query(`${SELECT} WHERE m.id = $1 AND m.meeting_id = $3`, [mid, viewerId, meetingId]); return rows[0] ? shape(rows[0]) : null;
  }
  /** a message the person is allowed to see (their conversation or Everyone), or 404 */
  async function visibleMessage(meetingId, mid, pid) {
    ensureUuid(mid, 'message');
    const { rows: [m] } = await db.query(`SELECT m.id, m.participant_id, m.kind, m.conversation_id, m.deleted_at FROM messages m WHERE m.id = $1 AND m.meeting_id = $2
      AND (m.conversation_id IS NULL OR EXISTS (SELECT 1 FROM chat_members cm WHERE cm.conversation_id = m.conversation_id AND cm.participant_id = $3))`, [mid, meetingId, pid]);
    if (!m) throw new HttpError(404, 'Message not found'); return m;
  }
  const convOfMessage = (meetingId, m, pid) => conversationOf(meetingId, m.conversation_id, pid);

  /** validates and stores one message; used by the socket event and the REST route. Returns the stored message. */
  async function post({ meetingId, participantId, role, body, rich, kind = 'text', replyTo = null, attachmentId = null, conversationId = null, idempotencyKey = null }) {
    if (!['text', 'gif', 'file'].includes(kind)) throw new HttpError(400, 'Invalid message');
    if (idempotencyKey != null) ensureUuid(idempotencyKey, 'idempotency key');
    const conv = await conversationOf(meetingId, conversationId, participantId);
    const policy = await policyOf(meetingId);
    if (!mayPost(role, policy, conv)) throw new HttpError(403, refusal(policy));
    if (idempotencyKey) { const { rows } = await db.query('SELECT id FROM messages WHERE participant_id=$1 AND idempotency_key=$2', [participantId, idempotencyKey]); if (rows[0]) return { ...(await one(meetingId, rows[0].id, participantId)), duplicate: true }; }
    let plain = '', canon = null;
    if (kind === 'text') {
      if (rich != null) { canon = sanitize(String(rich)); if (canon === null) throw new HttpError(400, 'Message is too long'); plain = toPlain(canon); if (!hasMarkup(canon)) canon = null; }
      else plain = cleanText(body, 4000);
      plain = plain.slice(0, 4000);
      if (!plain) throw new HttpError(400, 'Empty message');
      if (canon && canon.length > 8000) throw new HttpError(400, 'Message is too long');
    } else if (kind === 'gif') {
      if (!features.gif) throw new HttpError(404, 'GIFs are not enabled');
      plain = typeof body === 'string' ? body.trim() : ''; if (!GIF_URL.test(plain)) throw new HttpError(400, 'Invalid GIF');
    } else {
      if (!features.attachments) throw new HttpError(404, 'Attachments are not enabled');
      ensureUuid(attachmentId, 'attachment');
      const { rows } = await db.query('SELECT file_name FROM chat_attachments a WHERE a.id=$1 AND a.meeting_id=$2 AND a.uploader_id=$3 AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.attachment_id=a.id)', [attachmentId, meetingId, participantId]);
      if (!rows.length) throw new HttpError(400, 'Invalid attachment'); plain = rows[0].file_name;
    }
    if (replyTo != null) {
      ensureUuid(replyTo, 'reply target');
      const { rowCount } = await db.query('SELECT 1 FROM messages WHERE id=$1 AND meeting_id=$2 AND deleted_at IS NULL AND conversation_id IS NOT DISTINCT FROM $3', [replyTo, meetingId, conv.id]);
      if (!rowCount) throw new HttpError(404, 'The message you are replying to is gone');
    }
    const mid = randomUUID();
    const ins = await db.query('INSERT INTO messages(id, meeting_id, participant_id, body, body_rich, kind, reply_to, attachment_id, conversation_id, idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id',
      [mid, meetingId, participantId, plain, canon, kind, replyTo, kind === 'file' ? attachmentId : null, conv.id, idempotencyKey]);
    if (!ins.rowCount) { const { rows } = await db.query('SELECT id FROM messages WHERE participant_id=$1 AND idempotency_key=$2', [participantId, idempotencyKey]); return { ...(await one(meetingId, rows[0].id, participantId)), duplicate: true }; }
    return one(meetingId, mid, participantId);
  }
  /** send a stored message to the people who may see it (never to anybody else) */
  async function deliver(meetingId, msg) {
    if (msg.duplicate) return;
    await emitTo(meetingId, await conversationOf(meetingId, msg.conversationId, msg.participantId), 'chat', { ...msg, bookmarked: false });
  }

  // ---------- policy
  app.get(PATHS('/policy'), auth, member, handle(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ policy: await policyOf(req.params.id), canManage: req.user.role === 'host', policies: POLICIES }); }));
  app.put(PATHS('/policy'), auth, member, hostOnly, handle(async (req, res) => {
    const p = req.body?.policy; if (!POLICIES.includes(p)) throw new HttpError(400, 'Invalid policy');
    await db.query('UPDATE meetings SET chat_policy=$1 WHERE id=$2', [p, req.params.id]);
    await emitTo(req.params.id, EVERYONE, 'chat-policy', { policy: p }); res.json({ policy: p, canManage: true });
  }));

  // ---------- conversations
  const convShape = (c, members) => ({ id: c.id, kind: 'direct', createdBy: c.created_by, members });
  app.get(PATHS('/conversations'), auth, member, handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { rows } = await db.query(`SELECT c.id, c.created_by, c.created_at, json_agg(json_build_object('id', p.id, 'name', p.display_name, 'role', p.role) ORDER BY p.display_name) AS members
      FROM chat_conversations c JOIN chat_members cm ON cm.conversation_id = c.id JOIN participants p ON p.id = cm.participant_id
      WHERE c.meeting_id = $1 AND EXISTS (SELECT 1 FROM chat_members me WHERE me.conversation_id = c.id AND me.participant_id = $2) GROUP BY c.id ORDER BY c.created_at`, [req.params.id, req.user.participantId]);
    res.json({ conversations: [{ id: 'everyone', kind: 'everyone', members: [] }, ...rows.map((r) => convShape(r, r.members))], policy: await policyOf(req.params.id) });
  }));
  app.post(PATHS('/conversations'), auth, member, handle(async (req, res) => {
    const me = req.user.participantId, policy = await policyOf(req.params.id);
    let rec = req.body?.recipients; if (!Array.isArray(rec) || !rec.length || rec.length > MAX_RECIPIENTS) throw new HttpError(400, 'Choose 1 to ' + MAX_RECIPIENTS + ' people');
    rec = [...new Set(rec.map((r) => ensureUuid(r, 'recipient')))].filter((r) => r !== me); if (!rec.length) throw new HttpError(400, 'Choose someone other than yourself');
    const { rows: people } = await db.query("SELECT id, role, display_name FROM participants WHERE meeting_id=$1 AND admission='admitted' AND id = ANY($2::uuid[])", [req.params.id, rec]);
    if (people.length !== rec.length) throw new HttpError(400, 'Everybody you choose must be in this meeting');
    if (req.user.role !== 'host') {
      if (policy === 'none' || policy === 'group') throw new HttpError(403, refusal(policy));
      if (policy === 'hosts' && !people.every((x) => x.role === 'host')) throw new HttpError(403, refusal(policy));
    }
    const ids = [me, ...rec].sort(), key = ids.join(',');
    let { rows: [c] } = await db.query('SELECT id, created_by FROM chat_conversations WHERE meeting_id=$1 AND member_key=$2', [req.params.id, key]); let created = false;
    if (!c) {
      const cid = randomUUID(); const client = await db.connect();
      try {
        await client.query('BEGIN');
        const ins = await client.query('INSERT INTO chat_conversations(id, meeting_id, created_by, member_key) VALUES($1,$2,$3,$4) ON CONFLICT (meeting_id, member_key) DO NOTHING RETURNING id, created_by', [cid, req.params.id, me, key]);
        if (ins.rowCount) { c = ins.rows[0]; created = true; for (const pid of ids) await client.query('INSERT INTO chat_members(conversation_id, participant_id) VALUES($1,$2)', [cid, pid]); }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
      if (!c) c = (await db.query('SELECT id, created_by FROM chat_conversations WHERE meeting_id=$1 AND member_key=$2', [req.params.id, key])).rows[0];
    }
    const conv = await conversationOf(req.params.id, c.id, me), out = convShape(c, conv.members.map((m) => ({ id: m.id, name: m.name, role: m.role })));
    if (created) await emitTo(req.params.id, conv, 'chat-conversation', out);                      // only its members learn that it exists
    res.status(created ? 201 : 200).json(out);
  }));

  // ---------- messages
  app.get(PATHS(''), auth, member, handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const conv = await conversationOf(req.params.id, req.query.conversation, req.user.participantId);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100)), params = [req.params.id, req.user.participantId];
    let where = 'm.meeting_id = $1', extra = '';
    if (conv.id === null) where += ' AND m.conversation_id IS NULL'; else { params.push(conv.id); where += ` AND m.conversation_id = $${params.length}`; }
    if (req.query.before) { const d = new Date(String(req.query.before)); if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Invalid time'); params.push(d.toISOString()); where += ` AND m.created_at < $${params.length}`; }
    if (typeof req.query.q === 'string' && req.query.q.trim()) { params.push('%' + req.query.q.trim().slice(0, 100).replace(/[\\%_]/g, '\\$&') + '%'); where += ` AND m.deleted_at IS NULL AND m.body ILIKE $${params.length}`; }
    if (req.query.pinned === '1') extra = ' AND EXISTS (SELECT 1 FROM chat_pins cp WHERE cp.message_id = m.id)';
    if (req.query.bookmarked === '1') extra += ' AND EXISTS (SELECT 1 FROM chat_bookmarks b WHERE b.message_id = m.id AND b.participant_id = $2)';
    const { rows } = await db.query(`${SELECT} WHERE ${where}${extra} ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit}`, params);
    res.json({ messages: rows.reverse().map(shape), features, policy: await policyOf(req.params.id), canManage: req.user.role === 'host' });
  }));

  app.post(PATHS(''), auth, member, handle(async (req, res) => {
    const b = req.body || {};
    const msg = await post({ meetingId: req.params.id, participantId: req.user.participantId, role: req.user.role, body: b.body, rich: b.rich, kind: b.kind, replyTo: b.replyTo, attachmentId: b.attachmentId, conversationId: b.conversationId, idempotencyKey: b.idempotencyKey });
    await deliver(req.params.id, msg); res.status(msg.duplicate ? 200 : 201).json(msg);
  }));

  app.patch(PATHS('/:mid'), auth, member, handle(async (req, res) => {
    const m = await visibleMessage(req.params.id, req.params.mid, req.user.participantId);
    if (m.deleted_at) throw new HttpError(404, 'Message not found');
    if (m.participant_id !== req.user.participantId) throw new HttpError(403, 'Only the author can edit a message');
    if (m.kind !== 'text') throw new HttpError(400, 'Only text messages can be edited');
    const b = req.body || {}; let plain, canon = null;
    if (b.rich != null) { canon = sanitize(String(b.rich)); if (canon === null) throw new HttpError(400, 'Message is too long'); plain = toPlain(canon); if (!hasMarkup(canon)) canon = null; } else plain = cleanText(b.body, 4000);
    plain = plain.slice(0, 4000); if (!plain) throw new HttpError(400, 'Empty message');
    await db.query('UPDATE messages SET body=$1, body_rich=$2, edited_at=now() WHERE id=$3', [plain, canon, req.params.mid]);
    const msg = await one(req.params.id, req.params.mid, req.user.participantId);
    await emitTo(req.params.id, await convOfMessage(req.params.id, m, req.user.participantId), 'chat-edit', { id: msg.id, conversationId: msg.conversationId, body: msg.body, rich: msg.rich, editedAt: msg.editedAt }); res.json(msg);
  }));

  // delete = the author, or the host. The text is removed from the database (not just hidden); everybody who could see the message sees "Message deleted".
  app.delete(PATHS('/:mid'), auth, member, handle(async (req, res) => {
    const m = await visibleMessage(req.params.id, req.params.mid, req.user.participantId);
    if (m.participant_id !== req.user.participantId && req.user.role !== 'host') throw new HttpError(403, 'Only the author or the host can delete a message');
    if (!m.deleted_at) {
      await db.query("UPDATE messages SET body='', body_rich=NULL, deleted_at=now() WHERE id=$1", [m.id]);
      await db.query('DELETE FROM chat_pins WHERE message_id=$1', [m.id]); await db.query('DELETE FROM chat_bookmarks WHERE message_id=$1', [m.id]);
      await emitTo(req.params.id, await convOfMessage(req.params.id, m, req.user.participantId), 'chat-delete', { id: m.id, conversationId: m.conversation_id || null });
    }
    res.json({ ok: true, deleted: true });
  }));

  const live = async (req) => { const m = await visibleMessage(req.params.id, req.params.mid, req.user.participantId); if (m.deleted_at) throw new HttpError(404, 'Message not found'); return m; };
  app.put(PATHS('/:mid/bookmark'), auth, member, handle(async (req, res) => {
    await live(req); await db.query('INSERT INTO chat_bookmarks(participant_id, message_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.user.participantId, req.params.mid]); res.json({ ok: true, bookmarked: true });
  }));
  app.delete(PATHS('/:mid/bookmark'), auth, member, handle(async (req, res) => {
    await live(req); await db.query('DELETE FROM chat_bookmarks WHERE participant_id=$1 AND message_id=$2', [req.user.participantId, req.params.mid]); res.json({ ok: true, bookmarked: false });
  }));
  app.put(PATHS('/:mid/pin'), auth, member, hostOnly, handle(async (req, res) => {
    const m = await live(req); if (m.conversation_id) throw new HttpError(400, 'Only messages in Everyone can be pinned');
    await db.query('INSERT INTO chat_pins(message_id, meeting_id, pinned_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [req.params.mid, req.params.id, req.user.participantId]);
    await emitTo(req.params.id, EVERYONE, 'chat-pin', { id: req.params.mid, pinned: true }); res.json({ ok: true, pinned: true });
  }));
  app.delete(PATHS('/:mid/pin'), auth, member, hostOnly, handle(async (req, res) => {
    await visibleMessage(req.params.id, req.params.mid, req.user.participantId); await db.query('DELETE FROM chat_pins WHERE message_id=$1 AND meeting_id=$2', [req.params.mid, req.params.id]);
    await emitTo(req.params.id, EVERYONE, 'chat-pin', { id: req.params.mid, pinned: false }); res.json({ ok: true, pinned: false });
  }));

  app.post(PATHS('/:mid/tasks'), auth, member, handle(async (req, res) => {
    const m = await live(req);
    const b = req.body || {}, title = cleanText(b.title, 250); if (!title) throw new HttpError(400, 'A task needs a title');
    let due = null; if (b.dueDate != null && b.dueDate !== '') { if (typeof b.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate) || Number.isNaN(Date.parse(b.dueDate)) || new Date(b.dueDate + 'T00:00:00Z').toISOString().slice(0, 10) !== b.dueDate) throw new HttpError(400, 'Invalid due date'); due = b.dueDate; }
    const conv = await convOfMessage(req.params.id, m, req.user.participantId);
    let assignee = null; if (b.assigneeId != null && b.assigneeId !== '') {
      ensureUuid(b.assigneeId, 'assignee');
      const ok = conv.id === null ? (await db.query("SELECT 1 FROM participants WHERE id=$1 AND meeting_id=$2 AND admission='admitted'", [b.assigneeId, req.params.id])).rowCount : conv.members.some((x) => x.id === b.assigneeId);
      if (!ok) throw new HttpError(400, 'The assignee cannot see this conversation'); assignee = b.assigneeId;
    }
    const { rows: [t] } = await db.query('INSERT INTO chat_tasks(id, meeting_id, message_id, title, assignee_id, due_date, created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id, title, due_date, created_at',
      [randomUUID(), req.params.id, req.params.mid, title, assignee, due, req.user.participantId]);
    const task = { id: t.id, messageId: req.params.mid, conversationId: conv.id, title: t.title, assigneeId: assignee, dueDate: due, createdBy: req.user.participantId, createdAt: t.created_at };
    await emitTo(req.params.id, conv, 'chat-task', task); res.status(201).json(task);
  }));
  app.get(PATHS('/tasks/list'), auth, member, handle(async (req, res) => {
    const { rows } = await db.query(`SELECT t.id, t.message_id, x.conversation_id, t.title, t.assignee_id, to_char(t.due_date,'YYYY-MM-DD') AS due_date, t.created_by, t.created_at
      FROM chat_tasks t JOIN messages x ON x.id = t.message_id WHERE t.meeting_id=$1 AND x.deleted_at IS NULL
        AND (x.conversation_id IS NULL OR EXISTS (SELECT 1 FROM chat_members cm WHERE cm.conversation_id = x.conversation_id AND cm.participant_id = $2)) ORDER BY t.created_at DESC LIMIT 200`, [req.params.id, req.user.participantId]);
    res.json({ tasks: rows.map((t) => ({ id: t.id, messageId: t.message_id, conversationId: t.conversation_id || null, title: t.title, assigneeId: t.assignee_id, dueDate: t.due_date, createdBy: t.created_by, createdAt: t.created_at })) });
  }));

  // ---------- Save chat: the conversation the person is looking at, as a text file (only what that person may see; deleted messages are left out)
  app.get(PATHS('/export'), auth, member, handle(async (req, res) => {
    const conv = await conversationOf(req.params.id, req.query.conversation, req.user.participantId);
    const { rows: [mt] } = await db.query('SELECT title FROM meetings WHERE id=$1', [req.params.id]);
    const { rows } = await db.query(`SELECT p.display_name AS name, m.body, m.kind, m.created_at FROM messages m JOIN participants p ON p.id = m.participant_id
      WHERE m.meeting_id = $1 AND m.conversation_id IS NOT DISTINCT FROM $2 AND m.deleted_at IS NULL ORDER BY m.created_at, m.id LIMIT 5000`, [req.params.id, conv.id]);
    const title = conv.id === null ? 'Everyone' : 'Private chat with ' + conv.members.filter((x) => x.id !== req.user.participantId).map((x) => x.name).join(', ');
    const text = `${cleanText(mt?.title || 'Meeting', 120)} - ${title}\nSaved ${new Date().toISOString()}\n\n` + rows.map((r) => `[${new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19)}] ${r.name}: ${r.kind === 'gif' ? '[GIF]' : r.kind === 'file' ? '[file] ' + r.body : r.body.replace(/\r?\n/g, '\n    ')}`).join('\n') + '\n';
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Disposition': 'attachment; filename="qorlla-chat-' + new Date().toISOString().slice(0, 10) + '.txt"' });
    res.send(text);
  }));

  // ---- GIF search (server-side proxy; needs GIPHY_API_KEY)
  const gifSeen = new Map();
  app.get(PATHS('/gifs/search'), auth, member, handle(async (req, res) => {
    if (!features.gif) throw new HttpError(404, 'GIFs are not enabled');
    const k = req.user.participantId, now = Date.now(); if (now - (gifSeen.get(k) || 0) < 700) throw new HttpError(429, 'Slow down'); gifSeen.set(k, now); if (gifSeen.size > 5000) gifSeen.clear();
    const q = cleanText(req.query.q, 60); if (!q) return res.json({ gifs: [] });
    const r = await fetchImpl('https://api.giphy.com/v1/gifs/search?api_key=' + encodeURIComponent(giphyKey) + '&q=' + encodeURIComponent(q) + '&limit=12&rating=g', { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!r?.ok) throw new HttpError(503, 'GIF search is unavailable');
    const d = await r.json().catch(() => ({}));
    res.json({ gifs: (d.data || []).map((g) => ({ id: String(g.id).slice(0, 40), title: String(g.title || '').slice(0, 100), url: g.images?.fixed_height?.url, preview: g.images?.fixed_width_small?.url })).filter((g) => GIF_URL.test(g.url || '') && GIF_URL.test(g.preview || '')) });
  }));

  // ---- attachments (off unless CHAT_ATTACHMENTS_ENABLED=true)
  if (attachmentsEnabled) {
    app.post(PATHS('/attachments'), auth, member, express.raw({ type: '*/*', limit: MAX_FILE }), handle(async (req, res) => {
      const buf = req.body; if (!Buffer.isBuffer(buf) || !buf.length) throw new HttpError(400, 'No file');
      const type = (SNIFF.find(([, ok]) => ok(buf)) || [])[0]; if (!type) throw new HttpError(415, 'This file type is not allowed');
      const aid = randomUUID(), name = cleanName(decodeURIComponent(String(req.get('x-file-name') || 'file')).slice(0, 200));
      writeFileSync(join(attachmentsDir, aid + '.' + EXT[type]), buf, { flag: 'wx', mode: 0o600 });
      await db.query('INSERT INTO chat_attachments(id, meeting_id, uploader_id, file_name, content_type, size_bytes) VALUES($1,$2,$3,$4,$5,$6)', [aid, req.params.id, req.user.participantId, name, type, buf.length]);
      res.status(201).json({ attachmentId: aid, name, type, size: buf.length });
    }));
    app.get(PATHS('/attachments/:aid'), auth, member, handle(async (req, res) => {
      ensureUuid(req.params.aid, 'attachment');
      // a file is reachable only by people who can read the message it belongs to; a file not yet posted is reachable only by whoever uploaded it
      const { rows: [a] } = await db.query(`SELECT a.file_name, a.content_type FROM chat_attachments a LEFT JOIN messages m ON m.attachment_id = a.id WHERE a.id=$1 AND a.meeting_id=$2 AND (
          (m.id IS NULL AND a.uploader_id = $3) OR (m.id IS NOT NULL AND m.deleted_at IS NULL AND (m.conversation_id IS NULL OR EXISTS (SELECT 1 FROM chat_members cm WHERE cm.conversation_id = m.conversation_id AND cm.participant_id = $3))))`,
        [req.params.aid, req.params.id, req.user.participantId]);
      if (!a) throw new HttpError(404, 'File not found');
      const path = join(attachmentsDir, req.params.aid + '.' + EXT[a.content_type]); if (!existsSync(path)) throw new HttpError(404, 'File not found');
      res.set({ 'Content-Type': a.content_type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Disposition': 'attachment; filename="' + a.file_name.replace(/["\\\r\n]/g, '_') + '"', 'Content-Security-Policy': "default-src 'none'; sandbox" });
      createReadStream(path).pipe(res);
    }));
  }
  app.use((err, req, res, next) => (err?.type === 'entity.too.large' && String(req.path).includes('/chat/attachments') ? res.status(413).json({ error: 'File is too large (10 MB maximum)' }) : next(err)));

  return { post, deliver, features, one, policyOf };
}
