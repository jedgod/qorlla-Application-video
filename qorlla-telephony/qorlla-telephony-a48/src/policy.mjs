export class PolicyError extends Error {
  constructor(code, status=403) { super(code); this.code=code; this.status=status; }
}
export function normalizedDestination(kind, value) {
  if (kind === 'internal' && /^ext:[A-Za-z0-9_-]{1,64}$/.test(value)) return value;
  if (kind === 'external' && /^\+[1-9]\d{7,14}$/.test(value)) return value;
  throw new PolicyError('INVALID_DESTINATION', 422);
}
export function decideCall({kind,destination,config,identity,shield,entitlements,carrier}) {
  if (!identity?.tenantId || !identity?.userId || !identity?.active) throw new PolicyError('UNAUTHENTICATED',401);
  if (!shield?.allow) throw new PolicyError('SHIELD_DENIED');
  if (!entitlements?.voice) throw new PolicyError('SUBSCRIPTION_DENIED');
  const target=normalizedDestination(kind,destination);
  if (kind === 'internal') {
    if (!config.internalEnabled) throw new PolicyError('INTERNAL_CALLS_DISABLED');
    if (!entitlements.internalCalls) throw new PolicyError('INTERNAL_CALLS_NOT_ENTITLED');
    return {kind,target,carrierId:null};
  }
  if (kind !== 'external') throw new PolicyError('INVALID_CALL_KIND',422);
  if (!config.externalEnabled) throw new PolicyError('PSTN_DISABLED');
  if (!entitlements.externalCalls) throw new PolicyError('EXTERNAL_CALLS_NOT_ENTITLED');
  if (!carrier?.certified || !carrier?.outbound || !carrier?.healthy) throw new PolicyError('CARRIER_NOT_READY');
  if (!carrier?.allowedPrefixes?.some(p=>target.startsWith(p))) throw new PolicyError('DESTINATION_NOT_CERTIFIED');
  if (!config.emergencyPolicyCertified && config.emergencyNumbers?.includes(target)) throw new PolicyError('EMERGENCY_UNAVAILABLE');
  if (!entitlements?.fundingAuthorized) throw new PolicyError('BILLING_AUTHORIZATION_REQUIRED');
  return {kind,target,carrierId:carrier.id};
}
export const transitions=Object.freeze({
 authorized:['ringing','failed','ended'], ringing:['answered','failed','ended'],
 answered:['media_verifying','failed','ended'],media_verifying:['connected','failed','ended'],
 connected:['ended','failed'],ended:[],failed:[]
});
export function canTransition(from,to,evidence={}) {
 if (!transitions[from]?.includes(to)) return false;
 if (to==='connected') return evidence.encrypted===true && evidence.inboundAudio===true && evidence.outboundAudio===true && evidence.gatewayVerified===true;
 return true;
}
