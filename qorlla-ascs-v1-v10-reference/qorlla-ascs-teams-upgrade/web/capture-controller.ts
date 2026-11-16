/** Browser capture controller for Qorlla Meet. Browser chooser is authoritative. */
export type Source = 'screen'|'window'|'tab';
export interface Publisher {
  publish(shareId:string, stream:MediaStream):Promise<void>;
  unpublish(shareId:string):Promise<void>;
}
export interface SessionApi {
  start(request:{kind:Source;clientRequestId:string}):Promise<{id:string}>;
  stop(shareId:string):Promise<void>;
  heartbeat(shareId:string):Promise<{authorized:boolean}>;
}
export class CaptureController {
  private active?:{id:string;stream:MediaStream};
  private starting=false;
  private heartbeatTimer?:ReturnType<typeof setInterval>;
  constructor(private api:SessionApi,private publisher:Publisher,private onState:(state:'idle'|'starting'|'live'|'stopping'|'error',detail?:string)=>void){}
  async start(kind:Source,withAudio:boolean){
    if(this.starting||this.active) throw new Error('Share already active or starting');
    if(!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen capture is not supported');
    this.starting=true;this.onState('starting');
    let stream:MediaStream|undefined;let shareId:string|undefined;
    try {
      // User gesture must invoke this method directly; do not await a server request before the chooser.
      stream=await navigator.mediaDevices.getDisplayMedia({
        video:{displaySurface:kind==='window'?'window':kind==='tab'?'browser':'monitor'},
        audio:withAudio,
      });
      const video=stream.getVideoTracks()[0];
      if(!video||video.readyState!=='live') throw new Error('No live video track selected');
      const session=await this.api.start({kind,clientRequestId:crypto.randomUUID()});shareId=session.id;
      this.active={id:shareId,stream};
      video.addEventListener('ended',()=>{void this.stop();},{once:true});
      await this.publisher.publish(shareId,stream); // BOTH audio and video tracks, when present.
      if(this.active?.id!==shareId) throw new Error('Share stopped during publication');
      this.heartbeatTimer=setInterval(()=>{void this.checkAuthorization(shareId!);},5000);
      this.onState('live');
    }catch(error){
      if(stream) stream.getTracks().forEach(track=>track.stop());
      if(shareId){await this.publisher.unpublish(shareId).catch(()=>{});await this.api.stop(shareId).catch(()=>{});}
      this.active=undefined;this.onState('error',String(error));throw error;
    }finally{this.starting=false;}
  }
  private async checkAuthorization(shareId:string){
    if(this.active?.id!==shareId)return;
    try {const response=await this.api.heartbeat(shareId);if(!response.authorized)await this.stop();}
    catch { // Fail closed on lost authorization channel; server MUST separately gate media.
      await this.stop();
    }
  }
  async revoked(shareId:string){if(this.active?.id===shareId)await this.stop();}
  async stop(){
    if(this.heartbeatTimer){clearInterval(this.heartbeatTimer);this.heartbeatTimer=undefined;}
    const current=this.active;this.active=undefined;
    if(!current)return;
    this.onState('stopping');current.stream.getTracks().forEach(track=>track.stop());
    try{await this.publisher.unpublish(current.id);}finally{
      try{await this.api.stop(current.id);}finally{this.onState('idle');}
    }
  }
  dispose(){void this.stop();}
}
