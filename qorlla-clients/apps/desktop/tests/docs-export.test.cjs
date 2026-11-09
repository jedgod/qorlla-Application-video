'use strict';
// Qorlla Docs native export: the one narrow exception to the desktop shell's download block. These tests pin what may use it, what it accepts, and that nothing else got looser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sec = require('../security.cjs');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const ORIGINS = ['http://localhost:4800', 'http://localhost:4801']; const DEV = { allowLocalhostHttp: true };

test('only the app origin\'s /app/suite page may use the export bridge', () => {
  for (const ok of ['http://localhost:4800/app/suite', 'http://localhost:4800/app/suite/', 'http://localhost:4800/app/suite?doc=11111111-1111-4111-8111-111111111111', 'http://localhost:4800/app/suite#top'])
    assert.equal(sec.exportSenderAllowed(ok, ORIGINS, DEV), true, ok);
  for (const bad of ['http://localhost:4801/app/suite' /* Qorlla Meet's origin */, 'http://localhost:4800/app/notes', 'http://localhost:4800/app/suite/evil', 'http://localhost:4800/app/suiteX', 'http://localhost:4800/', 'http://localhost:4800/guest/meeting/12345678901/prejoin',
    'http://evil.example:4800/app/suite', 'http://localhost:4800.evil.example/app/suite', 'https://localhost:4800/app/suite', 'javascript:alert(1)', 'file:///app/suite', 'about:blank', '', 'not a url', null, undefined])
    assert.equal(sec.exportSenderAllowed(bad, ORIGINS, DEV), false, String(bad));
  assert.equal(sec.exportSenderAllowed('http://localhost:4800/app/suite', ORIGINS, {}), false, 'plain http is refused outside the development allowance');
  assert.equal(sec.exportSenderAllowed('https://app.qorlla.example/app/suite', ['https://app.qorlla.example', 'https://meet.qorlla.example'], {}), true);
  assert.equal(sec.exportSenderAllowed('https://meet.qorlla.example/app/suite', ['https://app.qorlla.example', 'https://meet.qorlla.example'], {}), false);
});

test('file names: only .md and .txt; directories, control characters and Windows device names are stripped', () => {
  const ok = (raw) => sec.validateExport({ filename: raw, text: 'x' });
  assert.deepEqual(ok('Plan Q3.md'), { ok: true, filename: 'Plan Q3.md', ext: 'md', text: 'x' });
  assert.equal(ok('Notes.TXT').filename, 'Notes.txt'); assert.equal(ok('Notes.TXT').ext, 'txt');
  assert.equal(ok('Résumé – plan.md').filename, 'Résumé – plan.md', 'non-ASCII names are fine');
  assert.equal(ok('..\\..\\Windows\\evil.md').filename, 'evil.md'); assert.equal(ok('../../etc/passwd.txt').filename, 'passwd.txt'); assert.equal(ok('C:\\Users\\x\\a.md').filename, 'a.md');
  assert.equal(ok('a\u0000b\r\n.md').filename, 'ab.md'); assert.equal(ok('CON.txt').filename, 'document.txt'); assert.equal(ok('nul.md').filename, 'document.md'); assert.equal(ok('LPT1.md').filename, 'document.md');
  assert.equal(ok('a<b>:c"d|e?f*.md').filename, 'a_b__c_d_e_f_.md'); assert.equal(ok('   .md').filename, 'document.md'); assert.equal(ok('...md').filename, 'document.md');
  assert.ok(ok('x'.repeat(150) + '.md').filename.length <= 83, 'long names are cut');
  for (const bad of ['evil.exe', 'evil.md.exe', 'evil.bat', 'evil.ps1', 'evil.js', 'evil.html', 'evil.docx', 'evil.pdf', 'noextension', 'evil.md ', 'evil.md.', '']) {
    const r = ok(bad); assert.equal(r.ok === true && /\.(md|txt)$/.test(r.filename), r.ok, bad);                       // anything accepted still ends .md/.txt
  }
  for (const rejected of ['evil.exe', 'evil.md.exe', 'evil.bat', 'evil.ps1', 'noextension', 'evil.docx']) assert.deepEqual(ok(rejected), { ok: false, reason: 'unsupported_type' }, rejected);
});

