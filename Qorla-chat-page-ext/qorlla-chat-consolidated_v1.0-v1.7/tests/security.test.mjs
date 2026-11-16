import test from 'node:test';import assert from 'node:assert/strict';import {cleanRichText,aesEncrypt,aesDecrypt} from '../server/modules/core.mjs';
test('strips script, event handlers and javascript URLs',()=>{const s=cleanRichText('<p onclick="evil()">hello<script>alert(1)</script><a href="javascript:alert(1)">bad</a></p>');assert.doesNotMatch(s,/<script|onclick|javascript:/i)});
test('accepts safe HTTPS links',()=>assert.match(cleanRichText('<a href="https://qorlla.com">Qorlla</a>'),/https:\/\/qorlla.com/));
test('rejects empty and oversized messages',()=>{assert.throws(()=>cleanRichText('<b></b>'));assert.throws(()=>cleanRichText('a'.repeat(20001)))});
test('encrypts and decrypts token objects',()=>{const key='a'.repeat(64),obj={access_token:'secret'};const c=aesEncrypt(obj,key);assert.doesNotMatch(c.toString(),/secret/);assert.deepEqual(aesDecrypt(c,key),obj)});
