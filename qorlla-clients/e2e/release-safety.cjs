'use strict';
// Release-safety rules for the repository's CI configuration. The repository is PUBLIC, so nothing that builds an installer may publish it, and the Linux AppImage (secure launch not established) must never be released.
//   node qorlla-clients/e2e/release-safety.cjs          checks every workflow file and the electron-builder configuration; exit 1 on a violation
const fs = require('node:fs');
const path = require('node:path');

const INSTALLER = /(\.(exe|msi|dmg|pkg|deb|rpm|appimage|apk|aab|ipa|zip|7z)\b|\bdist\b|\/outputs\/|installer|setup)/i;
/** Problems in one workflow file's text: installers uploaded as artifacts, release publishing, electron-builder publishing, or the AppImage being mentioned in any publishing context. */
function findPublishRisks(name, text) {
  const out = [], lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    if (/upload-artifact/.test(line)) { const block = lines.slice(i, i + 14).join('\n').split(/\n\s*- (?:name|uses):/)[0]; if (INSTALLER.test(block.replace(/uses:\s*\S+/, ''))) out.push(`${name}:${i + 1} uploads something that looks like an installer or build output as an artifact`); }
    if (/gh\s+release\b|create-release|action-gh-release|softprops\/action-gh-release|ncipollo\/release-action|actions\/create-release/i.test(line)) out.push(`${name}:${i + 1} creates a release`);
    if (/--publish[ =]+(always|onTag|onTagOrDraft)\b|\bpublish:\s*(always|onTag)/i.test(line)) out.push(`${name}:${i + 1} lets electron-builder publish`);
    if (/gh\s+(pr|api)\b.*releases|npm\s+publish|twine\s+upload|eas\s+submit|fastlane\s+(deliver|pilot|supply)|altool|notarytool\s+submit|pushd?\s+.*\bgh-pages\b/i.test(line)) out.push(`${name}:${i + 1} publishes or submits a package`);
  });
  return out;
}
/** The AppImage must be named so it cannot be mistaken for a distributable file, and must keep an explicit sandbox argument. */
function findPackageRisks(pkg) {
  const out = [], a = pkg.build && pkg.build.appImage;
  if (!a || !/NOT-DISTRIBUTABLE/.test(a.artifactName || '')) out.push('the AppImage artifact name must contain NOT-DISTRIBUTABLE');
  if (!a || !Array.isArray(a.executableArgs) || !a.executableArgs.length) out.push('appImage.executableArgs must be a non-empty list (an empty one makes electron-builder substitute --no-sandbox)');
  else if (a.executableArgs.some((x) => /sandbox/i.test(x) && /^--(no-|disable-)/.test(x))) out.push('appImage.executableArgs disables the sandbox');
  if (pkg.build && pkg.build.publish) out.push('build.publish is set: electron-builder could publish');
  return out;
}
function main() {
  const root = path.resolve(__dirname, '..', '..'), files = [path.join(root, '.github', 'workflows'), path.join(root, 'qorlla-clients', 'deployment', 'github-actions')].flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(d, f)) : []));
  const problems = files.flatMap((f) => findPublishRisks(path.relative(root, f), fs.readFileSync(f, 'utf8')));
  problems.push(...findPackageRisks(JSON.parse(fs.readFileSync(path.join(root, 'qorlla-clients', 'apps', 'desktop', 'package.json'), 'utf8'))));
  console.log(`checked ${files.length} workflow file(s) and the desktop package configuration`); for (const p of problems) console.log('FAIL ' + p); console.log(problems.length ? 'RELEASE SAFETY CHECK FAILED' : 'release safety check passed: nothing publishes an installer and the AppImage is marked NOT-DISTRIBUTABLE');
  return problems.length ? 1 : 0;
}
module.exports = { findPublishRisks, findPackageRisks };
if (require.main === module) process.exit(main());
