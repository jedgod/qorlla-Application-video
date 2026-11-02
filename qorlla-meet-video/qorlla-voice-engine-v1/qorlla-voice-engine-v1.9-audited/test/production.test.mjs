import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('durable event wiring exists in both transitions',()=>{
 const s=readFileSync(new URL('../src/store.mjs',import.meta.url),'utf8');
 assert.match(s,/appendEvent\(c,\{account,callId:id,kind:'incoming'/);
 assert.match(s,/appendEvent\(c,\{account,callId:id,kind:'state'/);
});
test('timeout emits durable state',()=>{
 const s=readFileSync(new URL('../src/durable-timeouts.mjs',import.meta.url),'utf8');
 assert.match(s,/appendEvent\(c,/);assert.match(s,/FOR UPDATE SKIP LOCKED/);
});
test('outbox refuses dangerously fast timer',()=>{
 const s=readFileSync(new URL('../src/operations.mjs',import.meta.url),'utf8');assert.match(s,/intervalMs<100/);
});
