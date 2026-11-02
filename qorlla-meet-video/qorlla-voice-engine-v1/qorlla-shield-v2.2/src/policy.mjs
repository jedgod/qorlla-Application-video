/** Pure fail-closed policy. Caller MUST supply trusted server-side context. */
export const OPERATIONS = Object.freeze(['guest.meeting.join','meeting.host','meeting.media.join','voice.internal','voice.pstn','voice.number.assign','message.send','org.manage','admin.manage']);
export function decide(c) {
  const deny = reason => ({allow:false,reason});
  if (!c || !OPERATIONS.includes(c.operation) || !c.principal || !c.resource) return deny('INVALID_CONTEXT');
  const p=c.principal, r=c.resource;
  if (p.suspended || p.orgSuspended) return deny('SUSPENDED');
  if (p.kind==='guest') return deny('GUEST_ADMISSION_ONLY');
  if (p.kind!=='user' || !p.id || !p.verified) return deny('UNVERIFIED');
  if (p.risk === undefined || !Number.isFinite(p.risk)) return deny('RISK_UNAVAILABLE');
  if (p.risk >= 50) return deny('RISK_REVIEW');
  if (r.orgId && (!p.orgId || p.orgId !== r.orgId)) return deny('TENANT_MISMATCH');
  if (c.operation==='guest.meeting.join') return deny('GUEST_GATEWAY_REQUIRED');
  if (['voice.number.assign','voice.pstn','org.manage','admin.manage'].includes(c.operation)) {
    if (!p.recentMfa || !p.deviceTrusted) return deny('STEP_UP_REQUIRED');
  }
  if (c.operation==='voice.number.assign') {
    if (!c.flags?.numbers || !r.providerConfirmed || !r.countryEligible) return deny('NUMBER_NOT_AUTHORIZED');
  }
  if (c.operation==='voice.pstn') {
    if (!c.flags?.pstn || !r.numberActive || !r.callerIdOwned || !r.destinationAllowed || !r.budgetAuthorized) return deny('PSTN_NOT_AUTHORIZED');
  }
  if (c.operation==='admin.manage' && !p.scopes?.includes('shield:admin:write')) return deny('SCOPE_DENIED');
  if (c.operation==='org.manage' && !p.scopes?.includes('org:manage')) return deny('SCOPE_DENIED');
  if (c.operation==='meeting.media.join' && !r.mediaAdmissionGranted) return deny('MEDIA_NOT_ADMITTED');
  return {allow:true,reason:'ALLOW'};
}
