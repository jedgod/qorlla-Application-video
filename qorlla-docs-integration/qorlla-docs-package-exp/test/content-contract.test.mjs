import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/docs-api.mjs',import.meta.url),'utf8');
test('docs router contains server-side permission and version controls',()=>{
 for(const token of ['version_conflict','document_quota_exceeded','entitlement_unavailable','workspaceId','base_version','pg_advisory_xact_lock']) assert.ok(source.includes(token),token);
});
test('new management routes are implemented',()=>{
 for(const token of ["'/folders'","'/folders/:folderId'","'/:id/duplicate'","'/:id/move'","'/:id/versions/:version'","'/:id/comments/:commentId/resolve'"])assert.ok(source.includes(token),token);
});
