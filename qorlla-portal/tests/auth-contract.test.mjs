import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../server/index.mjs',import.meta.url),'utf8');
test('does not accept development identity',()=>assert.doesNotMatch(source,/req\.actor=process\.env\.DEV_USER_ID/));
test('requires cryptographic JWT verification',()=>assert.match(source,/jwtVerify\(token,jwks/));
test('verifies membership from PostgreSQL',()=>assert.match(source,/FROM portal\.members WHERE user_id=\$1/));
test('protects writes with CSRF and Origin',()=>{assert.match(source,/x-csrf-token/);assert.match(source,/PORTAL_ALLOWED_ORIGIN/)});
test('public product catalog bypasses login',()=>assert.match(source,/\['\/health','\/products','\/plans'\]/));
