  function buildMore() {
    const t = $('tab-more'); t.textContent = ''; t.classList.add('more-v41-compact', 'more-v41-grids');
    const local = state.moreLocalTools || (state.moreLocalTools = { focus: false, remaining: 300000, deadline: 0, alarm: null });
    const host = state.role === 'host';
    const paths = {
      document: ['M7 3h7l4 4v14H7z', 'M14 3v5h5M10 12h5m-5 4h5'],
      captions: ['M3 5h18v14H3z', 'M10 10H7v4h3m7-4h-3v4h3'],
      list: ['M8 6h13M8 12h13M8 18h13M3 6h1m-1 6h1m-1 6h1'],
      bot: ['M5 8h14v12H5z', 'M12 3v5M9 3h6M2 12v4m20-4v4M8 12h1m6 0h1m-7 4h6'],
      invite: ['M15 21v-2a5 5 0 0 0-10 0v2', 'M10 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8M19 7v6m-3-3h6'],
      info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M12 11v6m0-10v1'],
      settings: ['M4 3v8m0 4v6m8-18v3m0 4v11m8-18v11m0 4v3M1 11h6m2-5h6m2 8h6'],
      shield: ['m12 2 8 3v6c0 6-8 11-8 11S4 17 4 11V5z'],
      people: ['M3 21v-3a6 6 0 0 1 12 0v3', 'M9 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8M17 5a3 3 0 0 1 0 6m4 10v-3a5 5 0 0 0-4-5'],
      record: ['M3 5h13v14H3z', 'm16 10 6-3v10l-6-3'],
      lock: ['M5 11h14v11H5z', 'M8 11V7a4 4 0 0 1 8 0v4m-4 5v2'],
      timer: ['M12 6a8 8 0 1 0 0 16 8 8 0 0 0 0-16', 'M9 2h6m-3 0v4m0 4v5l3 2m3-13 2 2'],
      focus: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10M12 11v2m-1-1h2'],
      layout: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
      background: ['M3 4h18v16H3z', 'm3 17 5-5 4 4 3-3 6 6M16 8h1'],
      more: ['M4 12h1m6 0h1m6 0h1']
    };
    function icon(name) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'})) svg.setAttribute(key,value);
      for (const d of paths[name] || paths.settings) { const path = document.createElementNS('http://www.w3.org/2000/svg','path'); path.setAttribute('d',d); svg.append(path); }
      return svg;
    }
    function modal(title, build) { rcModal(title, build); }
    function meetingInfo() {
      modal('Meeting info', box => {
        box.append(el('p','rc-note',state.meetingInfo || $('roomTitle')?.textContent || 'Current meeting'));
        box.append(el('p','rc-note','Meeting ID: ' + ($('roomId')?.textContent || state.meetingId)));
      });
    }
    function hostSettings(title) {
      if (!host) return notify('Only the host can change meeting permissions.');
      modal(title, box => hostPanel(box));
    }
    function attendance() {
      modal('Attendance — connected now', box => {
        box.append(el('p','rc-note','Current participants only. This is not a historical attendance report.'));
        const ids = new Set(state.roster || []); if (state.participantId) ids.add(state.participantId);
        const list = el('ul','rc-list');
        for (const id of ids) list.append(el('li','',(state.names?.get(id) || (id === state.participantId ? state.name : 'Participant ' + String(id).slice(0,8))) + (id === state.participantId ? ' (You)' : '')));
        box.append(list);
      });
    }
    function securitySettings() {
      modal('Security settings', box => {
        box.append(el('p','rc-note','Meeting access and recording follow this meeting’s existing authorization and consent controls.'));
        if (host) {
          const permissions = el('button','rc-secondary','Risk & permissions'); permissions.onclick = () => hostSettings('Risk & permissions');
          const recordings = el('button','rc-secondary','Recording library'); recordings.onclick = openRecordings;
          box.append(permissions, recordings);
        } else box.append(el('p','rc-note','Ask the host to change access permissions. Recording consent can be withdrawn through the existing recording controls.'));
      });
    }
    function timerTool() {
      modal('Personal timer', box => {
        box.append(el('p','rc-note','Only you see this timer.'));
        const minutes = el('input','','',{type:'number'}); minutes.type='number'; minutes.min='1'; minutes.max='180'; minutes.value=String(Math.max(1,Math.ceil((local.deadline ? local.deadline-Date.now() : local.remaining)/60000)));
        minutes.setAttribute('aria-label','Timer minutes');
        const output = el('output','more-timer-output'); output.setAttribute('aria-live','off');
        const start = el('button','rc-primary',local.deadline ? 'Pause' : 'Start'), reset = el('button','rc-secondary','Reset');
        const show = () => { const seconds=Math.max(0,Math.ceil((local.deadline ? local.deadline-Date.now() : local.remaining)/1000)); output.textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0'); };
        const stop = () => { if(local.deadline)local.remaining=Math.max(0,local.deadline-Date.now());local.deadline=0;clearTimeout(local.alarm);local.alarm=null;start.textContent='Start';show(); };
        minutes.onchange=()=>{const n=Number(minutes.value);if(!Number.isInteger(n)||n<1||n>180)return;stop();local.remaining=n*60000;show();};
        start.onclick=()=>{
          if(local.deadline){stop();return;}
          const n=Number(minutes.value);if(!Number.isInteger(n)||n<1||n>180)return notify('Choose 1–180 minutes.');
          if(local.remaining<=0)local.remaining=n*60000;
          local.deadline=Date.now()+local.remaining;start.textContent='Pause';show();clearTimeout(local.alarm);
          local.alarm=setTimeout(()=>{local.remaining=0;local.deadline=0;local.alarm=null;start.textContent='Start';show();notify('Your personal timer is complete.');},local.remaining);
        };
        reset.onclick=()=>{stop();local.remaining=300000;minutes.value='5';show();};
        const row=el('div','rc-row');row.append(start,reset);box.append(minutes,output,row);show();
        const tick=setInterval(()=>{if(!output.isConnected){clearInterval(tick);return;}show();},250);
      });
    }
    function layoutTool() {
      modal('Meeting layout', box => {
        const row = el('div','rc-row');
        for (const existing of document.querySelectorAll('[data-layout]')) {
          const button = el('button','rc-secondary',existing.textContent); button.onclick=()=>{existing.click();rcClose();};row.append(button);
        }
        box.append(row);
      });
    }
    const unavailable = (label, key, reason) => ({label,key,disabled:true,note:'Unavailable',reason:reason || 'This meeting service is not available.'});
    const groups = [
      {id:'collab',title:'Collaboration',key:'people',items:['Whiteboard','Breakout rooms','Shared files','Q&A']},
      {id:'intel',title:'Meeting intelligence',key:'bot',columns:4,tiles:[
        unavailable('AI Summary','document','Requires verified private AI access and explicit consent.'),
        unavailable('Live Transcript','captions','Requires a verified transcription service and consent.'),
        unavailable('Key Takeaways','list','Requires verified private AI access and explicit consent.'),
        unavailable('Ask QorllaMate','bot','Requires the private gateway, consent and verified entitlement.')
      ]},
      {id:'manage',title:'Meeting management',key:'invite',columns:5,tiles:[
        {label:'Invite People',key:'invite',run:()=>$('copyLink').click()},
        {label:'Meeting Info',key:'info',run:meetingInfo},
        {label:'Meeting Settings',key:'settings',disabled:!host,reason:'Host controls only.',run:()=>hostSettings('Meeting settings')},
        {label:'Risk & Permissions',key:'shield',disabled:!host,reason:'Host controls only.',run:()=>hostSettings('Risk & permissions')},
        {label:'Attendance',key:'people',run:attendance}
      ]},
      {id:'sec',title:'Security and recordings',key:'shield',columns:3,tiles:[
        {label:'Recording',key:'record',run:()=>host ? $('recordBtn').click() : notify('Recording follows the existing consent controls. You can withdraw consent at any time.')},
        {label:'Lock Meeting',key:'lock',lock:true},
        {label:'Security Settings',key:'settings',run:securitySettings}
      ]},
      {id:'tools',title:'Tools and settings',key:'settings',columns:6,tiles:[
        {label:'Timer',key:'timer',run:timerTool},
        {label:'Focus Mode',key:'focus',focus:true,run:()=>{local.focus=!local.focus;document.body.classList.toggle('more-focus-mode',local.focus);buildMore();}},
        {label:'Layout',key:'layout',run:layoutTool},
        unavailable('Background & Effects','background','Background processing is not available in this meeting.'),
        {label:'Audio & Video',key:'settings',run:()=>$('settingsBtn').click()},
        {label:'More Settings',key:'more',run:()=>$('settingsBtn').click()}
      ]}
    ];
    const banner=el('div','more-v41-heading');banner.append(el('strong','','Meeting tools'),el('span','more-v41-badge','V4.1'));t.append(banner);
    for(const group of groups){
      const section=el('section','mg'), heading=el('button','mg-h','',{type:'button',id:'mgh-'+group.id,'aria-expanded':String(openGroups.has(group.id)),'aria-controls':'mg-'+group.id});
      const mark=el('span','more-v41-icon');mark.append(icon(group.key));
      heading.append(mark,el('span','',group.title),el('span','mg-chev',openGroups.has(group.id)?'▴':'▾',{'aria-hidden':'true'}));
      const body=el('div',group.tiles?'mg-b more-tile-grid more-count-'+group.columns:'mg-b','',{id:'mg-'+group.id,role:'region','aria-labelledby':'mgh-'+group.id});body.hidden=!openGroups.has(group.id);
      if(group.items){
        body.append(el('p','','Reactions'));const row=el('div','emoji');
        for(const emoji of ['👍','👏','❤️','🎉','😂']){const button=el('button','',emoji,{type:'button','aria-label':'React with '+emoji});button.onclick=()=>state.socket?.emit('reaction',emoji);row.append(button);}body.append(row);
        for(const label of group.items){const button=el('button','mg-i','',{disabled:'','aria-disabled':'true'});button.append(el('span','',label),el('small','muted','Unavailable'));body.append(button);}
      }
      for(const definition of group.tiles || []){
        if(definition.lock){
          const label=el('label','more-square more-lock-square');label.append(icon('lock'),el('span','more-square-label',definition.label));
          const check=el('input','','',{type:'checkbox',role:'switch','aria-label':'Lock Meeting'});check.checked=!!state.settings?.locked;check.disabled=!host||!state.settings;
          check.onchange=async()=>{if(!host)return;check.disabled=true;try{const response=await fetch(BASE+'api/meetings/'+state.meetingId+'/settings',{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:'Bearer '+state.token},body:JSON.stringify({locked:check.checked})});const result=await response.json();if(!response.ok)throw Error(result.error||'Cannot update meeting lock');Object.assign(state.settings,result);announce(check.checked?'Meeting locked':'Meeting unlocked');}catch(error){check.checked=!check.checked;notify(error.message);}check.disabled=false;};
          label.append(check);body.append(label);continue;
        }
        const button=el('button','more-square','',{type:'button','data-more-tile':definition.label});button.append(icon(definition.key),el('span','more-square-label',definition.label));
        if(definition.disabled){button.disabled=true;button.setAttribute('aria-disabled','true');button.title=definition.reason || 'Unavailable';button.append(el('small','more-square-note',definition.note || 'Host only'));}
        if(definition.focus)button.setAttribute('aria-pressed',String(local.focus));
        button.onclick=async()=>{if(definition.disabled)return;try{await definition.run();}catch(error){notify(error.message || 'This tool could not open.');}};
        body.append(button);
      }
      heading.onclick=()=>{const open=heading.getAttribute('aria-expanded')!=='true';if(open)openGroups.add(group.id);else openGroups.delete(group.id);heading.setAttribute('aria-expanded',String(open));body.hidden=!open;heading.querySelector('.mg-chev').textContent=open?'▴':'▾';};
      section.append(heading,body);t.append(section);
    }
    t.append(el('p','muted','Unavailable tools stay off until their meeting services and privacy requirements are verified.'));
  }
