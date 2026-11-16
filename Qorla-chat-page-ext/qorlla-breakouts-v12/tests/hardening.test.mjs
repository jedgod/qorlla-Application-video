import test from 'node:test';
import assert from 'node:assert/strict';
import {createHardening,AccessError} from '../src/hardening.mjs';
const pool={connect:async()=>({query:async()=>({rows:[],rowCount:0}),release(){}})};
test('requires real adapters',()=>assert.throws(()=>createHardening({}),/required/));
test('rejects unauthenticated room moves',async()=>{const x=createHardening({pool,verifyActor:async()=>null,emitToAuthorizedRecipients:async()=>{}});await assert.rejects(x.move('x','o','p',null),e=>e instanceof AccessError&&e.status===403)});
test('participant cannot move another participant',async()=>{const x=createHardening({pool,verifyActor:async()=>({active:true,participantId:'p',role:'guest'}),emitToAuthorizedRecipients:async()=>{}});await assert.rejects(x.move('x','o','q',null),e=>e.status===403)});
test('invalid lead capabilities rejected',async()=>{const x=createHardening({pool,verifyActor:async()=>({active:true,participantId:'p',role:'host'}),emitToAuthorizedRecipients:async()=>{}});await assert.rejects(x.grantLead('x','o','r','q',['admin']),e=>e.status===400)});
