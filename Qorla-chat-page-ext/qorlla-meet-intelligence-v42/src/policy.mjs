export class PolicyError extends Error { constructor(code,status=403){super(code);this.code=code;this.status=status;} }
export function assertPrincipal(p,occurrenceId){
 if(!p || !p.actorId || p.occurrenceId!==occurrenceId || p.active!==true) throw new PolicyError('meet_membership_required');
 return p;
}
export function assertFeature(value){if(value!==true)throw new PolicyError('feature_unavailable',503);}
export function assertConsent(consent,kind){if(!consent || consent.granted!==true || consent.kind!==kind)throw new PolicyError('consent_required',409);}
export function safeAIOutput(v,max=16000){if(typeof v!=='string'||v.length>max)throw new PolicyError('invalid_ai_output',502);return v;}