test('the request: a name (<= 200 characters) and text (<= 2 MB), nothing else matters, nothing malformed passes', () => {
  assert.equal(sec.validateExport({ filename: 'a.md', text: '' }).ok, true, 'an empty document can be saved');
  assert.equal(sec.validateExport({ filename: 'a.md', text: 'é'.repeat(900000) }).ok, true);
  assert.deepEqual(sec.validateExport({ filename: 'a.md', text: 'é'.repeat(1100000) }), { ok: false, reason: 'too_large' }, 'size is counted in bytes, not characters');
  assert.deepEqual(sec.validateExport({ filename: 'x'.repeat(201) + '.md', text: 'a' }), { ok: false, reason: 'bad_request' });
  for (const bad of [null, undefined, 'a.md', 42, [], [{ filename: 'a.md', text: 'x' }], {}, { filename: 'a.md' }, { text: 'x' }, { filename: 5, text: 'x' }, { filename: 'a.md', text: 5 }, { filename: 'a.md', text: { toString() { return 'x'; } } }])
    assert.deepEqual(sec.validateExport(bad), { ok: false, reason: 'bad_request' }, JSON.stringify(bad));
  const r = sec.validateExport({ filename: 'a.md', text: 'x', path: 'C:\\Windows\\evil.md', openAfter: true, __proto__: { polluted: true } });
  assert.deepEqual(Object.keys(r).sort(), ['ext', 'filename', 'ok', 'text'], 'a page cannot smuggle a path or any other option through the request');
});

test('whatever is typed in the Save dialog, the saved file ends .md or .txt matching the export', () => {
  assert.equal(sec.finalExportPath('C:\\Docs\\notes.md', 'md'), 'C:\\Docs\\notes.md'); assert.equal(sec.finalExportPath('C:\\Docs\\NOTES.MD', 'md'), 'C:\\Docs\\NOTES.MD');
  assert.equal(sec.finalExportPath('C:\\Docs\\notes', 'md'), 'C:\\Docs\\notes.md'); assert.equal(sec.finalExportPath('C:\\Docs\\run.exe', 'txt'), 'C:\\Docs\\run.exe.txt');
  assert.equal(sec.finalExportPath('C:\\Docs\\notes.txt', 'md'), 'C:\\Docs\\notes.txt.md', 'a .txt name for a markdown export is not left looking like a different type');
  assert.equal(sec.finalExportPath('/home/a/b.md', 'md'), '/home/a/b.md');
});

test('nothing else in the shell got looser: downloads stay blocked, the bridge is one function, only docs-export.cjs writes a file', () => {
  const main = read('main.cjs'), pre = read('preload.cjs'), exp = read('docs-export.cjs');
  assert.match(main, /ses\.on\('will-download',\s*\(event\)\s*=>\s*\{\s*event\.preventDefault\(\)/, 'every download is still cancelled');
  assert.equal((main.match(/ipcMain\.handle\(/g) || []).length, 1, 'exactly one IPC handler'); assert.match(main, /ipcMain\.handle\('qorlla:save-docs-export'/);
  assert.equal((pre.match(/exposeInMainWorld\(/g) || []).length, 1, 'exactly one object is exposed to web content'); assert.match(pre, /exposeInMainWorld\('qorllaDesktop', Object\.freeze\(\{ saveDocsExport:/);
  assert.doesNotMatch(pre, /require\((['"])(node:)?(fs|path|child_process|os)\1\)|shell\.|process\./, 'the preload gives the page no file, path, process or shell access');
  assert.match(main, /contextIsolation: true/); assert.match(main, /nodeIntegration: false/); assert.match(main, /sandbox: true/);
  assert.equal((exp.match(/writeFile\(/g) || []).length, 1, 'one write, in one place'); assert.doesNotMatch(main + pre + read('security.cjs') + read('dev-local.cjs'), /writeFile|appendFile|mkdirSync/, 'no other shell file writes (the existing rule)');
  assert.match(exp, /frame !== contents\.mainFrame/, 'sub-frames cannot use it'); assert.match(exp, /exportSenderAllowed\(frame\.url/); assert.match(exp, /showSaveDialog/);
  assert.ok(exp.indexOf('exportSenderAllowed') < exp.indexOf('showSaveDialog') && exp.indexOf('validateExport') < exp.indexOf('showSaveDialog'), 'the sender and request are checked before any dialog is shown');
  assert.match(main, /testDir: dev && process\.env\.QORLLA_TEST_EXPORT_DIR/, 'the unattended test folder is ignored in a packaged build');
  assert.doesNotMatch(exp, /openExternal|openPath|showItemInFolder|exec\(|spawn\(/, 'a saved file is never opened or run');
});
