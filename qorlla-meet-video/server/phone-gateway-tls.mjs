// Optional dedicated gateway listener: the application sees the actual TLS peer certificate,
// rather than trusting a certificate header supplied through an HTTP reverse proxy.
import https from 'node:https';
import fs from 'node:fs';
export function gatewayTlsListener({app,io,env=process.env}) {
  const paths=[env.PHONE_GATEWAY_TLS_CERT,env.PHONE_GATEWAY_TLS_KEY,env.PHONE_GATEWAY_TLS_CA];
  if(paths.every(x=>!x))return null;
  if(paths.some(x=>!x))throw new Error('Gateway TLS requires certificate, key and CA paths');
  const server=https.createServer({cert:fs.readFileSync(paths[0]),key:fs.readFileSync(paths[1]),ca:fs.readFileSync(paths[2]),requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2'},(req,res)=>{
    if(!req.url?.startsWith('/api/phone/ivr/')){res.writeHead(404);res.end();return;}
    app(req,res);
  });
  io.attach(server);
  const port=Number(env.PHONE_GATEWAY_TLS_PORT||3443);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid gateway TLS port');
  server.listen(port,env.PHONE_GATEWAY_TLS_HOST||'127.0.0.1');
  return server;
}
