import http from 'node:http';
import {verifyGateway} from './gateway-auth.mjs';
import {PolicyError} from './policy.mjs';
export function createIntegrationServer({integration,secret,authenticateGateway,authorizeMeet,authorizeCarrier}){
 return http.createServer(async(req,res)=>{
  const reply=(status,obj)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(obj));};
  try{
   const path=new URL(req.url,'http://localhost').pathname;
   if(req.method==='GET'&&path==='/health/live')return reply(200,{alive:true});
   if(req.method!=='POST')return reply(404,{error:'NOT_FOUND'});
   if(!['/internal/gateway/events','/internal/meet/admission','/internal/carrier/cdr'].includes(path))return reply(404,{error:'NOT_FOUND'});
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>65536)throw new PolicyError('BODY_TOO_LARGE',413);chunks.push(chunk);}const raw=Buffer.concat(chunks);
   // HMAC is a reference transport guard; production requires mTLS, gateway identity, and durable nonce replay prevention.
   const signed=verifyGateway({method:req.method,path,headers:req.headers,body:raw,secret});
   const data=JSON.parse(raw.toString('utf8'));
   if(path==='/internal/gateway/events'){
    if(typeof authenticateGateway!=='function')throw new PolicyError('GATEWAY_AUTH_FAILED',401);
    const principalId=await authenticateGateway(req);
    if(typeof principalId!=='string'||!principalId)throw new PolicyError('GATEWAY_AUTH_FAILED',401);
    return reply(202,await integration.gatewayEvent(data,{principalId,nonce:signed.nonce,timestampMs:signed.ts}));
   }
   if(path==='/internal/meet/admission'){if(!authorizeMeet||!(await authorizeMeet(data,req)))throw new PolicyError('MEET_ADMISSION_DENIED',403);return reply(200,await integration.admit(data));}
   if(!authorizeCarrier||!(await authorizeCarrier(data,req)))throw new PolicyError('CARRIER_NOT_AUTHORIZED',403);
   return reply(200,await integration.reconcile({...data,raw}));
  }catch(e){if(!(e instanceof PolicyError)&&!(e instanceof SyntaxError))console.error('[telephony] integration request failed');reply(e instanceof PolicyError?e.status:e instanceof SyntaxError?400:500,{error:e instanceof PolicyError?e.code:e instanceof SyntaxError?'INVALID_JSON':'INTERNAL_ERROR'});}
 });
}
