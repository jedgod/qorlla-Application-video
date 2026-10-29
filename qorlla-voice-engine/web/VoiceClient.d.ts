// Types for VoiceClient.mjs (the SDK itself is plain JavaScript so it needs no build step).
export type VoiceCall = { id: string; caller_id: string; callee_id: string; status: 'ringing' | 'active' | 'rejected' | 'missed' | 'ended' | 'failed'; created_at: string; answered_at: string | null; ended_at: string | null; end_reason: string | null };
export type VoiceMember = { account_id: string; extension: string; role: 'host' | 'member'; status: 'invited' | 'joined'; generation: number; joined_at: string | null };
export type VoiceRoom = { id: string; title: string; host_id: string; meeting_ref: string | null; status: 'live' | 'ended'; max_members: number; created_at: string; ended_at: string | null; end_reason: string | null; members: VoiceMember[] };
type Durable = { eventId?: number; replayed?: boolean };
export type VoiceEvent =
  | ({ type: 'ready'; extension: string; deviceId: string; cursor: number })
  | ({ type: 'incoming'; call: VoiceCall; from: { extension: string | null } } & Durable)
  | ({ type: 'state'; call: VoiceCall } & Durable)
  | { type: 'call_accepted'; call: VoiceCall }
  | { type: 'offer_pending'; callId: string }
  | { type: 'connected' | 'connection_unstable' | 'connection_failed'; callId: string }
  | { type: 'connection_recovering'; callId: string; attempt: number; reason: string }
  | { type: 'call_ended'; callId: string; status: string; reason: string }
  | { type: 'taken_elsewhere'; call: VoiceCall }
  | { type: 'call_available'; call: VoiceCall; role: 'caller' | 'callee'; peer_extension: string | null }
  | { type: 'call_resumed'; call?: VoiceCall; room?: VoiceRoom }
  | { type: 'device_replaced'; callId?: string; roomId?: string }
  | { type: 'lease_lost'; callId?: string; roomId?: string }
  | ({ type: 'room_invite'; room: VoiceRoom; from: { extension: string | null; account_id?: string } } & Durable)
  | ({ type: 'room_state'; room: VoiceRoom } & Durable)
  | { type: 'room_joined'; room: VoiceRoom }
  | { type: 'room_available'; room: VoiceRoom }
  | { type: 'room_ended'; roomId: string; reason: string }
  | { type: 'peer_connected' | 'peer_unstable' | 'peer_failed'; account: string }
  | { type: 'muted'; muted: boolean }
  | { type: 'audio_play_blocked' }
  | { type: 'mic_error'; name: string }
  | { type: 'signaling_closed'; code: number }
  | { type: 'error'; error: string };
export type VoiceStats = { connectionState: string; iceConnectionState: string; bytesReceived: number; bytesSent: number; packetsLost: number; jitter: number; audioLevel: number; totalAudioEnergy: number; roundTripTime: number | null; candidateType: string | null; codec: string | null };
export type GroupHistoryItem = { call_id: string; room_name: string; room_status: 'live' | 'ended'; created_at: string; started_at: string | null; ended_at: string | null; end_reason: string | null; role: 'host' | 'member'; status: 'ringing' | 'ongoing' | 'completed' | 'declined' | 'missed' | 'cancelled' | 'kicked'; duration_seconds: number; participants: number };
export type GroupHistoryDetail = GroupHistoryItem & { segments: { segment_id: string; joined_at: string; left_at: string | null }[]; events: { event_type: string; occurred_at: string; subject_scope: 'self' | 'other' }[] };
export class EventLog { constructor(limit?: number); cursor: number; accept(id: number | undefined): boolean; }
export function collapseReplay(events: { id: number; kind: string; payload: any }[]): { id: number; kind: string; payload: any }[];
export class QorllaVoiceClient {
  constructor(base: string, token: () => Promise<string>, onEvent?: (e: VoiceEvent) => void, opts?: { WebSocketImpl?: typeof WebSocket; fetchImpl?: typeof fetch; deviceId?: string });
  deviceId: string; me: string | null; callId: string | null; role: 'caller' | 'callee' | null; generation: number; muted: boolean; startedAt: number | null; room: VoiceRoom | null; autoStart: boolean; autoResume: boolean;
  connect(): Promise<void>; disconnect(): void;
  dial(extension: string): Promise<VoiceCall>; answer(callId: string): Promise<void>; reject(callId: string): Promise<void>; hangup(): Promise<void>; setMuted(muted: boolean): void;
  continueHere(call: VoiceCall, role: 'caller' | 'callee'): Promise<void>; resumeCall(call: VoiceCall, role: 'caller' | 'callee'): Promise<void>;
  createRoom(extensions: string[], title?: string): Promise<VoiceRoom>; joinRoom(roomId: string): Promise<VoiceRoom>; resumeRoom(room: VoiceRoom): Promise<VoiceRoom>; declineRoom(roomId: string): Promise<void>;
  inviteToRoom(extension: string): Promise<any>; kickFromRoom(accountId: string): Promise<any>; leaveRoom(): Promise<void>; endRoom(): Promise<void>;
  groupHistory(o?: { limit?: number; cursor?: string }): Promise<{ items: GroupHistoryItem[]; nextCursor: string | null }>; groupHistoryDetail(callId: string): Promise<GroupHistoryDetail>;
  deleteGroupHistory(callId: string): Promise<{ deleted: number; retained: number }>; clearGroupHistory(): Promise<{ deleted: number; retained: number; remaining: number; skippedLive: number }>; historyPolicy(): Promise<{ retentionDays: number; retentionEnabled: boolean; deletable: string }>;
  stats(): Promise<VoiceStats | null>; roomStats(): Promise<Record<string, VoiceStats | null>>;
  api(path: string, init?: RequestInit): Promise<any>;
}
export default QorllaVoiceClient;
