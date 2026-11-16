const fs=require('fs'),assert=require('assert');
const {chromium}=require('@playwright/test');
(async()=>{
const html=fs.readFileSync('evidence/history-compact/candidate.html','utf8');
const start=html.indexOf('  function historySection(opts)'),end=html.indexOf('  VIEWS.history =',start);
const browser=await chromium.launch({headless:true});
try {
const page=await browser.newPage({viewport:{width:1400,height:1000}});
await page.setContent('<html><head>'+[...html.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)].map(x=>x[0]).join('')+'</head><body style="padding:20px"><main id="fixture"></main></body></html>');
await page.evaluate(code=>{
window.I18n={t:(s,p)=>p?s.replace('{a}',p.a).replace('{b}',p.b):s};window.store=()=>null;window.IC={};window.icon=()=>document.createElement('i');
window.h=(tag,attrs={},kids=[])=>{const e=document.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(k==='text')e.textContent=v;else e.setAttribute(k,v);}for(const kid of kids)if(kid)e.append(kid);return e;};
window.emptyState=t=>h('p',{class:'empty',text:t});
window.histRow=(b,reload,collapse)=>{const a=h('article',{class:'hist-row'}),head=h('button',{class:'hist-rowhead',text:b.title}),body=h('div',{class:'hist-body hidden'},[h('h3',{text:b.title}),h('p',{text:'Isolated layout fixture'}),h('div',{class:'hist-actions'},[h('button',{class:'btn',text:'Save outcome'})])]);a.append(head,body);a._collapse=()=>body.classList.add('hidden');head.onclick=()=>{collapse(a);body.classList.remove('hidden');a.classList.add('open');};return a;};
window.api2=async url=>{const q=new URL(url,'http://test').searchParams,off=Number(q.get('offset')),limit=Number(q.get('limit'));return{total:23,meetings:Array.from({length:Math.min(limit,23-off)},(_,i)=>({title:'Meeting '+(off+i+1)}))};};
(0,eval)(code);document.querySelector('#fixture').append(historySection({collapsible:false}));
},html.slice(start,end));
await page.waitForSelector('.hist-row');
assert.equal(await page.locator('.hist-row').count(),9);
await page.locator('.hist-next').click();await page.waitForTimeout(50);assert.equal(await page.locator('.hist-rowhead').first().textContent(),'Meeting 10');
await page.locator('.hist-next').click();await page.waitForTimeout(50);assert.equal(await page.locator('.hist-row').count(),5);assert(await page.locator('.hist-next').isDisabled());
await page.locator('.hist-prev').click();await page.waitForTimeout(50);assert.equal(await page.locator('.hist-rowhead').first().textContent(),'Meeting 10');
const box=await page.locator('.hist-pager').boundingBox(),list=await page.locator('.hist-list').boundingBox();assert(box.y+box.height<=list.y+list.height+2);
await page.screenshot({path:'evidence/history-compact/preview.png',fullPage:true});
await page.setViewportSize({width:390,height:844});await page.waitForTimeout(50);
assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
fs.writeFileSync('evidence/history-compact/validation.json',JSON.stringify({passed:true,checks:['inline script syntax','viewport capacity 9 rows','next and previous page offsets','last page 5 rows and disabled Next','bottom-aligned pager','390px mobile no horizontal overflow'],fixture:'Real historySection with isolated record renderer and API fixtures'},null,2));
console.log('History layout/pagination: six checks passed.');
}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
