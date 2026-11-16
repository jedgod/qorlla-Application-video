// Optional wiring, all features disabled by default. Integration never overrides legacy phone endpoints.
import {maybeMountA49} from './http.mjs';
import {registerA49CallApi} from './call-api.mjs';
import {registerA49CarrierCdr} from './carrier-http.mjs';

export function mountA49(app,{express,pool,auth,log,env=process.env,fetchImpl=fetch}){
  const id=env.A49_GATEWAY_ID;
  const shieldUrl=env.A49_SHIELD_AUTHZ_URL, token=env.A49_SHIELD_SERVICE_TOKEN;
  const configured=typeof shieldUrl==='string'&&shieldUrl.startsWith('https://')&&
    typeof token==='string'&&token.length>=32 && /^[a-zA-Z0-9_-]{3,100}$/.test(id||'');
  if(!configured){
    if(env.A49_EVENT_INGRESS_ENABLED==='true'||env.A49_INTERNAL_CALLS_ENABLED==='true')
      throw Error('A49 requested but Shield URL, token, or gateway identity not safely configured');
    return {mounted:false};
  }
  const authorize=async ctx=>{
    try{
      const r=await fetchImpl(shieldUrl,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
        body:JSON.stringify(ctx),signal:AbortSignal.timeout(4000)});
      const p=r.ok?await r.json():null;
      // The response must explicitly bind the decision to the action and subject.
      return p?.allow===true && p?.action===(ctx.action??ctx.eventType) &&
        (ctx.callId? p.callId===ctx.callId : p.actorId===ctx.actorId) &&
        (ctx.principalId ? p.gatewayId===ctx.principalId : true) &&
        (ctx.workspaceId ? p.workspaceId===ctx.workspaceId : true);
    }catch{return false;}
  };
  // Existing HMAC ingress requires gateway secret, Shield, enabled principal and DB release gate.
  const ingress=maybeMountA49(app,{express,pool,log,config:env});
  if(env.A49_INTERNAL_CALLS_ENABLED==='true')registerA49CallApi(app,{pool,auth,gatewayId:id,
    shieldAuthorize:authorize,gateEnvironment:()=>env.A49_INTERNAL_CALLS_ENABLED==='true',log});
  const carrier=registerA49CarrierCdr(app,{express,pool,carrierId:env.A49_CARRIER_ID,secret:env.A49_CARRIER_HMAC_SECRET,
    enabled:env.A49_CARRIER_CDR_ENABLED==='true',log});
  return {mounted:ingress||env.A49_INTERNAL_CALLS_ENABLED==='true'||carrier};
}
