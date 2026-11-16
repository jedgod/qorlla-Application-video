// A gateway replica that dies mid-admission. Started by crash-recovery.test.ts, which kills it with SIGKILL once it says it is attaching (or waiting for the host).
import pg from 'pg';
import { admitTelephoneCall, type Readiness } from '../../src/admission.js';
import { PostgresCallLedger } from '../../src/ledger-pg.js';
const [url, schema, callId, mode] = process.argv.slice(2);
const all: Readiness = { carrierConnected: true, inboundNumberCertified: true, gatewayHealthy: true, mediaBridgeCertified: true, billingCertified: true, productionApproved: true };
const pool = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema });
const ledger = new PostgresCallLedger(pool, 'child-' + process.pid);
const sid = '11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222';
const authority = { verifyPhoneJoin: async () => ({ allowed: true, requiresHostApproval: mode === 'host', meetingSessionId: sid }), requestHostApproval: () => { console.log('WAITING'); return new Promise<boolean>(() => {}); } };
const bridge = { attach: () => { console.log('ATTACHING'); return new Promise<{ mediaEstablished: boolean }>(() => {}); }, disconnect: async () => {} };
admitTelephoneCall({ meetingId: '12345678901', passcode: '12345678', callId, dialedNumber: '+12025550100' }, all, authority, bridge, { ledger, stepTimeoutMs: 600_000, hostApprovalTimeoutMs: 600_000 }).then(() => {});
