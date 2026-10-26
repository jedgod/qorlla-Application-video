// Shared by every certification runner: records exactly which commit was tested and whether source files were dirty.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const GIT = process.env.GIT_EXE || (fs.existsSync('C:/Program Files/Git/mingw64/bin/git.exe') ? 'C:/Program Files/Git/mingw64/bin/git.exe' : 'git');
// Evidence/log/screenshot outputs written by the runners themselves are not "source".
const isCertOutput = (line) => /^\S+\s+"?cert\/(([A-Z_]*EVIDENCE|V3_9_2_[A-Z_]+)\.(md|json)|[^/]+\.(log|jsonl)|screenshots\/)/.test(line);
export function gitState(root) {
  const g = (...a) => execFileSync(GIT, a, { cwd: root, encoding: 'utf8' }).trim();
  const dirty = g('status', '--porcelain').split('\n').filter(Boolean).filter((l) => !isCertOutput(l));
  return { headSha: g('rev-parse', 'HEAD'), branch: g('branch', '--show-current'), sourceTreeClean: dirty.length === 0, dirtySourcePaths: dirty.slice(0, 20) };
}
