import crypto from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
export const uuid=()=>crypto.randomUUID();
export function cleanRichText(html){
 if(typeof html!=='string'||html.length>20000)throw Object.assign(new Error('Invalid content'),{status:400});
 const clean=sanitizeHtml(html,{allowedTags:['p','br','b','strong','i','em','u','s','blockquote','ul','ol','li','a','h2','h3'],allowedAttributes:{a:['href']},allowedSchemes:['https'],transformTags:{a:(_tag,a)=>({tagName:'a',attribs:{href:a.href||'',rel:'noopener noreferrer nofollow'}})}});
 if(!sanitizeHtml(clean,{allowedTags:[],allowedAttributes:{}}).trim())throw Object.assign(new Error('Empty content'),{status:400});
 return clean;
}
export async function authority(url,secret,payload){
 const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),3000);
 try{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${secret}`},body:JSON.stringify(payload),signal:ctrl.signal});if(!r.ok)throw Error(`Authority ${r.status}`);return await r.json()}finally{clearTimeout(timer)}
}
export async function transaction(pool,fn){const c=await pool.connect();try{await c.query('BEGIN');const v=await fn(c);await c.query('COMMIT');return v}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
export function aesEncrypt(value,key){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),ciphertext])}
export function aesDecrypt(blob,key){const b=Buffer.from(blob),decipher=crypto.createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),b.subarray(0,12));decipher.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(b.subarray(28)),decipher.final()]).toString())}
