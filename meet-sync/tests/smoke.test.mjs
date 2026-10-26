import test from 'node:test';import assert from 'node:assert/strict';import {seal} from '../src/store.mjs';
test('vault refuses missing key',()=>{const old=process.env.QORLLA_VAULT_KEY;delete process.env.QORLLA_VAULT_KEY;assert.throws(()=>seal('secret'),/32 bytes/);if(old)process.env.QORLLA_VAULT_KEY=old});
test('vault uses randomized authenticated encryption',()=>{process.env.QORLLA_VAULT_KEY=Buffer.alloc(32,7).toString('base64');const a=seal('secret'),b=seal('secret');assert.notEqual(a.iv,b.iv);assert.equal(Buffer.from(a.tag,'base64').length,16)});
