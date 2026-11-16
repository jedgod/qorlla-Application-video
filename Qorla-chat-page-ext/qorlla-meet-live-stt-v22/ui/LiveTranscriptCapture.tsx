import React,{useEffect,useRef,useState} from 'react';

type Props={occurrenceId:string;sessionId:string;consentEpoch:number;authorized:boolean;apiBase:string;onError?:(message:string)=>void};
/** Records ONLY this participant's microphone, not other peers or system audio. */
export function LiveTranscriptCapture({occurrenceId,sessionId,consentEpoch,authorized,apiBase,onError}:Props){
 const [recording,setRecording]=useState(false);const recorder=useRef<MediaRecorder|null>(null);const stream=useRef<MediaStream|null>(null);const queue=useRef<Promise<unknown>>(Promise.resolve());const alive=useRef(false);const started=useRef(0);
 async function stop(){alive.current=false;recorder.current?.stop();recorder.current=null;stream.current?.getTracks().forEach(t=>t.stop());stream.current=null;setRecording(false)}
 useEffect(()=>{if(!authorized)void stop();return()=>{void stop()}},[authorized,sessionId,consentEpoch]);
 async function start(){
  if(!authorized||recording)return;
  const mime=['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg'].find(m=>MediaRecorder.isTypeSupported(m));
  if(!mime){onError?.('This browser does not support a compatible microphone recording format');return}
  try{const media=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
   if(!authorized){media.getTracks().forEach(t=>t.stop());return}
   stream.current=media;const rec=new MediaRecorder(media,{mimeType:mime});recorder.current=rec;alive.current=true;started.current=performance.now();let seq=0;
   rec.ondataavailable=(event)=>{if(!alive.current||event.data.size===0)return;const chunk=event.data;const chunkStartMs=seq++*4000;queue.current=queue.current.then(async()=>{
     if(!alive.current)return;const res=await fetch(`${apiBase}/${encodeURIComponent(occurrenceId)}/transcripts/${encodeURIComponent(sessionId)}/audio`,{method:'POST',credentials:'include',headers:{'content-type':chunk.type.split(';')[0],'x-consent-epoch':String(consentEpoch),'x-chunk-id':crypto.randomUUID(),'x-chunk-start-ms':String(chunkStartMs)},body:chunk});
     if(!res.ok){await stop();onError?.('Transcript consent or audio upload was rejected')}
    }).catch(()=>{void stop();onError?.('Transcription unavailable')});};
   rec.onerror=()=>{void stop();onError?.('Microphone capture failed')};rec.start(4000);setRecording(true);
  }catch{onError?.('Microphone permission denied or unavailable')}
 }
 return <section aria-label="Live transcript microphone"><p>Only your microphone is captured. Recording requires consent from every active participant in this room.</p><button disabled={!authorized||recording} onClick={()=>void start()}>Start my transcription</button><button disabled={!recording} onClick={()=>void stop()}>Stop my transcription</button><output aria-live="polite">{recording?'Microphone recording':'Not recording'}</output></section>
}
