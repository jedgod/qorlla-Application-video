import test from 'node:test';import assert from 'node:assert/strict';
import {liveAudioGateway} from '../src/live-audio-gateway.mjs';
test('fails closed without configured engine token',()=>{assert.throws(()=>liveAudioGateway({pool:{},authority:{},transcripts:{},engineUrl:'http://stt:8088',engineToken:'short'}),/invalid_gateway_configuration/)});
test('rejects malformed chunks before any database work',async()=>{const g=liveAudioGateway({pool:{},authority:{},transcripts:{},engineUrl:'http://stt:8088',engineToken:'a'.repeat(32)});await assert.rejects(g.ingest({sessionId:'bad',epoch:1,chunkId:'bad',chunkStartMs:0,audio:Buffer.alloc(10),contentType:'audio/webm'}),/invalid_parameters/)});
