import type { Offer } from './sdp.js';

/**
 * PROVIDER-NEUTRAL SIP ADAPTER (A4.2). The admission and the media gateway depend on THESE types only; a carrier-specific ingress (SIP/TLS from a trunk provider, a SIP proxy in front, a session border controller)
 * implements them. `udp-ingress.ts` is the development implementation used by the synthetic phones in the tests. Nothing here talks to a carrier.
 *
 * Guarantees every implementation must give the admission:
 *  - `onInvite` fires AT MOST ONCE per call, however often the network retransmits the INVITE or the carrier forks it (duplicate protection).
 *  - Nothing reaches `onInvite` unless the caller was authenticated (trunk credential and/or allowed source) and the request is within limits; unauthorised or malformed requests are answered and dropped here.
 *  - `ended` fires AT MOST ONCE per call with exactly one reason, for every way a call can end (CANCEL, BYE, our hang-up, no ACK, transport failure, shutdown).
 *  - A call that has not been answered holds NO media resources.
 */
export type EndReason = 'cancelled' | 'remote_bye' | 'local_hangup' | 'rejected' | 'no_ack' | 'answer_failed' | 'shutdown' | 'handler_error' | 'transport_error';
export interface InboundCall {
  /** Stable id for this call across the admission, the ledger and the media gateway: derived from the SIP Call-ID + From tag, never the raw Call-ID. */
  readonly callId: string;
  readonly caller: string;                                 // From user part, validated (digits and '+', at most 20)
  readonly dialed: string;                                 // To / request-URI user part, validated the same way
  readonly principal: string;                              // the authenticated trunk / credential name
  readonly source: { address: string; port: number };      // where the INVITE came from (the media address must match it, see sdp.ts)
  readonly offer: Offer;                                   // parsed and syntactically valid; codec / encryption acceptability is decided when answering
  readonly state: 'ringing' | 'answered' | 'ended';
  /** 200 OK with the SDP answer; resolves once the ACK has arrived (the dialog is established), rejects if it never does. Must be called at most once. */
  answer(sdp: string): Promise<void>;
  /** Final failure response (4xx-6xx) while ringing. No effect afterwards. */
  reject(status: number, reason: string): void;
  /** BYE for an answered call (idempotent). */
  hangup(reason?: string): void;
  onEnded(listener: (reason: EndReason) => void): void;
}
export type SipHealth = { listening: boolean; activeCalls: number; invitesAccepted: number; invitesRejected: Record<string, number>; retransmissionsAbsorbed: number; lastErrorAt?: number; lastError?: string };
export interface SipIngress {
  onInvite(handler: (call: InboundCall) => void | Promise<void>): void;
  start(): Promise<{ address: string; port: number }>;
  /** Hangs up every call and stops listening. Idempotent. */
  stop(): Promise<void>;
  health(): SipHealth;
}
export type LogLine = Record<string, unknown> & { event: string };
export type Logger = (line: LogLine) => void;
