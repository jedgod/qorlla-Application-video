import {PolicyError,canTransition} from './policy.mjs';
const eventState={RINGING:'ringing',ANSWERED:'answered',MEDIA_VERIFYING:'media_verifying',MEDIA_VERIFIED:'connected',HANGUP:'ended',FAILED:'failed'};
export function validateGatewayEvent(event){
 if(!event||typeof event!=='object'||typeof event.eventId!=='string'||!/^[-\w]{8,128}$/.test(event.eventId)||typeof event.callId!=='string'||typeof event.gatewayId!=='string'||!Number.isSafeInteger(event.sequence)||event.sequence<0||!Object.hasOwn(eventState,event.type))throw new PolicyError('INVALID_GATEWAY_EVENT',422);
 if(event.type==='MEDIA_VERIFIED' && !(event.evidence?.encrypted===true && event.evidence?.inboundAudio===true && event.evidence?.outboundAudio===true && event.evidence?.gatewayVerified===true))throw new PolicyError('MEDIA_NOT_VERIFIED',409);
 return eventState[event.type];
}
export function validateAdmission({state,hostApproved,shieldAllowed}){
 if(state!=='approved'||hostApproved!==true||shieldAllowed!==true)throw new PolicyError('MEET_ADMISSION_DENIED',403);
 return true;
}
export function reconcileAmounts({localMinor,carrierMinor,currency,carrierCurrency}){
 if(!Number.isSafeInteger(localMinor)||!Number.isSafeInteger(carrierMinor)||localMinor<0||carrierMinor<0||!/^[A-Z]{3}$/.test(currency)||currency!==carrierCurrency)throw new PolicyError('INVALID_CDR',422);
 const difference=carrierMinor-localMinor;
 return {status:difference===0?'matched':'disputed',differenceMinor:difference};
}
export {canTransition};
