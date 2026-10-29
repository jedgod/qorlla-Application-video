// Qorlla Voice browser SDK v1.5 (ES module, no build step). One-to-one internet calls and group rooms over WebRTC; signaling over the engine's ticketed WebSocket.
//
// Privacy: the microphone is opened ONLY when the person starts, answers or joins, and every track is stopped when the call/room ends, fails, is rejected, the device is replaced, or the client disconnects.
// Reliability: durable events carry an id and are applied once (duplicates are dropped); after a reconnect the client resumes from its last cursor and reconciles with the server's snapshot; media is
// repaired with ICE restarts; the device lease is renewed every 30 s; a replaced device tears its media down at once (generation fencing) without ending the call for the other person.
//
//   const voice = new QorllaVoiceClient(base, () => getToken(), (event) => ...);
//   await voice.connect();  await voice.dial('2041');  // incoming: {type:'incoming'} -> voice.answer(call.id) / voice.reject(call.id)
//   await voice.createRoom(['2041','2042'], 'Standup');  // room events: room_invite, room_state, room_ended, peer_connected ...
//
// Events: ready, incoming, state, call_accepted, offer_pending, connected, connection_unstable, connection_recovering, connection_failed, call_ended {reason}, taken_elsewhere, call_available,
//         call_resumed, device_replaced, lease_lost, muted, audio_play_blocked, mic_error, signaling_closed, room_invite, room_state, room_joined, room_ended, room_available, peer_connected, peer_unstable.

const PROTOCOL = 'qorlla.voice.v1';
const TERMINAL = ['ended', 'rejected', 'failed', 'missed'];
const LEASE_RENEW_MS = 30000, DISCONNECT_GRACE_MS = 3000, CONNECT_WATCHDOG_MS = 12000, MAX_RESTARTS = 3;

const memory = new Map();
const keep = {
  get(k) { try { const s = globalThis.sessionStorage; return s ? s.getItem(k) : memory.get(k) ?? null; } catch { return memory.get(k) ?? null; } },
  set(k, v) { try { const s = globalThis.sessionStorage; if (s) s.setItem(k, String(v)); else memory.set(k, String(v)); } catch { memory.set(k, String(v)); } }
};
const uuid = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));

/** Applies each durable event once. Events without an id (transient signaling) are always accepted. The cursor is the highest id seen. */
export class EventLog {
  constructor(limit = 2000) { this.limit = limit; this.seen = new Set(); this.cursor = 0; }
  accept(id) {
    if (!Number.isSafeInteger(id) || id <= 0) return true;
    if (this.seen.has(id)) return false;
    this.seen.add(id); if (this.seen.size > this.limit) this.seen.delete(this.seen.values().next().value);
    if (id > this.cursor) this.cursor = id; return true;
  }
}
/** A replayed batch is stale history: an invitation or ring for something that already ended must not pop up again, and only the latest roster per room matters. */
export function collapseReplay(events) {
  const lastTerminal = new Map(), lastRoom = new Map(), lastRoomEvent = new Map();
  events.forEach((e, i) => {
    const p = e.payload || {};
    if (e.kind === 'state' && p.call && TERMINAL.includes(p.call.status)) lastTerminal.set(p.call.id, i);
    if ((e.kind === 'room_state' || e.kind === 'room_invite') && p.room) lastRoomEvent.set(p.room.id, i);
    if (e.kind === 'room_state' && p.room) lastRoom.set(p.room.id, i);
  });
  return events.filter((e, i) => {
    const p = e.payload || {};
    if (e.kind === 'incoming' && p.call && lastTerminal.has(p.call.id) && lastTerminal.get(p.call.id) > i) return false;
    if (e.kind === 'room_state' && p.room && lastRoom.get(p.room.id) !== i) return false;
    if (e.kind === 'room_invite' && p.room && lastRoomEvent.get(p.room.id) > i) return false;
    return true;
  });
}

