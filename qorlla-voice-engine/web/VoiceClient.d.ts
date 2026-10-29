// Types for VoiceClient.mjs (the SDK itself is plain JavaScript so it needs no build step).
export type VoiceCall = { id: string; caller_id: string; callee_id: string; status: 'ringing' | 'active' | 'rejected' | 'missed' | 'ended' | 'failed'; created_at: string; answered_at: string | null; ended_at: string | null; end_reason: string | null };
export type VoiceEvent =
  | { type: 'ready'; extension: string }
  | { type: 'incoming'; call: VoiceCall; from: { extension: string | null } }
  | { type: 'state'; call: VoiceCall }
  | { type: 'call_accepted'; call: VoiceCall }
  | { type: 'offer_pending'; callId: string }
  | { type: 'connected' | 'connection_unstable' | 'connection_failed'; callId: string }
  | { type: 'call_ended'; callId: string; status: string; reason: string }
  | { type: 'taken_elsewhere'; call: VoiceCall }
  | { type: 'muted'; muted: boolean }
  | { type: 'audio_play_blocked' }
  | { type: 'mic_error'; name: string }
  | { type: 'signaling_closed'; code: number }
  | { type: 'error'; error: string };
export type VoiceStats = { connectionState: string; iceConnectionState: string; bytesReceived: number; bytesSent: number; packetsLost: number; jitter: number; audioLevel: number; totalAudioEnergy: number; roundTripTime: number | null; candidateType: string | null; codec: string | null };
export class QorllaVoiceClient {
  constructor(base: string, token: () => Promise<string>, onEvent?: (e: VoiceEvent) => void, opts?: { WebSocketImpl?: typeof WebSocket; fetchImpl?: typeof fetch });
  autoStart: boolean; callId: string | null; role: 'caller' | 'callee' | null; muted: boolean; startedAt: number | null;
  connect(): Promise<void>; disconnect(): void;
  dial(extension: string): Promise<VoiceCall>; answer(callId: string): Promise<void>; reject(callId: string): Promise<void>; hangup(): Promise<void>; setMuted(muted: boolean): void;
  stats(): Promise<VoiceStats | null>;
  api(path: string, init?: RequestInit): Promise<any>;
}
export default QorllaVoiceClient;
