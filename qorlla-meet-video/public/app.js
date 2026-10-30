import {initCollab} from './collab.js';
const $=id=>document.getElementById(id);
// Mounted at / or behind a path prefix such as /meet/ (reverse proxy strips it): everything is relative to this page's directory.
const BASE=new URL('.',document.baseURI).pathname;
const state={token:null,meetingId:null,participantId:null,role:'guest',name:'',socket:null,stream:null,screen:null,peers:new Map(),roster:new Set(),names:new Map(),mic:true,cam:true,hand:false,recording:null,recordChunks:[],iceServers:[],start:Date.now()};
const notify=(message)=>{const t=$('toast');t.textContent=message;t.classList.remove('hidden');clearTimeout(notify.timer);notify.timer=setTimeout(()=>t.classList.add('hidden'),3200);};
const error=(e)=>{const message=e?.message||String(e);$('landingError').textContent=message;notify(message);};
const api=async(path,method='GET',body)=>{const r=await fetch(BASE+'api'+path,{method,headers:{'Content-Type':'application/json',...(state.token?{Authorization:'Bearer '+state.token}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error||'Request failed');return data;};
function escapeText(text){const el=document.createElement('span');el.textContent=String(text);return el;}
function addMessage(msg){const d=document.createElement('div');d.className='message';const who=document.createElement('strong');who.textContent=msg.name;d.append(who,escapeText(msg.body));$('messages').append(d);$('messages').scrollTop=$('messages').scrollHeight;}
function tile(id,name,isLocal=false){let el=document.getElementById('tile-'+id);if(el)return el;el=document.createElement('div');el.id='tile-'+id;el.className='tile';const avatar=document.createElement('div');avatar.className='avatar';avatar.textContent=(name||'?').split(/\s+/).map(s=>s[0]).join('').slice(0,2).toUpperCase();const plate=document.createElement('div');plate.className='nameplate';plate.textContent=name+(isLocal?' (You)':'');const hand=document.createElement('span');hand.className='hand';el.append(avatar,plate,hand);$('videos').append(el);return el;}
function setVideo(id,stream,muted=false){const el=tile(id,state.names.get(id)||id,id===state.participantId);let v=el.querySelector('video');if(!v){v=document.createElement('video');v.autoplay=true;v.playsInline=true;v.muted=muted;el.prepend(v);}v.srcObject=stream;if(state.sinkId&&v.setSinkId)v.setSinkId(state.sinkId).catch(()=>{});el.querySelector('.avatar').style.display=stream.getVideoTracks().some(t=>t.enabled&&t.readyState==='live')?'none':'grid';v.play().catch(()=>{});if(id!==state.participantId)recAddAudio(id,stream);}
function renderPeople(){const root=$('peopleList');root.replaceChildren();for(const id of state.roster){const p=document.createElement('div');p.className='person';p.textContent=(state.names.get(id)||id.slice(0,8))+(id===state.participantId?' (You)':'');root.append(p);}}
function openTab(tab){shell.tab=tab;document.querySelectorAll('[data-tab]').forEach(b=>{const on=b.dataset.tab===tab;b.classList.toggle('selected',on);b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;});document.querySelectorAll('.tab-view').forEach(v=>v.classList.toggle('hidden',v.id!=='tab-'+tab));}
async function startMeeting(payload){Object.assign(state,{token:payload.token,meetingId:payload.meetingId,participantId:payload.participantId});const claims=JSON.parse(atob(payload.token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));state.role=claims.role;$('recordBtn').classList.toggle('hidden',claims.role!=='host');state.name=claims.name;state.names.set(state.participantId,state.name);state.start=Date.now();sessionStorage.setItem('qorlla-session',JSON.stringify({token:state.token,meetingId:state.meetingId,participantId:state.participantId}));await waitForAdmission();                                                                    // a guest in the waiting room cannot see anything until the host admits them
  await refreshIce();
  const data=await api('/meetings/'+state.meetingId);state.settings=data.waiting_room===undefined?null:{waitingRoom:data.waiting_room,joinBeforeHost:data.join_before_host,lockOnHostJoin:data.lock_on_host_join,locked:data.locked};$('landing').classList.add('hidden');$('app').classList.remove('hidden');$('roomTitle').textContent=data.title;$('roomId').textContent=(c=>/^\d{11}$/.test(c)?c.slice(0,3)+' '+c.slice(3,7)+' '+c.slice(7):c)(data.meeting_code||state.meetingId.slice(0,8));state.meetingInfo='Meeting ID: '+(data.meeting_code||state.meetingId);$('endBtn').classList.toggle('hidden',state.role!=='host');data.messages.forEach(addMessage);try{const cfg=await api('/config');if(!state.iceServers||!state.iceServers.length)state.iceServers=cfg.iceServers;state.returnOrigins=cfg.returnOrigins||[];}catch{}await startMedia();connect();collab.load();loadWaiting();}
async function startMedia(){try{state.stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:{width:{ideal:1280},height:{ideal:720}}});await applyDevicePrefs();}catch(e){notify('Media unavailable: '+e.message);state.stream=new MediaStream();state.mic=false;state.cam=false;}setVideo(state.participantId,state.stream,true);updateControls();}
function updateControls(){
  const set=(id,label,off,pressed)=>{const b=$(id);b.querySelector('span').textContent=label;b.classList.toggle('off',!!off);b.setAttribute('aria-pressed',String(!!pressed));};
  set('micBtn',state.mic?'Mute':'Unmute',!state.mic,!state.mic);set('camBtn',state.cam?'Stop video':'Start video',!state.cam,!state.cam);
  $('handBtn').querySelector('span').textContent=state.hand?'Lower hand':'Raise hand';$('handBtn').classList.toggle('on',state.hand);$('handBtn').setAttribute('aria-pressed',String(state.hand));
  const local=$('tile-'+state.participantId);if(local)local.querySelector('.avatar').style.display=(state.cam&&state.stream?.getVideoTracks().length)||local.classList.contains('sharing-local')?'none':'grid';setTileMedia(state.participantId,state.mic,state.cam);}
function connect(){state.socket=io({path:BASE+'socket.io',auth:{token:state.token},transports:['websocket','polling']});const s=state.socket;s.on('connect',()=>{state.reconnected=!!state.everConnected;state.everConnected=true;net.signaling='connected';net.lostAt=0;renderNet();if(state.reconnected)collab.load();s.emit('media-state',{mic:state.mic,cam:state.cam,sharing:!!state.screen});});s.on('connect_error',e=>{if(!net.lostAt)net.lostAt=Date.now();net.signaling=!s.active||!s.io.reconnection()?'disconnected':(state.everConnected?'reconnecting':'connecting');renderNet();if(!state.everConnected)notify('Connection error: '+e.message);});s.on('disconnect',reason=>{net.lostAt=Date.now();net.signaling=s.active&&s.io.reconnection()?'reconnecting':'disconnected';renderNet();if(reason==='io server disconnect')notify('You were disconnected from the meeting (another session may have joined as you).');});s.on('roster',ids=>{state.roster=new Set([...ids,state.participantId]);renderPeople();
  for(const id of [...state.peers.keys()])if(!state.roster.has(id))removePeer(id);                                  // people who left while we were offline
  for(const id of ids)if(id!==state.participantId){if(state.reconnected)dropPeer(id);createPeer(id,true);}          // after a reconnect every peer connection is rebuilt (the tile stays: no duplicates)
  state.reconnected=false;renderNet();});s.on('participant-online',p=>{s.emit('media-state',{mic:state.mic,cam:state.cam,sharing:!!state.screen});announce(p.name+' joined');state.roster.add(p.participantId);state.names.set(p.participantId,p.name);tile(p.participantId,p.name);renderPeople();notify(p.name+' joined');});s.on('participant-offline',p=>{announce((state.names.get(p.participantId)||'A participant')+' left');state.roster.delete(p.participantId);removePeer(p.participantId);renderPeople();renderNet();});s.on('signal',async({from,data})=>{try{await onSignal(from,data);}catch(e){console.error(e);notify('Media negotiation failed');}});s.on('names',map=>{for(const [pid,n] of Object.entries(map)){state.names.set(pid,n);const t=$('tile-'+pid);if(t&&pid!==state.participantId){t.querySelector('.nameplate').textContent=n;t.querySelector('.avatar').textContent=n.split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase();}}renderPeople();});s.on('chat',addMessage);s.on('recording-state',st=>recState(st));s.on('media-state',({participantId,sharing,mic,cam})=>{const t=$('tile-'+participantId);if(t&&participantId!==state.participantId){t.classList.toggle('sharing-remote',!!sharing);setTileMedia(participantId,mic,cam);}});s.on('hand',({participantId,raised})=>{setHand(participantId,raised);if(raised)announce((state.names.get(participantId)||'Someone')+' raised their hand');});s.on('reaction',({name,emoji})=>notify(name+' '+emoji));collab.attach(s);s.on('limit-reminder',limitReminder);s.on('meeting-limit',endedByLimit);s.on('waiting-changed',()=>loadWaiting());s.on('meeting-ended',()=>{notify('Host ended the meeting');setTimeout(()=>leave(),1300);});}
// One RTCPeerConnection per remote participant. The side that makes the offer owns the pair's "epoch"; every signal carries it, so messages from an
// older connection (before a reconnect) are ignored instead of corrupting the new one. ICE restarts reuse the epoch; a rebuilt connection gets a new one.
const ICE_GRACE_MS=4000,MAX_RESTARTS=3;
const newEpoch=()=>Math.random().toString(36).slice(2)+Date.now().toString(36);
const sendSignal=(to,data)=>{if(state.socket?.connected)state.socket.emit('signal',{to,data});};
function createPeer(id,initiator=false){
  if(state.peers.has(id))return state.peers.get(id);
  const pc=new RTCPeerConnection({iceServers:state.iceServers,iceTransportPolicy:state.iceTransportPolicy||'all'});state.peers.set(id,pc);pc._queue=[];pc._restarts=0;if(initiator)pc._epoch=newEpoch();
  for(const track of state.stream.getTracks())pc.addTrack(track,state.stream);
  pc.onicecandidate=e=>{if(e.candidate)sendSignal(id,{type:'candidate',candidate:e.candidate,epoch:pc._epoch||pc._remoteEpoch});};
  pc.ontrack=e=>{const stream=e.streams[0]||new MediaStream([e.track]);setVideo(id,stream);};
  pc.onconnectionstatechange=()=>{
    clearTimeout(pc._grace);renderNet();
    if(pc.connectionState==='connected'){pc._restarts=0;}
    else if(pc.connectionState==='failed')recoverPeer(id,pc);
    else if(pc.connectionState==='disconnected')pc._grace=setTimeout(()=>{if(state.peers.get(id)===pc&&pc.connectionState!=='connected')recoverPeer(id,pc);},ICE_GRACE_MS);
  };
  if(initiator)offerTo(id,pc,false);
  return pc;
}
async function offerTo(id,pc,iceRestart){
  try{const o=await pc.createOffer(iceRestart?{iceRestart:true}:undefined);await pc.setLocalDescription(o);sendSignal(id,{type:'offer',sdp:pc.localDescription,epoch:pc._epoch});}catch(e){console.error('offer failed',e);}
}
// A connection that is down: restart ICE (the offering side does it; the answering side asks); after repeated failures rebuild from scratch.
function recoverPeer(id,pc){
  if(state.peers.get(id)!==pc||!state.roster.has(id))return;
  if(!state.socket?.connected)return;                                                   // signalling is down: the roster handler rebuilds everything when it returns
  if(++pc._restarts>MAX_RESTARTS){if(pc._epoch){dropPeer(id);createPeer(id,true);}else sendSignal(id,{type:'rebuild',epoch:pc._remoteEpoch});return;}
  if(pc._epoch&&pc.signalingState==='stable')offerTo(id,pc,true);else if(!pc._epoch)sendSignal(id,{type:'restart',epoch:pc._remoteEpoch});
}
async function onSignal(id,data){
  let pc=state.peers.get(id);
  if(data.type==='offer'){
    if(pc&&pc._epoch){                                                                  // both sides offered at once: the lower id yields, the other keeps its offer
      if(state.participantId<id){dropPeer(id);pc=null;}else return;
    }else if(pc&&pc._remoteEpoch&&pc._remoteEpoch!==data.epoch){dropPeer(id);pc=null;}   // the other side rebuilt its connection
    if(!pc)pc=createPeer(id,false);
    pc._remoteEpoch=data.epoch;await pc.setRemoteDescription(data.sdp);await flushCandidates(pc);
    const answer=await pc.createAnswer();await pc.setLocalDescription(answer);sendSignal(id,{type:'answer',sdp:pc.localDescription,epoch:data.epoch});return;
  }
  if(!pc||(data.epoch&&data.epoch!==(pc._epoch||pc._remoteEpoch)))return;               // stale message from a connection that no longer exists
  if(data.type==='answer'){if(pc.signalingState==='have-local-offer'){await pc.setRemoteDescription(data.sdp);await flushCandidates(pc);}}
  else if(data.type==='candidate'){if(pc.remoteDescription)try{await pc.addIceCandidate(data.candidate);}catch(e){console.warn('ICE candidate rejected',e);}else pc._queue.push(data.candidate);}
  else if(data.type==='restart'){if(pc._epoch)recoverPeer(id,pc);}
  else if(data.type==='rebuild'){if(pc._epoch){dropPeer(id);createPeer(id,true);}}
}
async function flushCandidates(pc){const q=pc._queue.splice(0);for(const c of q)try{await pc.addIceCandidate(c);}catch(e){console.warn('queued ICE candidate rejected',e);}}
function dropPeer(id){const pc=state.peers.get(id);if(!pc)return;clearTimeout(pc._grace);pc.onconnectionstatechange=pc.ontrack=pc.onicecandidate=null;try{pc.close();}catch{}state.peers.delete(id);}
function removePeer(id){dropPeer(id);$('tile-'+id)?.remove();}

// ---- what the header and status line say: meeting, signalling and media are reported separately, and a lost connection never looks healthy -------
const net={signaling:'connecting',lostAt:0,online:navigator.onLine!==false};
function mediaHealth(){
  if(state.stream&&!state.stream.getTracks().some(t=>t.readyState==='live'))return 'unavailable';
  const st=[...state.peers.values()].map(p=>p.connectionState);
  return st.some(s=>s==='failed'||s==='disconnected')?'interrupted':st.some(s=>s==='new'||s==='connecting')?'connecting':'ok';
}
function renderNet(){
  const b=$('liveBadge'),t=$('liveText'),status=$('status');if(!b||!status)return;
  const media=mediaHealth(),lost=net.lostAt?Date.now()-net.lostAt:0;let key,label,line;
  if(!net.online){key='offline';label='No network';line='No network connection';}
  else if(net.signaling==='disconnected'){key='offline';label='Disconnected';line='Disconnected';}
  else if(net.signaling==='reconnecting'){key=lost>30000?'offline':'reconnecting';label=lost>30000?'Connection lost':'Reconnecting…';line=lost>30000?'Connection lost — still trying to reconnect':'Reconnecting…';}
  else if(net.signaling==='connecting'){key='reconnecting';label='Connecting…';line='Connecting…';}
  else if(media==='interrupted'){key='media';label='Media interrupted';line='Connected · media interrupted, recovering';}
  else if(media==='unavailable'){key='media';label='No camera/mic';line='Connected · camera and microphone are not available';}
  else{key='live';label='Live';line='Connected';}
  if(renderNet.k!==key){if(renderNet.k)announce(key==='live'?'Connection restored. The meeting is live.':line);renderNet.k=key;}
  b.dataset.state=key;t.textContent=label;status.textContent=line;
}
setInterval(renderNet,1000);
window.addEventListener('offline',()=>{net.online=false;renderNet();});
window.addEventListener('online',()=>{net.online=true;if(state.socket&&!state.socket.connected&&state.socket.active===false)state.socket.connect();for(const [id,pc] of state.peers)if(pc.connectionState!=='connected')recoverPeer(id,pc);renderNet();});
async function leave(){if(state.recording)await stopRecording();state.socket?.disconnect();state.peers.forEach(pc=>pc.close());state.stream?.getTracks().forEach(t=>t.stop());state.screen?.getTracks().forEach(t=>t.stop());sessionStorage.removeItem('qorlla-session');location.href=safeReturn(returnRaw)||BASE;}
$('createBtn').onclick=async()=>{try{const p=await api('/meetings','POST',{title:$('meetingTitle').value,name:$('displayName').value,passcode:$('newPasscode').value});await startMeeting(p);}catch(e){error(e);}};
$('joinBtn').onclick=async()=>{try{const p=await api('/meetings/'+encodeURIComponent($('meetingId').value.trim())+'/join','POST',{name:$('displayName').value,passcode:$('joinPasscode').value});await startMeeting(p);}catch(e){error(e);}};
$('chatForm').onsubmit=e=>{e.preventDefault();const input=$('chatText');if(!input.value.trim())return;state.socket.emit('chat',input.value,r=>{if(r?.ok)input.value='';else notify(r?.error||'Chat failed');});};
$('micBtn').onclick=async()=>{const tracks=state.stream?.getAudioTracks()||[];if(!tracks.length){notify('No microphone track. Rejoin with permission.');return;}state.mic=!state.mic;tracks.forEach(t=>t.enabled=state.mic);state.socket.emit('media-state',{mic:state.mic,cam:state.cam,sharing:!!state.screen});updateControls();};
$('camBtn').onclick=()=>{const tracks=state.stream?.getVideoTracks()||[];if(!tracks.length){notify('No camera track. Rejoin with permission.');return;}if(tracks.some(t=>t.readyState==='ended')){recoverCamera('manual');return;}state.cam=!state.cam;tracks.forEach(t=>t.enabled=state.cam);state.socket.emit('media-state',{mic:state.mic,cam:state.cam,sharing:!!state.screen});updateControls();};
$('handBtn').onclick=()=>{state.hand=!state.hand;state.socket.emit('hand',state.hand);setHand(state.participantId,state.hand);updateControls();};
// Ending a share must reset the page whether the browser ended it ("Stop sharing" in the browser bar) or the person clicked Stop here: calling track.stop()
// yourself does NOT fire the track's "ended" event, so both paths run the same cleanup.
async function endShare(){
  if(!state.screen)return;const screen=state.screen;state.screen=null;screen.getTracks().forEach(t=>t.stop());
  for(const pc of state.peers.values()){const sender=pc.getSenders().find(s=>s.track?.kind==='video');if(sender)await sender.replaceTrack(state.shareOld||null).catch(()=>{});}
  state.shareOld=null;REC.shareVideo=null;showLocalShare(false);setVideo(state.participantId,state.stream,true);
  $('shareBtn').querySelector('span').textContent='Share';$('shareBtn').classList.remove('on');$('shareBtn').setAttribute('aria-pressed','false');
  state.socket.emit('media-state',{mic:state.mic,cam:state.cam,sharing:false});updateControls();
}
$('shareBtn').onclick=async()=>{
  if(state.screen){await endShare();return;}
  try{
    // The window you share can contain this very page. Where the browser supports it, this tab is left out of the picker; and your own share is
    // never played back live in your tile (a placeholder is shown instead), so a shared screen can never mirror itself inside itself.
    const screen=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:15,max:30}},audio:false,selfBrowserSurface:'exclude',surfaceSwitching:'include',preferCurrentTab:false});
    state.screen=screen;const track=screen.getVideoTracks()[0];state.shareOld=state.stream.getVideoTracks()[0]||null;
    for(const pc of state.peers.values()){const sender=pc.getSenders().find(s=>s.track?.kind==='video');if(sender)await sender.replaceTrack(track);}
    showLocalShare(true);REC.shareVideo=shareVideoFor(track);
    $('shareBtn').querySelector('span').textContent='Stop share';$('shareBtn').classList.add('on');$('shareBtn').setAttribute('aria-pressed','true');
    state.socket.emit('media-state',{mic:state.mic,cam:state.cam,sharing:true});
    track.onended=()=>{endShare();};
  }catch(e){notify('Screen share unavailable: '+e.message);}};
