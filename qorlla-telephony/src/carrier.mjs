import {PolicyError} from './policy.mjs';
/** No direct network calls here: the certified SBC adapter implements this contract. */
export class CarrierAdapter {
 async readiness(){throw new Error('not implemented');}
 async originate(_call){throw new Error('not implemented');}
 async terminate(_carrierCallId){throw new Error('not implemented');}
 async verifySignedEvent(_rawBody,_headers){throw new Error('not implemented');}
}
export class DisabledCarrier extends CarrierAdapter {
 async readiness(){return {certified:false,outbound:false,healthy:false};}
 async originate(){throw new PolicyError('PSTN_DISABLED');}
 async terminate(){throw new PolicyError('PSTN_DISABLED');}
 async verifySignedEvent(){throw new PolicyError('PSTN_DISABLED');}
}
export function assertCertifiedCarrier(adapter,certificate){
 if(!adapter || !certificate?.approved || !certificate?.expiresAt || Date.parse(certificate.expiresAt)<=Date.now())throw new PolicyError('CARRIER_NOT_CERTIFIED');
 return adapter;
}
