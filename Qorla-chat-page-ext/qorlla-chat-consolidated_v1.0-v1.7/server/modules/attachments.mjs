import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,rename,unlink,stat} from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
export const MAX_FILE=20*1024*1024;
export async function scanClamAV(file,{host='127.0.0.1',port=3310}={}){
 return new Promise((resolve,reject)=>{const socket=net.connect({host,port}),chunks=[];let done=false;const fail=e=>{if(!done){done=true;socket.destroy();reject(e)}};socket.setTimeout(15000,()=>fail(Error('Scan timeout')));socket.on('error',fail);socket.on('data',c=>chunks.push(c));socket.on('end',()=>{if(done)return;done=true;const text=Buffer.concat(chunks).toString();if(text.includes('FOUND'))resolve(false);else if(text.includes('OK'))resolve(true);else reject(Error('Scanner returned unexpected result'))});socket.on('connect',()=>{socket.write('zINSTREAM\0');const stream=createReadStream(file,{highWaterMark:65536});stream.on('data',chunk=>{const size=Buffer.alloc(4);size.writeUInt32BE(chunk.length);socket.write(size);socket.write(chunk)});stream.on('end',()=>socket.end(Buffer.alloc(4)));stream.on('error',fail)})})
}
export async function acceptQuarantinedFile({tempPath,root,originalName,mime,scanner}){
 const s=await stat(tempPath);if(s.size>MAX_FILE||s.size<1)throw Error('Invalid upload size');
 const allowed=['image/png','image/jpeg','image/webp','application/pdf','text/plain'];if(!allowed.includes(mime))throw Error('Unsupported MIME');
 const clean=await scanner(tempPath);if(clean!==true)throw Error('Malware scan did not clear file');
 const key=randomUUID();await mkdir(root,{recursive:true,mode:0o700});const target=path.join(root,key);await rename(tempPath,target);const hash=createHash('sha256');for await(const chunk of createReadStream(target))hash.update(chunk);
 return {key,sha256:hash.digest('hex'),size:s.size,name:path.basename(originalName).slice(0,255),mime};
}
export async function discard(tempPath){await unlink(tempPath).catch(()=>{})}
