export class VoiceError extends Error { constructor(code,status=403){super(code);this.code=code;this.status=status;} }
export function classifyDial(raw){
 if(typeof raw!=='string'||raw.length>64)throw new VoiceError('invalid_destination',400);
 const s=raw.trim().replace(/[\s().-]/g,'');
 if(s.startsWith('00'))throw new VoiceError('international_prefix_requires_plus',400);
 if(s.startsWith('+')){
  if(!/^\+[1-9][0-9]{6,14}$/.test(s))throw new VoiceError('invalid_e164',400);
  return {kind:'external',number:s};
 }
 if(!/^[0-9]{4,15}$/.test(s))throw new VoiceError('invalid_internal_number',400);
 return {kind:'internal',number:s};
}
export function requireExternalEnabled(env){if(env.VOICE_PSTN_ENABLED!=='true'||env.VOICE_A38_ENABLED!=='true')throw new VoiceError('feature_disabled');}
export function requireEligible(principal){if(!principal||!principal.verified||principal.suspended||!principal.accountId||!principal.tenantId)throw new VoiceError('account_ineligible');}
export function requireCorridor(origin,destination,allowed){if(!allowed.some(x=>x.origin===origin&&x.destination===destination&&x.enabled===true))throw new VoiceError('corridor_blocked');}
export function requireDestination(number, metadata){const parsed=metadata.parse(number);if(!parsed?.valid||!parsed.country||parsed.type==='premium'||parsed.type==='emergency'||parsed.type==='unknown')throw new VoiceError('destination_blocked');return parsed;}
export function requireAuthorizedCallerId(value,allowlist){if(value!=null&&!allowlist.includes(value))throw new VoiceError('caller_id_not_authorized');}
