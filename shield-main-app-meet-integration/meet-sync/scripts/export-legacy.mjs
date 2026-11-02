import fs from 'node:fs';
const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('Usage: node export-legacy.mjs schedules.json export.jsonl');
const data=JSON.parse(fs.readFileSync(input,'utf8'));
const list=Array.isArray(data)?data:Array.isArray(data.schedules)?data.schedules:null;
if(!list)throw Error('Expected JSON array or {schedules:[]}');
const lines=[];const seen=new Set();let skipped=0;
for(const s of list){
 if(['cancelled','deleted'].includes(String(s.status||'').toLowerCase())){skipped++;continue}
 const sourceId=String(s.sourceId??s.id??'');
 const legacyCode=String(s.legacyCode??s.meetingId??s.meetingCode??'').replace(/[\s-]/g,'');
 const title=String(s.title??s.name??'').trim();const ownerName=String(s.ownerName??s.hostName??s.organizer??'').trim();
 const scheduledAt=s.scheduledAt??s.startAt??null;
 if(!/^[a-zA-Z0-9_.:-]{1,120}$/.test(sourceId)||!/^[0-9]{10,12}$/.test(legacyCode)||!title||!ownerName||(scheduledAt!==null&&!Number.isFinite(Date.parse(scheduledAt))))throw Error('Invalid schedule sourceId='+sourceId);
 if(seen.has(sourceId))throw Error('Duplicate sourceId '+sourceId);seen.add(sourceId);
 lines.push(JSON.stringify({sourceId,legacyCode,title,ownerName,scheduledAt}));
}
fs.writeFileSync(output,lines.join('\n')+(lines.length?'\n':''),{flag:'wx',mode:0o600});console.log(JSON.stringify({exported:lines.length,skipped}));
