#!/usr/bin/env bash
set -euo pipefail
apk="${1:?Usage: verify-android.sh path/to/app.apk}"
sha256sum "$apk"
apksigner verify --verbose "$apk"
if ! command -v adb >/dev/null; then echo 'ADB unavailable; physical install not tested'; exit 2; fi
adb devices -l
printf 'Select an authorized device explicitly; no automatic installation is performed.\n'
printf 'Example: adb -s SERIAL install -r "%s"\n' "$apk"
