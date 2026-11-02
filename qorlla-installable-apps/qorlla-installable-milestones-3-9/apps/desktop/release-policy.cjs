const crypto=require('node:crypto');const fs=require('node:fs');
function sha256File(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}
function verifyManifest(manifest,artifact,publicKey){if(!manifest||!manifest.signature||!manifest.sha256)throw Error('Unsigned manifest');if(sha256File(artifact)!==manifest.sha256)throw Error('Artifact hash mismatch');const payload=Buffer.from(JSON.stringify({version:manifest.version,sha256:manifest.sha256,platform:manifest.platform}));return crypto.verify(null,payload,publicKey,Buffer.from(manifest.signature,'base64'));}
module.exports={sha256File,verifyManifest};
