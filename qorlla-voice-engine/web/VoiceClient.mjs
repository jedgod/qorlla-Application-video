// Qorlla Voice browser SDK (ES module, no build step). One-to-one internet voice calls over WebRTC, signaling over the engine's ticketed WebSocket.
// Privacy: the microphone is opened ONLY when the person starts or answers a call, and every track is stopped when the call ends, fails, is rejected or the client is disconnected.
//
//   const voice = new QorllaVoiceClient(base, () => getToken(), (event) => ...);
//   await voice.connect();            // asks for a one-use ticket; the ticket travels in the WebSocket subprotocol, never in the URL
//   await voice.dial('2041');         // the caller's microphone opens when the callee answers
//   // incoming: event {type:'incoming', call, from:{extension}}  ->  await voice.answer(call.id)  or  voice.reject(call.id)
//
// Events (onEvent): ready, incoming, state, call_accepted, offer_pending, connected, connection_unstable, connection_failed, call_ended {reason}, taken_elsewhere,
//                   muted, audio_play_blocked, mic_error, signaling_closed.

const PROTOCOL = 'qorlla.voice.v1';
const TERMINAL = ['ended', 'rejected', 'failed', 'missed'];

export class QorllaVoiceClient {
  /** @param {string} base engine URL, @param {() => Promise<string>} token returns a fresh identity token, @param {(e: object) => void} onEvent */
  constructor(base, token, onEvent = () => {}, { WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
    Object.assign(this, { base: String(base).replace(/\/+$/, ''), token, onEvent, WS: WebSocketImpl, fetch: fetchImpl });
    this.ws = null; this.reset(); this.ringing = new Set(); this.autoStart = true;
  }
  reset() { this.pc = null; this.stream = null; this.callId = null; this.role = null; this.remote = null; this.pendingOffer = null; this.pendingIce = []; this.remoteSet = false; this.muted = false; this.startedAt = null; }

  async api(path, init = {}) {
    const r = await this.fetch(`${this.base}/v1/voice${path}`, { ...init, headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json', ...init.headers } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(body.error || `voice_http_${r.status}`), { status: r.status, code: body.error || null });
    return body;
  }
  emit(e) { try { this.onEvent(e); } catch { /* a faulty listener must not break signaling */ } }

  /** Opens signaling. Resolves when the server says ready; rejects if the ticket is refused or the socket closes first. */
  async connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    const { ticket } = await this.api('/ws-ticket', { method: 'POST', body: '{}' });
    const url = `${this.base.replace(/^http/, 'ws')}/v1/voice/ws`;
    const ws = new this.WS(url, [PROTOCOL, 'ticket.' + ticket]); this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(Error('signaling_timeout')); try { ws.close(); } catch { /* gone */ } }, 8000);
      ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m.type === 'ready') { clearTimeout(timer); resolve(); } this.handle(m).catch((e) => this.emit({ type: 'error', error: String(e && e.message || e) })); };
      ws.onerror = () => { clearTimeout(timer); reject(Error('signaling_failed')); };
      ws.onclose = (ev) => { clearTimeout(timer); reject(Error('signaling_closed')); this.emit({ type: 'signaling_closed', code: ev.code }); };
    });
    ws.onclose = (ev) => this.emit({ type: 'signaling_closed', code: ev.code });
  }
  send(m) { if (!this.ws || this.ws.readyState !== 1) throw Error('signaling_disconnected'); this.ws.send(JSON.stringify(m)); }

  async handle(m) {
    this.emit(m);
    if (m.type === 'incoming' && m.call) this.ringing.add(m.call.id);
    if (m.type === 'offer' && m.sdp && m.callId === this.callId && this.role === 'callee') { this.pendingOffer = m; this.emit({ type: 'offer_pending', callId: m.callId }); if (this.pc) await this.acceptPendingOffer(m.callId); }
    if (m.type === 'answer' && m.sdp && this.pc && m.callId === this.callId && this.role === 'caller') { await this.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); await this.markRemoteSet(); }
    if (m.type === 'ice' && m.callId === this.callId && this.pc) { if (this.remoteSet) await this.addCandidate(m.candidate); else if (this.pendingIce.length < 200) this.pendingIce.push(m.candidate); }   // candidates can outrun the offer or answer: buffer them
    if (m.type === 'state' && m.call) {
      const c = m.call;
      if (c.status === 'active' && c.id === this.callId && this.role === 'caller') { this.emit({ type: 'call_accepted', call: c }); if (this.autoStart && !this.pc) await this.startAcceptedCall(c.id); }
      if (c.status === 'active' && c.id !== this.callId && this.ringing.has(c.id)) { this.ringing.delete(c.id); this.emit({ type: 'taken_elsewhere', call: c }); }   // another of my devices answered
      if (TERMINAL.includes(c.status)) { this.ringing.delete(c.id); if (c.id === this.callId) { const reason = c.end_reason || c.status; this.cleanup(); this.emit({ type: 'call_ended', callId: c.id, status: c.status, reason }); } }
    }
  }
  async addCandidate(c) { try { await this.pc.addIceCandidate(c === null ? undefined : c); } catch { /* a stale or unusable candidate must not end the call */ } }
  async markRemoteSet() { this.remoteSet = true; const buffered = this.pendingIce.splice(0); for (const c of buffered) await this.addCandidate(c); }

  /** Microphone, peer connection and remote audio. Called only after the person started or answered a call. */
  async prepare(callId, role) {
    if (this.pc) return;
    this.callId = callId; this.role = role;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }); }
    catch (e) { this.callId = null; this.role = null; this.emit({ type: 'mic_error', name: e && e.name || 'error' }); throw e; }
    this.stream = stream;
    try {
      const { iceServers } = await this.api('/ice');
      const pc = new RTCPeerConnection({ iceServers }); this.pc = pc;
      stream.getTracks().forEach((t) => { t.enabled = !this.muted; pc.addTrack(t, stream); });
      const audio = document.createElement('audio'); audio.autoplay = true; audio.playsInline = true; audio.style.display = 'none'; document.body.appendChild(audio); this.remote = audio;
      pc.ontrack = (ev) => { audio.srcObject = ev.streams[0] || new MediaStream([ev.track]); audio.play().catch(() => this.emit({ type: 'audio_play_blocked' })); };
      pc.onicecandidate = (ev) => { try { this.send({ type: 'ice', callId, candidate: ev.candidate ? ev.candidate.toJSON() : null }); } catch { /* signaling is down: the existing media path may still work */ } };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') { if (!this.startedAt) this.startedAt = Date.now(); this.emit({ type: 'connected', callId }); }
        else if (pc.connectionState === 'disconnected') this.emit({ type: 'connection_unstable', callId });
        else if (pc.connectionState === 'failed') { this.emit({ type: 'connection_failed', callId }); this.api(`/calls/${callId}/fail`, { method: 'POST', body: '{}' }).catch(() => {}); }
      };
    } catch (e) { this.cleanup(); throw e; }
  }
  /** The caller's side, after the callee answered. */
  async startAcceptedCall(callId) { await this.prepare(callId, 'caller'); const offer = await this.pc.createOffer(); await this.pc.setLocalDescription(offer); this.send({ type: 'offer', callId, sdp: offer.sdp }); }
  async acceptPendingOffer(callId) {
    const o = this.pendingOffer; if (!o || o.callId !== callId || !this.pc) return; this.pendingOffer = null;
    await this.pc.setRemoteDescription({ type: 'offer', sdp: o.sdp }); await this.markRemoteSet();
    const answer = await this.pc.createAnswer(); await this.pc.setLocalDescription(answer); this.send({ type: 'answer', callId, sdp: answer.sdp });
  }

  async dial(extension) {
    if (this.callId) throw Error('already_in_call');
    const { call } = await this.api('/calls', { method: 'POST', body: JSON.stringify({ extension: String(extension), idempotencyKey: crypto.randomUUID() }) });
    this.callId = call.id; this.role = 'caller'; return call;
  }
  /** Prepares the microphone first, then tells the server: if the microphone is refused the call is never answered. */
  async answer(callId) {
    if (this.callId && this.callId !== callId) throw Error('already_in_call');
    await this.prepare(callId, 'callee');
    try { await this.api(`/calls/${callId}/answer`, { method: 'POST', body: '{}' }); this.ringing.delete(callId); } catch (e) { this.cleanup(); throw e; }
    await this.acceptPendingOffer(callId);
  }
  async reject(callId) { await this.api(`/calls/${callId}/reject`, { method: 'POST', body: '{}' }); this.ringing.delete(callId); if (this.callId === callId) this.cleanup(); }
  async hangup() { const id = this.callId; this.cleanup(); if (id) await this.api(`/calls/${id}/end`, { method: 'POST', body: '{}' }).catch(() => {}); }
  setMuted(muted) { this.muted = !!muted; this.stream?.getAudioTracks().forEach((t) => { t.enabled = !this.muted; }); this.emit({ type: 'muted', muted: this.muted }); }

  /** Quality numbers from the browser's own statistics (no audio content). Used by diagnostics and tests. */
  async stats() {
    if (!this.pc) return null;
    const out = { connectionState: this.pc.connectionState, iceConnectionState: this.pc.iceConnectionState, bytesReceived: 0, bytesSent: 0, packetsLost: 0, jitter: 0, audioLevel: 0, totalAudioEnergy: 0, roundTripTime: null, candidateType: null, codec: null };
    const report = await this.pc.getStats(); const codecs = new Map();
    report.forEach((r) => { if (r.type === 'codec') codecs.set(r.id, r.mimeType); });
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') { out.bytesReceived += r.bytesReceived || 0; out.packetsLost += r.packetsLost || 0; out.jitter = r.jitter || 0; out.audioLevel = r.audioLevel || 0; out.totalAudioEnergy = r.totalAudioEnergy || 0; out.codec = codecs.get(r.codecId) || out.codec; }
      if (r.type === 'outbound-rtp' && r.kind === 'audio') out.bytesSent += r.bytesSent || 0;
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) { out.roundTripTime = r.currentRoundTripTime ?? null; const l = report.get(r.localCandidateId); out.candidateType = l && l.candidateType || null; }
    });
    return out;
  }

  cleanup() {
    this.stream?.getTracks().forEach((t) => t.stop()); try { this.pc?.close(); } catch { /* already closed */ } this.remote?.remove(); this.reset();
  }
  disconnect() { this.cleanup(); try { this.ws?.close(); } catch { /* gone */ } this.ws = null; }
}
export default QorllaVoiceClient;
