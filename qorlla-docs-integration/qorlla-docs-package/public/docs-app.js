// Mount in the authenticated Qorlla Workspace shell; never use this page as an auth boundary.
const api='/api/v1/docs-next';
const $=id=>document.getElementById(id);
const state={id:null,version:null,dirty:false,busy:false,timer:null,lastSaved:null};
const json=async(path,options={})=>{
 const response=await fetch(api+path,{credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':document.querySelector('meta[name="csrf-token"]')?.content||''},...options});
 if(!response.ok){let body={};try{body=await response.json()}catch{};throw Error(body.error||`HTTP ${response.status}`)}
 return response.status===204?null:response.json();
};
const status=t=>$('status').textContent=t;
const showError=e=>$('error').textContent=e?.message||String(e);
const textNode=(tag,text)=>{const el=document.createElement(tag);el.textContent=text;return el};
const renderList=async()=>{
 $('listStatus').textContent='Loading documents…';$('docsList').replaceChildren();
 try{const view=encodeURIComponent($('view').value),q=encodeURIComponent($('search').value);const {documents}=await json(`/?view=${view}&q=${q}`);
  for(const d of documents){const card=document.createElement('button');card.className='card doc';card.append(textNode('strong','📄 '+d.title),textNode('p',`${d.kind.toUpperCase()} · Version ${d.current_version}`),textNode('small',new Date(d.updated_at).toLocaleString()));card.onclick=()=>openDoc(d.id);$('docsList').append(card)}
  $('listStatus').textContent=documents.length?`${documents.length} document(s)`:'No documents found.';
 }catch(e){$('listStatus').textContent=`Could not load documents: ${e.message}`}
};
const blocksFromEditor=()=>({type:'doc',blocks:[{type:'paragraph',text:$('content').innerText}]});
const loadEditor=content=>{$('content').replaceChildren();const blocks=Array.isArray(content?.blocks)?content.blocks:[];for(const block of blocks){const p=document.createElement('p');p.textContent=typeof block.text==='string'?block.text:'';$('content').append(p)}if(!blocks.length)$('content').append(document.createElement('p'))};
const openDoc=async id=>{
 if(state.dirty&&!confirm('Unsaved changes. Leave this document?'))return;
 try{const {document,content}=await json('/'+id);if(document.deleted_at)throw Error('Document is in Trash');state.id=id;state.version=document.current_version;state.dirty=false;$('title').value=document.title;loadEditor(content);$('homeView').style.display='none';$('editorView').style.display='block';status('Saved');history.replaceState(null,'','/docs?doc='+id)}catch(e){alert(e.message)}
};
const save=async()=>{
 if(!state.dirty||state.busy||!state.id)return;
 state.busy=true;status('Saving…');$('error').textContent='';
 try{const content=blocksFromEditor();const {version}=await json('/'+state.id,{method:'PUT',body:JSON.stringify({base_version:state.version,content})});state.version=version;state.dirty=false;state.lastSaved=Date.now();status('Saved');}
 catch(e){status('Not saved');showError(e);if(e.message==='version_conflict')showError(Error('Another edit was saved. Copy your changes before reloading.'));}
 finally{state.busy=false;if(state.dirty)queueSave()}
};
const queueSave=()=>{clearTimeout(state.timer);state.timer=setTimeout(save,900)};
$('content').addEventListener('input',()=>{state.dirty=true;status('Unsaved changes');queueSave()});
$('newDoc').onclick=async()=>{try{const {id}=await json('/',{method:'POST',body:JSON.stringify({kind:'doc',title:'Untitled document',content:{type:'doc',blocks:[]}})});await openDoc(id)}catch(e){alert(e.message)}};
$('back').onclick=async()=>{if(state.dirty){await save();if(state.dirty)return}state.id=null;$('editorView').style.display='none';$('homeView').style.display='block';history.replaceState(null,'','/docs');await renderList()};
$('title').addEventListener('change',async()=>{try{await json('/'+state.id,{method:'PATCH',body:JSON.stringify({title:$('title').value})});status('Title saved')}catch(e){showError(e)}});
$('delete').onclick=async()=>{if(!confirm('Move document to Trash?'))return;try{await json('/'+state.id,{method:'DELETE'});state.dirty=false;$('back').click()}catch(e){showError(e)}};
$('export').onclick=()=>{if(!state.id)return;window.location.href=api+'/'+state.id+'/export.txt'};
$('refresh').onclick=renderList;$('view').onchange=renderList;$('search').oninput=()=>{clearTimeout(state.searchTimer);state.searchTimer=setTimeout(renderList,250)};
for(const b of document.querySelectorAll('[data-format]'))b.onclick=()=>{document.execCommand(b.dataset.format,false,null);$('content').focus();state.dirty=true;queueSave()};
$('heading').onclick=()=>{document.execCommand('formatBlock',false,'h2');state.dirty=true;queueSave()};
window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue=''}});
renderList().then(()=>{const id=new URL(location.href).searchParams.get('doc');if(id)openDoc(id)});
