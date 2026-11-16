import test from 'node:test';import assert from 'node:assert/strict';import {clean} from '../server/index.mjs';
test('strips script tags and event handlers',()=>{const html=clean('<p onclick="alert(1)">Hi<script>alert(1)</script></p>');assert(!html.includes('onclick'));assert(!html.includes('<script'));assert(html.includes('Hi'))});
test('rejects javascript URLs',()=>assert(!clean('<a href="javascript:alert(1)">click</a>').includes('javascript:')));
