/** Reference browser SDK. Integrate with existing Qorlla session token and UI. */
type Signal = {type:string;callId?:string;sdp?:string;candidate?:RTCIceCandidateInit|null;call?:any};
export class QorllaVoiceClient {
 private ws?:WebSocket;private pc?:RTCPeerConnection;private stream?:MediaStream;
 private callId?:string;private remote?:HTMLAudioElement;private pendingOffer?:Signal;
 constructor(private base:string,private token:()=>Promise<string>,private onEvent:(s:Signal)=>void){}
 private async api(path:string,init:RequestInit={}){
  const response=await fetch(`${this.base}/v1/voice${path}`,{...init,headers:{Authorization:`Bearer ${await this.token()}`,'Content-Type':'application/json',...init.headers}});
  if(!response.ok)throw Error(`voice_http_${response.status}`);return response.json();
 }
 /** In production, obtain a single-use WS ticket from the authenticated backend. */
 async connect(){
  const {ticket}=await this.api('/ws-ticket',{method:'POST'});
  const wsUrl=new URL(`${this.base.replace(/^http/,'ws')}/v1/voice/ws`);
  wsUrl.searchParams.set('ticket',ticket);
  this.ws=new WebSocket(wsUrl);
  this.ws.onmessage=async ev=>{
   const m:Signal=JSON.parse(ev.data);this.onEvent(m);
   if(m.type==='offer'&&m.sdp){this.pendingOffer=m;this.onEvent({type:'offer_pending',callId:m.callId});if(this.pc&&this.callId===m.callId)await this.acceptPendingOffer(m.callId);}
   if(m.type==='answer'&&m.sdp&&this.pc)await this.pc.setRemoteDescription({type:'answer',sdp:m.sdp});
   if(m.type==='ice'&&this.pc&&m.candidate)await this.pc.addIceCandidate(m.candidate).catch(()=>{});
   if(m.type==='state'&&m.call?.status==='active'&&m.call?.caller_id){this.onEvent({type:'call_accepted',call:m.call});}
   if(m.type==='state'&&['ended','rejected','failed','missed'].includes(m.call?.status))this.cleanup();
  };
 }
 private send(m:Signal){if(this.ws?.readyState!==WebSocket.OPEN)throw Error('signaling_disconnected');this.ws.send(JSON.stringify(m));}
 private async prepare(callId:string){
  if(this.pc) return;this.callId=callId;
  const {iceServers}=await this.api('/ice');this.stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
  this.pc=new RTCPeerConnection({iceServers});this.stream.getTracks().forEach(t=>this.pc!.addTrack(t,this.stream!));
  this.remote=document.createElement('audio');this.remote.autoplay=true;this.remote.playsInline=true;this.remote.style.display='none';document.body.appendChild(this.remote);
  this.pc.ontrack=ev=>{this.remote!.srcObject=ev.streams[0]||new MediaStream([ev.track]);this.remote!.play().catch(()=>this.onEvent({type:'audio_play_blocked'}));};
  this.pc.onicecandidate=ev=>this.send({type:'ice',callId,candidate:ev.candidate?.toJSON()||null});
  this.pc.onconnectionstatechange=()=>{if(this.pc?.connectionState==='failed')this.onEvent({type:'connection_failed'});};
 }
 async dial(extension:string){const idempotencyKey=crypto.randomUUID();const {call}=await this.api('/calls',{method:'POST',body:JSON.stringify({extension,idempotencyKey})});this.callId=call.id;return call;}
 async startAcceptedCall(callId:string){await this.prepare(callId);const offer=await this.pc!.createOffer();await this.pc!.setLocalDescription(offer);this.send({type:'offer',callId,sdp:offer.sdp});}
 private async acceptPendingOffer(callId:string){if(this.pendingOffer?.callId===callId&&this.pendingOffer.sdp){const offer=this.pendingOffer;this.pendingOffer=undefined;await this.pc!.setRemoteDescription({type:'offer',sdp:offer.sdp});const answer=await this.pc!.createAnswer();await this.pc!.setLocalDescription(answer);this.send({type:'answer',callId,sdp:answer.sdp});}}
 async answer(callId:string){await this.prepare(callId);await this.api(`/calls/${callId}/answer`,{method:'POST'});await this.acceptPendingOffer(callId);}
 async reject(callId:string){await this.api(`/calls/${callId}/reject`,{method:'POST'});this.cleanup();}
 async hangup(){if(this.callId)await this.api(`/calls/${this.callId}/end`,{method:'POST'}).catch(()=>{});this.cleanup();}
 cleanup(){this.stream?.getTracks().forEach(t=>t.stop());this.pc?.close();this.remote?.remove();this.stream=undefined;this.pc=undefined;this.remote=undefined;this.callId=undefined;this.pendingOffer=undefined;}
 disconnect(){this.cleanup();this.ws?.close();}
}
