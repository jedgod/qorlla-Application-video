'use strict';
// Builds the PRIVATE Debian test package for physical certification from ONE exact commit, in a container pinned by image digest, and writes an auditable record.
//   node qorlla-clients/tools/build-test-package.cjs <commit> --out <private directory> [--record <path to the record file>]
// - The source is `git archive <commit>` (a working tree is never used), so the record's sourceCommit really is what was built.
// - The package is written to --out, which must be OUTSIDE the repository (installers are never committed or uploaded: the repository is public).
// - The record lists the toolchain, the package SHA-256 and the verification results. It starts "NOT yet approved": a person must approve it (approvedBy) before testers use the package.
// - A package that fails any check is not recorded. Builds are not byte-reproducible: the record identifies THIS file, and testers' files are compared with it, never with a CI hash.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BUILDER_IMAGE = 'node:22-bookworm';
function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
function main() {
  const repo = path.resolve(__dirname, '..', '..'), commit = process.argv[2], out = arg('--out');
  if (!commit || !out) { console.error('usage: build-test-package.cjs <commit> --out <private directory> [--record <file>]'); return 2; }
  const full = execFileSync('git', ['rev-parse', '--verify', commit + '^{commit}'], { cwd: repo, encoding: 'utf8' }).trim(), outDir = path.resolve(out);
  if (!/^[0-9a-f]{40}$/.test(full)) throw new Error('not a commit: ' + commit);
  if (path.relative(repo, outDir) && !path.relative(repo, outDir).startsWith('..')) { console.error('--out must be outside the repository (installers are never committed)'); return 2; }
  fs.mkdirSync(outDir, { recursive: true }); for (const f of fs.readdirSync(outDir)) fs.rmSync(path.join(outDir, f), { recursive: true, force: true });
  const digest = execFileSync('docker', ['image', 'inspect', BUILDER_IMAGE, '--format', '{{index .RepoDigests 0}}'], { encoding: 'utf8' }).trim();   // node@sha256:...
  if (!/@sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('cannot pin the builder image by digest: ' + digest);
  console.log(`building commit ${full.slice(0, 12)} in ${digest.slice(0, 30)}…`);
  const archive = spawnSync('git', ['archive', '--format=tar', full, '--', 'qorlla-clients', '.github'], { cwd: repo, maxBuffer: 1 << 30 });
  if (archive.status !== 0) throw new Error('git archive failed: ' + archive.stderr);
  const run = spawnSync('docker', ['run', '-i', '--rm', '-v', outDir + ':/out', digest, 'bash', '-c', 'mkdir /w && tar x -C /w && bash /w/qorlla-clients/tools/build-test-package.inside.sh'], { input: archive.stdout, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  process.stdout.write((run.stdout || '').split('\n').filter((l) => /^==|^[0-9a-f]{64}/.test(l)).join('\n') + '\n');
  if (run.status !== 0) { console.error('BUILD OR VERIFICATION FAILED; nothing recorded.\n' + (run.stderr || '').split('\n').slice(-8).join('\n')); return 1; }
  const facts = JSON.parse(fs.readFileSync(path.join(outDir, 'facts.json'), 'utf8'));
  const record = { schema: 'qorlla-test-package-record/1', status: 'built and verified; NOT yet approved for handoff', approvedBy: null, sourceCommit: full, builtOn: new Date().toISOString().slice(0, 10),
    builder: { image: BUILDER_IMAGE, imageDigest: digest.split('@')[1], ...facts.builder }, package: facts.package, verification: facts.verification,
    handoff: 'Private only. The file is never committed or uploaded; it is given to each tester through a controlled channel and every tester records its SHA-256, which must equal package.sha256.' };
  const recordPath = path.resolve(arg('--record') || path.join(outDir, 'test-package-record.json')); fs.mkdirSync(path.dirname(recordPath), { recursive: true }); fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
  console.log(`package : ${path.join(outDir, record.package.file)}  (PRIVATE, ${record.package.sizeBytes} bytes)\nsha256  : ${record.package.sha256}\nrecord  : ${recordPath}`); return 0;
}
if (require.main === module) { try { process.exit(main()); } catch (e) { console.error(e.message); process.exit(1); } }
