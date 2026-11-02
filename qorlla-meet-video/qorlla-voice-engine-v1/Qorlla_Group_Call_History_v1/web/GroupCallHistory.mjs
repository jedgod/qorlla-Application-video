// Framework-neutral SDK; credentials supplied by the existing authenticated app.
export class GroupCallHistoryClient {
 constructor({baseUrl='/v1/voice/history',getToken,fetchImpl=fetch}={}){if(typeof getToken!=='function')throw Error('getToken required');this.baseUrl=baseUrl;this.getToken=getToken;this.fetchImpl=fetchImpl;}
 async request(path='',signal){const token=await this.getToken();if(!token)throw Error('No session');const response=await this.fetchImpl(this.baseUrl+path,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},credentials:'omit',signal});if(!response.ok)throw Error(`History request failed (${response.status})`);return response.json();}
 list({limit=25,cursor,signal}={}){const q=new URLSearchParams({limit:String(limit)});if(cursor)q.set('cursor',cursor);return this.request('?'+q,signal);}
 get(callId,{signal}={}){if(!/^[a-f0-9-]{36}$/i.test(callId))throw Error('Invalid call id');return this.request('/'+encodeURIComponent(callId),signal);}
}
export function formatHistoryItem(item,{locale='en-US'}={}){return {id:item.call_id,title:item.room_name||'Group call',date:new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short'}).format(new Date(item.updated_at)),subtitle:`${item.status} · ${Math.floor(item.duration_seconds/60)}m ${item.duration_seconds%60}s`,status:item.status};}
