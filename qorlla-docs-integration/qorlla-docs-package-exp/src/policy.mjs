// Defaults only. Production must resolve entitlements from the existing SBACS service.
export const PLAN_DEFAULTS = Object.freeze({
  free:{maxDocuments:5,history:10,shareLimit:0,comments:false,live:false,importExport:false,ai:false},
  pro:{maxDocuments:500,history:100,shareLimit:5,comments:true,live:false,importExport:true,ai:true},
  business:{maxDocuments:5000,history:500,shareLimit:null,comments:true,live:true,importExport:true,ai:true},
  enterprise:{maxDocuments:null,history:null,shareLimit:null,comments:true,live:true,importExport:true,ai:true}
});
export function policyFor(plan, overrides={}) {
  const base=PLAN_DEFAULTS[String(plan).toLowerCase()];
  if(!base) throw Object.assign(new Error('Unknown plan; deny by default'),{status:403,code:'unknown_plan'});
  return {...base,...overrides};
}
export function requireFeature(policy, feature){
  if(policy[feature]!==true) throw Object.assign(new Error('Feature not included in subscription'),{status:403,code:'entitlement_required'});
}
