import {CarrierAdapter} from './carrier.mjs';
import {normalizedDestination,PolicyError} from './policy.mjs';

export class SimulatedCarrier extends CarrierAdapter {
 constructor({enabled=false}={}){
  super();
  if(enabled!==true||process.env.NODE_ENV==='production')throw new PolicyError('SIMULATOR_DISABLED',403);
 }
 async readiness(){return {simulated:true,certified:false,outbound:false,healthy:false};}
 async originate(call){
  normalizedDestination('external',call?.destination);
  return {simulated:true,status:'simulated',connected:false};
 }
 async terminate(){return {simulated:true,status:'simulated',connected:false};}
 async verifySignedEvent(){throw new PolicyError('SIMULATED_CARRIER_HAS_NO_SIGNED_EVENTS',403);}
}
