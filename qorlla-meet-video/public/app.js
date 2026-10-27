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
function setVideo(id,stream,muted=false){const el=tile(id,state.names.get(id)||id,id===state.participantId);let v=el.querySelector('video');if(!v){v=document.createElement('video');v.autoplay=true;v.playsInline=true;v.muted=muted;el.prepend(v);}v.srcObject=stream;el.querySelector('.avatar').style.display=stream.getVideoTracks().some(t=>t.enabled&&t.readyState==='live')?'none':'grid';v.play().catch(()=>{});if(id!==state.participantId)recAddAudio(id,stream);}
function renderPeople(){const root=$('peopleList');root.replaceChildren();for(const id of state.roster){const p=document.createElement('div');p.className='person';p.textContent=(state.names.get(id)||id.slice(0,8))+(id===state.participantId?' (You)':'');root.append(p);}}
function openTab(tab){document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('selected',b.dataset.tab===tab));document.querySelectorAll('.tab-view').forEach(v=>v.classList.toggle('hidden',v.id!=='tab-'+tab));}
async function startMeeting(payload){Object.assign(state,{token:payload.token,meetingId:payload.meetingId,participantId:payload.participantId});const claims=JSON.parse(atob(payload.token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));state.role=claims.role;state.name=claims.name;state.names.set(state.participantId,state.name);state.start=Date.now();sessionStorage.setItem('qorlla-session',JSON.stringify({token:state.token,meetingId:state.meetingId,participantId:state.participantId}));const data=await api('/meetings/'+state.meetingId);$('landing').classList.add('hidden');$('app').classList.remove('hidden');$('roomTitle').textContent=data.title;$('roomId').textContent=data.meeting_code||state.meetingId.slice(0,8);$('meetingDetails').textContent='Meeting ID: '+(data.meeting_code||state.meetingId);$('notes').value=data.notes;$('notes').readOnly=state.role!=='host';$('saveNotes').classList.toggle('hidden',state.role!=='host');$('pollForm').classList.toggle('hidden',state.role!=='host');$('endBtn').classList.toggle('hidden',state.role!=='host');data.messages.forEach(addMessage);data.polls.forEach(addPoll);try{state.iceServers=(await api('/config')).iceServers;}catch{}await startMedia();connect();}
async function startMedia(){try{state.stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:{width:{ideal:1280},height:{ideal:720}}});}catch(e){notify('Media unavailable: '+e.message);state.stream=new MediaStream();state.mic=false;state.cam=false;}setVideo(state.participantId,state.stream,true);updateControls();}
function updateControls(){
  const set=(id,label,off,pressed)=>{const b=$(id);b.querySelector('span').textContent=label;b.classList.toggle('off',!!off);b.setAttribute('aria-pressed',String(!!pressed));};
  set('micBtn',state.mic?'Mute':'Unmute',!state.mic,!state.mic);set('camBtn',state.cam?'Stop video':'Start video',!state.cam,!state.cam);
  $('handBtn').querySelector('span').textContent=state.hand?'Lower hand':'Raise hand';$('handBtn').classList.toggle('on',state.hand);$('handBtn').setAttribute('aria-pressed',String(state.hand));
  const local=$('tile-'+state.participantId);if(local)local.querySelector('.avatar').style.display=(state.cam&&state.stream?.getVideoTracks().length)||local.classList.contains('sharing-local')?'none':'grid';}
