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
/** `callerNumber` is the caller's number as the carrier reports it (E.164). Meet keeps its per-caller attempt limits and bans on it, so a gateway that has it must send it. */
export type JoinRequest = { meetingId: string; passcode: string; callId: string; dialedNumber: string; callerNumber?: string };
export type MeetingDecision = { allowed: boolean; requiresHostApproval: boolean; meetingSessionId?: string };
/** Passed to every dependency call. When a step times out the signal is aborted: implementations should stop their work (cancel the fetch, close the socket, abort the SIP INVITE). */
export type StepOptions = { signal: AbortSignal };
/** What the meeting service needs to know about the call being admitted. */
export type VerifyOptions = StepOptions & { callId: string; dialedNumber: string; callerNumber?: string };
export interface MeetingAuthority {
  verifyPhoneJoin(meetingId: string, passcode: string, opts?: VerifyOptions): Promise<MeetingDecision>;
  requestHostApproval(meetingSessionId: string, callId: string, opts?: StepOptions): Promise<boolean>;
  /** Called when an admission that reached the meeting (a waiting caller, a pending approval) ends without connecting, so the meeting does not keep a ghost participant. Best effort; must be idempotent. */
  cancelAdmission?(meetingSessionId: string, callId: string): Promise<void>;
}
export interface SipRtpBridge {
  /**
   * Must attach authenticated PSTN audio to the actual meeting SFU/mixer, not just signal success. `mediaEstablished: true` means AUDIO WAS VERIFIED in both directions (see media-contract.ts),
   * never merely that signalling succeeded. May be cancelled through `opts.signal`; a bridge that cannot cancel is still safe, because the gateway terminates any leg it creates late.
   */
  attach(callId: string, meetingSessionId: string, opts?: StepOptions): Promise<{ mediaEstablished: boolean }>;
  /** Must be idempotent and safe to call for a call that never finished attaching, is attaching right now, or attaches later. */
  disconnect(callId: string): Promise<void>;
}
/** Durable lifecycle of one admission. connected/ended are kept; failed/orphaned are terminal for that attempt. */
export type CallState = 'claimed' | 'authorizing' | 'awaiting_host' | 'attaching' | 'connected' | 'failed' | 'terminating' | 'ended' | 'orphaned';
/**
 * Durable, shared ownership record for call ids (PostgreSQL in production; see ledger-pg.ts). claim() must be atomic across every gateway replica: it returns true for exactly one caller per callId.
 * release() frees the id after a FAILED admission so the gateway may retry; a connected call keeps its claim until the call ends. transition() moves the durable state forward (never backwards);
 * it returns false when the move is not allowed from the current state.
 */
export interface CallLedger {
  claim(callId: string): Promise<boolean>;
  release(callId: string): Promise<void>;
  transition?(callId: string, to: CallState, detail?: { meetingSessionId?: string; reason?: string }): Promise<boolean>;
}
export type AdmissionResult = { status: 200 | 403 | 409 | 503; code: string; announcement: string };
export type AdmissionOptions = {
  ledger?: CallLedger;
  /** Meeting lookup and media attach must answer within this time (default 10 s). */
  stepTimeoutMs?: number;
  /** Each durable ledger operation must finish within this time (default 5 s); a ledger that does not answer stops the admission. */
  ledgerTimeoutMs?: number;
  /** How long the gateway waits for the host (default 60 s). Silence is a refusal. */
  hostApprovalTimeoutMs?: number;
  /** A media leg that was created AFTER its step timed out was found and terminated (`terminated` false: the teardown itself failed and operators must act). */
  onLateMedia?: (callId: string, terminated: boolean) => void;
};
export const UNAVAILABLE_MESSAGE = 'Joining a Qorlla meeting by telephone is not available at this time. Please use the Qorlla app or meeting link.';
const DENIED = 'Unable to join this meeting.';

/** True only when every one of the six conditions is exactly `true`. A missing, undefined, truthy-but-not-true or non-object readiness is NOT ready. */
export function telephoneReady(r: Readiness | null | undefined): boolean {
  if (!r || typeof r !== 'object') return false;
  return READINESS_KEYS.every((k) => (r as Record<string, unknown>)[k] === true);
}

