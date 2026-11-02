const {app,BrowserWindow,shell,session,dialog}=require('electron');
const path=require('node:path');
const {verifiedOrigin,navigationAllowed,externalAllowed}=require('./security.cjs');
let origin;try{origin=verifiedOrigin(process.env.QORLLA_APP_URL||'');}catch(e){console.error('QORLLA_APP_URL:',e.message);process.exit(1);}
const permissionTypes=new Set(['media','display-capture','notifications']);
function createWindow(){
 const win=new BrowserWindow({width:1280,height:850,minWidth:850,minHeight:600,show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,webviewTag:false}});
 win.once('ready-to-show',()=>win.show());
 win.webContents.setWindowOpenHandler(({url})=>{if(externalAllowed(url))shell.openExternal(url).catch(()=>{});return {action:'deny'};});
 win.webContents.on('will-navigate',(e,url)=>{if(!navigationAllowed(url,origin))e.preventDefault();});
 win.webContents.on('will-redirect',(e,url)=>{if(!navigationAllowed(url,origin))e.preventDefault();});
 win.webContents.on('will-attach-webview',e=>e.preventDefault());
 win.webContents.on('render-process-gone',()=>dialog.showErrorBox('Qorlla','The application renderer stopped. Restart Qorlla.'));
 win.loadURL(origin).catch(()=>win.loadFile(path.join(__dirname,'index.html')));
 return win;
}
app.whenReady().then(()=>{
 session.defaultSession.setPermissionRequestHandler((wc,permission,callback,details)=>{const url=details.requestingUrl||wc.getURL();callback(permissionTypes.has(permission)&&navigationAllowed(url,origin));});
 session.defaultSession.setPermissionCheckHandler((wc,permission,requestingOrigin)=>permissionTypes.has(permission)&&navigationAllowed(requestingOrigin,origin));
 session.defaultSession.on('will-download',(event,item)=>{event.preventDefault();dialog.showMessageBox({type:'info',message:'Downloads are disabled in this shell. Use the verified Qorlla web portal for file exports.'});});
 createWindow();app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
