/** Qorlla external telephone admission. All external PSTN paths default DENY. */
export type Readiness = {
  carrierConnected: boolean;
  inboundNumberCertified: boolean;
  gatewayHealthy: boolean;
  mediaBridgeCertified: boolean;
  billingCertified: boolean;
  productionApproved: boolean;
};
/** The six conditions, named explicitly. Readiness is judged against THIS list, never against whatever keys the caller happened to supply. */
export const READINESS_KEYS = ['carrierConnected', 'inboundNumberCertified', 'gatewayHealthy', 'mediaBridgeCertified', 'billingCertified', 'productionApproved'] as const;
export type JoinRequest = { meetingId: string; passcode: string; callId: string; dialedNumber: string };
export type MeetingDecision = { allowed: boolean; requiresHostApproval: boolean; meetingSessionId?: string };
export interface MeetingAuthority {
  verifyPhoneJoin(meetingId: string, passcode: string): Promise<MeetingDecision>;
  requestHostApproval(meetingSessionId: string, callId: string): Promise<boolean>;
}
export interface SipRtpBridge {
  /** Must attach authenticated PSTN audio to the actual meeting SFU/mixer, not just signal success. */
  attach(callId: string, meetingSessionId: string): Promise<{ mediaEstablished: boolean }>;
  /** Must be idempotent and safe to call for a call that never finished attaching. */
  disconnect(callId: string): Promise<void>;
}
/**
 * Durable, shared replay/idempotency record for call ids (PostgreSQL or Redis in production). claim() must be atomic: it returns true for exactly one caller per callId.
 * release() frees the id after a FAILED admission so the gateway may retry; a connected call keeps its claim until the call ends.
 */
export interface CallLedger {
  claim(callId: string): Promise<boolean>;
  release(callId: string): Promise<void>;
}
export type AdmissionResult = { status: 200 | 403 | 409 | 503; code: string; announcement: string };
export type AdmissionOptions = {
  ledger?: CallLedger;
  /** Meeting lookup and media attach must answer within this time (default 10 s). */
  stepTimeoutMs?: number;
  /** How long the gateway waits for the host (default 60 s). Silence is a refusal. */
  hostApprovalTimeoutMs?: number;
};
export const UNAVAILABLE_MESSAGE = 'Joining a Qorlla meeting by telephone is not available at this time. Please use the Qorlla app or meeting link.';
const DENIED = 'Unable to join this meeting.';

/** True only when every one of the six conditions is exactly `true`. A missing, undefined, truthy-but-not-true or non-object readiness is NOT ready. */
export function telephoneReady(r: Readiness | null | undefined): boolean {
  if (!r || typeof r !== 'object') return false;
  return READINESS_KEYS.every((k) => (r as Record<string, unknown>)[k] === true);
}

class StepTimeout extends Error { constructor(readonly step: string) { super(`${step} timed out`); } }
function within<T>(step: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const clock = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StepTimeout(step)), ms); });
  return Promise.race([work, clock]).finally(() => clearTimeout(timer));
}

export async function admitTelephoneCall(
  req: JoinRequest,
  readiness: Readiness,
  authority: MeetingAuthority,
  bridge: SipRtpBridge,
  options: AdmissionOptions = {}
): Promise<AdmissionResult> {
  const stepMs = options.stepTimeoutMs ?? 10_000, hostMs = options.hostApprovalTimeoutMs ?? 60_000;
  if (!telephoneReady(readiness)) return { status: 503, code: 'PHONE_JOIN_UNAVAILABLE', announcement: UNAVAILABLE_MESSAGE };
  if (typeof req?.meetingId !== 'string' || typeof req.passcode !== 'string' || typeof req.callId !== 'string' || typeof req.dialedNumber !== 'string' ||
      !/^[-A-Za-z0-9]{6,64}$/.test(req.meetingId) || req.passcode.length < 4 || req.passcode.length > 128 ||
      !/^[-A-Za-z0-9_:]{8,128}$/.test(req.callId) || !/^\+[1-9]\d{5,14}$/.test(req.dialedNumber)) {
    return { status: 403, code: 'INVALID_JOIN_REQUEST', announcement: DENIED };
  }
  // The same call id is admitted at most once (a retried or replayed webhook cannot attach a second leg).
  let claimed = false;
  if (options.ledger) {
    try { claimed = await within('ledger', stepMs, options.ledger.claim(req.callId)); }
    catch { return { status: 503, code: 'PHONE_JOIN_UNAVAILABLE', announcement: UNAVAILABLE_MESSAGE }; }
    if (!claimed) return { status: 409, code: 'DUPLICATE_CALL', announcement: DENIED };
  }
  const giveUp = async () => { if (claimed) await options.ledger!.release(req.callId).catch(() => undefined); };

  let decision: MeetingDecision;
  try { decision = await within('meeting', stepMs, authority.verifyPhoneJoin(req.meetingId, req.passcode)); }
  catch { await giveUp(); return { status: 503, code: 'MEETING_SERVICE_UNAVAILABLE', announcement: UNAVAILABLE_MESSAGE }; }
  if (!decision || decision.allowed !== true || typeof decision.meetingSessionId !== 'string' || !decision.meetingSessionId) { await giveUp(); return { status: 403, code: 'JOIN_DENIED', announcement: DENIED }; }

  if (decision.requiresHostApproval !== false) {                                                       // approval is required unless the meeting says, explicitly, that it is not
    let approved = false, timedOut = false;
    try { approved = (await within('host approval', hostMs, authority.requestHostApproval(decision.meetingSessionId, req.callId))) === true; }
    catch (e) { timedOut = e instanceof StepTimeout; if (!timedOut) { await giveUp(); return { status: 503, code: 'MEETING_SERVICE_UNAVAILABLE', announcement: UNAVAILABLE_MESSAGE }; } }
    if (!approved) { await giveUp(); return timedOut ? { status: 403, code: 'HOST_APPROVAL_TIMEOUT', announcement: 'The meeting host did not respond.' } : { status: 403, code: 'HOST_APPROVAL_DENIED', announcement: 'The meeting host did not approve this request.' }; }
  }

  try {
    const media = await within('media bridge', stepMs, bridge.attach(req.callId, decision.meetingSessionId));
    if (!media || media.mediaEstablished !== true) throw new Error('Media not established');
    return { status: 200, code: 'MEDIA_CONNECTED', announcement: 'You are now connected to the meeting.' };
  } catch {
    // The bridge may have partly attached before failing or timing out: always tear down, whatever the reason, and free the call id for a retry.
    await bridge.disconnect(req.callId).catch(() => undefined);
    await giveUp();
    return { status: 503, code: 'MEDIA_UNAVAILABLE', announcement: UNAVAILABLE_MESSAGE };
  }
}
