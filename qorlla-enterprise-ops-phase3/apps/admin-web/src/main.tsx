import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
const sections = ["Overview", "Customers", "Tickets", "Workforce", "Meetings", "Numbers & Plans", "Billing", "External Calling", "Security", "Audit"];
function App() {
 const [section,setSection]=useState(sections[0]);
 const [token,setToken]=useState('');
 const [items,setItems]=useState<any[]>([]);
 const [error,setError]=useState('');
 async function load() {
  setError('');
  try {
   const res=await fetch('/api/ops/tickets',{headers:{Authorization:`Bearer ${token}`}});
   if(!res.ok) throw new Error(`Request failed: ${res.status}`);
   const data=await res.json(); setItems(data.items??[]);
  } catch(e) {setError(e instanceof Error?e.message:'Unknown error')}
 }
 return <div className="shell"><aside><h1>◈ Qorlla</h1><small>Admin Control Center</small><nav>{sections.map(s=><button className={section===s?'active':''} onClick={()=>setSection(s)} key={s}>{s}</button>)}</nav><footer>Controlled operations • v2.0</footer></aside><main><header><span>Admin Control Center</span><span className="pill">Integration starter</span></header><h2>{section}</h2><p>Secure operational view. Connect to Qorlla identity and authoritative service APIs.</p><div className="cards"><article><label>Active users</label><strong>—</strong><small>Live source required</small></article><article><label>Open cases</label><strong>{items.length||'—'}</strong><small>API-backed when loaded</small></article><article><label>External calling</label><strong>BLOCKED</strong><small>Certification required</small></article></div><section><h3>Support queue</h3><p>Enter an existing Qorlla access token for local integration testing. Never use this input on a shared device.</p><input type="password" aria-label="Access token" value={token} onChange={e=>setToken(e.target.value)} placeholder="OIDC access token"/><button onClick={load} disabled={!token}>Load authorized tickets</button>{error&&<p role="alert">{error}</p>}<div className="list">{items.map(t=><div key={t.id}><b>{t.subject}</b><span>{t.status} · {t.priority}</span></div>)}</div></section></main></div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
