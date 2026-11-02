// Express integration helper; invoke after canonical route is verified.
export function installCanonicalRoute(app) {
  app.get('/index.html',(req,res)=>res.redirect(302,'/qorlla.html'));
}
export function validateMeetingFields(input) {
  const title=String(input.title??'').trim();
  if (!title || title.length>160) throw new Error('Meeting title must be 1–160 characters');
  const passcode=input.passcode==null?'':String(input.passcode);
  if (passcode && (passcode.length<8 || passcode.length>128)) throw new Error('Passcode must be 8–128 characters');
  return {title,passcode}; // hash passcode server-side; never log, return or place in URL
}
