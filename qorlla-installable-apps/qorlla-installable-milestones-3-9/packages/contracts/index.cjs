'use strict';
const STATES=Object.freeze(['requested','ringing','connected','ended','failed']);
const E164=/^\+[1-9]\d{1,14}$/;
function parseCallEvent(value){if(!value||typeof value!=='object')throw Error('event required');if(!/^[0-9a-f-]{36}$/i.test(value.callId||''))throw Error('invalid callId');if(!STATES.includes(value.state))throw Error('invalid state');if(!Number.isSafeInteger(value.sequence)||value.sequence<0)throw Error('invalid sequence');return {callId:value.callId,state:value.state,sequence:value.sequence};}
function isExternalDestination(v){return typeof v==='string'&&E164.test(v)}
function assertReleaseGate(flags){if(flags?.pstnEnabled!==true||flags?.certified!==true||flags?.shieldApproved!==true)throw Error('PSTN_BLOCKED');return true;}
module.exports={STATES,parseCallEvent,isExternalDestination,assertReleaseGate};
