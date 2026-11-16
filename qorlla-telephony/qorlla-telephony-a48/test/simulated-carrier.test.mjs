import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulatedCarrier } from '../src/simulated-carrier.mjs';

test('simulator requires explicit enablement and cannot be considered a live carrier',async()=>{
 assert.throws(()=>new SimulatedCarrier(),{code:'SIMULATOR_DISABLED'});
 const carrier=new SimulatedCarrier({enabled:true});
 assert.deepEqual(await carrier.readiness(),{simulated:true,certified:false,outbound:false,healthy:false});
 assert.deepEqual(await carrier.originate({destination:'+12025550123'}),{simulated:true,status:'simulated',connected:false});
 await assert.rejects(carrier.originate({destination:'invalid'}),{code:'INVALID_DESTINATION'});
 await assert.rejects(carrier.verifySignedEvent(),{code:'SIMULATED_CARRIER_HAS_NO_SIGNED_EVENTS'});
});

test('simulator refuses to run in production',()=>{
 const previous=process.env.NODE_ENV;
 try{process.env.NODE_ENV='production';assert.throws(()=>new SimulatedCarrier({enabled:true}),{code:'SIMULATOR_DISABLED'});}
 finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}
});