class StepTimeout extends Error { constructor(readonly step: string) { super(`${step} timed out`); } }
/** Runs `work(signal)` with a deadline. On timeout the signal is ABORTED (so the work can stop) and StepTimeout is thrown; the returned `settled` promise still reports how the work finally ended. */
function withDeadline<T>(step: string, ms: number, work: (signal: AbortSignal) => Promise<T>): { result: Promise<T>; settled: Promise<{ ok: true; value: T } | { ok: false; error: unknown }> } {
  const ctl = new AbortController(); let timer: ReturnType<typeof setTimeout>;
  const started = Promise.resolve().then(() => work(ctl.signal));
  const settled = started.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));
  const clock = new Promise<never>((_, reject) => { timer = setTimeout(() => { ctl.abort(new StepTimeout(step)); reject(new StepTimeout(step)); }, ms); });
  const result = Promise.race([started, clock]).finally(() => clearTimeout(timer));
  result.catch(() => undefined);                                                                       // the rejection is handled by the caller; this only prevents an unhandled-rejection warning
  return { result, settled };
}

export async function admitTelephoneCall(
  req: JoinRequest,
  readiness: Readiness,
  authority: MeetingAuthority,
  bridge: SipRtpBridge,
  options: AdmissionOptions = {}
): Promise<AdmissionResult> {
  const stepMs = options.stepTimeoutMs ?? 10_000, ledgerMs = options.ledgerTimeoutMs ?? 5_000, hostMs = options.hostApprovalTimeoutMs ?? 60_000, ledger = options.ledger;
  if (!telephoneReady(readiness)) return { status: 503, code: 'PHONE_JOIN_UNAVAILABLE', announcement: UNAVAILABLE_MESSAGE };
  if (typeof req?.meetingId !== 'string' || typeof req.passcode !== 'string' || typeof req.callId !== 'string' || typeof req.dialedNumber !== 'string' || (req.callerNumber !== undefined && (typeof req.callerNumber !== 'string' || !/^\+[1-9]\d{5,14}$/.test(req.callerNumber))) ||
      !/^[-A-Za-z0-9]{6,64}$/.test(req.meetingId) || req.passcode.length < 4 || req.passcode.length > 128 ||
      !/^[-A-Za-z0-9_:]{8,128}$/.test(req.callId) || !/^\+[1-9]\d{5,14}$/.test(req.dialedNumber)) {
    return { status: 403, code: 'INVALID_JOIN_REQUEST', announcement: DENIED };
  }
  // The same call id is admitted at most once ACROSS ALL GATEWAY REPLICAS: the ledger's claim is atomic (a PostgreSQL unique constraint), so a retried or replayed webhook cannot attach a second leg.
  let claimed = false;
  if (ledger) {
    try { claimed = await withDeadline('ledger', ledgerMs, () => ledger.claim(req.callId)).result; }
    catch { return { status: 503, code: 'PHONE_JOIN_UNAVAILABLE', announcement: UNAVAILABLE_MESSAGE }; }
    if (!claimed) return { status: 409, code: 'DUPLICATE_CALL', announcement: DENIED };
  }
  const mark = async (to: CallState, detail?: { meetingSessionId?: string; reason?: string }) => {       // a durable state change that could not be recorded stops the admission (fail closed)
    if (!ledger?.transition) return;
    if (!(await withDeadline('ledger', ledgerMs, () => ledger.transition!(req.callId, to, detail)).result)) throw new Error('ledger refused ' + to);
  };
  let sessionId: string | undefined;
  const giveUp = async (reason: string, state: CallState = 'failed') => {
    if (sessionId && authority.cancelAdmission) await authority.cancelAdmission(sessionId, req.callId).catch(() => undefined);
    if (claimed) { await ledger!.transition?.(req.callId, state, { meetingSessionId: sessionId, reason }).catch(() => false); await ledger!.release(req.callId).catch(() => undefined); }
  };

  let decision: MeetingDecision;
  try { await mark('authorizing'); decision = await withDeadline('meeting', stepMs, (signal) => authority.verifyPhoneJoin(req.meetingId, req.passcode, { signal, callId: req.callId, dialedNumber: req.dialedNumber, callerNumber: req.callerNumber })).result; }
  catch { await giveUp('meeting_service_unavailable'); return { status: 503, code: 'MEETING_SERVICE_UNAVAILABLE', announcement: UNAVAILABLE_MESSAGE }; }
  if (!decision || decision.allowed !== true || typeof decision.meetingSessionId !== 'string' || !decision.meetingSessionId) { await giveUp('join_denied'); return { status: 403, code: 'JOIN_DENIED', announcement: DENIED }; }
  sessionId = decision.meetingSessionId;

  if (decision.requiresHostApproval !== false) {                                                       // approval is required unless the meeting says, explicitly, that it is not
    let approved = false, timedOut = false;
    try {
      await mark('awaiting_host', { meetingSessionId: sessionId });
      approved = (await withDeadline('host approval', hostMs, (signal) => authority.requestHostApproval(sessionId!, req.callId, { signal })).result) === true;
    } catch (e) { timedOut = e instanceof StepTimeout; if (!timedOut) { await giveUp('meeting_service_unavailable'); return { status: 503, code: 'MEETING_SERVICE_UNAVAILABLE', announcement: UNAVAILABLE_MESSAGE }; } }
    if (!approved) { await giveUp(timedOut ? 'host_approval_timeout' : 'host_approval_denied'); return timedOut ? { status: 403, code: 'HOST_APPROVAL_TIMEOUT', announcement: 'The meeting host did not respond.' } : { status: 403, code: 'HOST_APPROVAL_DENIED', announcement: 'The meeting host did not approve this request.' }; }
  }

  // The media step. Timing out does not just stop waiting: the attempt is ABORTED, the leg is torn down now, and the still-running attach is watched so that a leg it creates LATER is found and terminated too.
  let attempt: ReturnType<typeof withDeadline<{ mediaEstablished: boolean }>> | undefined, attachSettled = false;
  try {
    await mark('attaching', { meetingSessionId: sessionId });
    attempt = withDeadline('media bridge', stepMs, (signal) => bridge.attach(req.callId, sessionId!, { signal }));
    void attempt.settled.then(() => { attachSettled = true; });
    const media = await attempt.result;
    if (!media || media.mediaEstablished !== true) throw new Error('Media not established');
    await mark('connected', { meetingSessionId: sessionId });
    return { status: 200, code: 'MEDIA_CONNECTED', announcement: 'You are now connected to the meeting.' };
  } catch {
    const watch = attempt?.settled;
    await bridge.disconnect(req.callId).catch(() => undefined);                                         // the bridge may have half-attached: tear down whatever exists now
    if (watch && !attachSettled) {
      // The attach is still running (it timed out). Keep the call id claimed in 'terminating' so a retry cannot be confused with the leg that may still appear; when the attach finally ends,
      // any leg it created is terminated, the outcome is recorded, and only then is the id released.
      if (claimed) await ledger!.transition?.(req.callId, 'terminating', { meetingSessionId: sessionId, reason: 'media_timeout' }).catch(() => false);
      if (sessionId && authority.cancelAdmission) await authority.cancelAdmission(sessionId, req.callId).catch(() => undefined);
      void watch.then(async (outcome) => {
        let terminated = false;
        for (let i = 0; i < 3 && !terminated; i++) { try { await bridge.disconnect(req.callId); terminated = true; } catch { /* retry */ } }
        if (outcome.ok || !terminated) options.onLateMedia?.(req.callId, terminated);
        if (claimed && ledger) { await ledger.transition?.(req.callId, terminated ? 'failed' : 'orphaned', { reason: outcome.ok ? 'late_media' : 'media_error' }).catch(() => false); if (terminated) await ledger.release(req.callId).catch(() => undefined); }
      });
    } else await giveUp('media_unavailable');
    return { status: 503, code: 'MEDIA_UNAVAILABLE', announcement: UNAVAILABLE_MESSAGE };
  }
}
