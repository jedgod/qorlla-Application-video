const { app, BrowserWindow, shell, session } = require('electron');
const { URL } = require('node:url');
const raw = process.env.QORLLA_APP_URL;
if (!raw) { console.error('Set QORLLA_APP_URL to the verified HTTPS Qorlla web application origin'); process.exit(1); }
let origin;
try { const url = new URL(raw); if (url.protocol !== 'https:' || url.username || url.password) throw Error('HTTPS required'); origin = url.origin; } catch { console.error('Invalid QORLLA_APP_URL'); process.exit(1); }
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    let source; try { source = new URL(details.requestingUrl || wc.getURL()); } catch { return callback(false); }
    callback(source.origin === origin && ['media', 'display-capture', 'notifications'].includes(permission));
  });
  const win = new BrowserWindow({ width: 1280, height: 850, minWidth: 850, minHeight: 600, webPreferences: { preload: require('node:path').join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  win.webContents.setWindowOpenHandler(({ url }) => { try { const u = new URL(url); if (u.protocol === 'https:') shell.openExternal(url); } catch {} return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { try { if (new URL(url).origin !== origin) event.preventDefault(); } catch { event.preventDefault(); } });
  win.loadURL(origin).catch(err => { console.error('Qorlla failed to load:', err.message); win.loadFile('index.html'); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
