import React,{useEffect,useState,useRef} from 'react';
/** Mount inside Meet's existing More tab. Pass an authenticated same-origin request function.
 * api(path,{method,body}) must enforce CSRF and Meet session auth in the host app. */
export function SmartClassroomPanel({occurrenceId,role,api,roomId,onAssign}){
 const [tab,setTab]=useState('dashboard'),[dashboard,setDashboard]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [title,setTitle]=useState(''),[prompt,setPrompt]=useState(''),[duration,setDuration]=useState(900),[boardId,setBoardId]=useState(null);
 const host=['host','cohost'].includes(role);
 const base=`/api/meet/occurrences/${encodeURIComponent(occurrenceId)}/classroom`;
 async function call(path,method='GET',body){setError('');setBusy(true);try{return await api(base+path,{method,body})}catch(e){setError(e?.message||'Request failed');throw e}finally{setBusy(false)}}
 async function refresh(){try{setDashboard(await call(host?'/dashboard':`/rooms/${encodeURIComponent(roomId)}/dashboard`))}catch{}}
 useEffect(()=>{if(occurrenceId&&(host||roomId))refresh()},[occurrenceId,roomId,role]);
 async function createExercise(e){e.preventDefault();try{await call(`/rooms/${encodeURIComponent(roomId)}/exercises`,'POST',{title,prompt,durationSeconds:Number(duration)});setTitle('');setPrompt('');await refresh()}catch{}}
 async function makeBoard(){try{const b=await call(`/rooms/${encodeURIComponent(roomId)}/board`,'POST',{});setBoardId(b.id)}catch{}}
 return <section aria-label="Smart Classroom" className="q-smart-classroom">
  <header><h2>Smart Classroom</h2><p>Room activities, collaboration and teacher oversight</p></header>
  <nav aria-label="Smart Classroom sections">{['dashboard','assign','exercises','whiteboard','reports'].map(x=><button type="button" key={x} aria-current={tab===x?'page':undefined} onClick={()=>setTab(x)}>{x[0].toUpperCase()+x.slice(1)}</button>)}</nav>
  {error&&<p role="alert">{error}</p>}
  {tab==='dashboard'&&<div><button disabled={busy} onClick={refresh}>Refresh</button>{dashboard?.rooms?.map(r=><article key={r.id}><h3>{r.name}</h3><p>{r.members} participants · {r.active_exercises} exercises · {r.help_requests} help requests · {r.reports} reports</p></article>)}</div>}
  {tab==='assign'&&(host?<section><h3>Assign participants</h3><p>Use the existing epoch-fenced Meet room movement service.</p><button disabled={busy||!onAssign} onClick={()=>onAssign?.()}>Open room assignments</button></section>:<p>Only the host can assign participants.</p>)}
  {tab==='exercises'&&<form onSubmit={createExercise}><h3>Timed exercise</h3><label>Title<input required maxLength={180} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>Instructions<textarea maxLength={12000} value={prompt} onChange={e=>setPrompt(e.target.value)}/></label><label>Duration (seconds)<input type="number" min="30" max="14400" value={duration} onChange={e=>setDuration(e.target.value)}/></label><button disabled={busy||!roomId}>Create exercise</button></form>}
  {tab==='whiteboard'&&<section><h3>Room whiteboard</h3><button disabled={busy||!roomId} onClick={makeBoard}>Open room board</button>{boardId&&<RoomWhiteboard boardId={boardId} api={api} base={base}/>}</section>}
  {tab==='reports'&&<section><h3>Group reports</h3><p>Reports are stored in the meeting database. AI summaries require explicit consent and the private Portal AI gateway.</p></section>}
 </section>;
}
export function RoomWhiteboard({boardId,api,base}){
 const canvas=useRef(null),drawing=useRef(false),points=useRef([]),[error,setError]=useState('');
 function normalized(e){const r=canvas.current.getBoundingClientRect();return {x:Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),y:Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))}}
 function start(e){drawing.current=true;points.current=[normalized(e)];e.currentTarget.setPointerCapture(e.pointerId)}
 function move(e){if(!drawing.current)return;const p=normalized(e);const c=canvas.current,ctx=c.getContext('2d');const prev=points.current.at(-1);ctx.beginPath();ctx.moveTo(prev.x*c.width,prev.y*c.height);ctx.lineTo(p.x*c.width,p.y*c.height);ctx.stroke();points.current.push(p)}
 async function end(){if(!drawing.current)return;drawing.current=false;const p=points.current;points.current=[];if(!p.length)return;try{await api(`${base}/boards/${encodeURIComponent(boardId)}/ops`,{method:'POST',body:{opId:crypto.randomUUID(),kind:'stroke',points:p,color:'#222222',width:2}})}catch(e){setError('Could not save stroke; reload the board before continuing')}}
 return <div><canvas ref={canvas} width={800} height={450} style={{width:'100%',touchAction:'none',background:'white',border:'1px solid #999'}} aria-label="Room whiteboard drawing surface" onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end}/>{error&&<p role="alert">{error}</p>}<p>Drawing is provisional until server acknowledgment. Connect replay to boardOps for shared rendering.</p></div>
}