$('copyLink').onclick=()=>navigator.clipboard.writeText(location.origin+BASE+'?meeting='+($('roomId').textContent||state.meetingId)).then(()=>notify('Meeting link copied')).catch(()=>notify('Copy unavailable'));
$('settingsBtn').onclick=()=>openSettings();
$('recordBtn').onclick=()=>recButton();window.addEventListener('beforeunload',e=>{if(state.recording){e.preventDefault();e.returnValue='';}});
$('leaveBtn').onclick=leave;$('endBtn').onclick=async()=>{if(!(await askConfirm('End the meeting for everyone?','Everyone is disconnected and the meeting closes. A recording in progress stops.','End for all',true)))return;try{await api('/meetings/'+state.meetingId+'/end','POST');leave();}catch(e){notify(e.message);}};
$('peopleBtn').onclick=()=>toggleTab('people');$('chatBtn').onclick=()=>toggleTab('chat');document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>openTab(b.dataset.tab));document.querySelectorAll('[data-layout]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-layout]').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',String(x===b));});$('videos').className='video-grid '+b.dataset.layout;});document.querySelectorAll('[data-emoji]').forEach(b=>b.onclick=()=>state.socket.emit('reaction',b.dataset.emoji));
setInterval(()=>{if(!state.token)return;const seconds=Math.floor((Date.now()-state.start)/1000);$('timer').textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');},1000);
const query=new URLSearchParams(location.search);
// Where Leave sends you: this site, or an origin the operator listed in RETURN_ORIGINS (same hostname on another port is NOT enough). No parameter = the landing page.
const safeReturn = value => {if(!value)return null;try {const u=new URL(value,location.href);return ['http:','https:'].includes(u.protocol)&&(u.origin===location.origin||(state.returnOrigins||[]).includes(u.origin))?u.href:null;}catch{return null;}};
const returnRaw=query.get('return')||query.get('returnUrl');
const originalLeave=leave;
// The handoff return destination is constrained to the same hostname.
if(query.has('meeting'))$('meetingId').value=query.get('meeting');
// Hand-off from Qorlla Workplace: the session arrives in the URL fragment (never sent to a server); take it and remove it from the address bar at once.
{const m=/[#&]qs=([A-Za-z0-9_-]+)/.exec(location.hash||'');if(m){try{const p=JSON.parse(atob(m[1].replace(/-/g,'+').replace(/_/g,'/')));if(p&&p.token&&p.meetingId&&p.participantId){sessionStorage.setItem('qorlla-session',JSON.stringify({token:p.token,meetingId:p.meetingId,participantId:p.participantId}));if(p.prefs)sessionStorage.setItem('qorlla-prefs',JSON.stringify({camLabel:String(p.prefs.camLabel||'').slice(0,120),micLabel:String(p.prefs.micLabel||'').slice(0,120),spkLabel:String(p.prefs.spkLabel||'').slice(0,120),res:['720','480','360'].includes(String(p.prefs.res))?String(p.prefs.res):''}));}}catch(e){/* ignore a malformed hand-off */}try{history.replaceState(null,'',location.pathname+location.search);}catch(e){/* ignore */}}}
const cached=sessionStorage.getItem('qorlla-session');if(cached){try{startMeeting(JSON.parse(cached)).catch(e=>{sessionStorage.removeItem('qorlla-session');if(e&&/did not let you in/.test(e.message))error(e);});}catch{sessionStorage.removeItem('qorlla-session');}}

// Qorlla main-page integration: prefill fields and honor initial device preferences.
const initialName=query.get('name')||query.get('displayName');
if(initialName)$('displayName').value=initialName.slice(0,70);
const initialMeeting=query.get('meetingId')||query.get('id');
if(initialMeeting)$('meetingId').value=initialMeeting;
if(query.get('title'))$('meetingTitle').value=query.get('title').slice(0,160);
if(query.get('passcode'))$('joinPasscode').value=query.get('passcode').slice(0,100);
const desiredMic=query.get('mic')!=='false' && query.get('mic')!=='off';
const desiredCam=query.get('camera')!=='false' && query.get('cam')!=='false' && query.get('camera')!=='off';
const originalStartMedia=startMedia;
// ICE servers and relay policy for THIS participant (short-lived TURN credentials; see server/index.js). Failing keeps the static list from /api/config, so deployments without TURN are unchanged.
async function refreshIce(){
  try{
    const ice=await api('/meetings/'+state.meetingId+'/ice');state.iceServers=ice.iceServers;state.iceTransportPolicy=ice.iceTransportPolicy==='relay'?'relay':'all';
    for(const pc of state.peers.values()){try{pc.setConfiguration({...pc.getConfiguration(),iceServers:state.iceServers});}catch(e){/* closed or not changeable */}}
    clearTimeout(state.iceTimer);state.iceTimer=setTimeout(refreshIce,Math.max(30000,(Number(ice.expiresIn)||3600)*400));   // renew at 40% of the lifetime
  }catch(e){/* keep what we have */}
}
startMedia=async()=>{await originalStartMedia();state.mic=desiredMic&&state.mic;state.cam=desiredCam&&state.cam;state.stream.getAudioTracks().forEach(t=>t.enabled=state.mic);state.stream.getVideoTracks().forEach(t=>t.enabled=state.cam);state.stream.getVideoTracks().forEach(watchCamera);updateControls();};
// Camera recovery. A camera that ENDS by itself (device removed, driver reset, sleep/wake, a capture error) makes the browser fire "ended" on the track with no action from this page, which used to leave the person in the
// meeting sending no video and not knowing. The page now takes a fresh camera track and swaps it into the local stream and into every call, retrying with a short backoff. Turning the camera off by hand only
// DISABLES the track (it does not end it), and leaving stops tracks without firing "ended", so neither triggers this.
let cameraRecovering=false;state.cameraRecoveries=0;document.documentElement.dataset.cameraRecoveries='0';   // read-only diagnostic: how many times the camera was recovered in this page
function watchCamera(t){if(!t||t.__watched)return;t.__watched=true;t.addEventListener('ended',()=>{if(t.__expectedStop)return;recoverCamera('ended');});}
async function recoverCamera(why){
  if(cameraRecovering)return;cameraRecovering=true;notify('Camera lost. Reconnecting…');
  try{
    for(let attempt=1;attempt<=6;attempt++){
      try{
        const got=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:1280},height:{ideal:720}}}),nt=got.getVideoTracks()[0];if(!nt)throw new Error('no camera track');
        state.stream.getVideoTracks().forEach(o=>{o.__expectedStop=true;state.stream.removeTrack(o);try{o.stop();}catch(e){/* already ended */}});
        nt.enabled=state.cam;state.stream.addTrack(nt);watchCamera(nt);
        if(state.screen)state.shareOld=nt;   // sharing right now: the share ends back onto the NEW camera
        else for(const pc of state.peers.values()){const sender=pc.getSenders().find(x=>x.track?.kind==='video');if(sender)await sender.replaceTrack(nt).catch(()=>{});}
        state.cameraLost=false;state.cameraRecoveries++;document.documentElement.dataset.cameraRecoveries=String(state.cameraRecoveries);notify('Camera reconnected.');return;
      }catch(e){await new Promise(r=>setTimeout(r,attempt*1500));}
    }
    state.cameraLost=true;notify('Camera unavailable. It will be reconnected when it is available again, or choose Start video to try now.');
  }finally{cameraRecovering=false;}
}
// A camera that is gone (unplugged, or its driver or the browser's capture process restarted) comes back as a device change: retry then, instead of waiting for the person to notice.
navigator.mediaDevices?.addEventListener?.('devicechange',async()=>{if(!state.cameraLost||cameraRecovering)return;try{const d=await navigator.mediaDevices.enumerateDevices();if(!d.some(x=>x.kind==='videoinput'))return;}catch(e){return;}state.cameraLost=false;recoverCamera('devicechange');});
if(initialName){if(query.get('start')==='new')$('createBtn').click();else if(query.get('start')==='join' && $('meetingId').value)$('joinBtn').click();}
// launch parameters (name, passcode, mic/camera, start) have been consumed: do not leave them in the address bar, history or screenshots
try{history.replaceState(null,'',location.pathname+(returnRaw?'?return='+encodeURIComponent(returnRaw):''));}catch{}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Screen-share placeholder, meeting recording
// ---------------------------------------------------------------------------------------------------------------------------------------------
function shareVideoFor(track){const el=document.createElement('video');el.muted=true;el.playsInline=true;el.srcObject=new MediaStream([track]);el.play().catch(()=>{});return el;}
function showLocalShare(on){
  const el=document.getElementById('tile-'+state.participantId);if(!el)return;el.classList.toggle('sharing-local',on);let note=el.querySelector('.share-note');
  if(on&&!note){note=document.createElement('div');note.className='share-note';const t=document.createElement('div');t.textContent="You're sharing your screen";const b=document.createElement('button');b.type='button';b.textContent='Stop sharing';b.onclick=()=>$('shareBtn').click();note.append(t,b);el.append(note);}
  else if(!on&&note)note.remove();
  const av=el.querySelector('.avatar');if(av&&on)av.style.display='none';
}

