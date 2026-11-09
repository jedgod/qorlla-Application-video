'use strict';
// The ONLY thing exposed to web content is the Qorlla Docs export bridge below. It carries a filename and text to the main process, which decides whether this page may use it
// (the main frame of /app/suite on the app origin) and shows the native Save As dialog. No Electron object, path or file handle is ever given to the page.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('qorllaDesktop', Object.freeze({ saveDocsExport: (payload) => ipcRenderer.invoke('qorlla:save-docs-export', payload) }));
