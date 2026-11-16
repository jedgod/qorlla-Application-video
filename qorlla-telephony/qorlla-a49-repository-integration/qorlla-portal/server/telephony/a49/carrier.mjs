// Carrier-neutral CDR foundation: NEVER initiates a real SIP or PSTN call.
import {stableHash,transaction,TelephonyError,uuid} from './core.mjs';
const CURRENCY=/^[A-Z]{3}$/;
const TEXT=/^[a-zA-Z0-9_.:-]{3,128}$/;
export function validateCdr(x) {
 if(!x || !TEXT.test(x.carrierId??'') || !TEXT.test(x.cdrId??'') || !uuid(x.callId) ||
    !Number.isSafeInteger(x.seconds) || x.seconds<0 || !Number.isSafeInteger(x.amountMinor) || x.amountMinor<0 ||
    !CURRENCY.test(x.currency??'')) throw new TelephonyError('INVALID_CDR',422);
 return x;
}
export function reconcileCdr({carrierAmount,carrierCurrency,ratedAmount,ratedCurrency}) {
 if(!CURRENCY.test(carrierCurrency??'')||!CURRENCY.test(ratedCurrency??'')||
   !Number.isSafeInteger(carrierAmount)||carrierAmount<0||!Number.isSafeInteger(ratedAmount)||ratedAmount<0)
   throw new TelephonyError('INVALID_RATING',422);
 return carrierCurrency===ratedCurrency && carrierAmount===ratedAmount ? 'matched' : 'disputed';
}
export function createCarrierIngestion({pool,authorizeCarrier}) {
 if(typeof authorizeCarrier!=='function') throw new Error('Carrier identity verification is mandatory');
 return {async ingest({rawBody,carrierPrincipal}) {
   if(!Buffer.isBuffer(rawBody) || rawBody.length>65536) throw new TelephonyError('INVALID_BODY',422);
   // Must be a verified carrier identity, not a request-supplied carrierId.
   let cdr;try{cdr=validateCdr(JSON.parse(rawBody.toString('utf8')));}catch(e){if(e instanceof TelephonyError)throw e;throw new TelephonyError('INVALID_CDR',422);}
   if(await authorizeCarrier({carrierPrincipal,carrierId:cdr.carrierId,rawBody})!==true)
     throw new TelephonyError('CARRIER_AUTH_DENIED',403);
   return transaction(pool,async c=>{
     const call=(await c.query('SELECT kind FROM portal.a49_calls WHERE id=$1 FOR UPDATE',[cdr.callId])).rows[0];
     if(!call || call.kind!=='external') throw new TelephonyError('NOT_EXTERNAL_CALL',403);
     const fingerprint=stableHash(rawBody);
     const existing=await c.query('SELECT payload_sha256 FROM portal.a49_carrier_cdr WHERE carrier_id=$1 AND cdr_id=$2',[cdr.carrierId,cdr.cdrId]);
     if(existing.rowCount){if(existing.rows[0].payload_sha256!==fingerprint)throw new TelephonyError('CDR_REPLAY_CONFLICT',409);return {replayed:true};}
     await c.query(`INSERT INTO portal.a49_carrier_cdr(carrier_id,cdr_id,call_id,duration_seconds,currency,amount_minor,payload_sha256)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,[cdr.carrierId,cdr.cdrId,cdr.callId,cdr.seconds,cdr.currency,cdr.amountMinor,fingerprint]);
     const rating=await c.query('SELECT currency,amount_minor FROM portal.a49_ratings WHERE call_id=$1',[cdr.callId]);
     return {replayed:false,status:rating.rowCount?reconcileCdr({carrierAmount:cdr.amountMinor,carrierCurrency:cdr.currency,
       ratedAmount:Number(rating.rows[0].amount_minor),ratedCurrency:rating.rows[0].currency.trim()}):'pending'};
   });
 }};
}
