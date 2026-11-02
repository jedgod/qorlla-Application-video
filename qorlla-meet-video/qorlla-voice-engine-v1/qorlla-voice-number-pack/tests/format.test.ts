import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePhoneNumberFromString} from 'libphonenumber-js';
test('illustrative US number parses as US E.164',()=>{
 const p=parsePhoneNumberFromString('+12023021142');assert.equal(p?.country,'US');assert.equal(p?.number,'+12023021142');
});
test('UK example parses as GB',()=>{
 const p=parsePhoneNumberFromString('+447459558868');assert.equal(p?.country,'GB');
});
