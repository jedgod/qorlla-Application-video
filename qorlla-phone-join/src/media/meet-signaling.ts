import { io } from 'socket.io-client';
import type { SignalData, SignalingFactory, SignalingPort } from './mesh-peer.js';

/**
 * Binds the mesh peer to Qorlla Meet's real signalling relay (server/index.js): a socket.io connection authenticated with the PARTICIPANT token Meet issued for this call, a `roster` event on connect, `signal`
 * {to,data} out (acknowledged) and `signal` {from,data} in, `participant-offline` when someone leaves. The token comes from the caller (`token`), i.e. from Meet's own admission: this module never mints, stores or
 * logs one, and it connects once - a dropped signalling connection ends the session (the call is then torn down and re-admitted, never silently re-joined).
 *
 * OPEN DESIGN POINT (see docs/A4_SIP_MEDIA_GATEWAY.md): Meet admits a socket only for an `admitted` participant, while the A3 lifecycle says a telephone caller is not a participant until audio is VERIFIED - and audio
 * can only be verified after this peer has negotiated with the browsers. Which credential Meet issues for the verification phase is a Meet-side decision; this binding takes whatever token it is given.
 */
export type MeetSignalingOptions = { baseUrl: string; path?: string; token: (a: { callId: string; meetingSessionId: string; mediaToken?: string; signal: AbortSignal }) => Promise<string>; connectTimeoutMs?: number; transports?: ('websocket' | 'polling')[] };
const participantIdOf = (jwt: string): string => { try { const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')); return typeof p.participantId === 'string' ? p.participantId : ''; } catch { return ''; } };   // read-only: Meet verifies the token, we only need our own id

export function meetSignaling(o: MeetSignalingOptions): SignalingFactory {
  return async (a) => {
    const token = await o.token(a), selfId = participantIdOf(token); if (!selfId) throw new Error('the meeting token carries no participant id'); if (a.signal.aborted) throw new Error('cancelled');                  // cancelled while the token was being fetched: never connect
    const socket = io(o.baseUrl, { path: o.path ?? '/socket.io', auth: { token }, transports: o.transports ?? ['websocket'], reconnection: false, timeout: o.connectTimeoutMs ?? 8000 });
    let onSignal: (f: string, d: SignalData) => void = () => undefined, onLeft: (id: string) => void = () => undefined, onClosed: (r: string) => void = () => undefined, closed = false;
    const finish = (reason: string) => { if (closed) return; closed = true; try { socket.disconnect(); } catch { /* gone */ } onClosed(reason); };
    const roster = await new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('timed out joining the meeting signalling')); socket.disconnect(); }, o.connectTimeoutMs ?? 8000); timer.unref?.();
      const abort = () => { clearTimeout(timer); reject(new Error('cancelled')); socket.disconnect(); }; a.signal.addEventListener('abort', abort, { once: true }); if (a.signal.aborted) abort();
      socket.once('roster', (ids: unknown) => { clearTimeout(timer); a.signal.removeEventListener('abort', abort); resolve(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []); });
      socket.once('connect_error', (e: Error) => { clearTimeout(timer); a.signal.removeEventListener('abort', abort); reject(new Error('meeting signalling refused: ' + e.message)); });
    });
    socket.on('signal', (m: { from?: unknown; data?: unknown }) => { if (typeof m?.from === 'string' && m.data && typeof m.data === 'object') onSignal(m.from, m.data as SignalData); });
    socket.on('participant-offline', (p: { participantId?: unknown }) => { if (typeof p?.participantId === 'string') onLeft(p.participantId); });
    socket.on('disconnect', (reason: string) => finish('signaling_' + reason));
    const port: SignalingPort = { selfId, roster: () => roster.filter((x) => x !== selfId), send: (to, data) => { if (!closed && socket.connected) socket.emit('signal', { to, data }, () => undefined); },
      onSignal: (cb) => { onSignal = cb; }, onPeerLeft: (cb) => { onLeft = cb; }, onClosed: (cb) => { onClosed = cb; }, close: () => finish('closed') };
    return port;
  };
}
