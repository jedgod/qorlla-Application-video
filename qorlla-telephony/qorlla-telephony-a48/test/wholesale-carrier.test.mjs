import test from 'node:test';
import assert from 'node:assert/strict';
import {WholesaleCarrier} from '../src/wholesale-carrier.mjs';
const params={tenantId:'t',callId:'c',destination:'+12025550123',corridor:'US'};
test('PSTN refuses without gate reader',async()=>assert.rejects(new WholesaleCarrier({}).authorizeOutbound(params),{code:'PSTN_DISABLED'}));
test('PSTN refuses missing Shield',async()=>assert.rejects(new WholesaleCarrier({gateReader:async()=>true}).authorizeOutbound(params),{code:'SHIELD_DENIED'}));
test('PSTN refuses uncertified corridor',async()=>assert.rejects(new WholesaleCarrier({gateReader:async()=>true,shieldAuthorize:async()=>true,certificationReader:async()=>false}).authorizeOutbound(params),{code:'CORRIDOR_NOT_CERTIFIED'}));
test('PSTN refuses absent adapter',async()=>assert.rejects(new WholesaleCarrier({gateReader:async()=>true,shieldAuthorize:async()=>true,certificationReader:async()=>true}).authorizeOutbound(params),{code:'CARRIER_ADAPTER_NOT_CONFIGURED'}));
