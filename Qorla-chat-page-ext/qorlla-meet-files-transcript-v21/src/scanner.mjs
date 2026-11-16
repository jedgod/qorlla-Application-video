import {createHash} from 'node:crypto';
// Requires an injected ClamAV streaming client (INSTREAM protocol) and an injected
// magic-byte MIME detector. No extension-based acceptance or scan bypass.
export function scanningAdapter({clamav,detectMime,maxBytes=25*1024*1024}){
 if(!clamav||!detectMime)throw new Error('scanner_dependencies_required');
 return {async inspect(stream,declaredType,expectedBytes){
  const chunks=[];let size=0;
  for await(const chunk of stream){size+=chunk.length;if(size>maxBytes||size>expectedBytes)throw new Error('oversize');chunks.push(chunk);}
  if(size!==expectedBytes)throw new Error('size_mismatch');
  const buffer=Buffer.concat(chunks);const detectedType=await detectMime(buffer);
  const result=await clamav.scan(buffer);return {clean:result==='OK'&&detectedType===declaredType,detectedType,sha256:createHash('sha256').update(buffer).digest('hex'),engine:'clamav',reason:result};
 }};
}
