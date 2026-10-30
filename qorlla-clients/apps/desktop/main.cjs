'use strict';
const { app, BrowserWindow, shell, session, dialog, desktopCapturer } = require('electron');
const path = require('node:path');
const sec = require('./security.cjs');

// Development/test switches. Every one of them is ignored in a packaged build.
const dev = !app.isPackaged;
const insecureLocal = sec.localhostHttpAllowed(process.env, app.isPackaged);          // http://localhost for local stacks only
if (dev && process.env.QORLLA_DEV_USER_DATA) app.setPath('userData', process.env.QORLLA_DEV_USER_DATA);
// Diagnostic switch for the certification runs only (ignored when packaged): lets a run be repeated with GPU acceleration off to see whether capture/encode problems come from it.
if (dev && process.env.QORLLA_TEST_DISABLE_GPU === '1') app.disableHardwareAcceleration();
if (dev && process.env.QORLLA_TEST_FAKE_MEDIA === '1') { app.commandLine.appendSwitch('use-fake-device-for-media-stream'); app.commandLine.appendSwitch('use-fake-ui-for-media-stream'); }

let origins;
try { origins = sec.trustedOrigins(process.env.QORLLA_APP_URL || '', process.env.QORLLA_MEET_URLS || '', { allowLocalhostHttp: insecureLocal }); }
catch (e) { console.error('QORLLA_APP_URL / QORLLA_MEET_URLS:', e.message); process.exit(1); }
const opts = { allowLocalhostHttp: insecureLocal };
const appOrigin = origins[0];
const allowed = (url) => sec.navigationAllowed(url, origins, opts);

let win = null, pendingLink = null;
const linkFrom = (argv) => argv.find((a) => /^qorlla:/i.test(a));
/** A qorlla://join link opens the pre-join page of that meeting inside the shell. A malformed or unknown link is ignored. */
function openLink(raw) {
  const j = sec.parseJoinLink(raw); if (!j) return false;
  if (!win) { pendingLink = raw; return true; }
  win.loadURL(sec.prejoinUrl(appOrigin, j.meetingId)).catch(() => {}); if (win.isMinimized()) win.restore(); win.focus(); return true;
}

function createWindow(startUrl) {
  win = new BrowserWindow({ icon: path.join(__dirname, 'build', 'icon.png'), width: 1280, height: 850, minWidth: 850, minHeight: 600, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false } });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { if (sec.externalAllowed(url)) shell.openExternal(url).catch(() => {}); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!allowed(url)) e.preventDefault(); });
  win.webContents.on('will-redirect', (e, url) => { if (!allowed(url)) e.preventDefault(); });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.webContents.on('render-process-gone', () => dialog.showErrorBox('Qorlla', 'The application renderer stopped. Restart Qorlla.'));
  win.loadURL(startUrl).catch(() => win && win.loadFile(path.join(__dirname, 'index.html')));
  return win;
}

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', (_e, argv) => { const l = linkFrom(argv); if (l) openLink(l); else if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('open-url', (e, url) => { e.preventDefault(); openLink(url); });                     // macOS delivers links here
  if (app.isPackaged) app.setAsDefaultProtocolClient('qorlla');                                  // never rewrites OS registrations from a dev run
  app.whenReady().then(() => {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((wc, permission, callback, details) => callback(sec.permissionAllowed(permission, details.requestingUrl || wc.getURL(), origins, opts)));
    ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => sec.permissionAllowed(permission, requestingOrigin, origins, opts));
    // Screen sharing: only a trusted page may ask, and the PERSON confirms which screen. Declining (or any error) denies.
    ses.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        if (!allowed(request.frame?.url || '')) return callback({});
        const screens = await desktopCapturer.getSources({ types: ['screen'] }); if (!screens.length) return callback({});
        const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Share my screen', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Share your screen in this meeting?', detail: 'Everyone in the meeting will see everything on the screen "' + screens[0].name + '".' });
        callback(r.response === 0 ? { video: screens[0] } : {});
      } catch { callback({}); }
    });
    ses.on('will-download', (event) => { event.preventDefault(); dialog.showMessageBox({ type: 'info', message: 'Downloads are disabled in this shell. Use the verified Qorlla web portal for file exports.' }); });
    const first = pendingLink || linkFrom(process.argv), j = first && sec.parseJoinLink(first);
    createWindow(j ? sec.prejoinUrl(appOrigin, j.meetingId) : appOrigin);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(appOrigin); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
