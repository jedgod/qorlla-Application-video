import {readFileSync,existsSync} from 'node:fs';
const manifest=JSON.parse(readFileSync(new URL('./evidence.json',import.meta.url)));
const mandatory=['portal_auth','meet_shield_membership','tenant_rls','postgres_integration','redis_replay','attachments_clamav','oauth_pkce_revocation','browser_e2e','security_negative','performance','workspace_regression','meet_regression','shield_regression','ollama_private_ai'];
let failed=0;
for(const gate of mandatory){const entry=manifest.gates?.[gate];const valid=entry?.status==='pass'&&typeof entry.evidence==='string'&&entry.evidence.length>0&&existsSync(new URL(entry.evidence,import.meta.url));console.log(`${valid?'PASS':'BLOCK'} ${gate}`);if(!valid)failed++}
console.log(failed?`NO-GO: ${failed} mandatory gates missing verified evidence`:'Evidence files present; review provenance and approve release separately');
if(failed)process.exitCode=1;
