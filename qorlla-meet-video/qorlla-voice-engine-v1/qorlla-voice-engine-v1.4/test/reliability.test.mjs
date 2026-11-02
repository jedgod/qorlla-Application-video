import test from 'node:test';import assert from 'node:assert/strict';
import {safeCursor,backoff,safeEvent} from '../src/reliability-core.mjs';
import {ownsGeneration} from '../src/lease-fencing.mjs';
import {EventDeduplicator} from '../src/event-dedupe.mjs';
test('cursor rejects negatives, fractions and unsafe numbers',()=>{for(const n of [-1,1.2,Infinity,NaN,Number.MAX_SAFE_INTEGER+1,'2'])assert.equal(safeCursor(n),false);assert.equal(safeCursor(0),true)});
test('backoff capped and increasing',()=>{assert.equal(backoff(1),1000);assert.equal(backoff(2),2000);assert.equal(backoff(100),256000)});
test('event whitelist and payload size',()=>{assert.equal(safeEvent('state',{ok:true}),true);assert.equal(safeEvent('sdp',{ok:true}),false);assert.equal(safeEvent('state',{blob:'x'.repeat(33000)}),false)});
test('generation fencing rejects replaced device',()=>{const lease={device_id:'device-b',generation:'8',expires_at:new Date(Date.now()+30000).toISOString()};assert.equal(ownsGeneration(lease,{deviceId:'device-a',generation:7}),false);assert.equal(ownsGeneration(lease,{deviceId:'device-b',generation:8}),true)});
test('deduplicator rejects duplicate events',()=>{const d=new EventDeduplicator(2);assert.equal(d.accept(2),true);assert.equal(d.accept(2),false);assert.equal(d.accept(3),true);assert.equal(d.accept(4),true);assert.equal(d.accept(2),true)});
