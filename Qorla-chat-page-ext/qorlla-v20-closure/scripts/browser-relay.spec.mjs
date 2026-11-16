// Requires npm install -D playwright and actual coturn credentials/ports.
import {chromium,firefox,webkit} from 'playwright';
const browserType=process.env.BROWSER||'chromium';const browser=await ({chromium,firefox,webkit})[browserType].launch({headless:true});
try{const ctx=await browser.newContext();const page=await ctx.newPage();const result=await page.evaluate(async({url,username,credential})=>{
 const pc=new RTCPeerConnection({iceTransportPolicy:'relay',iceServers:[{urls:url,username,credential}]});pc.createDataChannel('relay-test');await pc.setLocalDescription(await pc.createOffer());await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('relay candidate timeout')),15000);pc.addEventListener('icecandidate',e=>{if(e.candidate?.candidate.includes(' typ relay ')){clearTimeout(timer);resolve();}});});const stats=await pc.getStats();pc.close();return {relayCandidate:true,statsCount:stats.size};
 },{url:process.env.TURN_URL,username:process.env.TURN_USER,credential:process.env.TURN_PASSWORD});console.log(result);
}finally{await browser.close();}
