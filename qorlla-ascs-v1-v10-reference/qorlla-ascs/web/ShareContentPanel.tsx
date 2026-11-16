import React, {useEffect,useRef,useState} from 'react';
export type ShareKind='screen'|'window'|'tab'|'slides'|'docs'|'whiteboard'|'camera';
export type PresenterMode='content'|'standout'|'side-by-side'|'reporter';
export interface ShareBridge {
  requestStart(input:{kind:ShareKind;mode:PresenterMode;clientRequestId:string}):Promise<{id:string}>;
  publishTrack(track:MediaStreamTrack,shareId:string,stream:MediaStream):Promise<void>;
  stopShare(shareId:string):Promise<void>;
}
export function ShareContentPanel({bridge,canPresent=true}:{bridge:ShareBridge;canPresent?:boolean}) {
  const [kind,setKind]=useState<ShareKind>('screen');
  const [mode,setMode]=useState<PresenterMode>('content');
  const [audio,setAudio]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [sharing,setSharing]=useState(false);
  const active=useRef<{id:string;stream:MediaStream}|null>(null);
  async function stop(){const item=active.current;active.current=null;setSharing(false);if(!item)return;
    item.stream.getTracks().forEach(t=>t.stop());try{await bridge.stopShare(item.id);}catch(e){setError(String(e));}}
  useEffect(()=>()=>{const item=active.current;if(item){item.stream.getTracks().forEach(t=>t.stop());void bridge.stopShare(item.id);}},[bridge]);
  async function start(){if(busy||active.current||!canPresent)return;setBusy(true);setError('');let stream:MediaStream|undefined;let shareId:string|undefined;
    try{
      if(kind==='screen'||kind==='window'||kind==='tab'){
        // The browser, not Qorlla, controls the source chooser. displaySurface is only a hint.
        stream=await navigator.mediaDevices.getDisplayMedia({video:{displaySurface:kind==='window'?'window':kind==='tab'?'browser':'monitor'},audio});
      } else if(kind==='camera') stream=await navigator.mediaDevices.getUserMedia({video:true,audio:false});
      else throw new Error('Workspace source requires its dedicated Qorlla Docs/Slides/Whiteboard adapter.');
      const result=await bridge.requestStart({kind,mode,clientRequestId:crypto.randomUUID()});shareId=result.id;
      active.current={id:shareId,stream};setSharing(true);
      stream.getVideoTracks()[0]?.addEventListener('ended',()=>{void stop();},{once:true});
      await bridge.publishTrack(stream.getVideoTracks()[0],shareId,stream);
    }catch(e){if(stream)stream.getTracks().forEach(t=>t.stop());if(shareId)await bridge.stopShare(shareId).catch(()=>{});active.current=null;setSharing(false);setError(String(e));}
    finally{setBusy(false);}
  }
  return <section aria-label="Qorlla sharing" className="ascs-panel">
    <h2>Share content</h2><label><input type="checkbox" checked={audio} onChange={e=>setAudio(e.target.checked)}/>Include supported computer audio</label>
    <fieldset><legend>Presenter mode</legend>{(['content','standout','side-by-side','reporter'] as const).map(m=><label key={m}><input type="radio" name="presenter-mode" checked={mode===m} onChange={()=>setMode(m)}/>{m}</label>)}</fieldset>
    <fieldset><legend>Sharing source</legend>{(['screen','window','tab','slides','docs','whiteboard','camera'] as const).map(k=><label key={k}><input type="radio" name="share-source" checked={kind===k} onChange={()=>setKind(k)}/>{k}</label>)}</fieldset>
    {error&&<p role="alert">{error}</p>}
    {sharing?<button onClick={()=>void stop()}>Stop sharing</button>:<button disabled={busy||!canPresent} onClick={()=>void start()}>{busy?'Starting…':'Share'}</button>}
  </section>;
}
