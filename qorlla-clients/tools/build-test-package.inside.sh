#!/bin/bash
# Runs INSIDE the pinned builder container (started by build-test-package.cjs). The source arrives as a git archive of one exact commit, extracted to /w; nothing from a working tree is used.
# Builds the unsigned Debian package, verifies it, and writes the facts the package record needs to /out. Any failed check stops the build: a package that fails is never recorded.
set -euo pipefail
OUT=/out; mkdir -p "$OUT"
cd /w/qorlla-clients/apps/desktop
echo "== npm ci (lockfile install)"; npm ci --no-audit --no-fund > "$OUT/npm-ci.log" 2>&1
echo "== desktop unit tests"; node --test tests/*.test.cjs > "$OUT/desktop-tests.log" 2>&1
echo "== build the unsigned deb"; npx electron-builder --linux deb --x64 > "$OUT/builder.log" 2>&1
DEB=$(ls "$PWD"/dist/qorlla-*-amd64.deb); cp "$DEB" "$OUT/"
cd /w; rm -rf /tmp/x /tmp/ctl; mkdir -p /tmp/x; dpkg-deb -x "$DEB" /tmp/x; dpkg-deb -e "$DEB" /tmp/ctl; dpkg-deb -c "$DEB" > /tmp/contents.txt
echo "== verify: sandbox regression check (desktop entries and launchers), release safety, modes, maintainer scripts"
node qorlla-clients/e2e/linux-sandbox-check.cjs /tmp/x > "$OUT/sandbox-check.log" 2>&1
node qorlla-clients/e2e/release-safety.cjs > "$OUT/release-safety.log" 2>&1
grep -qE "^-rw-r--r-- 0/0 .* \./opt/Qorlla/resources/apparmor/qorlla$" /tmp/contents.txt || { echo "the AppArmor profile is not shipped as root-owned 0644"; exit 1; }
grep -qE "^-rwxr-xr-x 0/0 .* \./opt/Qorlla/chrome-sandbox$" /tmp/contents.txt || { echo "chrome-sandbox must be root-owned 0755 (not setuid)"; exit 1; }
! grep -qE "4755|chmod u\+s" /tmp/ctl/postinst /tmp/ctl/postrm || { echo "a maintainer script makes something setuid"; exit 1; }
grep -q "apparmor_parser --replace" /tmp/ctl/postinst && grep -qE "remove\|purge\)" /tmp/ctl/postrm || { echo "the AppArmor install or removal handling is missing"; exit 1; }
DESKTOP=$(grep -E " \./usr/share/applications/.*\.desktop$" /tmp/contents.txt | awk '{print $NF}' | head -1); EXEC=$(grep -E "^Exec=" /tmp/x/"$DESKTOP" | head -1)
node -e '
const fs = require("fs"), cp = require("child_process"), crypto = require("crypto");
const sh = (c) => cp.execSync(c, { encoding: "utf8" }).trim(), sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const deb = process.argv[1], osr = Object.fromEntries(fs.readFileSync("/etc/os-release", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.split("=")[0], l.split("=").slice(1).join("=").replace(/"/g, "")]));
const facts = {
  builder: { os: osr.PRETTY_NAME, node: process.version, npm: sh("npm -v"), electron: JSON.parse(fs.readFileSync("/w/qorlla-clients/apps/desktop/node_modules/electron/package.json")).version, electronBuilder: JSON.parse(fs.readFileSync("/w/qorlla-clients/apps/desktop/node_modules/electron-builder/package.json")).version, lockfileSha256: sha("/w/qorlla-clients/apps/desktop/package-lock.json") },
  package: { file: require("path").basename(deb), sizeBytes: fs.statSync(deb).size, sha256: sha(deb), dpkgVersion: sh("dpkg-deb -f " + deb + " Version"), dpkgDepends: sh("dpkg-deb -f " + deb + " Depends") },
  verification: { desktopTests: "passed", sandboxRegressionCheck: "passed", releaseSafetyCheck: "passed", chromeSandboxMode: "755", chromeSandboxOwner: "root", appArmorProfileMode: "644", setuidFree: true, appArmorProfileSha256: sha("/tmp/x/opt/Qorlla/resources/apparmor/qorlla"), postinstSha256: sha("/tmp/ctl/postinst"), postrmSha256: sha("/tmp/ctl/postrm"), desktopEntryExec: process.argv[2].replace(/^Exec=/, "") },
};
fs.writeFileSync("/out/facts.json", JSON.stringify(facts, null, 2) + "\n");
' "$DEB" "$EXEC"
echo "== built and verified: $(basename "$DEB")"; sha256sum "$DEB"
