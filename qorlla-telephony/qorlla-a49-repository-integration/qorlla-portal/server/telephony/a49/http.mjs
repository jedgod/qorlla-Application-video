// Isolated A49 ingress. Register BEFORE portal app's general express.json middleware.
// This has no call-placement route and cannot enable PSTN.
import {createGatewayService,TelephonyError} from './core.mjs';
export function registerA49Gateway(app,{express,pool,secretFor,shieldAuthorize,log,allowStaging=false}) {
 const service=createGatewayService({pool,secretFor,shieldAuthorize,allowStaging});
 app.post('/api/v1/a49/gateway/events',express.raw({type:'application/json',limit:'64kb'}),async(req,res)=>{
   res.set('Cache-Control','no-store');
   if(!Buffer.isBuffer(req.body))return res.status(415).json({code:'JSON_BODY_REQUIRED'});
   const timestamp=Number(req.get('x-qorlla-timestamp'));
   try {
     const result=await service.receive({principalId:req.get('x-qorlla-gateway-id'),body:req.body,
       signature:req.get('x-qorlla-signature'),nonce:req.get('x-qorlla-nonce'),timestamp});
     res.status(202).json(result);
   } catch(e) {
     if(!(e instanceof TelephonyError))log?.error('A49 event ingestion error',{code:e?.code ?? 'unknown'});
     res.status(e instanceof TelephonyError?e.status:503).json({code:e instanceof TelephonyError?e.code:'GATEWAY_UNAVAILABLE'});
   }
 });
}
// A49 is intentionally not mounted unless an authenticated Shield integration
// and trusted gateway-key resolver are provided by the production runtime.
export function maybeMountA49(app,{express,pool,log,config=process.env}) {
 const id=config.A49_GATEWAY_ID, key=config.A49_GATEWAY_SECRET;
 const url=config.A49_SHIELD_AUTHZ_URL, token=config.A49_SHIELD_SERVICE_TOKEN;
 if(config.A49_EVENT_INGRESS_ENABLED!=='true')return false;
 if(!id||!key||Buffer.byteLength(key)<32||!url||!url.startsWith('https://')||!token||token.length<32) {
   log?.warn('A49 ingress refuses startup: gateway identity or Shield not fully configured');return false;
 }
 const secretFor=async principalId=>principalId===id?key:null;
 const shieldAuthorize=async context=>{
   try {
     const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
       body:JSON.stringify(context),signal:AbortSignal.timeout(4000),redirect:'error'});
     if(!r.ok)return false;
     const data=await r.json();return data?.allow===true && data?.gatewayId===context.principalId && data?.callId===context.callId;
   }catch{return false;}
 };
 registerA49Gateway(app,{express,pool,secretFor,shieldAuthorize,log,allowStaging:false});return true;
}
