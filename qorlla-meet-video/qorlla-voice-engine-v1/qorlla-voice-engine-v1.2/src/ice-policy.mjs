import {turnCredentials} from './core.mjs';
export function iceConfiguration(account,env=process.env){
 const urls=(env.TURN_URLS||'').split(',').map(s=>s.trim()).filter(Boolean);
 if(env.VOICE_REQUIRE_TURN!=='false' && !urls.length)throw Error('turn_not_configured');
 if(urls.some(u=>!/^turns?:[^\s]+$/i.test(u)))throw Error('invalid_turn_url');
 const servers=[];
 if(env.STUN_URL)servers.push({urls:[env.STUN_URL]});
 if(urls.length){const c=turnCredentials(account,600);servers.push({urls,username:c.username,credential:c.credential});}
 return {iceServers:servers,iceTransportPolicy:env.VOICE_RELAY_ONLY==='true'?'relay':'all',expiresIn:600};
}