export class QorllaVoiceClient {
  /** @param {string} base engine URL, @param {() => Promise<string>} token returns a fresh identity token, @param {(e: object) => void} onEvent */
  constructor(base, token, onEvent = () => {}, { WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch && globalThis.fetch.bind(globalThis), deviceId } = {}) {
    Object.assign(this, { base: String(base).replace(/\/+$/, ''), token, onEvent, WS: WebSocketImpl, fetch: fetchImpl });
    this.deviceId = deviceId || keep.get('qorlla.voice.device') || uuid(); keep.set('qorlla.voice.device', this.deviceId);
    this.cursorKey = 'qorlla.voice.cursor.' + this.deviceId; this.log = new EventLog(); this.log.cursor = Number(keep.get(this.cursorKey)) || 0;
    this.callVersions = new Map(); this.ws = null; this.me = null; this.ringing = new Set(); this.autoStart = true; this.autoResume = true; this.peers = new Map(); this.ackTimer = null; this.replaying = false;
    this.reset(); this.resetRoom();
  }
  reset() {
    this.pc = null; this.stream = null; this.callId = null; this.role = null; this.remote = null; this.pendingOffer = null; this.pendingIce = []; this.remoteSet = false; this.muted = false; this.startedAt = null;
    this.generation = 0; this.peerGen = 0; this.makingOffer = false; this.offerer = false; this.restarts = 0; this.leaseTimer = null; this.watch = null; this.graceTimer = null;
  }
  resetRoom() { this.room = null; this.roomGen = 0; this.roomStream = null; this.roomLease = null; }

