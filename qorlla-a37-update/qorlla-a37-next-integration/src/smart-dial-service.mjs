import {classifyDial} from './dial-routing.mjs';

/** Inject actual Shield, registry, policy, rate and wallet services from engine. */
export function createSmartDialService(deps) {
  const {shield,registry,voiceEngine,flags,externalPolicy,rateService}=deps;
  return {
    async prepare({principal,dial}) {
      const parsed=classifyDial(dial);
      if(parsed.kind==='INVALID') return {status:'INVALID',reason:parsed.reason};
      if(!await shield.isEligible(principal)) return {status:'DENIED',reason:'ACCOUNT_INELIGIBLE'};
      if(parsed.kind==='INTERNAL_LOOKUP') {
        const target=await registry.lookup({national:parsed.national,country:principal.verifiedCountry});
        if(!target) return {status:'NOT_FOUND',reason:'QORLLA_USER_NOT_FOUND'};
        if(!await shield.canCall({caller:principal,target})) return {status:'DENIED',reason:'INTERNAL_POLICY'};
        return {status:'INTERNAL_READY',targetExtensionId:target.extensionId};
      }
      if(flags.VOICE_PSTN_ENABLED!==true) return {status:'UNAVAILABLE',reason:'PSTN_DISABLED'};
      const policy=await externalPolicy.authorize({principal,e164:parsed.e164});
      if(!policy?.allowed) return {status:'DENIED',reason:policy?.reason??'CORRIDOR_BLOCKED'};
      const quote=await rateService.createQuote({principal,e164:parsed.e164});
      if(!quote?.id || !quote?.expiresAt) return {status:'UNAVAILABLE',reason:'RATE_UNAVAILABLE'};
      return {status:'EXTERNAL_CONFIRMATION_REQUIRED',quoteId:quote.id,expiresAt:quote.expiresAt,
        currency:quote.currency,ratePerMinute:quote.ratePerMinute};
    },
    async startInternal({principal,targetExtensionId,idempotencyKey}) {
      if(!await shield.isEligible(principal)) throw new Error('ACCOUNT_INELIGIBLE');
      const target=await registry.byExtensionId(targetExtensionId);
      if(!target || !await shield.canCall({caller:principal,target})) throw new Error('INTERNAL_POLICY');
      // Reuse the engine's existing invitation/signaling path; do not create a parallel session.
      return voiceEngine.invite({principal,targetExtensionId,idempotencyKey});
    }
  };
}
