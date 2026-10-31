// Starts a Qorlla Meet on port 3310 for the recording acceptance tests (R01-R18) against the dev stack's PostgreSQL, with SHORT clocks (1 retention day = 4 s, sweep every 2 s,
// idle recorder = 12 s) so retention / crash recovery can be tested in seconds. Never use these settings outside tests. Needs: npm run dev:stack once (database + secrets).
// Fail closed: never start beside (or be mistaken for) another process on the same port.
{const port=String(process.env.MEET_TEST_PORT||3310);if(require('child_process').spawnSync(process.execPath,['-e',"require('net').connect(+process.argv[1],'127.0.0.1').on('connect',()=>process.exit(1)).on('error',()=>process.exit(0))",port]).status===1){console.error('Port '+port+' is already in use by another process; refusing to start. Choose a free MEET_TEST_PORT.');process.exit(1);}}
const s=require('../.dev-stack/secrets.json');const {spawn}=require('child_process'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const env={...process.env,PORT:String(process.env.MEET_TEST_PORT||3310),DATABASE_URL:'postgres://qorlla:'+s.dbPassword+'@127.0.0.1:'+(process.env.MEET_DB_PORT||35432)+'/qorlla_meet',JWT_SECRET:s.jwt,QORLLA_BRIDGE_SECRET:s.bridge,RECOVERY_ESCROW_KEY:s.escrow,NODE_ENV:'development',
 RECORDING_MASTER_KEYS:JSON.stringify({dev1:s.recordingKey}),RECORDING_ACTIVE_KEY_ID:'dev1',RECORDING_STORE_DIR:path.join(__dirname,'..','.dev-stack','recordings'),RECORDING_ADMIN_SECRET:'test-admin-secret',PHONE_PROVIDER:'test',PHONE_WEBHOOK_SECRET:'phone-test-secret-123456',PHONE_LOCK_MS:'4000',RETURN_ORIGINS:'http://localhost:5290,http://127.0.0.1:5290',
 // short clocks so retention / crash-recovery behaviour can be tested in seconds (1 "day" = 4 s)
 RECORDING_DAY_MS:'4000',RECORDING_SWEEP_MS:'2000',RECORDING_IDLE_MS:'12000',RECORDING_FINALIZE_GRACE_MS:'6000',RECORDING_LATE_CHUNK_MS:'8000',RECORDING_LINK_SECONDS:'5'};
const log=fs.openSync(path.join(__dirname,'..','.dev-stack','meet'+(process.env.MEET_TEST_PORT||3310)+'.log'),'w');
const c=spawn(process.execPath,['server/index.js'],{cwd:path.join(root,'qorlla-meet-video'),detached:true,stdio:['ignore',log,log],env});c.unref();
