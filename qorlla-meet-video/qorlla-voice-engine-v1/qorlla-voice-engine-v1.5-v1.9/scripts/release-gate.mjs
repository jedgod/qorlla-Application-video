import {readFileSync,writeFileSync} from 'node:fs';
const file=process.argv[2]||'certification-evidence.json';
let data;try{data=JSON.parse(readFileSync(file,'utf8'))}catch{console.error('missing_or_invalid_evidence');process.exit(2)}
const gates=Array.from({length:15},(_,i)=>`QVE-${String(i+1).padStart(2,'0')}`);
const missing=gates.filter(g=>data[g]?.status!=='PASS'||!data[g]?.evidence||!data[g]?.operator||!data[g]?.timestamp);
const report={version:'1.9',result:missing.length?'BLOCKED':'EVIDENCE_RECORDED_REVIEW_REQUIRED',missing,reviewRequired:true};
console.log(JSON.stringify(report,null,2));process.exit(missing.length?1:0);
