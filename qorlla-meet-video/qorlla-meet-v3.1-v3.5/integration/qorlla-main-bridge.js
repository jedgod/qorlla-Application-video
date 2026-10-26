/* Include in qorlla.html after the page's meeting controls; call openQorllaMeet(options).
   Do not pass host secrets or long-lived tokens in URLs. */
export function openQorllaMeet({ mode='join', meetingId='', displayName='', mic=true, camera=true, title='', passcode='' }={}) {
 const configured=localStorage.getItem('zw_meet_url');
 const target=new URL(configured || `${location.protocol}//${location.hostname}:3000/`);
 if(!['http:','https:'].includes(target.protocol)) throw new Error('Unsupported Meet URL');
 target.searchParams.set('start',mode==='new'?'new':'join');
 if(meetingId)target.searchParams.set('meetingId',meetingId);
 if(displayName)target.searchParams.set('name',displayName);
 if(title)target.searchParams.set('title',title);
 // Passcodes in URLs may be logged; let the Meet lobby collect the passcode instead.
 target.searchParams.set('mic',String(!!mic));
 target.searchParams.set('camera',String(!!camera));
 target.searchParams.set('return',location.origin+'/');
 location.assign(target.href);
}