// Recording = a file saved on THIS computer containing what you see and hear: the gallery (or the shared screen with a participant strip) and the mixed
// audio of everyone. Everyone in the meeting is shown a recording indicator while it runs.
const REC={ctx:null,dest:null,canvas:null,g:null,tick:null,ui:0,t0:0,src:new Map(),shareVideo:null,chunks:[],done:null,stream:null};
function recAddAudio(id,stream){
  if(!REC.ctx||REC.src.has(id)||!stream)return;
  const a=stream.getAudioTracks().filter(t=>t.readyState==='live');if(!a.length)return;
  try{const s=REC.ctx.createMediaStreamSource(new MediaStream([a[0]]));s.connect(REC.dest);REC.src.set(id,s);}catch(e){/* an unusable track is skipped */}
}
// Consent is enforced on what is composed: someone who has not agreed to the requested scopes is never drawn or mixed in, whatever the server timing.
function recMayShow(id){return !id||(!!REC.consent&&REC.consent.video&&REC.consent.set.has(id));}
function recSyncAudio(){
  if(!REC.ctx||!REC.dest)return;const ok=id=>!!REC.consent&&REC.consent.audio&&REC.consent.set.has(id==='local'?state.participantId:id);
  for(const [id,node] of [...REC.src]){if(!ok(id)){try{node.disconnect();}catch(e){/* already gone */}REC.src.delete(id);}}
  if(ok('local'))recAddAudio('local',state.stream);
  document.querySelectorAll('#videos .tile video').forEach(vd=>{const id=vd.closest('.tile').id.slice(5);if(id!==state.participantId&&ok(id)&&vd.srcObject)recAddAudio(id,vd.srcObject);});
}
function recDraw(t,x,y,w,h){
  const g=REC.g;g.fillStyle='#121824';g.fillRect(x,y,w,h);
  if(!recMayShow(t.id)){g.fillStyle='#8a96ab';g.textAlign='center';g.textBaseline='middle';g.font='600 16px sans-serif';g.fillText('Not recorded',x+w/2,y+h/2);g.textAlign='left';g.textBaseline='alphabetic';return;}
  const v=t.v,live=v&&v.readyState>=2&&v.videoWidth>0&&!t.el.classList.contains('sharing-local')&&t.el.querySelector('.avatar')?.style.display==='none';
  if(live){const r=Math.min(w/v.videoWidth,h/v.videoHeight),dw=v.videoWidth*r,dh=v.videoHeight*r;g.drawImage(v,x+(w-dw)/2,y+(h-dh)/2,dw,dh);}
  else{const ini=(t.name||'?').replace(/ \(You\)$/,'').split(/\s+/).map(s=>s[0]).join('').slice(0,2).toUpperCase();g.fillStyle='#273750';g.beginPath();g.arc(x+w/2,y+h/2,Math.min(w,h)/5,0,Math.PI*2);g.fill();g.fillStyle='#c9d9ff';g.font='600 '+Math.round(Math.min(w,h)/6)+'px sans-serif';g.textAlign='center';g.textBaseline='middle';g.fillText(ini,x+w/2,y+h/2);}
  g.textAlign='left';g.textBaseline='alphabetic';g.font='14px sans-serif';const label=(t.name||'').slice(0,40);const tw=g.measureText(label).width+16;g.fillStyle='rgba(7,11,18,.8)';g.fillRect(x+8,y+h-30,tw,22);g.fillStyle='#fff';g.fillText(label,x+16,y+h-14);
}
function recFrame(){
  const c=REC.canvas,g=REC.g,W=c.width,H=c.height;g.fillStyle='#080b11';g.fillRect(0,0,W,H);
  const tiles=[...document.querySelectorAll('#videos .tile')].map(el=>({el,id:el.id.slice(5),v:el.querySelector('video'),name:el.querySelector('.nameplate')?.textContent||''}));
  let main=null;
  if(state.screen&&REC.shareVideo&&REC.shareVideo.readyState>=2)main={v:REC.shareVideo,el:document.createElement('div'),name:'Your screen'};
  else{const s=tiles.find(t=>t.el.classList.contains('sharing-remote')&&t.v&&t.v.readyState>=2&&recMayShow(t.id));if(s)main={v:s.v,el:s.el,name:s.name+' (screen)'};}
  const pad=6;
  if(main){
    const mw=Math.round(W*.78);g.fillStyle='#000';g.fillRect(0,0,mw,H);const v=main.v,r=Math.min(mw/v.videoWidth,H/v.videoHeight);g.drawImage(v,(mw-v.videoWidth*r)/2,(H-v.videoHeight*r)/2,v.videoWidth*r,v.videoHeight*r);
    const rest=tiles.filter(t=>t.v!==main.v).slice(0,4),h=rest.length?Math.floor(H/rest.length):0;rest.forEach((t,i)=>recDraw(t,mw+pad,i*h+pad,W-mw-2*pad,h-2*pad));
  }else{
    const n=Math.max(1,tiles.length),cols=Math.ceil(Math.sqrt(n)),rows=Math.ceil(n/cols),cw=W/cols,ch=H/rows;
    tiles.forEach((t,i)=>recDraw(t,(i%cols)*cw+pad,Math.floor(i/cols)*ch+pad,cw-2*pad,ch-2*pad));
  }
  const s=Math.floor((Date.now()-REC.t0)/1000);g.fillStyle='rgba(185,28,28,.9)';g.fillRect(W-132,12,120,28);g.fillStyle='#fff';g.font='bold 14px sans-serif';g.fillText('● REC '+String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0'),W-122,31);
}
function recLabel(){const s=Math.floor((Date.now()-REC.t0)/1000);return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');}
function recUi(){
  const b=$('recordBtn');if(!state.recording){b.classList.remove('on');b.setAttribute('aria-pressed','false');b.querySelector('span').textContent='Record';return;}
  b.classList.add('on');b.setAttribute('aria-pressed','true');b.querySelector('span').textContent='Stop '+recLabel();renderRecBanner();
}
async function beginCapture(){
  if(!window.MediaRecorder||!HTMLCanvasElement.prototype.captureStream){notify('Recording is not supported in this browser.');return;}
  try{
    REC.canvas=document.createElement('canvas');REC.canvas.width=1280;REC.canvas.height=720;REC.g=REC.canvas.getContext('2d');
    REC.ctx=new (window.AudioContext||window.webkitAudioContext)();await REC.ctx.resume();REC.dest=REC.ctx.createMediaStreamDestination();REC.src.clear();
    recSyncAudio();
    REC.stream=new MediaStream([...REC.canvas.captureStream(15).getVideoTracks(),...REC.dest.stream.getAudioTracks()]);
    const mime=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(t=>MediaRecorder.isTypeSupported(t))||'';
    const rec=new MediaRecorder(REC.stream,mime?{mimeType:mime,videoBitsPerSecond:2500000}:{});
    Object.assign(REC,{rid:rcState.st.recordingId,nextSeq:0,accepted:0,refused:0,queue:[],queued:0,uploading:false});
    rec.ondataavailable=e=>{if(e.data&&e.data.size)recEnqueue(e.data);};
    REC.done=new Promise(resolve=>{rec.onstop=()=>{
      clearInterval(REC.ui);REC.tick?.stop?.();REC.tick=null;REC.stream.getTracks().forEach(t=>t.stop());REC.ctx.close().catch(()=>{});
      state.recording=null;recUi();
      recFinish().then(resolve,resolve);};});
    REC.t0=Date.now();state.recording=rec;rec.start(1000);
    // Frames are drawn on a plain timer (the page's content-security-policy forbids blob workers). A tab that is playing the meeting's audio is not
    // throttled by the browser, so keep this tab open while recording.
    const iv=setInterval(recFrame,66);REC.tick={stop:()=>clearInterval(iv)};
    REC.ui=setInterval(()=>{recUi();recSyncAudio();},1000);recUi();
    notify('Recording started. Everyone can see the recording indicator.');
  }catch(e){state.recording=null;notify('Could not start recording: '+(e.message||e));throw e;}
}
function stopRecording(){
  const rec=state.recording;if(!rec)return Promise.resolve();
  try{if(rec.state!=='inactive')rec.stop();}catch(e){/* already stopped */}
  return Promise.race([REC.done||Promise.resolve(),new Promise(r=>setTimeout(r,35000))]);
}
// Recorded media goes to the meeting's encrypted storage in small chunks. The server decides whether each chunk may be accepted (consent state at that moment);
// a refused chunk is dropped, never kept. Network failures are retried in order; sequence numbers only advance when a chunk is stored, so there are no gaps.
function recEnqueue(blob){
  REC.queue.push(blob);REC.queued+=blob.size;
  if(REC.queued>150*1024*1024&&!REC.overflow){REC.overflow=true;notify('Uploads are far behind. Stopping the recording to protect this computer.');rcApi('/stop','POST').catch(()=>{});}
  recPump();
}
async function recPump(){
  if(REC.uploading)return;REC.uploading=true;let tries=0;
  while(REC.queue.length){
    const blob=REC.queue[0];
    try{
      const r=await fetch(BASE+'api/v1/meetings/'+state.meetingId+'/recordings/'+REC.rid+'/chunks?seq='+REC.nextSeq,{method:'POST',headers:{Authorization:'Bearer '+state.token,'Content-Type':'application/octet-stream'},body:blob});
      if(r.status===201||r.status===200){REC.accepted++;REC.nextSeq++;REC.queue.shift();REC.queued-=blob.size;tries=0;}
      else if(r.status===409||r.status===403||r.status===404){REC.queue.shift();REC.queued-=blob.size;REC.refused++;}
      else throw new Error('HTTP '+r.status);
    }catch(e){tries++;await new Promise(res=>setTimeout(res,Math.min(8000,500*2**Math.min(tries,4))));}
  }
  REC.uploading=false;
}
const medApi=async(path,method,body)=>{const r=await fetch(BASE+'api/v1/meetings/'+state.meetingId+path,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+state.token},body:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'Request failed');return d;};
async function recFinish(){
  const t0=Date.now();while((REC.queue.length||REC.uploading)&&Date.now()-t0<25000){recPump();await new Promise(r=>setTimeout(r,200));}
  try{
    const r=await medApi('/recordings/'+REC.rid+'/complete','POST',{chunks:REC.nextSeq});
    if(r.status==='available')notify(r.partial?'Recording saved, but only part of it reached the server.':'Recording saved securely. Open More › Security and recording › Recordings to download it.');
    else notify('Nothing was recorded.');
  }catch(e){notify('The recording could not be finalized: '+e.message+'. The server keeps what it received.');}
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Fit: tiles always fill the stage exactly, whatever the window size, number of people or layout. Nothing scrolls.
// ---------------------------------------------------------------------------------------------------------------------------------------------
function fitGrid(){
  const grid=$('videos');if(!grid)return;const tiles=[...grid.querySelectorAll('.tile')];const n=tiles.length;if(!n)return;
  const W=Math.max(1,grid.clientWidth-24),H=Math.max(1,grid.clientHeight-18);
  const sharer=tiles.find(t=>t.classList.contains('sharing-remote')||t.classList.contains('sharing-local'));
  const main=sharer||tiles[0];tiles.forEach(t=>t.classList.toggle('main',t===main));
  const layout=grid.classList.contains('speaker')?'speaker':grid.classList.contains('stage')?'stage':'gallery';
  grid.classList.toggle('autoshare',layout==='gallery'&&!!sharer&&n>1);                  // someone is sharing: give the screen the big area
  const set=(k,val)=>{if(grid.style.getPropertyValue(k)!==String(val))grid.style.setProperty(k,val);};
  if(layout==='gallery'&&!sharer||n===1){
    // choose the column count whose 16:9 tiles come out largest in this space
    let best=1,bestSize=0;for(let c=1;c<=n;c++){const r=Math.ceil(n/c),size=Math.min(W/c*9/16,H/r);if(size>bestSize){bestSize=size;best=c;}}
    set('--cols',best);set('--rows',Math.ceil(n/best));
  }else if(layout==='stage'){set('--scols',Math.max(1,n-1));}
  else{set('--srows',Math.max(1,n-1));}
}
new MutationObserver(fitGrid).observe($('videos'),{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
new ResizeObserver(fitGrid).observe($('videos'));window.addEventListener('resize',fitGrid);fitGrid();

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Recording consent. The SERVER decides (request -> everyone answers -> start); this page only shows it and captures once the server says go.
// A web page cannot technically stop someone recording their own screen with other tools; the rules and the notice are the protection.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const rcState={st:{status:'disabled'},answeredFor:null,mine:null};
const rcApi=async(path,method,body)=>{const r=await fetch(BASE+'api/v1/meetings/'+state.meetingId+'/recording'+path,{method:method||'GET',headers:{'Content-Type':'application/json',Authorization:'Bearer '+state.token},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok){const e=Error(d.error||'Request failed');e.data=d;throw e;}return d;};
function rcEl(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function rcClose(keepFocus){const m=document.getElementById('rcModal');if(!m)return;m.remove();if(!keepFocus){const o=shell.dlgOpener;shell.dlgOpener=null;if(o&&document.contains(o))o.focus();}}
function rcModal(title,build,opts={}){
  const critical=!!rcState.critical;rcState.critical=false;
  if(!document.getElementById('rcModal'))shell.dlgOpener=document.activeElement;rcClose(true);
  const wrap=rcEl('div','rc-modal');wrap.id='rcModal';const box=rcEl('div','rc-box');box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');
  const h=rcEl('h2','',title);h.id='rcTitle';box.setAttribute('aria-labelledby','rcTitle');box.append(h);build(box);wrap.append(box);document.body.append(wrap);
  wrap.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&!critical){e.stopPropagation();e.preventDefault();rcClose();opts.onClose?.();return;}
    if(e.key==='Tab'){const f=[...box.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),textarea,select,[tabindex]:not([tabindex="-1"])')].filter(x=>x.offsetParent!==null);if(!f.length)return;const first=f[0],last=f[f.length-1];
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}else if(!box.contains(document.activeElement)){e.preventDefault();first.focus();}}
  });
  (opts.focus?box.querySelector(opts.focus):box.querySelector('input,button'))?.focus();return box;
}
function askConfirm(title,message,okLabel,danger){return new Promise(res=>{rcModal(title,box=>{box.append(rcEl('p','',message));const row=rcEl('div','rc-row'),ok=rcEl('button',danger?'rc-danger':'rc-primary',okLabel),no=rcEl('button','rc-secondary','Cancel');ok.onclick=()=>{rcClose();res(true);};no.onclick=()=>{rcClose();res(false);};row.append(ok,no);box.append(row);},{focus:'.rc-secondary',onClose:()=>res(false)});});}
function rcScopeText(n){return [n.video&&'video',n.audio&&'audio'].filter(Boolean).join(' and ');}
function rcNotice(box,n){const dl=rcEl('dl','rc-notice');for(const [k,v] of [['Who is recording',n.requestedBy||'Host'],['Data controller',n.controller],['What is recorded',rcScopeText(n)+' of this meeting'],['Why',n.purpose],['Who will receive it',n.recipients],['How long it is kept',n.retention],['Privacy contact',n.privacyContact]]){dl.append(rcEl('dt','',k),rcEl('dd','',v||'—'));}
  const dd=rcEl('dd');if(n.privacyUrl){const a=rcEl('a','','View Privacy Policy');a.href=n.privacyUrl;a.target='_blank';a.rel='noopener noreferrer';dd.append(a);}else dd.textContent='Not provided — ask the privacy contact';dl.append(rcEl('dt','','Privacy policy'),dd);box.append(dl);box.append(rcEl('p','rc-note','AI transcription and summaries are NOT part of this request and are not offered by this version. Declining never stops you attending the meeting.'));}

// ---- status shown to everybody -------------------------------------------------------------------------------------------------------------
function renderRecBanner(){
  const b=$('recBanner'),st=rcState.st,s=st.status;
  if(s==='disabled'||!s){b.classList.add('hidden');b.textContent='';applyRecBadge();return;}
  const me=st.recorder&&st.recorder.participantId===state.participantId,who=me?'You are':(st.recorder?.name||'The host')+' is';
  const txt={awaiting:'Recording requested by '+(st.requestedBy||'the host')+' — waiting for '+st.pending+' answer(s). NOTHING is being recorded.',
    blocked:'Recording blocked — a participant declined. NOTHING is being recorded.',
    ready:'Everyone has agreed. Waiting for the host to start. NOTHING is being recorded yet.',
    recording:who+' recording this meeting ('+rcScopeText(st)+')'+(me&&state.recording?' '+recLabel():''),
    paused:'Recording PAUSED — waiting for a new participant to answer. Nothing is recorded while paused.'}[s];
  b.classList.remove('hidden');b.classList.toggle('pending',s!=='recording');if(b.textContent!==txt)b.textContent=txt;applyRecBadge();
}
function applyRecBadge(){
  const st=rcState.st,live=st.status==='recording'&&st.recorder;
  document.querySelectorAll('#videos .tile').forEach(t=>{const want=live&&t.id==='tile-'+st.recorder.participantId,has=t.querySelector('.rec-badge');if(want&&!has){const bd=rcEl('span','rec-badge','● REC');t.append(bd);}else if(!want&&has)has.remove();});
}
new MutationObserver(applyRecBadge).observe($('videos'),{childList:true});

// ---- server state arrives (socket snapshot or broadcast) -----------------------------------------------------------------------------------
async function recState(st){
  const prev=rcState.st;rcState.st=st||{status:'disabled'};REC.consent={set:new Set(rcState.st.consenting||[]),video:!!rcState.st.video,audio:!!rcState.st.audio};recSyncAudio();
  renderRecBanner();recUi();
  if(rcState.st.status==='disabled'){rcClose();rcState.answeredFor=null;rcState.mine=null;if(state.recording){notify('Recording stopped.');await stopRecording();}return;}
  // the person recording captures only while the server says RECORDING; paused means stop feeding the file
  const me=rcState.st.recorder&&rcState.st.recorder.participantId===state.participantId;
  if(me&&rcState.st.status==='recording'&&!state.recording&&!rcState.starting){rcState.starting=true;try{await beginCapture();}catch(e){try{await rcApi('/stop','POST');}catch{}}finally{rcState.starting=false;}}
  if(state.recording){try{if(rcState.st.status==='paused'&&state.recording.state==='recording')state.recording.pause();else if(rcState.st.status==='recording'&&state.recording.state==='paused')state.recording.resume();}catch{}}
  if(state.role==='host'){rcRefreshHost();return;}
  if(rcState.answeredFor!==rcState.st.sessionId){rcState.answeredFor=rcState.st.sessionId;try{const c=await rcApi('/consents');rcState.mine=c.mine?.decision||'pending';}catch{rcState.mine='pending';}
    if(rcState.mine==='pending')rcAskParticipant();}
  else if(prev.sessionId===rcState.st.sessionId&&rcState.mine==='pending'&&!document.getElementById('rcModal'))rcAskParticipant();
  rcMineControl();
}

// ---- participant: the blocking consent dialog ----------------------------------------------------------------------------------------------
function rcAskParticipant(){
  const n=rcState.st;rcState.critical=true;
  rcModal('Recording consent',box=>{
    box.append(rcEl('p','rc-lead',(n.requestedBy||'The host')+' wants to record this meeting. Nothing is recorded unless everyone agrees.'));rcNotice(box,n);
    const mk=(id,label,disabled)=>{const l=rcEl('label','rc-check');const i=rcEl('input');i.type='checkbox';i.id=id;i.disabled=!!disabled;l.append(i,document.createTextNode(' '+label));box.append(l);return i;};
    const v=n.video?mk('rcVideo','I consent to my video being recorded'):null,a=n.audio?mk('rcAudio','I consent to my audio being recorded'):null,r=mk('rcReviewed','I have reviewed the recording notice above');
    const err=rcEl('p','rc-err');err.setAttribute('role','alert');
    const row=rcEl('div','rc-row');const agree=rcEl('button','rc-primary','Agree'),decline=rcEl('button','rc-secondary','Decline');agree.disabled=true;row.append(agree,decline);box.append(err,row);
    const sync=()=>{agree.disabled=!((!v||v.checked)&&(!a||a.checked)&&r.checked);};[v,a,r].forEach(x=>x&&x.addEventListener('change',sync));
    const send=async(decision)=>{agree.disabled=decline.disabled=true;try{await rcApi('/consent','POST',{sessionId:n.sessionId,decision,video:!!v?.checked,audio:!!a?.checked,noticeReviewed:r.checked});rcState.mine=decision;rcClose();
      if(decision==='decline')rcDeclined();else notify('You agreed to the recording. You can withdraw at any time.');rcMineControl();}catch(e){err.textContent=e.message;sync();decline.disabled=false;}};
    agree.onclick=()=>send('agree');decline.onclick=()=>send('decline');
  });
}
function rcDeclined(){
  rcModal('You declined recording',box=>{box.append(rcEl('p','','Recording will not start while your answer is “decline”. You can stay in the meeting or leave.'));
    const row=rcEl('div','rc-row'),stay=rcEl('button','rc-primary','Stay in meeting'),lv=rcEl('button','rc-secondary','Leave meeting');stay.onclick=rcClose;lv.onclick=()=>{rcClose();leave();};row.append(stay,lv);box.append(row);});
}
function rcMineControl(){
  let b=document.getElementById('rcWithdraw');const st=rcState.st.status;
  const show=state.role!=='host'&&rcState.mine==='agree'&&['awaiting','ready','recording','paused'].includes(st);
  if(!show){b?.remove();return;}
  if(!b){b=rcEl('button','rc-withdraw','Withdraw recording consent');b.id='rcWithdraw';b.onclick=async()=>{try{await rcApi('/consent','POST',{sessionId:rcState.st.sessionId,decision:'withdraw',noticeReviewed:true});rcState.mine='withdraw';notify('Consent withdrawn. Recording stops.');rcMineControl();}catch(e){notify(e.message);}};document.body.append(b);}
}

// ---- host: request form, progress panel, start / stop --------------------------------------------------------------------------------------
function recButton(){
  if(state.role!=='host')return;
  const s=rcState.st.status;
  if(s==='disabled'||!s)return rcRequestForm();
  if(s==='recording'||s==='paused'){return askConfirm('Stop recording?','Recording stops for everyone and the file is saved to this computer.','Stop recording',true).then(ok=>ok?rcApi('/stop','POST').catch(e=>notify(e.message)):undefined);}
  rcHostPanel();
}
function rcRequestForm(){
  rcModal('Request to record this meeting',box=>{
    box.append(rcEl('p','rc-lead','Everyone present must agree before recording can start. Tell them clearly what happens to the recording.'));
    const f={};const field=(key,label,ph,val)=>{const l=rcEl('label','rc-field');l.append(rcEl('span','',label));const i=rcEl('input');i.type='text';i.id='rc_'+key;i.placeholder=ph||'';if(val)i.value=val;f[key]=i;l.append(i);box.append(l);};
    field('purpose','Purpose of the recording','e.g. Minutes and follow-up for people who could not attend');field('recipients','Who will receive or access it','e.g. Meeting attendees and the project team');{const l=rcEl('label','rc-field');l.append(rcEl('span','','How long it is kept'));const sel=rcEl('select');sel.id='rc_days';for(const d of [7,30,90,365])sel.append(new Option(d+' days, then deleted automatically',String(d)));sel.value='30';f.retention=sel;l.append(sel);box.append(l);}
    field('controller','Data controller (who is responsible)','Name of the organisation or host',state.name);field('privacyContact','Privacy contact','e.g. privacy@example.com');field('privacyUrl','Privacy policy link (optional)','https://');
    const row1=rcEl('div','rc-row');const mk=(label)=>{const l=rcEl('label','rc-check');const i=rcEl('input');i.type='checkbox';i.checked=true;l.append(i,document.createTextNode(' '+label));row1.append(l);return i;};const vid=mk('Record video'),aud=mk('Record audio');box.append(row1);
    box.append(rcEl('p','rc-note','AI transcription and summaries are separate and not included.'));
    const err=rcEl('p','rc-err');err.setAttribute('role','alert');const row=rcEl('div','rc-row'),send=rcEl('button','rc-primary','Send request'),cancel=rcEl('button','rc-secondary','Cancel');row.append(send,cancel);box.append(err,row);cancel.onclick=rcClose;
    send.onclick=async()=>{send.disabled=true;try{await rcApi('/request','POST',{purpose:f.purpose.value,recipients:f.recipients.value,retentionDays:Number(f.retention.value),controller:f.controller.value,privacyContact:f.privacyContact.value,privacyUrl:f.privacyUrl.value,video:vid.checked,audio:aud.checked});rcClose();notify('Request sent. Waiting for everyone to answer.');}catch(e){err.textContent=e.message;send.disabled=false;}};
  });
}
async function rcRefreshHost(){
  const m=document.getElementById('rcModal');if(m&&m.dataset.panel==='1')rcHostPanel();
}
async function rcHostPanel(){
  let data;try{data=await rcApi('/consents');}catch(e){notify(e.message);return;}
  const st=rcState.st;if(st.status==='recording'||st.status==='disabled'||!st.status){document.getElementById('rcModal')?.remove();return;}   // a late refresh must never reopen the panel over a running recording
  const box=rcModal('Recording consent',box=>{
    
    const label={awaiting:'Waiting for answers',blocked:'Blocked — someone declined',ready:'Everyone agreed — ready to start',recording:'Recording',paused:'Paused — waiting for a new participant'}[st.status]||st.status;
    box.append(rcEl('p','rc-lead','Status: '+label));
    const ul=rcEl('ul','rc-list');for(const p of data.participants||[]){const li=rcEl('li','rc-'+p.decision);li.append(rcEl('span','',p.name||'Participant'),rcEl('b','',{agree:'Agreed',decline:'Declined',withdraw:'Withdrew',pending:'Waiting'}[p.decision]||p.decision));ul.append(li);}box.append(ul);
    const row=rcEl('div','rc-row');
    if(st.status==='ready'){const go=rcEl('button','rc-primary','Start recording');go.onclick=async()=>{go.disabled=true;try{await rcApi('/start','POST');rcClose();}catch(e){notify(e.message);go.disabled=false;}};row.append(go);}
    const cancel=rcEl('button','rc-secondary',st.status==='recording'||st.status==='paused'?'Stop recording':'Cancel request');cancel.onclick=async()=>{try{await rcApi('/stop','POST');rcClose();}catch(e){notify(e.message);}};
    const close=rcEl('button','rc-secondary','Close');close.onclick=rcClose;row.append(cancel,close);box.append(row);
  });
  box.parentElement.dataset.panel='1';return box;
}
// Debug/test hook (read access to the page state for the browser tests; exposes nothing the page does not already hold).
const collab=initCollab({state,BASE,notify,announce,rcModal,rcClose,rcEl,askConfirm});
window.__qorlla={state,recoverPeer,rec:()=>({consent:[...(REC.consent?.set||[])],audio:[...REC.src.keys()],accepted:REC.accepted||0,queue:(REC.queue||[]).length,refused:REC.refused||0,rid:REC.rid||null})};

// ---------------------------------------------------------------------------------------------------------------------------------------------
// v4.0.2 shell: responsive layouts (desktop panel / tablet drawer / mobile sheet), adaptive toolbar, keyboard, announcements, accessible dialogs
// ---------------------------------------------------------------------------------------------------------------------------------------------
var shell={open:null,tab:'chat',dlgOpener:null,trigger:null};
const mqDesktop=matchMedia('(min-width:1200px)'),mqNarrow=matchMedia('(max-width:639px)');
const lsGet=(k,d)=>{try{return localStorage.getItem(k)??d;}catch{return d;}},lsSet=(k,v)=>{try{localStorage.setItem(k,v);}catch{}};
function announce(msg){const a=$('announcer');if(!a||!msg)return;if(announce.last===msg&&Date.now()-announce.at<2500)return;announce.last=msg;announce.at=Date.now();a.textContent='';setTimeout(()=>{a.textContent=msg;},60);}
function setTileMedia(pid,mic,cam){
  const t=document.getElementById('tile-'+pid);if(!t)return;
  let c=t.querySelector('.chips');if(!c){c=rcEl('div','chips');t.append(c);}c.textContent='';
  if(mic===false)c.append(rcEl('span','chip','🔇 Muted'));if(cam===false)c.append(rcEl('span','chip','📷 Camera off'));
  t.classList.toggle('micoff',mic===false);t.classList.toggle('camoff',cam===false);
  if(pid!==state.participantId){const av=t.querySelector('.avatar');if(av&&t.querySelector('video'))av.style.display=cam===false?'grid':'none';}
}
function setHand(pid,raised){const t=document.getElementById('tile-'+pid);const h=t&&t.querySelector('.hand');if(h)h.textContent=raised?'✋ Hand raised':'';}

// ---- panel ----
const overlayMode=()=>!mqDesktop.matches;
function setPanel(open,{tab,focus=true}={}){
  const app=$('app'),p=$('panel');if(tab)openTab(tab);
  const wasOpen=shell.open;shell.open=open;app.classList.toggle('panel-open',open);p.toggleAttribute('inert',!open);
  const tg=$('panelToggle');tg.setAttribute('aria-expanded',String(open));tg.textContent=open?'Hide panel':'Show panel';
  $('chatBtn').setAttribute('aria-pressed',String(open&&shell.tab==='chat'));$('peopleBtn').setAttribute('aria-pressed',String(open&&shell.tab==='people'));
  $('panelScrim').classList.toggle('hidden',!(open&&overlayMode()));
  if(open&&!wasOpen&&focus&&overlayMode())p.querySelector('[role=tab][aria-selected=true]')?.focus();
  if(!open&&wasOpen&&focus){const t=shell.trigger;shell.trigger=null;if(t&&document.contains(t)&&t.offsetParent!==null)t.focus();}
}
function toggleTab(tab){
  if(shell.open&&shell.tab===tab)return setPanel(false);
  if(!shell.open)shell.trigger=document.activeElement;
  setPanel(true,{tab});
}
$('panelToggle').onclick=()=>{if(!shell.open)shell.trigger=document.activeElement;setPanel(!shell.open);};
$('panelClose').onclick=()=>setPanel(false);$('panelScrim').onclick=()=>setPanel(false);
document.querySelectorAll('[data-tab]').forEach(b=>{b.setAttribute('role','tab');b.id='tabbtn-'+b.dataset.tab;b.setAttribute('aria-controls','tab-'+b.dataset.tab);});
document.querySelectorAll('.tab-view').forEach(v=>{v.setAttribute('role','tabpanel');v.setAttribute('aria-labelledby','tabbtn-'+v.id.slice(4));});
document.querySelector('.tabs').addEventListener('keydown',e=>{
  const tabs=[...document.querySelectorAll('[data-tab]')],i=tabs.indexOf(document.activeElement);if(i<0)return;
  const to={ArrowRight:(i+1)%tabs.length,ArrowLeft:(i+tabs.length-1)%tabs.length,Home:0,End:tabs.length-1}[e.key];if(to===undefined)return;
  e.preventDefault();openTab(tabs[to].dataset.tab);tabs[to].focus();
});
openTab('chat');
{ // panel position (dock) and size, lockable; desktop only (tablet and mobile keep the drawer / bottom sheet)
  const r=$('panelResizer'),app=$('app'),root=document.documentElement.style;
  const dock=()=>app.dataset.panelDock||'right',horizontal=()=>dock()==='top'||dock()==='bottom';
  const lim=()=>horizontal()?[140,Math.round(innerHeight*0.6)]:[280,560];
  const apply=n=>{const [lo,hi]=lim();n=Math.max(lo,Math.min(hi,Math.round(n)));root.setProperty(horizontal()?'--panel-h':'--panel-w',n+'px');r.setAttribute('aria-valuemin',String(lo));r.setAttribute('aria-valuemax',String(hi));r.setAttribute('aria-valuenow',String(n));return n;};
  const sizeKey=()=>horizontal()?'qorlla-panel-h':'qorlla-panel-w';
  function setLocked(on){app.dataset.locked=String(on);const b=$('panelLock');b.setAttribute('aria-pressed',String(on));b.textContent=on?'🔒 Locked':'🔓 Unlocked';b.title=on?'Unlock to move or resize the panel':'Lock the panel so it cannot be moved or resized';
    document.querySelectorAll('[data-dock],#dockGrip').forEach(x=>x.disabled=on);r.tabIndex=on?-1:0;r.setAttribute('aria-disabled',String(on));lsSet('qorlla-panel-locked',String(on));if(!app.classList.contains('hidden'))announce(on?'Panel locked in place':'Panel unlocked');}
  function setDock(d,{announceIt=true}={}){app.dataset.panelDock=d;r.setAttribute('aria-orientation',horizontal()?'horizontal':'vertical');
    document.querySelectorAll('[data-dock]').forEach(x=>x.setAttribute('aria-pressed',String(x.dataset.dock===d)));
    apply(Number(lsGet(sizeKey(),horizontal()?'240':'340'))||(horizontal()?240:340));lsSet('qorlla-panel-dock',d);if(announceIt)announce('Panel docked '+d);}
  document.querySelectorAll('[data-dock]').forEach(b=>b.addEventListener('click',()=>{if(app.dataset.locked!=='true')setDock(b.dataset.dock);}));
  $('panelLock').addEventListener('click',()=>setLocked(app.dataset.locked!=='true'));
  // drag the grip: drop on the nearest side (left / right quarter, otherwise top or bottom half)
  const zone=rcEl('div','dock-zone');document.body.append(zone);
  const pick=(x,y)=>x<innerWidth*0.25?'left':x>innerWidth*0.75?'right':y<innerHeight/2?'top':'bottom';
  const show=d=>{const W=innerWidth,Hh=innerHeight;const box={left:[0,56,W*0.3,Hh-120],right:[W*0.7,56,W*0.3,Hh-120],top:[0,56,W,Hh*0.3],bottom:[0,Hh*0.65,W,Hh*0.3]}[d];Object.assign(zone.style,{display:'block',left:box[0]+'px',top:box[1]+'px',width:box[2]+'px',height:box[3]+'px'});};
  $('dockGrip').addEventListener('pointerdown',e=>{if(app.dataset.locked==='true'||e.button!==0)return;const g=$('dockGrip');g.setPointerCapture(e.pointerId);app.classList.add('dragging-panel');
    const mv=ev=>show(pick(ev.clientX,ev.clientY)),up=ev=>{g.removeEventListener('pointermove',mv);g.removeEventListener('pointerup',up);g.removeEventListener('pointercancel',up);app.classList.remove('dragging-panel');zone.style.display='none';if(ev.type==='pointerup')setDock(pick(ev.clientX,ev.clientY));};
    g.addEventListener('pointermove',mv);g.addEventListener('pointerup',up);g.addEventListener('pointercancel',up);show(pick(e.clientX,e.clientY));});
  r.addEventListener('pointerdown',e=>{if(app.dataset.locked==='true')return;r.setPointerCapture(e.pointerId);
    const val=ev=>{const d=dock();return d==='right'?innerWidth-ev.clientX:d==='left'?ev.clientX:d==='bottom'?innerHeight-64-ev.clientY:ev.clientY-56;};
    const mv=ev=>apply(val(ev)),up=()=>{r.removeEventListener('pointermove',mv);r.removeEventListener('pointerup',up);lsSet(sizeKey(),r.getAttribute('aria-valuenow'));};r.addEventListener('pointermove',mv);r.addEventListener('pointerup',up);});
  r.addEventListener('keydown',e=>{if(app.dataset.locked==='true')return;const cur=Number(r.getAttribute('aria-valuenow')),d=dock();
    const grow={right:'ArrowLeft',left:'ArrowRight',top:'ArrowDown',bottom:'ArrowUp'}[d],shrink={right:'ArrowRight',left:'ArrowLeft',top:'ArrowUp',bottom:'ArrowDown'}[d];
    const to=e.key===grow?cur+20:e.key===shrink?cur-20:e.key==='Home'?lim()[0]:e.key==='End'?lim()[1]:undefined;if(to===undefined)return;e.preventDefault();lsSet(sizeKey(),String(apply(to)));});
  setDock(['left','right','top','bottom'].includes(lsGet('qorlla-panel-dock','right'))?lsGet('qorlla-panel-dock','right'):'right',{announceIt:false});
  setLocked(lsGet('qorlla-panel-locked','false')==='true');
}
const defaultPanel=()=>setPanel(mqDesktop.matches,{focus:false});
mqDesktop.addEventListener('change',defaultPanel);defaultPanel();

// ---- adaptive toolbar: below 640px Share / Record / Raise hand move into a More menu ----
const OVERFLOW=['shareBtn','recordBtn','handBtn'];
function closeOverflow(focusMore){const m=$('overflowMenu'),b=$('moreCtl');if(m.classList.contains('hidden'))return;m.classList.add('hidden');b.setAttribute('aria-expanded','false');if(focusMore)b.focus();}
function placeOverflow(){
  const menu=$('overflowMenu'),more=$('moreCtl');
  if(mqNarrow.matches){for(const id of OVERFLOW)if($(id).parentElement!==menu)menu.append($(id));more.classList.remove('hidden');}
  else{closeOverflow(false);for(const id of OVERFLOW)if($(id).parentElement===menu)$('peopleBtn').before($(id));more.classList.add('hidden');}
}
$('moreCtl').onclick=()=>{const m=$('overflowMenu');if(m.classList.contains('hidden')){m.classList.remove('hidden');$('moreCtl').setAttribute('aria-expanded','true');[...m.querySelectorAll('button')].find(b=>b.offsetParent!==null)?.focus();}else closeOverflow(true);};
$('overflowMenu').addEventListener('click',e=>{if(e.target.closest('button'))setTimeout(()=>closeOverflow(true),0);});
document.addEventListener('pointerdown',e=>{if(!e.target.closest('#overflowMenu,#moreCtl'))closeOverflow(false);});
mqNarrow.addEventListener('change',placeOverflow);placeOverflow();

// ---- keyboard ----
const SHORTCUTS=[['M','Mute or unmute',()=>$('micBtn').click()],['V','Start or stop video',()=>$('camBtn').click()],['H','Raise or lower hand',()=>$('handBtn').click()],['C','Show or hide chat',()=>toggleTab('chat')],['P','Show or hide people',()=>toggleTab('people')],['S','Start or stop sharing',()=>$('shareBtn').click()],['?','This help',()=>openSettings()],['Esc','Close a panel, menu or dialog',null]];
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&!document.getElementById('rcModal')){
    if(!$('overflowMenu').classList.contains('hidden')){e.preventDefault();return closeOverflow(true);}
    if(shell.open&&overlayMode()){e.preventDefault();setPanel(false);}
    return;
  }
  if(e.ctrlKey||e.metaKey||e.altKey||e.isComposing||e.repeat||$('app').classList.contains('hidden')||document.getElementById('rcModal'))return;
  if(e.target.closest?.('input,textarea,select,[contenteditable="true"]'))return;
  if(e.key==='?'){e.preventDefault();return openSettings();}
  if(lsGet('qorlla-shortcuts','on')==='off')return;                                   // WCAG 2.1.4: single-key shortcuts can be turned off
  const s=SHORTCUTS.find(x=>x[2]&&x[0].length===1&&x[0].toLowerCase()===e.key.toLowerCase()&&x[0]!=='?');if(s){e.preventDefault();s[2]();}
});
function openSettings(){
  rcModal('Settings and keyboard shortcuts',box=>{
    const live=$('liveText').textContent,media=mediaHealth(),tracks=state.stream?state.stream.getTracks().map(t=>t.kind+(t.readyState==='live'?(t.enabled?'':' (off)'):' (stopped)')).join(', '):'none';
    const dl=rcEl('dl','rc-notice');for(const [k,v] of [['Connection',live],['Media',media],['Your devices',tracks||'none'],['Connected people',String(Math.max(0,state.roster.size-1))]])dl.append(rcEl('dt','',k),rcEl('dd','',v));box.append(dl);
    box.append(rcEl('p','rc-note','To change camera or microphone permission, use your browser’s site settings for this page.'));
    const l=rcEl('label','rc-check'),cb=rcEl('input');cb.type='checkbox';cb.checked=lsGet('qorlla-shortcuts','on')!=='off';cb.onchange=()=>{lsSet('qorlla-shortcuts',cb.checked?'on':'off');announce(cb.checked?'Single-key shortcuts on':'Single-key shortcuts off');};l.append(cb,document.createTextNode(' Single-key shortcuts (M, V, H, C, P, S)'));box.append(l);
    const tb=rcEl('table','kbd-table');for(const [k,d] of SHORTCUTS){const tr=rcEl('tr');const td=rcEl('td');td.append(rcEl('kbd','',k));tr.append(td,rcEl('td','',d));tb.append(tr);}box.append(tb);
    const row=rcEl('div','rc-row'),x=rcEl('button','rc-primary','Close');x.onclick=()=>rcClose();row.append(x);box.append(row);
  });
}
// labels for controls that only had placeholders or icons
document.querySelectorAll('[data-emoji]').forEach(b=>b.setAttribute('aria-label','React with '+b.dataset.emoji));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Admission (v4.0.2b): the waiting room for guests, and the host's list of people waiting. The SERVER decides; this only shows it.
// ---------------------------------------------------------------------------------------------------------------------------------------------
async function waitForAdmission(){
  const panel=$('waiting');state.cancelWait=false;
  for(;;){
    const a=await api('/meetings/'+state.meetingId+'/admission');
    if(a.status==='admitted'){panel.classList.add('hidden');return;}
    if(a.status==='denied'){panel.classList.add('hidden');sessionStorage.removeItem('qorlla-session');$('landing').classList.remove('hidden');throw Error('The host did not let you in.');}
    $('landing').classList.add('hidden');panel.classList.remove('hidden');
    const msg=a.reason==='host_absent'?'Waiting for the host to start the meeting…':'Waiting for the host to let you in…';
    if($('waitingMsg').textContent!==msg){$('waitingMsg').textContent=msg;announce(msg);}
    await new Promise(r=>setTimeout(r,2000));
    if(state.cancelWait)throw Error('Left the waiting room.');
  }
}
$('waitLeave').onclick=()=>{state.cancelWait=true;leave();};
let lastWaiting=0;
async function loadWaiting(){if(state.role!=='host')return;let d;try{d=await api('/meetings/'+state.meetingId+'/waiting');}catch(e){return;}renderWaiting(d.waiting||[]);}
function renderWaiting(list){
  let box=$('waitingBox');if(!box){box=document.createElement('div');box.id='waitingBox';box.className='waiting-box';$('peopleList').before(box);}
  box.textContent='';document.querySelector('[data-tab=people]').textContent=list.length?'People ('+list.length+' waiting)':'People';
  if(list.length>lastWaiting){const n=list[list.length-1].name;notify(n+' is waiting to join');announce(n+' is waiting to join');}
  lastWaiting=list.length;if(!list.length){box.classList.add('hidden');return;}box.classList.remove('hidden');
  const act=async(body)=>{try{await api('/meetings/'+state.meetingId+'/admit','POST',body);}catch(e){notify(e.message);}loadWaiting();};
  const head=rcEl('div','wb-head');head.append(rcEl('h4','','Waiting room ('+list.length+')'));const all=rcEl('button','','Admit all');all.onclick=()=>act({all:true,allow:true});head.append(all);box.append(head);
  const ul=rcEl('ul','wb-list');for(const p of list){const li=rcEl('li');li.append(rcEl('span','',p.name+(p.reason==='host_absent'?' (waiting for host)':'')));
    const ok=rcEl('button','rc-primary','Admit'),no=rcEl('button','rc-secondary','Deny');ok.setAttribute('aria-label','Admit '+p.name);no.setAttribute('aria-label','Deny '+p.name);ok.onclick=()=>act({participantId:p.participantId,allow:true});no.onclick=()=>act({participantId:p.participantId,allow:false});li.append(ok,no);ul.append(li);}
  box.append(ul);
}
// The pre-meeting screen can hand over the names of the camera and microphone the person chose (device IDs differ per site, labels do not).
async function applyDevicePrefs(){
  let prefs=null;try{prefs=JSON.parse(sessionStorage.getItem('qorlla-prefs')||'null');}catch(e){/* none */}
  if(!prefs||!state.stream)return;
  try{
    const devs=await navigator.mediaDevices.enumerateDevices();
    if(prefs.res){const vt=state.stream.getVideoTracks()[0];if(vt&&vt.applyConstraints)await vt.applyConstraints({height:{ideal:Number(prefs.res)},width:{ideal:Math.round(Number(prefs.res)*16/9)}}).catch(()=>{});}   // the video quality chosen on the start screen
    const spk=prefs.spkLabel?devs.find(d=>d.kind==='audiooutput'&&d.label===prefs.spkLabel):null;
    if(spk){state.sinkId=spk.deviceId;document.querySelectorAll('#videos video').forEach(v=>v.setSinkId&&v.setSinkId(spk.deviceId).catch(()=>{}));}      // the chosen speakers play the meeting
    const want=(kind,label)=>label?devs.find(d=>d.kind===kind&&d.label===label):null;
    const cam=want('videoinput',prefs.camLabel),mic=want('audioinput',prefs.micLabel),c={};
    if(mic&&mic.label!==state.stream.getAudioTracks()[0]?.label)c.audio={deviceId:{exact:mic.deviceId},echoCancellation:true,noiseSuppression:true};
    if(cam&&cam.label!==state.stream.getVideoTracks()[0]?.label)c.video={deviceId:{exact:cam.deviceId},width:{ideal:1280},height:{ideal:720}};
    if(!c.audio&&!c.video)return;
    const extra=await navigator.mediaDevices.getUserMedia(c);
    for(const t of extra.getTracks()){const old=t.kind==='audio'?state.stream.getAudioTracks()[0]:state.stream.getVideoTracks()[0];if(old){state.stream.removeTrack(old);old.stop();}state.stream.addTrack(t);}
  }catch(e){/* keep the default devices */}
  finally{sessionStorage.removeItem('qorlla-prefs');}
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Free-plan time limit: reminders (a banner with a countdown and an Upgrade link), then the meeting is closed with an upgrade message.
// ---------------------------------------------------------------------------------------------------------------------------------------------
function limitReminder(r){
  let b=document.getElementById('limitBanner');
  if(!b){b=rcEl('div','limit-banner');b.id='limitBanner';b.setAttribute('role','status');const t=rcEl('span','limit-text');t.id='limitText';const a=rcEl('a','limit-up','Upgrade');a.id='limitUp';a.target='_blank';a.rel='noopener noreferrer';b.append(t,a);document.body.append(b);}
  const left=Date.now()+Number(r.remainingMs||0);b.dataset.phase=r.phase;document.getElementById('limitUp').href=r.upgradeUrl||'/pricing';
  const paint=()=>{const s=Math.max(0,Math.round((left-Date.now())/1000));document.getElementById('limitText').textContent=r.message+'  ('+String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')+' left)';};
  clearInterval(limitReminder.iv);paint();limitReminder.iv=setInterval(paint,1000);announce(r.message);
}
function endedByLimit(r){
  if(state.limitEnded)return;state.limitEnded=true;clearInterval(limitReminder.iv);document.getElementById('limitBanner')?.remove();
  try{if(state.recording)stopRecording();}catch(e){/* nothing running */}
  try{state.socket.io.reconnection(false);state.socket.disconnect();}catch(e){/* already closed */}
  state.peers.forEach(pc=>{try{pc.close();}catch(e){/* closed */}});state.peers.clear();state.stream?.getTracks().forEach(t=>t.stop());state.screen?.getTracks().forEach(t=>t.stop());
  sessionStorage.removeItem('qorlla-session');
  rcState.critical=true;
  rcModal('Meeting time limit reached',box=>{
    box.append(rcEl('p','rc-lead',(r&&r.message)||'Upgrade to have full access to Qorlla packages'));
    box.append(rcEl('p','rc-note','This meeting was closed because the free plan time limit was reached. Everyone was disconnected. Upgrade to keep meeting without interruptions.'));
    const row=rcEl('div','rc-row'),up=rcEl('a','rc-primary','See plans');up.href=(r&&r.upgradeUrl)||'/pricing';up.target='_blank';up.rel='noopener noreferrer';up.id='limitPlans';
    const lv=rcEl('button','rc-secondary','Leave');lv.onclick=()=>{location.href=safeReturn(returnRaw)||BASE;};row.append(up,lv);box.append(row);
  },{focus:'#limitPlans'});
}
