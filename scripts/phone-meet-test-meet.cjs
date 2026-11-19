// Starts the Meet on :3310 WITH a Shield workload credential pointing at the test engine (127.0.0.1:5344) and writes the JWKS the engine will serve on :5345.
const crypto=require('crypto'),fs=require('fs'),{spawn}=require('child_process');
const s=require('C:/Users/cj_wo/qv-pm22/.dev-stack/secrets.json');
const {publicKey,privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'P-256'});
const jwk={...publicKey.export({format:'jwk'}),kid:'w1',alg:'ES256',use:'sig'};
fs.writeFileSync(''+(process.env.QORLLA_TEST_MEET_JWKS||require('os').tmpdir()+'/meet-jwks.json')+'',JSON.stringify({keys:[jwk]}));
const env={...process.env,PORT:'3310',DATABASE_URL:'postgres://postgres:postgres@127.0.0.1:25690/meet_pm22',JWT_SECRET:s.jwt,QORLLA_BRIDGE_SECRET:s.bridge,RECOVERY_ESCROW_KEY:s.escrow,NODE_ENV:'development',MEET_ALLOW_ANONYMOUS_START:'false',
 SHIELD_URL:'http://127.0.0.1:5344',SHIELD_MEET_KEY_PEM:privateKey.export({type:'pkcs8',format:'pem'}),SHIELD_WORKLOAD_ISSUER:'qorlla-workload',SHIELD_WORKLOAD_KID:'w1'};
const log=fs.openSync('C:/Users/cj_wo/AppData/Local/Temp/meet3310.log','w');const c=spawn(process.execPath,['server/index.js'],{cwd:'C:/Users/cj_wo/qv-pm22/qorlla-meet-video',detached:true,stdio:['ignore',log,log],env});c.unref();console.log('pid',c.pid);