  async api(path, init = {}) {
    const r = await this.fetch(`${this.base}/v1/voice${path}`, { ...init, headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json', ...init.headers } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(body.error || `voice_http_${r.status}`), { status: r.status, code: body.error || null });
    return body;
  }
  post(path, body = {}) { return this.api(path, { method: 'POST', body: JSON.stringify(body) }); }
  emit(e) { try { this.onEvent(e); } catch { /* a faulty listener must not break signaling */ } }

  // ------------------------------------------------------------------------------------------------ signaling, resume and reconciliation
  /** Opens signaling. Resolves when the server says ready; rejects if the ticket is refused or the socket closes first. Safe to call again after a drop: state and media are kept. */
  async connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    const { ticket } = await this.post('/ws-ticket', { deviceId: this.deviceId });
    const ws = new this.WS(`${this.base.replace(/^http/, 'ws')}/v1/voice/ws`, [PROTOCOL, 'ticket.' + ticket]); this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(Error('signaling_timeout')); try { ws.close(); } catch { /* gone */ } }, 8000);
      ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m.type === 'ready') { clearTimeout(timer); resolve(); } this.queue(m); };
      ws.onerror = () => { clearTimeout(timer); reject(Error('signaling_failed')); };
      ws.onclose = (ev) => { clearTimeout(timer); reject(Error('signaling_closed')); this.emit({ type: 'signaling_closed', code: ev.code }); };
    });
    ws.onclose = (ev) => { if (this.ws === ws) this.emit({ type: 'signaling_closed', code: ev.code }); };
  }
  send(m) { if (!this.ws || this.ws.readyState !== 1) throw Error('signaling_disconnected'); this.ws.send(JSON.stringify(m)); }
  /** Inbound messages are applied one at a time, in order. */
  queue(m) { this.chain = (this.chain || Promise.resolve()).then(() => this.handle(m)).catch((e) => this.emit({ type: 'error', error: String(e && e.message || e) })); }

  async afterReady(m) {
    this.emit(m);
    if (!this.me) { try { this.me = (await this.api('/me')).identity.account_id; } catch { /* retried on next connect */ } }
    if (!this.log.cursor) this.log.cursor = m.cursor || 0;                       // a brand-new device starts from now; older history is reconciled from the snapshot below
    try { this.send({ type: 'resume', after: this.log.cursor }); } catch { /* socket closed again */ }
  }
  ackSoon() { clearTimeout(this.ackTimer); this.ackTimer = setTimeout(() => { keep.set(this.cursorKey, this.log.cursor); try { this.send({ type: 'ack', cursor: this.log.cursor }); } catch { /* offline */ } }, 800); }
  async applyBatch(m) {
    const events = collapseReplay(m.events || []); this.replaying = true;
    try { for (const e of events) await this.handle({ ...e.payload, eventId: e.id, kind: e.kind, replayed: true }); } finally { this.replaying = false; }
    for (const e of (m.events || [])) this.log.accept(e.id);                    // events that were collapsed away still move the cursor
    keep.set(this.cursorKey, this.log.cursor);
    if (m.hasMore && m.events?.length) { try { this.send({ type: 'resume', after: m.events.at(-1).id }); } catch { /* offline */ } return; }
    await this.reconcile();
  }
  /** After a reconnect the server's snapshot is the truth: pick up a call or room that continued, or notice that it ended while we were away. */
  async reconcile() {
    try {
      const live = await this.api('/calls/live');
      if (live.call && !this.callId) {
        const c = live.call;
        if (c.status === 'ringing' && live.role === 'callee') { this.ringing.add(c.id); this.emit({ type: 'incoming', call: c, from: { extension: live.peer_extension || null }, replayed: true }); }
        else if (c.status === 'ringing' && live.role === 'caller' && live.lease?.device_id === this.deviceId) { this.callId = c.id; this.role = 'caller'; this.generation = live.lease.generation; this.startLease(); }
        else if (c.status === 'active') { if (live.lease?.device_id === this.deviceId && this.autoResume) await this.resumeCall(c, live.role); else this.emit({ type: 'call_available', call: c, role: live.role, peer_extension: live.peer_extension || null }); }
      } else if (!live.call && this.callId) { const id = this.callId; this.cleanup(); this.emit({ type: 'call_ended', callId: id, status: 'ended', reason: 'ended_while_offline' }); }
      const rm = await this.api('/rooms/live');
      if (rm.room && !this.room) {
        if (rm.me?.status === 'joined') { if (rm.me.device_id === this.deviceId && this.autoResume) await this.resumeRoom(rm.room); else this.emit({ type: 'room_available', room: rm.room }); }
        else if (rm.me?.status === 'invited') this.emit({ type: 'room_invite', room: rm.room, from: { extension: null }, replayed: true });
      } else if (!rm.room && this.room) { const id = this.room.id; this.exitRoom(); this.emit({ type: 'room_ended', roomId: id, reason: 'ended_while_offline' }); }
    } catch { /* the next reconnect reconciles again */ }
  }

  async handle(m) {
    if (m.type === 'ready') return this.afterReady(m);
    if (m.type === 'resume_batch') return this.applyBatch(m);
    if (m.type === 'ack_ok') return;
    if (m.eventId !== undefined) { if (!this.log.accept(m.eventId)) return; this.ackSoon(); }        // durable events are applied once, however often they are delivered
    if (m.type === 'incoming' && m.replayed && m.call && Date.now() - Date.parse(m.call.created_at) > 90000) return;
    if (m.type === 'room_state') await this.onRoomState(m.room);                                        // the roster is updated BEFORE listeners hear about it, so they read the new one
    this.emit(m);
    switch (m.type) {
      case 'incoming': if (m.call) this.ringing.add(m.call.id); break;
      case 'offer': case 'answer': case 'ice': return this.onSignal(m);
      case 'g_offer': case 'g_answer': case 'g_ice': return this.onGroupSignal(m);
      case 'device_claimed': return this.onPeerDevice(m);
      case 'device_revoked': return this.onRevoked(m);
      case 'state': return this.onState(m.call);
      default:
    }
  }
  async onState(c) {
    if (!c) return;
    if (Number.isFinite(c.version)) { const seen = this.callVersions.get(c.id); if (seen !== undefined && c.version < seen) return; this.callVersions.set(c.id, c.version); if (this.callVersions.size > 200) this.callVersions.delete(this.callVersions.keys().next().value); }   // events can be delivered out of order (several workers, retries): an older state never overwrites a newer one
    if (c.status === 'active' && c.id === this.callId && this.role === 'caller') { this.emit({ type: 'call_accepted', call: c }); if (this.autoStart && !this.pc) await this.startAcceptedCall(c.id); }
    if (c.status === 'active' && c.id !== this.callId && this.ringing.has(c.id)) { this.ringing.delete(c.id); this.emit({ type: 'taken_elsewhere', call: c }); }          // another of my devices answered
    if (TERMINAL.includes(c.status)) { this.ringing.delete(c.id); if (c.id === this.callId) { const reason = c.end_reason || c.status; this.cleanup(); this.emit({ type: 'call_ended', callId: c.id, status: c.status, reason }); } }
  }
  /** My seat was taken by another device: stop media NOW and stop signaling, but do not end the call; the other device carries it on. */
  onRevoked(m) {
    if (m.revokedDevice !== this.deviceId) return;
    if (m.callId && m.callId === this.callId) { const id = this.callId; this.cleanup(); this.emit({ type: 'device_replaced', callId: id }); }
    if (m.roomId && this.room && m.roomId === this.room.id) { const id = this.room.id; this.exitRoom(); this.emit({ type: 'device_replaced', roomId: id }); }
  }
  /** The other person moved to a new device: their old connection is dead, so wait for the new device's offer on a fresh connection. */
  async onPeerDevice(m) {
    if (m.callId !== this.callId || !this.pc || !(m.generation > this.peerGen)) return;
    this.peerGen = m.generation; await this.freshPc();
  }

  // ------------------------------------------------------------------------------------------------ one-to-one media
  async onSignal(m) {
    if (m.callId !== this.callId) return;
    if (m.gen < this.peerGen) return;                                                                   // from a replaced device: stale
    if (m.gen > this.peerGen) { this.peerGen = m.gen; if (this.pc && m.type === 'offer') await this.freshPc(); }
    if (m.type === 'offer' && m.sdp) {
      if (!this.pc) { this.pendingOffer = m; this.emit({ type: 'offer_pending', callId: m.callId }); return; }
      return this.acceptOffer(m);
    }
    if (m.type === 'answer' && m.sdp && this.pc && this.pc.signalingState === 'have-local-offer') { await this.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); await this.markRemoteSet(); }
    if (m.type === 'ice' && this.pc) { if (this.remoteSet) await this.addCandidate(m.candidate); else if (this.pendingIce.length < 200) this.pendingIce.push(m.candidate); }   // candidates can outrun the offer or answer
  }
  async addCandidate(c) { try { await this.pc.addIceCandidate(c === null ? undefined : c); } catch { /* a stale or unusable candidate must not end the call */ } }
  async markRemoteSet() { this.remoteSet = true; const buffered = this.pendingIce.splice(0); for (const c of buffered) await this.addCandidate(c); }
  /** Perfect negotiation: the callee is polite. If both sides offer at once the polite side yields; the other side ignores the colliding offer. */
  async acceptOffer(m) {
    const polite = this.role === 'callee', collision = this.makingOffer || this.pc.signalingState !== 'stable';
    if (collision && !polite) return;
    await this.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp }); await this.markRemoteSet();
    const answer = await this.pc.createAnswer(); await this.pc.setLocalDescription(answer); this.send({ type: 'answer', callId: this.callId, generation: this.generation, sdp: answer.sdp }); this.armWatchdog();
  }
  async acceptPendingOffer(callId) { const o = this.pendingOffer; if (!o || o.callId !== callId || !this.pc) return; this.pendingOffer = null; await this.acceptOffer(o); }
  async sendOffer(restart = false) {
    if (!this.pc) return; const pc = this.pc; this.offerer = true; this.makingOffer = true;
    try { const offer = await pc.createOffer(restart ? { iceRestart: true } : undefined); if (pc !== this.pc) return; await pc.setLocalDescription(offer); this.send({ type: 'offer', callId: this.callId, generation: this.generation, sdp: offer.sdp }); this.armWatchdog(); }
    finally { this.makingOffer = false; }
  }
  armWatchdog() { clearTimeout(this.watch); const pc = this.pc; this.watch = setTimeout(() => { if (pc === this.pc && pc.connectionState !== 'connected') this.recover('timeout'); }, CONNECT_WATCHDOG_MS); }
  /** ICE restart (up to 3 times), then give up and tell the server the connection failed. Both sides may try; the polite-peer rule resolves a collision. */
  async recover(reason) {
    if (!this.pc || !this.callId) return;
    if (this.restarts >= MAX_RESTARTS) { this.emit({ type: 'connection_failed', callId: this.callId, reason }); this.api(`/calls/${this.callId}/fail`, { method: 'POST', body: JSON.stringify({ deviceId: this.deviceId, generation: this.generation }) }).catch(() => {}); return; }
    this.restarts++; this.emit({ type: 'connection_recovering', callId: this.callId, attempt: this.restarts, reason });
    const pc = this.pc;
    try { await this.sendOffer(true); } catch { /* signaling is down: the reconnect will resume */ }
    setTimeout(() => { if (pc === this.pc && pc.connectionState === 'connected') this.restarts = 0; }, 8000);
  }
  buildPc(iceServers, iceTransportPolicy) {
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: iceTransportPolicy || 'all' }); this.pc = pc; this.remoteSet = false; this.pendingIce = []; this.makingOffer = false;
    this.stream.getTracks().forEach((t) => { t.enabled = !this.muted; pc.addTrack(t, this.stream); });
    pc.ontrack = (ev) => { if (!this.remote) { const a = document.createElement('audio'); a.autoplay = true; a.playsInline = true; a.style.display = 'none'; document.body.appendChild(a); this.remote = a; } this.remote.srcObject = ev.streams[0] || new MediaStream([ev.track]); this.remote.play().catch(() => this.emit({ type: 'audio_play_blocked' })); };
    pc.onicecandidate = (ev) => { if (pc !== this.pc) return; try { this.send({ type: 'ice', callId: this.callId, generation: this.generation, candidate: ev.candidate ? ev.candidate.toJSON() : null }); } catch { /* signaling is down: the existing media path may still work */ } };
    pc.oniceconnectionstatechange = () => { if (pc === this.pc && (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')) { clearTimeout(this.watch); this.restarts = 0; } };
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return; clearTimeout(this.graceTimer);
      if (pc.connectionState === 'connected') { clearTimeout(this.watch); this.restarts = 0; if (!this.startedAt) this.startedAt = Date.now(); this.emit({ type: 'connected', callId: this.callId }); }
      else if (pc.connectionState === 'disconnected') { this.emit({ type: 'connection_unstable', callId: this.callId }); this.graceTimer = setTimeout(() => { if (pc === this.pc && pc.connectionState !== 'connected') this.recover('disconnected'); }, DISCONNECT_GRACE_MS); }
      else if (pc.connectionState === 'failed') this.recover('failed');
    };
    return pc;
  }
  async freshPc() { try { this.pc?.close(); } catch { /* closed */ } clearTimeout(this.watch); this.offerer = false; const { iceServers, iceTransportPolicy } = await this.api('/ice'); this.buildPc(iceServers, iceTransportPolicy); }
  /** Microphone, peer connection and remote audio. Called only after the person started, answered or resumed a call. */
  async prepare(callId, role) {
    if (this.pc) return;
    this.callId = callId; this.role = role;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }); }
    catch (e) { this.callId = null; this.role = null; this.emit({ type: 'mic_error', name: e && e.name || 'error' }); throw e; }
    this.stream = stream;
    try { const { iceServers, iceTransportPolicy } = await this.api('/ice'); this.buildPc(iceServers, iceTransportPolicy); } catch (e) { this.cleanup(); throw e; }
  }
  startLease() { clearInterval(this.leaseTimer); const id = this.callId; this.leaseTimer = setInterval(() => { this.api(`/calls/${id}/device/refresh`, { method: 'POST', body: JSON.stringify({ deviceId: this.deviceId, generation: this.generation }) }).catch((e) => { if (e.status === 409) { const cid = this.callId; this.cleanup(); this.emit({ type: 'lease_lost', callId: cid }); } }); }, LEASE_RENEW_MS); }
  /** The caller's side, after the callee answered. */
  async startAcceptedCall(callId) { await this.prepare(callId, 'caller'); await this.sendOffer(); }
  /** This device takes over (or recovers) a live call: it claims the next generation, opens its microphone and makes a fresh offer. The other side resets its connection when it sees the new generation. */
  async resumeCall(call, role) {
    if (this.pc || this.room) throw Error('already_in_call');
    this.callId = call.id; this.role = role;
    try { const r = await this.post(`/calls/${call.id}/device`, { deviceId: this.deviceId }); this.generation = r.generation; } catch (e) { this.callId = null; this.role = null; throw e; }
    this.startLease();
    try { await this.prepare(call.id, role); await this.sendOffer(); } catch (e) { this.cleanup(); throw e; }
    this.emit({ type: 'call_resumed', call });
  }
  /** Explicit takeover by the person (a second device): same as resume. */
  async continueHere(call, role) { return this.resumeCall(call, role); }

  async dial(extension) {
    if (this.callId || this.room) throw Error('already_in_call');
    const r = await this.post('/calls', { extension: String(extension), idempotencyKey: uuid(), deviceId: this.deviceId });
    this.callId = r.call.id; this.role = 'caller'; this.generation = r.generation || 1; this.startLease(); return r.call;
  }
  /** Prepares the microphone first, then tells the server: if the microphone is refused the call is never answered. */
  async answer(callId) {
    if ((this.callId && this.callId !== callId) || this.room) throw Error('already_in_call');
    await this.prepare(callId, 'callee');
    try { const r = await this.post(`/calls/${callId}/answer`, { deviceId: this.deviceId }); this.generation = r.generation || 1; this.ringing.delete(callId); this.startLease(); } catch (e) { this.cleanup(); throw e; }
    await this.acceptPendingOffer(callId);
  }
  async reject(callId) { await this.post(`/calls/${callId}/reject`); this.ringing.delete(callId); if (this.callId === callId) this.cleanup(); }
  async hangup() { const id = this.callId; this.cleanup(); if (id) await this.post(`/calls/${id}/end`).catch(() => {}); }
  setMuted(muted) {
    this.muted = !!muted;
    for (const s of [this.stream, this.roomStream]) s?.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
    this.emit({ type: 'muted', muted: this.muted });
  }

  // ------------------------------------------------------------------------------------------------ group rooms (full mesh: one connection per other member)
  async openRoomMic() {
    if (this.roomStream) return;
    try { this.roomStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }); }
    catch (e) { this.emit({ type: 'mic_error', name: e && e.name || 'error' }); throw e; }
  }
  async createRoom(extensions, title = '') {
    if (this.callId || this.room) throw Error('already_in_call');
    await this.openRoomMic();
    try { const r = await this.post('/rooms', { extensions, title, deviceId: this.deviceId }); await this.enterRoom(r.room, r.generation); return r.room; } catch (e) { this.exitRoom(); throw e; }
  }
  async joinRoom(roomId) {
    if (this.callId || (this.room && this.room.id !== roomId)) throw Error('already_in_call');
    await this.openRoomMic();
    try { const r = await this.post(`/rooms/${roomId}/join`, { deviceId: this.deviceId }); await this.enterRoom(r.room, r.generation); return r.room; } catch (e) { this.exitRoom(); throw e; }
  }
  /** Take the room over on this device (a second device, or recovery after a page refresh). */
  async resumeRoom(room) {
    if (this.callId || this.room) throw Error('already_in_call');
    await this.openRoomMic();
    try { const r = await this.post(`/rooms/${room.id}/device`, { deviceId: this.deviceId }); await this.enterRoom(r.room, r.generation); this.emit({ type: 'call_resumed', room: r.room }); return r.room; } catch (e) { this.exitRoom(); throw e; }
  }
  async declineRoom(roomId) { await this.post(`/rooms/${roomId}/decline`); }
  async inviteToRoom(extension) { return this.post(`/rooms/${this.room.id}/invite`, { extension }); }
  async kickFromRoom(accountId) { return this.post(`/rooms/${this.room.id}/kick`, { accountId }); }
  async leaveRoom() { const id = this.room?.id; this.exitRoom(); if (id) await this.post(`/rooms/${id}/leave`).catch(() => {}); }
  async endRoom() { const id = this.room?.id; this.exitRoom(); if (id) await this.post(`/rooms/${id}/end`).catch(() => {}); }
  async enterRoom(room, generation) {
    this.room = room; this.roomGen = generation; this.roomStream.getTracks().forEach((t) => { t.enabled = !this.muted; });
    clearInterval(this.roomLease); const id = room.id;
    this.roomLease = setInterval(() => { this.api(`/rooms/${id}/device-refresh`, { method: 'POST', body: JSON.stringify({ deviceId: this.deviceId, generation: this.roomGen }) }).catch((e) => { if (e.status === 409) { this.exitRoom(); this.emit({ type: 'lease_lost', roomId: id }); } }); }, LEASE_RENEW_MS);
    this.emit({ type: 'room_joined', room }); await this.syncPeers(room);
  }
  async onRoomState(room) {
    if (!room || !this.room || room.id !== this.room.id) return;
    if (Number.isFinite(room.version) && Number.isFinite(this.room.version) && room.version < this.room.version) return;                    // a stale roster
    const mine = room.members.find((m) => m.account_id === this.me);
    if (room.status !== 'live' || !mine || mine.status !== 'joined') { const id = room.id, reason = room.end_reason || (mine ? mine.status : 'removed'); this.exitRoom(); this.emit({ type: 'room_ended', roomId: id, reason }); return; }
    this.room = room; await this.syncPeers(room);
  }
  newerThan(a, b) { const ta = Date.parse(a.joined_at), tb = Date.parse(b.joined_at); return ta > tb || (ta === tb && a.account_id > b.account_id); }
  /** One connection per other joined member. The member who joined LATER makes the offer, so every pair has exactly one offerer. */
  async syncPeers(room) {
    const mine = room.members.find((m) => m.account_id === this.me); if (!mine || mine.status !== 'joined' || !this.roomStream) return;
    const live = new Set();
    for (const m of room.members) {
      if (m.account_id === this.me || m.status !== 'joined') continue; live.add(m.account_id);
      let p = this.peers.get(m.account_id);
      if (p && p.theirGen !== m.generation) { this.dropPeer(m.account_id); p = null; }                   // they moved to a new device: their old connection is dead
      if (!p) { p = await this.makePeer(m.account_id, m.generation); if (this.newerThan(mine, m)) await this.offerTo(p); }
    }
    for (const id of [...this.peers.keys()]) if (!live.has(id)) this.dropPeer(id);
  }
  async makePeer(account, theirGen) {
    const { iceServers, iceTransportPolicy } = await this.api('/ice'), pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: iceTransportPolicy || 'all' });
    const p = { account, theirGen, pc, audio: null, remoteSet: false, pendingIce: [], making: false, offerer: false, restarts: 0, watch: null, grace: null };
    this.peers.set(account, p);
    this.roomStream.getTracks().forEach((t) => pc.addTrack(t, this.roomStream));
    pc.ontrack = (ev) => { if (!p.audio) { const a = document.createElement('audio'); a.autoplay = true; a.playsInline = true; a.style.display = 'none'; document.body.appendChild(a); p.audio = a; } p.audio.srcObject = ev.streams[0] || new MediaStream([ev.track]); p.audio.play().catch(() => this.emit({ type: 'audio_play_blocked' })); };
    pc.onicecandidate = (ev) => { if (this.peers.get(account) !== p) return; try { this.send({ type: 'g_ice', roomId: this.room.id, to: account, generation: this.roomGen, candidate: ev.candidate ? ev.candidate.toJSON() : null }); } catch { /* offline */ } };
    pc.oniceconnectionstatechange = () => { if (this.peers.get(account) === p && (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')) { clearTimeout(p.watch); p.restarts = 0; } };
    pc.onconnectionstatechange = () => {
      if (this.peers.get(account) !== p) return; clearTimeout(p.grace);
      if (pc.connectionState === 'connected') { clearTimeout(p.watch); p.restarts = 0; this.emit({ type: 'peer_connected', account }); }
      else if (pc.connectionState === 'disconnected') { this.emit({ type: 'peer_unstable', account }); p.grace = setTimeout(() => { if (this.peers.get(account) === p && pc.connectionState !== 'connected') this.recoverPeer(p); }, DISCONNECT_GRACE_MS); }
      else if (pc.connectionState === 'failed') this.recoverPeer(p);
    };
    return p;
  }
  async offerTo(p, restart = false) {
    p.offerer = true; p.making = true;
    try {
      const offer = await p.pc.createOffer(restart ? { iceRestart: true } : undefined); if (this.peers.get(p.account) !== p) return; await p.pc.setLocalDescription(offer);
      this.send({ type: 'g_offer', roomId: this.room.id, to: p.account, generation: this.roomGen, sdp: offer.sdp });
      clearTimeout(p.watch); p.watch = setTimeout(() => { if (this.peers.get(p.account) === p && p.pc.connectionState !== 'connected') this.recoverPeer(p); }, CONNECT_WATCHDOG_MS);
    } finally { p.making = false; }
  }
  async recoverPeer(p) {
    if (p.restarts >= MAX_RESTARTS) { this.emit({ type: 'peer_failed', account: p.account }); return; } p.restarts++;
    try { await this.offerTo(p, true); } catch { /* offline */ }
    setTimeout(() => { if (this.peers.get(p.account) === p && p.pc.connectionState === 'connected') p.restarts = 0; }, 8000);
  }
  dropPeer(account) { const p = this.peers.get(account); if (!p) return; this.peers.delete(account); clearTimeout(p.watch); clearTimeout(p.grace); try { p.pc.close(); } catch { /* closed */ } p.audio?.remove(); }
  async onGroupSignal(m) {
    if (!this.room || m.roomId !== this.room.id || m.toGen !== this.roomGen) return;                       // for a room I am not in, or addressed to my previous device
    let p = this.peers.get(m.from);
    if (p && m.gen < p.theirGen) return;                                                                      // from a replaced device: stale
    if (!p || m.gen > p.theirGen) { if (p) this.dropPeer(m.from); p = await this.makePeer(m.from, m.gen); }
    if (m.type === 'g_offer' && m.sdp) {
      const mineSeat = this.room.members.find((x) => x.account_id === this.me), their = this.room.members.find((x) => x.account_id === m.from);
      const polite = !(mineSeat && their && this.newerThan(mineSeat, their)), collision = p.making || p.pc.signalingState !== 'stable';
      if (collision && !polite) return;
      await p.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp }); await this.markPeerRemote(p);
      const answer = await p.pc.createAnswer(); await p.pc.setLocalDescription(answer); this.send({ type: 'g_answer', roomId: this.room.id, to: m.from, generation: this.roomGen, sdp: answer.sdp });
    } else if (m.type === 'g_answer' && m.sdp && p.pc.signalingState === 'have-local-offer') { await p.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); await this.markPeerRemote(p); }
    else if (m.type === 'g_ice') { if (p.remoteSet) { try { await p.pc.addIceCandidate(m.candidate === null ? undefined : m.candidate); } catch { /* stale */ } } else if (p.pendingIce.length < 200) p.pendingIce.push(m.candidate); }
  }
  async markPeerRemote(p) { p.remoteSet = true; for (const c of p.pendingIce.splice(0)) { try { await p.pc.addIceCandidate(c === null ? undefined : c); } catch { /* stale */ } } }
  exitRoom() { for (const id of [...this.peers.keys()]) this.dropPeer(id); this.roomStream?.getTracks().forEach((t) => t.stop()); clearInterval(this.roomLease); this.resetRoom(); }
  async resumeRoomIfAny() { return this.reconcile(); }

  // ------------------------------------------------------------------------------------------------ quality numbers and cleanup
  /** Quality numbers from the browser's own statistics (no audio content). Used by diagnostics and tests. */
  async stats(pc = this.pc) {
    if (!pc) return null;
    const out = { connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState, bytesReceived: 0, bytesSent: 0, packetsLost: 0, jitter: 0, audioLevel: 0, totalAudioEnergy: 0, roundTripTime: null, candidateType: null, codec: null };
    const report = await pc.getStats(); const codecs = new Map();
    report.forEach((r) => { if (r.type === 'codec') codecs.set(r.id, r.mimeType); });
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') { out.bytesReceived += r.bytesReceived || 0; out.packetsLost += r.packetsLost || 0; out.jitter = r.jitter || 0; out.audioLevel = r.audioLevel || 0; out.totalAudioEnergy = r.totalAudioEnergy || 0; out.codec = codecs.get(r.codecId) || out.codec; }
      if (r.type === 'outbound-rtp' && r.kind === 'audio') out.bytesSent += r.bytesSent || 0;
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) { out.roundTripTime = r.currentRoundTripTime ?? null; const l = report.get(r.localCandidateId); out.candidateType = l && l.candidateType || null; }
    });
    return out;
  }
  /** Per-member statistics for a room. */
  async roomStats() { const out = {}; for (const [account, p] of this.peers) out[account] = await this.stats(p.pc); return out; }
  cleanup() {
    clearInterval(this.leaseTimer); clearTimeout(this.watch); clearTimeout(this.graceTimer);
    this.stream?.getTracks().forEach((t) => t.stop()); try { this.pc?.close(); } catch { /* already closed */ } this.remote?.remove(); this.reset();
  }
  disconnect() { this.cleanup(); this.exitRoom(); clearTimeout(this.ackTimer); try { this.ws?.close(); } catch { /* gone */ } this.ws = null; }
}
export default QorllaVoiceClient;
