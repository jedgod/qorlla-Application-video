'use strict';
// MANDATORY security regression check for the Linux packages: nothing that ships in the deb or the AppImage may start Qorlla with Chromium's process sandbox disabled.
// It inspects what is actually PACKAGED (desktop entries and launcher scripts in the extracted package), not the source files:
//   dpkg-deb -x qorlla.deb out-deb;  ./qorlla.AppImage --appimage-extract           (-> squashfs-root)
//   node qorlla-clients/e2e/linux-sandbox-check.cjs out-deb squashfs-root
// Exit code 1 and a list of findings when anything disables the sandbox. Never "fix" a failure by adding an exception here: fix the package.
const fs = require('node:fs');
const path = require('node:path');

const SWITCH = /--(no-sandbox|disable-setuid-sandbox|disable-gpu-sandbox|disable-seccomp-filter-sandbox|disable-namespace-sandbox|disable-renderer-sandbox|disable-sandbox)\b/i;
const ENV = /\bELECTRON_(DISABLE|NO)_SANDBOX\b/;

/** files: [{ path, text }]. Returns the problems (empty = clean). Only desktop entries and launcher scripts are meaningful; binaries are not passed in. */
function findProblems(files) {
  const problems = [];
  for (const f of files) {
    const isDesktop = /\.desktop$/i.test(f.path);
    f.text.split(/\r?\n/).forEach((line, i) => {
      if (isDesktop && !/^\s*Exec\s*=/.test(line) && !/^\s*TryExec\s*=/.test(line)) return;
      if (!isDesktop && /^\s*#/.test(line)) return;                                  // a comment in a script does not run
      if (SWITCH.test(line)) problems.push(`${f.path}:${i + 1} disables the Chromium sandbox: ${line.trim().slice(0, 120)}`);
      else if (ENV.test(line)) problems.push(`${f.path}:${i + 1} sets an Electron sandbox-disabling environment variable: ${line.trim().slice(0, 120)}`);
    });
  }
  return problems;
}

/** Collects the desktop entries (anywhere) and small text launchers (AppRun, *.sh, files without an extension at the package root or under opt/) below each directory. */
function collect(dirs) {
  const out = [], seen = new Set();
  const walk = (d, depth) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (depth < 6 && !/^(node_modules|locales|resources|lib|share)$/.test(e.name) || /^(applications)$/.test(e.name) || (e.name === 'share' && depth < 4)) walk(p, depth + 1); continue; }
      const isDesktop = /\.desktop$/i.test(e.name), small = fs.statSync(p).size < 65536;
      const launcher = small && (e.name === 'AppRun' || /\.sh$/i.test(e.name) || (/^[^.]+$/.test(e.name) && depth <= 3));
      if ((isDesktop || launcher) && !seen.has(p)) {
        seen.add(p); let text; try { text = fs.readFileSync(p, e.name === 'AppRun' ? 'latin1' : 'utf8'); } catch { continue; }
        // AppRun is inspected whatever its type: if it is a compiled binary, a baked-in switch still shows up as a string once the NUL separators become line breaks. Other binaries are not launchers and are skipped.
        if (e.name === 'AppRun') out.push({ path: p, text: text.replace(/\0/g, '\n') }); else if (!text.includes('\0')) out.push({ path: p, text });
      }
    }
  };
  for (const d of dirs) walk(d, 0);
  return out;
}

function main(argv) {
  if (!argv.length) { console.error('usage: linux-sandbox-check.cjs <extracted dir>...'); return 2; }
  for (const d of argv) if (!fs.existsSync(d)) { console.error('not found: ' + d); return 2; }
  const files = collect(argv), desktop = files.filter((f) => /\.desktop$/i.test(f.path));
  if (!desktop.length) { console.error('no desktop entry found in the packages: refusing to pass without having inspected one'); return 2; }
  const problems = findProblems(files);
  console.log(`inspected ${desktop.length} desktop entr${desktop.length === 1 ? 'y' : 'ies'} and ${files.length - desktop.length} launcher script(s)`);
  for (const f of desktop) for (const l of f.text.split(/\r?\n/)) if (/^Exec\s*=/.test(l)) console.log(`  ${path.basename(f.path)}: ${l.trim()}`);
  for (const p of problems) console.log('FAIL ' + p);
  console.log(problems.length ? 'SANDBOX CHECK FAILED: the package disables Chromium sandboxing. Do not distribute it.' : 'sandbox check passed: no packaged launcher disables the Chromium sandbox');
  return problems.length ? 1 : 0;
}
module.exports = { findProblems, collect };
if (require.main === module) process.exit(main(process.argv.slice(2)));
