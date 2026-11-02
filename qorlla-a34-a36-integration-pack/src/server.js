import https from 'node:https';
import fs from 'node:fs';
import Fastify from 'fastify';
import { pathToFileURL } from 'node:url';
import { createWorkloadVerifier } from './workload-auth.js';
import { assertDeployment, requireScope } from './policy.js';
import { makeDb } from './db.js';
import { VoiceService } from './voice-service.js';
import { RoomService } from './room-service.js';

// User authentication MUST be supplied by existing Shield. Never trust x-user headers.
export async function buildServer({env=process.env,shield}) {
  assertDeployment(env);
  if (typeof shield?.authenticateUser !== 'function') throw new Error('Existing Shield authenticateUser adapter required');
  if (!env.TLS_KEY || !env.TLS_CERT || !env.TLS_CLIENT_CA || !env.WORKLOAD_JWKS_URL || !env.WORKLOAD_ISSUER || !env.WORKLOAD_AUDIENCE || !env.WORKLOAD_ALLOWLIST) throw new Error('Missing mTLS/workload configuration');
  const allowedIdentities=new Map(JSON.parse(env.WORKLOAD_ALLOWLIST).map(x=>[x.sub,{scopes:x.scopes}]));
  const verifyWorkload=await createWorkloadVerifier({jwksUrl:env.WORKLOAD_JWKS_URL,issuer:env.WORKLOAD_ISSUER,audience:env.WORKLOAD_AUDIENCE,allowedIdentities});
  const db=makeDb(env.DATABASE_URL); const voice=new VoiceService(db);const rooms=new RoomService(db);
  const app=Fastify({logger:true,bodyLimit:32768,https:{key:fs.readFileSync(env.TLS_KEY),cert:fs.readFileSync(env.TLS_CERT),ca:fs.readFileSync(env.TLS_CLIENT_CA),requestCert:true,rejectUnauthorized:true}});
  const user=async(req)=>{
    const p=await shield.authenticateUser(req);
    if (!p?.accountId||!p?.tenantId) throw Object.assign(new Error('UNAUTHORIZED'),{statusCode:401});
    return p;
  };
  const workload=async(req,scope)=>{
    const cert=req.raw.socket.getPeerCertificate(true);
    if (!req.raw.socket.authorized || !cert?.raw) throw Object.assign(new Error('MTLS_REQUIRED'),{statusCode:401});
    return verifyWorkload({authorization:req.headers.authorization,peerCertificateDer:cert.raw,requiredScope:scope});
  };
  app.setErrorHandler((err,req,reply)=>{
    req.log.warn({code:err.message},'request refused');
    reply.code(Number.isInteger(err.statusCode)&&err.statusCode>=400&&err.statusCode<500?err.statusCode:503).send({error:err.statusCode?err.message:'SERVICE_UNAVAILABLE'});
  });
  app.post('/v1/voice/calls',async req=>voice.invite(await user(req),req.body?.extension));
  app.post('/v1/voice/calls/:id/accept',async req=>voice.transition(await user(req),req.params.id,'accept'));
  app.post('/v1/voice/calls/:id/reject',async req=>voice.transition(await user(req),req.params.id,'reject'));
  app.post('/v1/voice/calls/:id/end',async req=>voice.transition(await user(req),req.params.id,'end'));
  app.post('/v1/voice/rooms',async req=>rooms.create(await user(req)));
  app.post('/v1/voice/rooms/:id/join',async req=>rooms.join(await user(req),req.params.id));
  app.post('/v1/voice/rooms/:id/disable',async req=>rooms.disable(await user(req),req.params.id));
  app.post('/v1/internal/voice/suspend',async req=>{
    const actor=await workload(req,'voice.account.suspend');
    if (!req.body?.tenantId||!req.body?.accountId||!req.body?.reason) throw Object.assign(new Error('VALIDATION_ERROR'),{statusCode:400});
    return voice.suspend({...req.body,actorId:actor.workloadId});
  });
  app.get('/health/live',async()=>({live:true}));
  app.get('/health/ready',async(req,reply)=>{
    try {await db.pool.query('SELECT 1');return {ready:true};}
    catch {return reply.code(503).send({ready:false});}
  });
  app.addHook('onClose',async()=>db.pool.end());
  return app;
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const modulePath=process.env.QORLLA_SHIELD_ADAPTER;
  if(!modulePath) throw new Error('QORLLA_SHIELD_ADAPTER is required');
  const shield=await import(pathToFileURL(modulePath).href);
  const app=await buildServer({shield});
  await app.listen({host:'0.0.0.0',port:Number(process.env.PORT||8443)});
}
