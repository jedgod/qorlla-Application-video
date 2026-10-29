// Group calls (v1.5): voice rooms with a host, invitations and a roster. Media is a full mesh of one-to-one WebRTC connections (so a room is capped at max_members, default 6), which means the
// server relays signaling only and never carries or records audio. Every change is one transaction that also writes the durable room events, exactly like one-to-one calls.
import { randomUUID } from 'node:crypto';
import { validExtension, validCallId } from './core.mjs';

const fail = (code) => Object.assign(new Error(code), { code });
const ROOM_COLS = 'id, host_id, title, meeting_ref, status, max_members, created_at, ended_at, end_reason, version';
export const validRoomId = validCallId;

export function createRooms({ db, tx, lockAccounts, ev, lockEvents, busyAccounts, validDevice, extensionOf, LEASE_SECONDS }) {
  const leaseSql = `now() + make_interval(secs => ${LEASE_SECONDS})`;

  async function snapshot(c, roomId) {
    const room = (await c.query(`SELECT ${ROOM_COLS} FROM voice_rooms WHERE id=$1`, [roomId])).rows[0]; if (!room) return null;
    const members = (await c.query(`SELECT m.account_id, i.extension, m.role, m.status, m.generation, m.joined_at, m.invited_at FROM voice_room_members m JOIN voice_identities i ON i.account_id=m.account_id
      WHERE m.room_id=$1 AND m.status IN ('invited','joined') ORDER BY COALESCE(m.joined_at, m.invited_at), m.account_id`, [roomId])).rows;
    return { id: room.id, version: Number(room.version), title: room.title, host_id: room.host_id, meeting_ref: room.meeting_ref, status: room.status, max_members: room.max_members, created_at: room.created_at, ended_at: room.ended_at, end_reason: room.end_reason,
      members: members.map((m) => ({ account_id: m.account_id, extension: m.extension, role: m.role, status: m.status, generation: Number(m.generation), joined_at: m.joined_at })) };
  }
  /** A durable room_state event to every current member plus anyone who just left or was removed (so they learn the final state). */
  async function notify(c, snap, extra = []) {
    const accounts = new Set([...snap.members.map((m) => m.account_id), ...extra]); await lockEvents(c, [...accounts]);
    for (const a of accounts) await ev(c, a, 'room_state', { type: 'room_state', room: snap }, null);
  }
  const lockRoom = async (c, roomId) => (await c.query(`SELECT ${ROOM_COLS} FROM voice_rooms WHERE id=$1 FOR UPDATE`, [roomId])).rows[0] || null;
  const member = async (c, roomId, account) => (await c.query('SELECT * FROM voice_room_members WHERE room_id=$1 AND account_id=$2 FOR UPDATE', [roomId, account])).rows[0] || null;

  /** Common tail of leave / remove / lease expiry: the room ends when nobody is joined, and the host role passes to the longest-serving member when the host goes. */
  async function afterChange(c, room, extra) {
    const joined = (await c.query("SELECT account_id, role FROM voice_room_members WHERE room_id=$1 AND status='joined' ORDER BY joined_at, account_id", [room.id])).rows;
    if (!joined.length) {
      const gone = (await c.query("UPDATE voice_room_members SET status='missed' WHERE room_id=$1 AND status='invited' RETURNING account_id", [room.id])).rows.map((r) => r.account_id);
      await c.query("UPDATE voice_rooms SET status='ended', ended_at=now(), end_reason=COALESCE(end_reason,'empty'), version=version+1 WHERE id=$1", [room.id]);
      extra = [...extra, ...gone];
    } else if (!joined.some((m) => m.role === 'host')) {
      await c.query("UPDATE voice_room_members SET role='member' WHERE room_id=$1 AND role='host'", [room.id]);
      await c.query("UPDATE voice_room_members SET role='host' WHERE room_id=$1 AND account_id=$2", [room.id, joined[0].account_id]);
      await c.query('UPDATE voice_rooms SET host_id=$2, version=version+1 WHERE id=$1', [room.id, joined[0].account_id]);
    } else await c.query('UPDATE voice_rooms SET version=version+1 WHERE id=$1', [room.id]);
    const snap = await snapshot(c, room.id); await notify(c, snap, extra); return snap;
  }

  async function createRoom(host, extensions, { title = '', meetingRef = null, deviceId, maxMembers = 6 } = {}) {
    if (!validDevice(deviceId) || !Array.isArray(extensions) || extensions.some((e) => !validExtension(e))) throw fail('invalid_input');
    const exts = [...new Set(extensions)], max = Math.min(8, Math.max(2, Number(maxMembers) || 6));
    if (exts.length > max - 1 || (!exts.length && !meetingRef)) throw fail('invalid_input');
    if (typeof title !== 'string' || title.length > 80 || (meetingRef != null && !/^[A-Za-z0-9:_-]{1,64}$/.test(meetingRef))) throw fail('invalid_input');
    return tx(async (c) => {
      const invitees = exts.length ? (await c.query('SELECT account_id, extension FROM voice_identities WHERE extension = ANY($1::text[]) AND enabled=true', [exts])).rows : [];
      if (invitees.length !== exts.length || invitees.some((i) => i.account_id === host)) throw fail('invalid_recipient');
      const ids = [host, ...invitees.map((i) => i.account_id)]; await lockAccounts(c, ids);
      if (!(await c.query('SELECT enabled FROM voice_identities WHERE account_id=$1', [host])).rows[0]?.enabled) throw fail('caller_disabled');
      if ((await c.query('SELECT 1 FROM voice_blocks WHERE (owner_id=$1 AND blocked_id = ANY($2::text[])) OR (blocked_id=$1 AND owner_id = ANY($2::text[]))', [host, ids.slice(1)])).rowCount) throw fail('blocked');
      if (await busyAccounts(c, [host])) throw fail('busy');
      if (meetingRef && (await c.query("SELECT 1 FROM voice_rooms WHERE meeting_ref=$1 AND status='live'", [meetingRef])).rowCount) throw fail('room_exists');
      const id = randomUUID();
      await c.query("INSERT INTO voice_rooms(id, host_id, title, meeting_ref, status, max_members) VALUES($1,$2,$3,$4,'live',$5)", [id, host, title, meetingRef, max]);
      await c.query(`INSERT INTO voice_room_members(room_id, account_id, role, status, device_id, lease_token, generation, lease_expires_at, joined_at) VALUES($1,$2,'host','joined',$3,$4,1,${leaseSql},now())`, [id, host, deviceId, randomUUID()]);
      for (const i of invitees) await c.query("INSERT INTO voice_room_members(room_id, account_id, role, status, invited_by) VALUES($1,$2,'member','invited',$3)", [id, i.account_id, host]);
      const snap = await snapshot(c, id), from = { extension: await extensionOf(c, host), account_id: host }; await lockEvents(c, ids);
      for (const i of invitees) await ev(c, i.account_id, 'room_invite', { type: 'room_invite', room: snap, from }, null);
      await ev(c, host, 'room_state', { type: 'room_state', room: snap }, null);
      return { room: snap, lease: { generation: 1, device_id: deviceId } };
    });
  }

  async function join(roomId, account, deviceId) {
    if (!validDevice(deviceId)) throw fail('invalid_input');
    return tx(async (c) => {
      await lockAccounts(c, [account]);
      const room = await lockRoom(c, roomId); if (!room || room.status !== 'live') throw fail('not_found');
      const m = await member(c, roomId, account); if (!m || !['invited', 'joined'].includes(m.status)) throw fail('not_found');
      if (m.status === 'joined') throw fail('already_joined');
      if (!(await c.query('SELECT enabled FROM voice_identities WHERE account_id=$1', [account])).rows[0]?.enabled) throw fail('caller_disabled');
      if (await busyAccounts(c, [account])) throw fail('busy');
      if ((await c.query("SELECT count(*)::int AS n FROM voice_room_members WHERE room_id=$1 AND status='joined'", [roomId])).rows[0].n >= room.max_members) throw fail('room_full');
      const generation = Number(m.generation) + 1;
      await c.query(`UPDATE voice_room_members SET status='joined', joined_at=now(), left_at=NULL, device_id=$3, lease_token=$4, generation=$5, lease_expires_at=${leaseSql} WHERE room_id=$1 AND account_id=$2`, [roomId, account, deviceId, randomUUID(), generation]);
      await c.query('UPDATE voice_rooms SET version=version+1 WHERE id=$1', [roomId]);
      const snap = await snapshot(c, roomId); await notify(c, snap);
      return { room: snap, lease: { generation, device_id: deviceId } };
    });
  }

  /** Leave a room you joined, or decline an invitation. Returns the room as everyone now sees it. */
  async function leaveTx(c, roomId, account, reason = 'left') {
    const room = await lockRoom(c, roomId); if (!room || room.status !== 'live') return null;
    const m = await member(c, roomId, account); if (!m || !['invited', 'joined'].includes(m.status)) return null;
    const next = m.status === 'invited' ? (reason === 'left' ? 'declined' : 'removed') : 'left';
    await c.query("UPDATE voice_room_members SET status=$3, left_at=now(), lease_expires_at=NULL WHERE room_id=$1 AND account_id=$2", [roomId, account, next]);
    return afterChange(c, room, [account]);
  }
  async function leave(roomId, account) { return tx(async (c) => { const snap = await leaveTx(c, roomId, account); if (!snap) throw fail('not_found'); return snap; }); }
  async function end(roomId, actor) {
    return tx(async (c) => {
      const room = await lockRoom(c, roomId); if (!room || room.status !== 'live') throw fail('not_found');
      const m = await member(c, roomId, actor); if (!m || m.status !== 'joined') throw fail('not_found');
      if (room.host_id !== actor) throw fail('forbidden');
      const all = (await c.query("SELECT account_id FROM voice_room_members WHERE room_id=$1 AND status IN ('invited','joined')", [roomId])).rows.map((r) => r.account_id);
      await c.query("UPDATE voice_room_members SET status=CASE WHEN status='joined' THEN 'left' ELSE 'missed' END, left_at=now(), lease_expires_at=NULL WHERE room_id=$1 AND status IN ('invited','joined')", [roomId]);
      await c.query("UPDATE voice_rooms SET status='ended', ended_at=now(), end_reason='ended_by_host', version=version+1 WHERE id=$1", [roomId]);
      const snap = await snapshot(c, roomId); await notify(c, snap, all); return snap;
    });
  }
  async function kick(roomId, actor, targetAccount) {
    return tx(async (c) => {
      const room = await lockRoom(c, roomId); if (!room || room.status !== 'live') throw fail('not_found');
      const m = await member(c, roomId, actor); if (!m || m.status !== 'joined') throw fail('not_found');
      if (room.host_id !== actor || targetAccount === actor) throw fail('forbidden');
      const t = await member(c, roomId, targetAccount); if (!t || !['invited', 'joined'].includes(t.status)) throw fail('not_found');
      await c.query("UPDATE voice_room_members SET status='removed', left_at=now(), lease_expires_at=NULL WHERE room_id=$1 AND account_id=$2", [roomId, targetAccount]);
      return afterChange(c, room, [targetAccount]);
    });
  }
  async function invite(roomId, actor, extension) {
    if (!validExtension(extension)) throw fail('invalid_input');
    return tx(async (c) => {
      const target = (await c.query('SELECT account_id FROM voice_identities WHERE extension=$1 AND enabled=true', [extension])).rows[0]?.account_id;
      if (!target || target === actor) throw fail('invalid_recipient');
      await lockAccounts(c, [actor, target]);
      const room = await lockRoom(c, roomId); if (!room || room.status !== 'live') throw fail('not_found');
      const m = await member(c, roomId, actor); if (!m || m.status !== 'joined') throw fail('not_found');
      if ((await c.query('SELECT 1 FROM voice_blocks WHERE (owner_id=$1 AND blocked_id=$2) OR (owner_id=$2 AND blocked_id=$1)', [actor, target])).rowCount) throw fail('blocked');
      const t = await member(c, roomId, target);
      if (t && ['invited', 'joined'].includes(t.status)) return { room: await snapshot(c, roomId), reused: true };
      if ((await c.query("SELECT count(*)::int AS n FROM voice_room_members WHERE room_id=$1 AND status IN ('invited','joined')", [roomId])).rows[0].n >= room.max_members) throw fail('room_full');
      if (t) await c.query("UPDATE voice_room_members SET status='invited', invited_by=$3, invited_at=now(), left_at=NULL, device_id=NULL, lease_expires_at=NULL WHERE room_id=$1 AND account_id=$2", [roomId, target, actor]);
      else await c.query("INSERT INTO voice_room_members(room_id, account_id, role, status, invited_by) VALUES($1,$2,'member','invited',$3)", [roomId, target, actor]);
      await c.query('UPDATE voice_rooms SET version=version+1 WHERE id=$1', [roomId]);
      const snap = await snapshot(c, roomId); await lockEvents(c, [target, ...snap.members.map((x) => x.account_id)]);
      await ev(c, target, 'room_invite', { type: 'room_invite', room: snap, from: { extension: await extensionOf(c, actor), account_id: actor } }, null);
      await notify(c, { ...snap, members: snap.members.filter((x) => x.account_id !== target) });
      return { room: snap, reused: false };
    });
  }
  /** The same generation fencing as one-to-one calls: a new device that claims the member's seat replaces the old one, and the old one is told to stop. */
  async function claimDevice(roomId, account, deviceId) {
    if (!validDevice(deviceId)) throw fail('invalid_input');
    return tx(async (c) => {
      const room = await lockRoom(c, roomId); if (!room || room.status !== 'live') throw fail('not_found');
      const m = await member(c, roomId, account); if (!m || m.status !== 'joined') throw fail('not_found');
      const generation = Number(m.generation) + 1;
      await c.query(`UPDATE voice_room_members SET device_id=$3, lease_token=$4, generation=$5, lease_expires_at=${leaseSql} WHERE room_id=$1 AND account_id=$2`, [roomId, account, deviceId, randomUUID(), generation]);
      if (m.device_id && m.device_id !== deviceId) await ev(c, account, 'device_revoked', { type: 'device_revoked', roomId, revokedDevice: m.device_id, newDevice: deviceId, generation }, null);
      await c.query('UPDATE voice_rooms SET version=version+1 WHERE id=$1', [roomId]);
      const snap = await snapshot(c, roomId); await notify(c, snap);
      return { room: snap, lease: { generation, device_id: deviceId } };
    });
  }
  async function refreshLease(roomId, account, deviceId, generation) {
    const r = await db.query(`UPDATE voice_room_members m SET lease_expires_at=${leaseSql} FROM voice_rooms r WHERE m.room_id=$1 AND m.account_id=$2 AND m.status='joined' AND m.device_id=$3 AND m.generation=$4
      AND m.lease_expires_at > now() AND r.id=m.room_id AND r.status='live' RETURNING m.lease_expires_at`, [roomId, account, deviceId, generation]);
    return r.rows[0] || null;
  }
  /** What a signaling decision needs: the room, and the sender's and recipient's seats with their current devices (read from PostgreSQL, so every replica agrees). */
  async function signalContext(roomId, from, to) {
    const { rows } = await db.query(`SELECT r.status AS room_status, m.account_id, m.status, m.device_id, m.generation, (m.lease_expires_at > now()) AS valid FROM voice_rooms r JOIN voice_room_members m ON m.room_id=r.id
      WHERE r.id=$1 AND m.account_id = ANY($2::text[])`, [roomId, [from, to]]);
    if (!rows.length) return null;
    const seat = (a) => { const r = rows.find((x) => x.account_id === a); return r ? { status: r.status, device_id: r.device_id, generation: Number(r.generation), valid: r.valid } : null; };
    return { live: rows[0].room_status === 'live', from: seat(from), to: seat(to) };
  }
  async function get(roomId, account) {
    const c = db; const room = await snapshot(c, roomId); if (!room) return null;
    return room.members.some((m) => m.account_id === account) ? room : null;
  }
  async function liveFor(account) {
    const r = (await db.query(`SELECT m.room_id FROM voice_room_members m JOIN voice_rooms r ON r.id=m.room_id WHERE m.account_id=$1 AND m.status IN ('invited','joined') AND r.status='live'
      ORDER BY (m.status='joined') DESC, m.invited_at DESC LIMIT 1`, [account])).rows[0];
    return r ? snapshot(db, r.room_id) : null;
  }
  /** This account's own seat, including which device currently holds it (so a reloaded page can tell whether it is the same device). */
  async function seat(roomId, account) {
    const r = (await db.query('SELECT status, device_id, generation FROM voice_room_members WHERE room_id=$1 AND account_id=$2', [roomId, account])).rows[0];
    return r ? { status: r.status, device_id: r.device_id, generation: Number(r.generation) } : null;
  }
  async function removeAccountTx(c, account, reason) {
    for (const r of (await c.query("SELECT m.room_id FROM voice_room_members m JOIN voice_rooms r ON r.id=m.room_id WHERE m.account_id=$1 AND m.status IN ('invited','joined') AND r.status='live'", [account])).rows) await leaveTx(c, r.room_id, account, reason);
  }
  /** Invitations nobody answered become "missed". */
  async function expireInvites(seconds = 60) {
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 600) throw fail('invalid_timeout');
    const rows = (await db.query(`SELECT m.room_id, m.account_id FROM voice_room_members m JOIN voice_rooms r ON r.id=m.room_id WHERE m.status='invited' AND r.status='live' AND m.invited_at < now() - make_interval(secs => $1::int) LIMIT 100`, [seconds])).rows;
    let n = 0;
    for (const r of rows) await tx(async (c) => {
      const room = await lockRoom(c, r.room_id); if (!room || room.status !== 'live') return;
      const m = await member(c, r.room_id, r.account_id); if (!m || m.status !== 'invited' || new Date(m.invited_at).getTime() > Date.now() - seconds * 1000) return;
      await c.query("UPDATE voice_room_members SET status='missed', left_at=now() WHERE room_id=$1 AND account_id=$2", [r.room_id, r.account_id]); await afterChange(c, room, [r.account_id]); n++;
    });
    return n;
  }
  /** A joined member that stopped renewing the device lease (browser closed, network lost) is dropped after a grace period, so nobody stays "in a room" forever. */
  async function expireStaleMembers(graceSeconds = 120) {
    const rows = (await db.query(`SELECT m.room_id, m.account_id FROM voice_room_members m JOIN voice_rooms r ON r.id=m.room_id WHERE m.status='joined' AND r.status='live'
      AND m.lease_expires_at < now() - make_interval(secs => $1::int) LIMIT 100`, [graceSeconds])).rows;
    let n = 0;
    for (const r of rows) await tx(async (c) => {
      const m = await member(c, r.room_id, r.account_id);
      if (!m || m.status !== 'joined' || !m.lease_expires_at || new Date(m.lease_expires_at).getTime() > Date.now() - graceSeconds * 1000) return;
      if (await leaveTx(c, r.room_id, r.account_id, 'lease_expired')) n++;
    });
    return n;
  }
  return { createRoom, join, leave, end, kick, invite, claimDevice, refreshLease, signalContext, get, liveFor, seat, removeAccountTx, expireInvites, expireStaleMembers, snapshot };
}