function connect(){state.socket=io({path:BASE+'socket.io',auth:{token:state.token},transports:['websocket','polling']});const s=state.socket;s.on('connect',()=>{$('status').textContent='Connected';s.emit('media-state',{mic:state.mic,cam:state.cam,sharing:!!state.screen});});s.on('connect_error',e=>notify('Connection error: '+e.message));s.on('disconnect',()=>{$('status').textContent='Reconnecting…';});s.on('roster',ids=>{state.roster=new Set([...ids,state.participantId]);renderPeople();for(const id of ids)if(id!==state.participantId)createPeer(id,true);});s.on('participant-online',p=>{state.roster.add(p.participantId);state.names.set(p.participantId,p.name);tile(p.participantId,p.name);renderPeople();notify(p.name+' joined');});s.on('participant-offline',p=>{state.roster.delete(p.participantId);removePeer(p.participantId);renderPeople();});s.on('signal',async({from,data})=>{try{await onSignal(from,data);}catch(e){console.error(e);notify('Media negotiation failed');}});s.on('chat',addMessage);s.on('recorders',list=>{for(const r of list)setRecorder(r.participantId,r.name||state.names.get(r.participantId)||'Someone',true);});s.on('recording',({participantId,name,recording})=>setRecorder(participantId,participantId===state.participantId?'You':(name||state.names.get(participantId)||'Someone'),!!recording));s.on('media-state',({participantId,sharing})=>{const t=$('tile-'+participantId);if(t&&participantId!==state.participantId)t.classList.toggle('sharing-remote',!!sharing);});s.on('hand',({participantId,raised})=>{const t=$('tile-'+participantId);if(t)t.querySelector('.hand').textContent=raised?'✋':'';});s.on('reaction',({name,emoji})=>notify(name+' '+emoji));s.on('notes',text=>$('notes').value=text);s.on('poll-created',addPoll);s.on('poll-results',updatePollResults);s.on('meeting-ended',()=>{notify('Host ended the meeting');setTimeout(()=>leave(),1300);});}
function createPeer(id,initiator=false){if(state.peers.has(id))return state.peers.get(id);const pc=new RTCPeerConnection({iceServers:state.iceServers});state.peers.set(id,pc);for(const track of state.stream.getTracks())pc.addTrack(track,state.stream);pc.onicecandidate=e=>{if(e.candidate)state.socket.emit('signal',{to:id,data:{type:'candidate',candidate:e.candidate}});};pc.ontrack=e=>{const stream=e.streams[0]||new MediaStream([e.track]);setVideo(id,stream);};pc.onconnectionstatechange=()=>{if(pc.connectionState==='failed')notify('Connection to participant interrupted');};if(initiator)pc.createOffer().then(o=>pc.setLocalDescription(o).then(()=>state.socket.emit('signal',{to:id,data:{type:'offer',sdp:pc.localDescription}}))).catch(console.error);return pc;}
async function onSignal(id,data){let pc=state.peers.get(id);if(!pc)pc=createPeer(id);if(data.type==='offer'){await pc.setRemoteDescription(data.sdp);const answer=await pc.createAnswer();await pc.setLocalDescription(answer);state.socket.emit('signal',{to:id,data:{type:'answer',sdp:pc.localDescription}});}else if(data.type==='answer'){await pc.setRemoteDescription(data.sdp);}else if(data.type==='candidate'){try{await pc.addIceCandidate(data.candidate);}catch(e){console.warn('ICE candidate deferred/failed',e);}}}
function removePeer(id){state.peers.get(id)?.close();state.peers.delete(id);$('tile-'+id)?.remove();}
function addPoll(p){if($('poll-'+p.id))return;const d=document.createElement('div');d.className='poll';d.id='poll-'+p.id;const h=document.createElement('h4');h.textContent=p.question;d.append(h);p.options.forEach((o,i)=>{const b=document.createElement('button');b.textContent=o;b.onclick=()=>state.socket.emit('poll-vote',{pollId:p.id,choice:i},r=>{if(!r?.ok)notify(r?.error||'Vote failed');else notify('Vote saved');});d.append(b);});const result=document.createElement('p');result.className='muted';result.dataset.results='true';d.append(result);$('pollsList').prepend(d);}
function updatePollResults({pollId,counts}){const el=$('poll-'+pollId)?.querySelector('[data-results]');if(el)el.textContent='Votes: '+counts.map(x=>`Option ${x.choice+1}: ${x.count}`).join(' · ');}
async function leave(){if(state.recording)await stopRecording();state.socket?.disconnect();state.peers.forEach(pc=>pc.close());state.stream?.getTracks().forEach(t=>t.stop());state.screen?.getTracks().forEach(t=>t.stop());sessionStorage.removeItem('qorlla-session');location.href=returnTo||BASE;}
$('createBtn').onclick=async()=>{try{const p=await api('/meetings','POST',{title:$('meetingTitle').value,name:$('displayName').value,passcode:$('newPasscode').value});await startMeeting(p);}catch(e){error(e);}};
$('joinBtn').onclick=async()=>{try{const p=await api('/meetings/'+encodeURIComponent($('meetingId').value.trim())+'/join','POST',{name:$('displayName').value,passcode:$('joinPasscode').value});await startMeeting(p);}catch(e){error(e);}};
$('chatForm').onsubmit=e=>{e.preventDefault();const input=$('chatText');if(!input.value.trim())return;state.socket.emit('chat',input.value,r=>{if(r?.ok)input.value='';else notify(r?.error||'Chat failed');});};
$('micBtn').onclick=async()=>{const tracks=state.stream?.getAudioTracks()||[];if(!tracks.length){notify('No microphone track. Rejoin with permission.');return;}state.mic=!state.mic;tracks.forEach(t=>t.enabled=state.mic);state.socket.emit('media-state',{mic:state.mic,cam:state.cam,sharing:!!state.screen});updateControls();};
$('camBtn').onclick=()=>{const tracks=state.stream?.getVideoTracks()||[];if(!tracks.length){notify('No camera track. Rejoin with permission.');return;}state.cam=!state.cam;tracks.forEach(t=>t.enabled=state.cam);state.socket.emit('media-state',{mic:state.mic,cam:state.cam,sharing:!!state.screen});updateControls();};
$('handBtn').onclick=()=>{state.hand=!state.hand;state.socket.emit('hand',state.hand);$('tile-'+state.participantId).querySelector('.hand').textContent=state.hand?'✋':'';updateControls();};
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
$('saveNotes').onclick=()=>state.socket.emit('notes',$('notes').value,r=>notify(r?.ok?'Notes saved':r?.error||'Save failed'));
$('pollForm').onsubmit=e=>{e.preventDefault();state.socket.emit('poll-create',{question:$('pollQuestion').value,options:$('pollOptions').value.split('|')},r=>{if(r?.ok){$('pollQuestion').value='';$('pollOptions').value='';}else notify(r?.error||'Poll failed');});};
$('copyLink').onclick=()=>navigator.clipboard.writeText(location.origin+BASE+'?meeting='+($('roomId').textContent||state.meetingId)).then(()=>notify('Meeting link copied')).catch(()=>notify('Copy unavailable'));
$('settingsBtn').onclick=()=>notify('Use your browser site settings to manage microphone and camera permissions.');
$('recordBtn').onclick=()=>{if(state.recording)stopRecording();else startRecording();};window.addEventListener('beforeunload',e=>{if(state.recording){e.preventDefault();e.returnValue='';}});
$('leaveBtn').onclick=leave;$('endBtn').onclick=async()=>{if(!confirm('End meeting for everyone?'))return;try{await api('/meetings/'+state.meetingId+'/end','POST');leave();}catch(e){notify(e.message);}};
$('peopleBtn').onclick=()=>openTab('people');$('chatBtn').onclick=()=>openTab('chat');document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>openTab(b.dataset.tab));document.querySelectorAll('[data-layout]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-layout]').forEach(x=>x.classList.toggle('selected',x===b));$('videos').className='video-grid '+b.dataset.layout;});document.querySelectorAll('[data-emoji]').forEach(b=>b.onclick=()=>state.socket.emit('reaction',b.dataset.emoji));
setInterval(()=>{if(!state.token)return;const seconds=Math.floor((Date.now()-state.start)/1000);$('timer').textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');},1000);
const query=new URLSearchParams(location.search);
const safeReturn = value => {try {const u=new URL(value,location.href);return u.hostname===location.hostname && ['http:','https:'].includes(u.protocol)?u.href:null;}catch{return null;}};
const returnTo=safeReturn(query.get('return')||query.get('returnUrl'));
const originalLeave=leave;
// The handoff return destination is constrained to the same hostname.
if(query.has('meeting'))$('meetingId').value=query.get('meeting');
const cached=sessionStorage.getItem('qorlla-session');if(cached){try{startMeeting(JSON.parse(cached)).catch(()=>sessionStorage.removeItem('qorlla-session'));}catch{sessionStorage.removeItem('qorlla-session');}}

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
startMedia=async()=>{await originalStartMedia();state.mic=desiredMic&&state.mic;state.cam=desiredCam&&state.cam;state.stream.getAudioTracks().forEach(t=>t.enabled=state.mic);state.stream.getVideoTracks().forEach(t=>t.enabled=state.cam);updateControls();};
if(initialName){if(query.get('start')==='new')$('createBtn').click();else if(query.get('start')==='join' && $('meetingId').value)$('joinBtn').click();}

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
function recDraw(t,x,y,w,h){
  const g=REC.g;g.fillStyle='#121824';g.fillRect(x,y,w,h);
  const v=t.v,live=v&&v.readyState>=2&&v.videoWidth>0&&!t.el.classList.contains('sharing-local')&&t.el.querySelector('.avatar')?.style.display==='none';
  if(live){const r=Math.min(w/v.videoWidth,h/v.videoHeight),dw=v.videoWidth*r,dh=v.videoHeight*r;g.drawImage(v,x+(w-dw)/2,y+(h-dh)/2,dw,dh);}
  else{const ini=(t.name||'?').replace(/ \(You\)$/,'').split(/\s+/).map(s=>s[0]).join('').slice(0,2).toUpperCase();g.fillStyle='#273750';g.beginPath();g.arc(x+w/2,y+h/2,Math.min(w,h)/5,0,Math.PI*2);g.fill();g.fillStyle='#c9d9ff';g.font='600 '+Math.round(Math.min(w,h)/6)+'px sans-serif';g.textAlign='center';g.textBaseline='middle';g.fillText(ini,x+w/2,y+h/2);}
  g.textAlign='left';g.textBaseline='alphabetic';g.font='14px sans-serif';const label=(t.name||'').slice(0,40);const tw=g.measureText(label).width+16;g.fillStyle='rgba(7,11,18,.8)';g.fillRect(x+8,y+h-30,tw,22);g.fillStyle='#fff';g.fillText(label,x+16,y+h-14);
}
function recFrame(){
  const c=REC.canvas,g=REC.g,W=c.width,H=c.height;g.fillStyle='#080b11';g.fillRect(0,0,W,H);
  const tiles=[...document.querySelectorAll('#videos .tile')].map(el=>({el,v:el.querySelector('video'),name:el.querySelector('.nameplate')?.textContent||''}));
  let main=null;
  if(state.screen&&REC.shareVideo&&REC.shareVideo.readyState>=2)main={v:REC.shareVideo,el:document.createElement('div'),name:'Your screen'};
  else{const s=tiles.find(t=>t.el.classList.contains('sharing-remote')&&t.v&&t.v.readyState>=2);if(s)main={v:s.v,el:s.el,name:s.name+' (screen)'};}
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
const recorders=new Map();
function setRecorder(pid,name,on){
  if(on)recorders.set(pid,name);else recorders.delete(pid);
  const t=document.getElementById('tile-'+pid);if(t){t.querySelector('.rec-badge')?.remove();if(on){const bd=document.createElement('span');bd.className='rec-badge';bd.textContent='● REC';t.append(bd);}}
  renderRecBanner();
}
function renderRecBanner(){
  const b=$('recBanner');const names=[...recorders.values()];
  if(!names.length){b.classList.add('hidden');b.textContent='';return;}
  b.classList.remove('hidden');b.textContent=names.length===1&&names[0]==='You'?'You are recording this meeting'+(state.recording?' ('+recLabel()+')':''):names.join(', ')+(names.length===1?' is':' are')+' recording this meeting';
}
async function startRecording(){
  if(!window.MediaRecorder||!HTMLCanvasElement.prototype.captureStream){notify('Recording is not supported in this browser.');return;}
  if(!confirm('Record this meeting to a file on your computer?\n\nEveryone in the meeting will see a recording indicator. Only record where everyone has agreed. Keep this tab open while recording.'))return;
  try{
    REC.canvas=document.createElement('canvas');REC.canvas.width=1280;REC.canvas.height=720;REC.g=REC.canvas.getContext('2d');
    REC.ctx=new (window.AudioContext||window.webkitAudioContext)();await REC.ctx.resume();REC.dest=REC.ctx.createMediaStreamDestination();REC.src.clear();
    recAddAudio('local',state.stream);document.querySelectorAll('#videos .tile video').forEach(vd=>{const id=vd.closest('.tile').id.slice(5);if(id!==state.participantId&&vd.srcObject)recAddAudio(id,vd.srcObject);});
    REC.stream=new MediaStream([...REC.canvas.captureStream(15).getVideoTracks(),...REC.dest.stream.getAudioTracks()]);
    const mime=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(t=>MediaRecorder.isTypeSupported(t))||'';
    const rec=new MediaRecorder(REC.stream,mime?{mimeType:mime,videoBitsPerSecond:2500000}:{});REC.chunks=[];
    rec.ondataavailable=e=>{if(e.data&&e.data.size)REC.chunks.push(e.data);};
    REC.done=new Promise(resolve=>{rec.onstop=()=>{
      clearInterval(REC.ui);REC.tick?.stop?.();REC.tick=null;REC.stream.getTracks().forEach(t=>t.stop());REC.ctx.close().catch(()=>{});
      state.recording=null;setRecorder(state.participantId,'You',false);recUi();state.socket?.emit('recording',false);
      if(!REC.chunks.length){notify('Nothing was recorded.');resolve();return;}
      const blob=new Blob(REC.chunks,{type:rec.mimeType||'video/webm'});const code=($('roomId').textContent||'meeting').replace(/\W+/g,'');const d=new Date(),p=n=>String(n).padStart(2,'0');
      const name='qorlla-'+code+'-'+d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes())+'.webm';
      const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
      notify('Recording saved: '+name);resolve();};});
    REC.t0=Date.now();state.recording=rec;rec.start(1000);
    // Frames are drawn on a plain timer (the page's content-security-policy forbids blob workers). A tab that is playing the meeting's audio is not
    // throttled by the browser, so keep this tab open while recording.
    const iv=setInterval(recFrame,66);REC.tick={stop:()=>clearInterval(iv)};
    REC.ui=setInterval(recUi,1000);setRecorder(state.participantId,'You',true);recUi();state.socket?.emit('recording',true);
    notify('Recording started. Everyone can see the recording indicator.');
  }catch(e){state.recording=null;notify('Could not start recording: '+(e.message||e));}
}
function stopRecording(){
  const rec=state.recording;if(!rec)return Promise.resolve();
  try{if(rec.state!=='inactive')rec.stop();}catch(e){/* already stopped */}
  return Promise.race([REC.done||Promise.resolve(),new Promise(r=>setTimeout(r,3000))]);
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
