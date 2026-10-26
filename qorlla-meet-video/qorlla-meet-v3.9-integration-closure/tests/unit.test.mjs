import test from 'node:test';import assert from 'node:assert/strict';
import {validateMeetingFields} from '../main/route-and-dialog.mjs';
import {recoverHost} from '../main/recovery-client.mjs';
test('title and passcode validation',()=>{assert.equal(validateMeetingFields({title:' Test ',passcode:'abcdefgh'}).title,'Test');assert.throws(()=>validateMeetingFields({title:'',passcode:''}));assert.throws(()=>validateMeetingFields({title:'ok',passcode:'123'}));});
test('vault failure prevents acknowledgment; retries same request',async()=>{let id='fixed',acks=0,attempts=0;const args={sourceId:'a',loadOrCreateRequest:async()=>id,meetIssue:async(_,r)=>({hostSecret:'secret',generation:1,requestId:r}),vaultPut:async()=>{if(++attempts===1)throw Error('disk');},verifyHost:async()=>true,meetAck:async()=>{acks++;}};await assert.rejects(()=>recoverHost(args));assert.equal(acks,0);await recoverHost(args);assert.equal(acks,1);});
