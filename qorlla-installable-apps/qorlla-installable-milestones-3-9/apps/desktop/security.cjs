const {URL}=require('node:url');
function verifiedOrigin(raw){const u=new URL(raw);if(u.protocol!== 'https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error('A bare HTTPS origin is required');return u.origin;}
function navigationAllowed(raw,origin){try{const u=new URL(raw);return u.origin===origin&&u.protocol==='https:';}catch{return false;}}
function externalAllowed(raw){try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}}
module.exports={verifiedOrigin,navigationAllowed,externalAllowed};
