import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { newDb } from 'pg-mem';
import { meetingMore } from '../server/more.mjs';

async function fixture(t, migrate = true) {
  const memory = newDb();
  memory.public.none(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
  if (migrate) memory.public.none(readFileSync(new URL('../sql/v4_1_more.sql', import.meta.url), 'utf8'));
  const { Pool } = memory.adapters.createPg(), db = new Pool();
  // pg-mem uses RelationNotFound instead of node-postgres's SQLSTATE. Preserve
  // the production protocol when exercising the missing-migration fallback.
  const connect = db.connect.bind(db);
  db.connect = async () => {
    const client = await connect();
    if (!client.__sqlstateAdapter) {
      const query = client.query.bind(client); client.__sqlstateAdapter = true;
      client.query = async (...args) => { try { return await query(...args); } catch (error) { if (error.constructor.name === 'RelationNotFound') error.code = '42P01'; throw error; } };
    }
    return client;
  };
  const ids = Object.fromEntries(['a','b','host','guest','other','hostB'].map(name => [name,randomUUID()]));
  for (const [id,title,code] of [[ids.a,'Meeting A','123456789012'],[ids.b,'Meeting B','987654321012']]) await db.query('INSERT INTO meetings(id,title,host_secret_hash,meeting_code) VALUES($1,$2,$3,$4)',[id,title,'test-only-hash',code]);
  for (const [id,meeting,role,name] of [[ids.host,ids.a,'host','Host'],[ids.guest,ids.a,'guest','Guest'],[ids.other,ids.a,'guest','Other'],[ids.hostB,ids.b,'host','Host B']]) await db.query('INSERT INTO participants(id,meeting_id,role,display_name) VALUES($1,$2,$3,$4)',[id,meeting,role,name]);
  const key = randomBytes(32), sent = []; let now = 10000;
  const more = meetingMore({ db, io: { to: target => ({ emit: (event,payload) => sent.push({target,event,payload}) }) }, room: id => 'meeting:' + id, clock: () => now });
  const app = express(); app.use(express.json({limit:'32kb'}));
  const auth = (req,res,next) => { try { req.user=jwt.verify(req.headers.authorization?.replace(/^Bearer /,''),key); next(); } catch { res.status(401).json({error:'Unauthorized'}); } };
  const member = async(req,res,next) => {
    if(req.user.meetingId!==req.params.id)return res.status(403).json({error:'Wrong meeting'});
    const {rows} = await db.query('SELECT m.ended_at,p.role FROM meetings m JOIN participants p ON p.meeting_id=m.id WHERE m.id=$1 AND p.id=$2',[req.params.id,req.user.participantId]);
    if(!rows.length||rows[0].ended_at)return res.status(403).json({error:'Meeting unavailable'});
    req.user.role=rows[0].role;next();
  };
  more.register(app,auth,member);
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.end();});
  const token = actor => jwt.sign({meetingId:actor==='hostB'?ids.b:ids.a,participantId:ids[actor],role:'host'},key,{expiresIn:300}); // Deliberately stale/overprivileged claim; member reloads the DB role.
  const request = async(actor,suffix='',method='GET',body,meeting=actor==='hostB'?ids.b:ids.a) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/meetings/${meeting}/more${suffix}`,{method,headers:{Authorization:'Bearer '+token(actor),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  return {ids,db,more,sent,request,advance:ms=>{now+=ms;}};
}

test('Q&A keeps pending questions private, moderates, answers and makes votes idempotent',async t=>{
  const {request,sent,ids}=await fixture(t);
  assert.equal((await request('guest','/questions','POST',{question:'<img src=x onerror=alert(1)> How does this work?'})).status,200);
  const own=(await request('guest')).body.questions;
  assert.equal(own.length,1);assert.equal(own[0].status,'pending');
  assert.equal((await request('other')).body.questions.length,0);
  assert.equal((await request('other',`/questions/${own[0].id}/vote`,'PUT',{active:true})).status,404);
  assert.equal((await request('guest',`/questions/${own[0].id}`,'PATCH',{status:'published'})).status,403);
  assert.equal((await request('host',`/questions/${own[0].id}`,'PATCH',{status:'published'})).status,200);
  assert.equal((await request('other')).body.questions.length,1);
  for(let i=0;i<2;i++)assert.equal((await request('other',`/questions/${own[0].id}/vote`,'PUT',{active:true})).status,200);
  assert.equal((await request('host')).body.questions[0].votes,1);
  assert.equal((await request('host',`/questions/${own[0].id}`,'PATCH',{status:'answered',answer:'The host can explain.'})).status,200);
  assert.equal((await request('other')).body.questions[0].answer,'The host can explain.');
  assert.ok(sent.every(event=>event.target==='meeting:'+ids.a));
  assert.ok(sent.every(event=>!JSON.stringify(event.payload).includes('How does this work')),'nudges never leak pending question text');
});

test('roles, chat and reaction permissions are enforced in the backend and revocation takes effect without a new token',async t=>{
  const {request,more,ids}=await fixture(t);
  assert.equal((await request('guest','/permissions','PATCH',{guestChat:false,reactions:false})).status,403);
  assert.equal((await request('host','/cohosts/'+ids.hostB,'PUT',{active:true})).status,403);
  assert.equal((await request('host','/cohosts/'+ids.guest,'PUT',{active:true})).status,200);
  assert.equal((await request('guest')).body.canManage,true);
  assert.equal((await request('guest','/cohosts/'+ids.other,'PUT',{active:true})).status,403);
  assert.equal((await request('guest','/permissions','PATCH',{guestChat:false,reactions:false})).status,200);
  assert.equal(await more.chatAllowed(ids.a,ids.other,'guest'),false);
  assert.equal(await more.chatAllowed(ids.a,ids.guest,'guest'),true);
  await assert.rejects(more.react(ids.a,ids.other,'guest','Other','👍'),error=>error.status===403);
  assert.equal((await request('host','/cohosts/'+ids.guest,'PUT',{active:false})).status,200);
  assert.equal((await request('guest')).body.canManage,false);
  assert.equal((await request('guest','/permissions','PATCH',{guestChat:true,reactions:true})).status,403);
});

test('ended occurrences and reused public meeting codes cannot expose prior Q&A, roles or permissions',async t=>{
  const {request,db,ids}=await fixture(t);
  await request('host','/questions','POST',{question:'Only in occurrence A'});
  await request('host','/permissions','PATCH',{guestChat:false,reactions:false});
  const old=(await request('host')).body;
  assert.equal((await request('hostB','', 'GET',undefined,ids.a)).status,403);
  await db.query('UPDATE meetings SET ended_at=now(),meeting_code=NULL WHERE id=$1',[ids.a]);
  await db.query('UPDATE meetings SET meeting_code=$1 WHERE id=$2',['123456789012',ids.b]);
  assert.equal((await request('host')).status,403);
  const next=(await request('hostB')).body;
  assert.notEqual(next.occurrenceId,old.occurrenceId);assert.equal(next.questions.length,0);assert.equal(next.permissions.guestChat,true);
  assert.equal((await request('hostB',`/questions/${old.questions[0].id}`,'PATCH',{status:'answered',answer:'No leak'})).status,404);
  assert.equal((await request('hostB',`/questions/${old.questions[0].id}/vote`,'PUT',{active:true})).status,404);
});

test('reactions are room-scoped, limited across reconnects for the same participant and recover after the window',async t=>{
  const {more,ids,sent,advance}=await fixture(t);
  for(let i=0;i<3;i++)await more.react(ids.a,ids.guest,'guest','Guest','👍');
  await assert.rejects(more.react(ids.a,ids.guest,'guest','Guest','👍'),error=>error.status===429);
  assert.equal(sent.length,3);assert.ok(sent.every(event=>event.target==='meeting:'+ids.a));
  advance(5001);await more.react(ids.a,ids.guest,'guest','Guest','👏');
  await assert.rejects(more.react(ids.a,ids.guest,'guest','Guest','arbitrary'),error=>error.status===400);
});

test('missing collaboration storage is unavailable, never a pretend Q&A success',async t=>{
  const {request}=await fixture(t,false);
  const result=await request('host');
  assert.equal(result.status,200);assert.equal(result.body.available,false);
  assert.equal((await request('guest','/questions','POST',{question:'Cannot save without storage'})).status,503);
});
