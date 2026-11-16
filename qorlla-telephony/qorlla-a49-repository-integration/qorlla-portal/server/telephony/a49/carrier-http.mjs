// Optional CDR intake. This module NEVER originates a public telephone call.
import crypto from 'node:crypto';
import {createCarrierIngestion} from './carrier.mjs';
import {verifyHmac,TelephonyError} from './core.mjs';
export function registerA49CarrierCdr(app,{express,pool,carrierId,secret,enabled=false,log}){
  if(!enabled)return false;
  if(!/^[A-Za-z0-9_.:-]{3,128}$/.test(carrierId||'')||typeof secret!=='string'||Buffer.byteLength(secret)<32)
    throw Error('Carrier principal and secret missing');
  const service=createCarrierIngestion({pool,authorizeCarrier:async({carrierPrincipal,carrierId:id})=>
    carrierPrincipal===carrierId&&id===carrierId});
  app.post('/api/v1/a49/carrier/cdr',express.raw({type:'application/json',limit:'64kb'}),async(req,res)=>{
    res.set('Cache-Control','no-store');
    try{
      if(req.get('x-qorlla-carrier-id')!==carrierId)throw new TelephonyError('CARRIER_AUTH_DENIED',401);
      const nonce=req.get('x-qorlla-nonce'),timestamp=Number(req.get('x-qorlla-timestamp'));
      verifyHmac({body:req.body,signature:req.get('x-qorlla-signature'),nonce,timestamp,secret,
        method:'POST',path:'/api/v1/a49/carrier/cdr'});
      const result=await service.ingest({rawBody:req.body,carrierPrincipal:carrierId});
      return res.status(202).json(result);
    }catch(e){if(!(e instanceof TelephonyError))log?.error('A49 CDR intake error',{code:e.code||'unknown'});
      return res.status(e instanceof TelephonyError?e.status:503).json({code:e instanceof TelephonyError?e.code:'CARRIER_UNAVAILABLE'});}
  });
  return true;
}
