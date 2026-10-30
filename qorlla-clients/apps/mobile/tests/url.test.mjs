import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {readFileSync} from 'node:fs';
// Evaluate the platform-neutral helper without requiring React Native dependencies.
const source=readFileSync(new URL('../url.js',import.meta.url),'utf8').replace('export function','function');const fn=new Function(source+';return createQorllaUrl')();
test('safe mobile links',()=>{assert.equal(fn('https://q.example','/auth/login'),'https://q.example/auth/login');assert.throws(()=>fn('http://q.example','/auth/login'));assert.throws(()=>fn('https://q.example','//evil'));});
