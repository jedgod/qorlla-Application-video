#!/bin/bash
# Qorlla Debian package: after remove / purge / upgrade. $1 is the maintainer-script action (remove, purge, upgrade, failed-upgrade, ...).

# Delete the link to the binary (unchanged from electron-builder's default)
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/usr/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

# AppArmor: take the profile out ONLY when the package is really going away. On an upgrade the new version's install script replaces it.
case "$1" in
    remove|purge)
        if [ -f /etc/apparmor.d/qorlla ]; then
            if command -v apparmor_parser >/dev/null 2>&1; then
                apparmor_parser --remove /etc/apparmor.d/qorlla || true
            fi
            rm -f /etc/apparmor.d/qorlla
            rm -f /var/cache/apparmor/*/qorlla 2>/dev/null || true
        fi
        ;;
esac
