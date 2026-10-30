#!/bin/bash
# Qorlla Debian package: after install / upgrade. Based on electron-builder's default script with ONE deliberate change: chrome-sandbox is never made setuid.
# (The default decided that by running `unshare --user` as root here, which succeeds even on Ubuntu 24.04 where the same call is refused to a normal user for an application without an AppArmor profile.)
# Placeholders in dollar-brace form are replaced by electron-builder; every other variable below is written without braces on purpose.

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Chromium uses its user-namespace sandbox. The setuid helper is NOT enabled: it stays root-owned and not setuid.
chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true

# AppArmor (Ubuntu 24.04+): install the profile for this executable and load it now. Skipped, with a message, where AppArmor 4 is not present
# (older releases do not restrict user namespaces and need no profile). A load failure does not fail the installation but is reported loudly.
PROFILE_SRC='/opt/${sanitizedProductName}/resources/apparmor/qorlla'
PROFILE_DST='/etc/apparmor.d/qorlla'
if [ -f "$PROFILE_SRC" ]; then
    if [ -d /etc/apparmor.d ] && [ -e /etc/apparmor.d/abi/4.0 ] && command -v apparmor_parser >/dev/null 2>&1; then
        install -m 0644 "$PROFILE_SRC" "$PROFILE_DST"
        if apparmor_parser --replace --write-cache "$PROFILE_DST"; then
            echo "Qorlla: AppArmor profile loaded."
        else
            echo "Qorlla: WARNING: the AppArmor profile could not be loaded. On Ubuntu 24.04 and later Qorlla will refuse to start because its sandbox is unavailable." >&2
        fi
    else
        echo "Qorlla: AppArmor 4 not available here; no profile installed (not needed where unprivileged user namespaces are unrestricted)."
    fi
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
