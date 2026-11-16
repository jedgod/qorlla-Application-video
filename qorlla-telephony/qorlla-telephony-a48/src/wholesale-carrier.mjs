import {PolicyError} from './policy.mjs';
// Carrier-specific SIP signaling belongs in a separately certified SBC adapter.
// This contract deliberately does NOT send calls or imply a working PSTN connection.
export class WholesaleCarrier {
 constructor({adapter,gateReader,shieldAuthorize,certificationReader}){
  this.adapter=adapter;this.gateReader=gateReader;this.shieldAuthorize=shieldAuthorize;this.certificationReader=certificationReader;
 }
 async authorizeOutbound({tenantId,callId,destination,corridor}){
  if(!/^\+[1-9]\d{7,14}$/.test(destination??''))throw new PolicyError('INVALID_DESTINATION',422);
  if(typeof this.gateReader!=='function'||await this.gateReader('external')!==true)throw new PolicyError('PSTN_DISABLED');
  if(typeof this.shieldAuthorize!=='function'||await this.shieldAuthorize({tenantId,callId,destination})!==true)throw new PolicyError('SHIELD_DENIED');
  if(typeof this.certificationReader!=='function'||await this.certificationReader({destination,corridor})!==true)throw new PolicyError('CORRIDOR_NOT_CERTIFIED');
  if(typeof this.adapter?.originate!=='function')throw new PolicyError('CARRIER_ADAPTER_NOT_CONFIGURED');
  return {authorized:true};
 }
 // No implicit call to originate: reservation, balance hold, and audit must precede dialing.
}
