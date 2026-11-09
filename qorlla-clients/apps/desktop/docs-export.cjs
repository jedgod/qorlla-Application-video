'use strict';
// Native "Save As" for Qorlla Docs exports. This is the ONLY place in the desktop shell that writes a file, and it only ever writes ONE file, chosen by the person in the
// operating system's Save dialog, with content the Docs page just fetched with the person's own session (sign-in, document rights and plan limits were enforced by the
// server before the text reached the page). General download protection (main.cjs "will-download") stays on for everything else.
//   - who may ask:  the main frame of /app/suite on the app origin, nothing else (security.exportSenderAllowed)
//   - what:         a filename ending .md or .txt and text up to 2 MB (security.validateExport); the final path is forced to .md/.txt as well
//   - where:        wherever the person chooses in the Save dialog; the page never learns the path
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const sec = require('./security.cjs');

let busy = false;                                                   // one dialog at a time: a page cannot stack Save dialogs

/** `testDir` (development builds only, set by main.cjs from QORLLA_TEST_EXPORT_DIR) replaces the dialog with a fixed folder so a certification run can exercise the real IPC path unattended. */
async function handleSave(event, payload, { origins, opts, testDir = null }) {
  const frame = event.senderFrame, contents = event.sender;
  if (!frame || !contents || frame !== contents.mainFrame || !sec.exportSenderAllowed(frame.url, origins, opts)) return { saved: false, error: 'not_allowed' };
  const v = sec.validateExport(payload);
  if (!v.ok) return { saved: false, error: v.reason };
  if (busy) return { saved: false, error: 'busy' };
  busy = true;
  try {
    let target;
    if (testDir) target = path.join(testDir, v.filename);
    else {
      const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(contents), {
        title: 'Save document', defaultPath: path.join(app.getPath('documents'), v.filename),
        filters: [{ name: sec.EXPORT_TYPES[v.ext], extensions: [v.ext] }], properties: ['showOverwriteConfirmation']
      });
      if (r.canceled || !r.filePath) return { saved: false, canceled: true };
      target = sec.finalExportPath(r.filePath, v.ext);
    }
    await fs.promises.writeFile(target, v.text, { encoding: 'utf8', flag: 'w' });
    return { saved: true };
  } catch { return { saved: false, error: 'write_failed' }; }
  finally { busy = false; }
}
module.exports = { handleSave };
