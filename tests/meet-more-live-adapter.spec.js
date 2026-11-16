const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname,'../evidence/more-localhost-4801');

test('compact adapter renders against the actual 4801 assets without replacing notes, polls or recording logic',async({page})=>{
  const original=fs.readFileSync(path.join(root,'original/collab.js'),'utf8');
  const candidate=fs.readFileSync(path.join(root,'candidate/collab.js'),'utf8');
  expect(candidate.slice(0,candidate.indexOf('  function buildMore()'))).toBe(original.slice(0,original.indexOf('  function buildMore()')));
  expect(candidate.slice(candidate.indexOf('  async function openRecordings()'))).toBe(original.slice(original.indexOf('  async function openRecordings()')));
  const html=fs.readFileSync(path.join(root,'original/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:1440,height:900});
  await page.route('**/*',async route=>{
    const name=new URL(route.request().url()).pathname;
    if(name==='/adapter-preview')return route.fulfill({contentType:'text/html',body:html});
    if(name==='/styles.css'||name==='/collab.js')return route.fulfill({path:path.join(root,'candidate',name.slice(1))});
    if(name==='/favicon.ico')return route.fulfill({status:204});
    throw Error('Unexpected request in isolated adapter preview: '+name);
  });
  await page.goto('/adapter-preview');
  await page.evaluate(async()=>{
    const {initCollab}=await import('/collab.js');
    const el=(tag,cls,text)=>{const element=document.createElement(tag);if(cls)element.className=cls;if(text)element.textContent=text;return element;};
    initCollab({state:{role:'host',name:'Preview host',participantId:'preview-host',meetingId:'preview-meeting',start:Date.now(),tools:{},settings:{locked:false},socket:{emit(){}}},BASE:'/',notify(){},announce(){},rcModal(){},rcClose(){},rcEl:el,askConfirm:async()=>false,hostPanel:container=>container.append(el('p','muted','Existing host controls retained'))});
    document.querySelector('#landing').classList.add('hidden');document.querySelector('#app').classList.remove('hidden');
    document.querySelector('#app').classList.add('panel-open');document.querySelector('#app').dataset.panelDock='right';
    for(const view of document.querySelectorAll('.tab-view'))view.classList.toggle('hidden',view.id!=='tab-more');
    for(const tab of document.querySelectorAll('.tabs [data-tab]'))tab.classList.toggle('selected',tab.dataset.tab==='more');
    document.querySelector('#status').textContent='Isolated preview — no live meeting';
    document.querySelector('#roomTitle').textContent='More V4.1 preview';
  });
  await expect(page.locator('.tabs [data-tab]')).toHaveCount(5);
  await expect(page.locator('#tab-more .mg')).toHaveCount(5);
  await expect(page.locator('.more-v41-badge')).toHaveText('V4.1');
  await expect(page.locator('#tab-more button').filter({hasText:'Q&A'})).toBeDisabled();
  await page.locator('#mgh-intel').click();
  await expect(page.locator('#mg-intel button').filter({hasText:'QorllaMate AI'})).toBeDisabled();
  await page.locator('#mgh-intel').click();
  await page.screenshot({path:path.join(root,'preview.png')});
  expect(errors).toEqual([]);
});
