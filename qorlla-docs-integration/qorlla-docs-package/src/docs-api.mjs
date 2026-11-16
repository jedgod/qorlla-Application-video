import express from 'express';
import {randomUUID} from 'node:crypto';
import {policyFor,requireFeature} from './policy.mjs';

const fail=(status,code,message=code)=>{throw Object.assign(new Error(message),{status,code});};
const isUuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const assertId=x=>{if(!isUuid(x))fail(400,'invalid_id');return x;};
const title=x=>{if(typeof x!=='string'||x.trim().length<1||x.trim().length>200)fail(400,'invalid_title');return x.trim();};
const safeContent=x=>{if(x===null||typeof x!=='object'||Array.isArray(x)||Buffer.byteLength(JSON.stringify(x))>1500000)fail(400,'invalid_content');return x;};
const query=async(db,sql,values=[])=> (await db.query(sql,values)).rows;

/**
 * Mount on a trusted, authenticated Express app only.
 * identity(req) MUST validate session, workspace membership and active subscription server-side.
 * Never trust identity fields from headers or request bodies.
 * resolveEntitlements(req,identity) MUST query existing SBACS and return {plan,overrides}.
 */
export function createDocsRouter({db,identity,resolveEntitlements}){
 if(!db||!identity||!resolveEntitlements)throw new Error('Required production adapters missing');
 const r=express.Router();
 r.use(express.json({limit:'1600kb'}));
 r.use(async(req,res,next)=>{try{
   const actor=await identity(req);
   if(!actor||!isUuid(actor.userId)||!isUuid(actor.workspaceId)||actor.active!==true)fail(401,'unauthorized');
   const ent=await resolveEntitlements(req,actor);
   if(!ent?.plan)fail(503,'entitlement_unavailable');
   req.docsActor=actor;req.docsPolicy=policyFor(ent.plan,ent.overrides||{});next();
 }catch(e){next(e)}});
 const audit=async(c,a,doc,action)=>c.query('INSERT INTO portal.doc_audit(workspace_id,document_id,actor_id,action) VALUES($1,$2,$3,$4)',[a.workspaceId,doc,a.userId,action]);
 const get=async(c,id,a,mode='read',lock=false)=>{
   assertId(id);
   const rows=await query(c,`SELECT d.*,CASE WHEN d.owner_id=$3 THEN 'owner' ELSE p.role END AS direct_role
    FROM portal.documents d LEFT JOIN portal.document_permissions p ON p.document_id=d.id AND p.user_id=$3
    WHERE d.id=$1 AND d.workspace_id=$2 ${lock?'FOR UPDATE OF d':''}`,[id,a.workspaceId,a.userId]);
   const d=rows[0];
   if(!d)fail(404,'not_found');
   const canRead=d.direct_role||d.general_access==='workspace_view'||d.general_access==='workspace_edit';
   const canWrite=d.direct_role==='owner'||d.direct_role==='editor'||d.general_access==='workspace_edit';
   if(!canRead||(mode==='write'&&!canWrite)||(mode==='owner'&&d.direct_role!=='owner'))fail(404,'not_found');
   return d;
 };
 const tx=async fn=>{const c=await db.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
 r.get('/',wrap(async(req,res)=>{
   const a=req.docsActor,view=String(req.query.view||'recent');
   if(!['recent','mine','shared','starred','trash','templates'].includes(view))fail(400,'invalid_view');
   const q=String(req.query.q||'').slice(0,200);
   const rows=await query(db,`SELECT d.id,d.title,d.kind,d.current_version,d.updated_at,d.deleted_at,d.owner_id,
      CASE WHEN d.owner_id=$2 THEN 'owner' ELSE p.role END AS role,
      COALESCE(m.template,false) AS template,COALESCE(m.starred_by,'[]'::jsonb) AS starred_by
     FROM portal.documents d LEFT JOIN portal.document_permissions p ON p.document_id=d.id AND p.user_id=$2
     LEFT JOIN portal.doc_metadata m ON m.document_id=d.id
     WHERE d.workspace_id=$1 AND (d.owner_id=$2 OR p.role IS NOT NULL OR d.general_access IN ('workspace_view','workspace_edit'))
     AND (CASE WHEN $3='trash' THEN d.deleted_at IS NOT NULL ELSE d.deleted_at IS NULL END)
     AND ($4='' OR d.title ILIKE '%'||$4||'%')
     AND ($3 NOT IN ('mine','shared','starred','templates') OR
       ($3='mine' AND d.owner_id=$2) OR ($3='shared' AND d.owner_id<>$2) OR
       ($3='starred' AND COALESCE(m.starred_by,'[]'::jsonb) ? $2::text) OR
       ($3='templates' AND COALESCE(m.template,false)))
     ORDER BY d.updated_at DESC LIMIT 200`,[a.workspaceId,a.userId,view,q]);
   res.json({documents:rows});
 }));
 r.post('/',wrap(async(req,res)=>{
   const a=req.docsActor,p=req.docsPolicy,kind=req.body.kind||'doc';
   if(!['doc','sheet','slides'].includes(kind))fail(400,'invalid_kind');
   const name=title(req.body.title||'Untitled document');
   const content=safeContent(req.body.content||{type:'doc',blocks:[]});
   const id=await tx(async c=>{
     // Serialize quota checks across all document creates for this workspace.
     await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[a.workspaceId]);
     const count=Number((await query(c,'SELECT count(*)::int AS n FROM portal.documents WHERE workspace_id=$1 AND deleted_at IS NULL',[a.workspaceId]))[0].n);
     if(p.maxDocuments!==null&&count>=p.maxDocuments)fail(403,'document_quota_exceeded');
     const id=randomUUID();
     await c.query(`INSERT INTO portal.documents(id,workspace_id,owner_id,kind,title,current_version,general_access,search_text) VALUES($1,$2,$3,$4,$5,1,'restricted',$5)`,[id,a.workspaceId,a.userId,kind,name]);
     await c.query(`INSERT INTO portal.document_versions(document_id,version_no,content,source,created_by) VALUES($1,1,$2,'user',$3)`,[id,JSON.stringify(content),a.userId]);
     await c.query('INSERT INTO portal.doc_metadata(document_id,workspace_id) VALUES($1,$2)',[id,a.workspaceId]);
     await audit(c,a,id,'created');return id;
   });res.status(201).json({id,version:1});
 }));
 r.get('/:id',wrap(async(req,res)=>{
   const d=await get(db,req.params.id,req.docsActor);
   if(d.deleted_at)fail(404,'not_found');
   const v=(await query(db,'SELECT content,version_no FROM portal.document_versions WHERE document_id=$1 AND version_no=$2',[d.id,d.current_version]))[0];
   res.json({document:d,content:v?.content??null});
 }));
 r.put('/:id',wrap(async(req,res)=>{
   const a=req.docsActor,content=safeContent(req.body.content);
   if(!Number.isSafeInteger(req.body.base_version)||req.body.base_version<1)fail(400,'invalid_base_version');
   const version=await tx(async c=>{
     const d=await get(c,req.params.id,a,'write',true);
     if(d.deleted_at)fail(404,'not_found');
     if(d.current_version!==req.body.base_version)fail(409,'version_conflict');
     const n=d.current_version+1;
     await c.query(`INSERT INTO portal.document_versions(document_id,version_no,content,source,created_by) VALUES($1,$2,$3,'user',$4)`,[d.id,n,JSON.stringify(content),a.userId]);
     await c.query('UPDATE portal.documents SET current_version=$2,updated_at=now() WHERE id=$1',[d.id,n]);
     await audit(c,a,d.id,'saved');return n;
   });res.json({version,saved:true});
 }));
 r.patch('/:id',wrap(async(req,res)=>{
   const a=req.docsActor;
   const result=await tx(async c=>{
     const d=await get(c,req.params.id,a,'write',true);
     if(d.deleted_at)fail(404,'not_found');
     if(req.body.title!==undefined)await c.query('UPDATE portal.documents SET title=$2,search_text=$2,updated_at=now() WHERE id=$1',[d.id,title(req.body.title)]);
     if(req.body.starred!==undefined){
       if(typeof req.body.starred!=='boolean')fail(400,'invalid_starred');
       await c.query(`UPDATE portal.doc_metadata SET starred_by=CASE WHEN $3::boolean THEN
         (SELECT COALESCE(jsonb_agg(DISTINCT v),'[]'::jsonb) FROM jsonb_array_elements_text(starred_by||to_jsonb($2::text)) AS v)
         ELSE starred_by - $2::text END WHERE document_id=$1`,[d.id,a.userId,req.body.starred]);
     }
     await audit(c,a,d.id,'metadata_changed');return {ok:true};
   });res.json(result);
 }));
 r.get('/:id/versions',wrap(async(req,res)=>{
   await get(db,req.params.id,req.docsActor);
   const limit=req.docsPolicy.history===null?200:Math.min(200,req.docsPolicy.history);
   const versions=await query(db,'SELECT version_no,source,note,created_by,created_at FROM portal.document_versions WHERE document_id=$1 ORDER BY version_no DESC LIMIT $2',[req.params.id,limit]);
   res.json({versions});
 }));
 r.post('/:id/restore',wrap(async(req,res)=>{
   const a=req.docsActor,n=req.body.version;
   if(!Number.isSafeInteger(n)||n<1)fail(400,'invalid_version');
   const version=await tx(async c=>{
     const d=await get(c,req.params.id,a,'write',true);
     if(d.deleted_at)fail(404,'not_found');
     const v=(await query(c,'SELECT content FROM portal.document_versions WHERE document_id=$1 AND version_no=$2',[d.id,n]))[0];
     if(!v)fail(404,'not_found');
     const next=d.current_version+1;
     await c.query(`INSERT INTO portal.document_versions(document_id,version_no,content,source,created_by) VALUES($1,$2,$3,'restore',$4)`,[d.id,next,JSON.stringify(v.content),a.userId]);
     await c.query('UPDATE portal.documents SET current_version=$2,updated_at=now() WHERE id=$1',[d.id,next]);
     await audit(c,a,d.id,'restored');return next;
   });res.json({version});
 }));
 r.get('/:id/permissions',wrap(async(req,res)=>{
   const d=await get(db,req.params.id,req.docsActor,'owner');
   const permissions=await query(db,'SELECT user_id,role FROM portal.document_permissions WHERE document_id=$1',[d.id]);res.json({permissions});
 }));
 r.put('/:id/permissions',wrap(async(req,res)=>{
   const a=req.docsActor,p=req.docsPolicy,userId=assertId(req.body.user_id),role=req.body.role;
   if(!['viewer','editor',null].includes(role))fail(400,'invalid_role');
   await tx(async c=>{
     const d=await get(c,req.params.id,a,'owner',true);
     if(d.deleted_at)fail(404,'not_found');
     if(userId===a.userId)fail(400,'cannot_share_with_self');
     if(role!==null){
       if(p.shareLimit===0)fail(403,'entitlement_required');
       // Adapt membership table name/columns to the live Portal schema before integration.
       const member=await query(c,'SELECT 1 FROM portal.workspace_members WHERE workspace_id=$1 AND user_id=$2 LIMIT 1',[a.workspaceId,userId]);
       if(!member.length)fail(404,'not_found');
       const count=Number((await query(c,'SELECT count(*)::int AS n FROM portal.document_permissions WHERE document_id=$1 AND user_id<>$2',[d.id,userId]))[0].n);
       if(p.shareLimit!==null&&count>=p.shareLimit)fail(403,'collaborator_quota_exceeded');
       await c.query(`INSERT INTO portal.document_permissions(document_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)
          ON CONFLICT(document_id,user_id) DO UPDATE SET role=EXCLUDED.role,granted_by=EXCLUDED.granted_by`,[d.id,userId,role,a.userId]);
     }else await c.query('DELETE FROM portal.document_permissions WHERE document_id=$1 AND user_id=$2',[d.id,userId]);
     await audit(c,a,d.id,'sharing_changed');
   });res.json({ok:true});
 }));
 r.get('/:id/comments',wrap(async(req,res)=>{
   requireFeature(req.docsPolicy,'comments');const d=await get(db,req.params.id,req.docsActor);
   const comments=await query(db,'SELECT id,author_id,body,created_at,resolved_at FROM portal.doc_comments WHERE document_id=$1 ORDER BY created_at DESC LIMIT 200',[d.id]);res.json({comments});
 }));
 r.post('/:id/comments',wrap(async(req,res)=>{
   requireFeature(req.docsPolicy,'comments');const a=req.docsActor;
   const body=req.body.body;
   if(typeof body!=='string'||body.trim().length<1||body.length>4000)fail(400,'invalid_comment');
   const id=await tx(async c=>{const d=await get(c,req.params.id,a,'write');if(d.deleted_at)fail(404,'not_found');const id=randomUUID();await c.query('INSERT INTO portal.doc_comments(id,document_id,author_id,body) VALUES($1,$2,$3,$4)',[id,d.id,a.userId,body.trim()]);await audit(c,a,d.id,'commented');return id;});res.status(201).json({id});
 }));
 r.delete('/:id',wrap(async(req,res)=>{
   const a=req.docsActor;
   await tx(async c=>{const d=await get(c,req.params.id,a,'owner',true);await c.query('UPDATE portal.documents SET deleted_at=now(),updated_at=now() WHERE id=$1 AND deleted_at IS NULL',[d.id]);await audit(c,a,d.id,'deleted');});res.status(204).end();
 }));
 r.post('/:id/undelete',wrap(async(req,res)=>{
   const a=req.docsActor;
   await tx(async c=>{const d=await get(c,req.params.id,a,'owner',true);await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[a.workspaceId]);const count=Number((await query(c,'SELECT count(*)::int AS n FROM portal.documents WHERE workspace_id=$1 AND deleted_at IS NULL',[a.workspaceId]))[0].n);if(req.docsPolicy.maxDocuments!==null&&count>=req.docsPolicy.maxDocuments)fail(403,'document_quota_exceeded');await c.query('UPDATE portal.documents SET deleted_at=NULL,updated_at=now() WHERE id=$1',[d.id]);await audit(c,a,d.id,'undeleted');});res.json({ok:true});
 }));
 r.get('/:id/export.txt',wrap(async(req,res)=>{
   const d=await get(db,req.params.id,req.docsActor);if(d.deleted_at)fail(404,'not_found');
   const v=(await query(db,'SELECT content FROM portal.document_versions WHERE document_id=$1 AND version_no=$2',[d.id,d.current_version]))[0];
   // Plain text only. Real DOCX/PDF conversion requires an isolated conversion service.
   const blocks=Array.isArray(v.content?.blocks)?v.content.blocks:[];
   const plain=blocks.map(b=>typeof b.text==='string'?b.text:'').join('\n');
   res.type('text/plain; charset=utf-8').set('Content-Disposition',`attachment; filename="document-${d.id}.txt"`).send(plain);
 }));
 r.use((err,req,res,next)=>{
   if(res.headersSent)return next(err);
   const status=Number.isInteger(err.status)?err.status:500;
   if(status>=500)console.error('docs-api error',err);
   res.status(status).json({error:status>=500?'internal_error':err.code||'request_failed'});
 });
 return r;
}
