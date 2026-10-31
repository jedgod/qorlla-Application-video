'use strict';
// The release-safety rules catch the dangerous patterns (negative tests) and the real configuration is clean.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { findPublishRisks, findPackageRisks } = require('./release-safety.cjs');

test('the repository as committed passes (nothing publishes an installer; the AppImage is marked NOT-DISTRIBUTABLE)', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'release-safety.cjs')], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stdout);
});
test('NEGATIVE: uploading an installer or build output as an artifact is caught', () => {
  for (const p of ['qorlla-clients/apps/desktop/dist/*.exe', 'dist/', 'build/outputs/apk/release/*.apk', '**/*.AppImage', 'out/Qorlla.dmg', 'qorlla.deb', 'app.aab', 'app.ipa'])
    assert.equal(findPublishRisks('w.yml', `      - uses: actions/upload-artifact@v4\n        with:\n          name: x\n          path: ${p}\n      - name: next\n        run: echo`).length, 1, p);
});
test('a test report uploaded as an artifact is not an installer', () => {
  assert.deepEqual(findPublishRisks('w.yml', '      - uses: actions/upload-artifact@v4\n        with:\n          name: playwright-execution-report\n          path: playwright-report/\n          retention-days: 30\n      - name: Teardown\n        run: docker compose down\n'), []);
});
test('NEGATIVE: creating a release, letting electron-builder publish, or submitting a package is caught', () => {
  assert.equal(findPublishRisks('w.yml', '        run: gh release create v1 dist/*.exe').length, 1);
  assert.equal(findPublishRisks('w.yml', '      - uses: softprops/action-gh-release@v2').length, 1);
  assert.equal(findPublishRisks('w.yml', '        run: npm run dist -- --publish always').length, 1);
  assert.equal(findPublishRisks('w.yml', '        run: npx eas submit --platform android').length, 1);
  assert.equal(findPublishRisks('w.yml', '        run: xcrun notarytool submit app.zip').length, 1);
  assert.deepEqual(findPublishRisks('w.yml', '        run: npm run dist -- --publish never\n        # gh release create is forbidden here\n'), [], 'a comment and an explicit "never" are not publishing');
});
test('NEGATIVE: the AppImage must stay marked, keep an explicit sandbox argument and not be publishable', () => {
  const good = { build: { appImage: { artifactName: 'qorlla-${version}-NOT-DISTRIBUTABLE.${ext}', executableArgs: ['--enable-sandbox'] } } };
  assert.deepEqual(findPackageRisks(good), []);
  assert.equal(findPackageRisks({ build: { appImage: { artifactName: 'qorlla-${version}.${ext}', executableArgs: ['--enable-sandbox'] } } }).length, 1);
  assert.equal(findPackageRisks({ build: { appImage: { artifactName: good.build.appImage.artifactName, executableArgs: [] } } }).length, 1, 'an empty list restores --no-sandbox');
  assert.equal(findPackageRisks({ build: { appImage: { artifactName: good.build.appImage.artifactName, executableArgs: ['--no-sandbox'] } } }).length, 1);
  assert.equal(findPackageRisks({ build: { ...good.build, publish: [{ provider: 'github' }] } }).length, 1);
  assert.equal(findPackageRisks({ build: {} }).length, 2);
});
