/** A3.7 pure dial classification. No network or billable action. */
export function classifyDial(raw) {
  if (typeof raw !== 'string') return {kind:'INVALID',reason:'Number must be text'};
  const value=raw.trim().replace(/[\s().-]/g,'');
  if (value.startsWith('+')) {
    return /^\+[1-9]\d{6,14}$/.test(value)
      ? {kind:'EXTERNAL_REQUEST',e164:value}
      : {kind:'INVALID',reason:'Invalid international format'};
  }
  if (value.startsWith('00')) return {kind:'INVALID',reason:'Use +country code for international calls'};
  if (/^\d{4,15}$/.test(value)) return {kind:'INTERNAL_LOOKUP',national:value};
  return {kind:'INVALID',reason:'Use a local Qorlla number or +country code'};
}
/** This only routes to policy services; it must never initiate PSTN by itself. */
export async function prepareCall({dial,principal,services}) {
  if (!principal?.verified || principal?.suspended) return {status:'DENIED',reason:'ACCOUNT_INELIGIBLE'};
  const parsed=classifyDial(dial);
  if (parsed.kind==='INVALID') return {status:'INVALID',reason:parsed.reason};
  if (parsed.kind==='INTERNAL_LOOKUP') {
    const target=await services.lookupInternal({national:parsed.national,country:principal.verifiedCountry,tenantId:principal.tenantId});
    if (!target) return {status:'NOT_FOUND',reason:'QORLLA_USER_NOT_FOUND'};
    const allowed=await services.authorizeInternal({principal,target});
    return allowed ? {status:'INTERNAL_READY',targetId:target.id} : {status:'DENIED',reason:'INTERNAL_POLICY'};
  }
  if (!services.flags.VOICE_PSTN_ENABLED) return {status:'UNAVAILABLE',reason:'PSTN_DISABLED'};
  const eligibility=await services.authorizeExternal({principal,e164:parsed.e164});
  if (!eligibility.allowed) return {status:'DENIED',reason:eligibility.reason};
  const quote=await services.quoteExternal({principal,e164:parsed.e164});
  if (!quote?.quoteId || !quote?.expiresAt) return {status:'UNAVAILABLE',reason:'RATE_UNAVAILABLE'};
  return {status:'EXTERNAL_CONFIRMATION_REQUIRED',e164:parsed.e164,quote};
}
