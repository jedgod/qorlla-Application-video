import test from 'node:test';
import assert from 'node:assert/strict';
import {validateEnvelope,envelope,DistributedBus,CHANNEL} from '../src/distributed.mjs';
test('validates distributed envelope and timestamp',()=>{
 const m=envelope('node-a','account-a',null,{type:'state'});
 assert.equal(validateEnvelope(m),true);
 assert.equal(validateEnvelope({...m,ts:Date.now()-60000}),false);
 assert.equal(validateEnvelope({...m,device:42}),false);
 assert.equal(validateEnvelope({...m,payload:{x:'a'.repeat(71000)}}),false);
});
test('publish requires ready bus',async()=>{
 const b=new DistributedBus({url:'redis://unused',onDelivery:()=>{}});
 await assert.rejects(()=>b.publish('a',null,{}),/distributed_bus_unavailable/);
});
test('bus dispatches remote messages, ignores own',async()=>{
 let listener;const published=[];const received=[];
 const makeClient=()=>({isReady:true,on(){},async connect(){},duplicate(){return makeClient()},async subscribe(ch,fn){assert.equal(ch,CHANNEL);listener=fn},async publish(ch,raw){published.push(JSON.parse(raw))},async quit(){}});
 const bus=new DistributedBus({url:'redis://fake',instanceId:'node-a',clientFactory:makeClient,onDelivery:m=>received.push(m)});
 await bus.start();await bus.publish('alice',null,{type:'incoming'});
 assert.equal(published.length,1);await listener(JSON.stringify(published[0]));assert.equal(received.length,0);
 await listener(JSON.stringify({...published[0],source:'node-b'}));assert.equal(received.length,1);
 await bus.close();
});
