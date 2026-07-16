#!/usr/bin/env bash
# Build a release bundle and install it to /Applications, replacing any
# existing Zeigen install(s) first. This is the "upgrade" process — run it
# instead of manually building + copying, so a stale duplicate can't get
# left behind in /Applications.
set -euo pipefail

cd "$(dirname "$0")/.."

BUNDLE_ID="com.zeigen.app"
BUILT_APP="src-tauri/target/release/bundle/macos/Zeigen.app"
INSTALL_DIR="/Applications"

# The installed app is signed below with the "Zeigen Dev Signing"
# certificate (self-signed, in the login keychain), which gives every build
# the same code signing identity — so TCC permission grants (Screen
# Recording/Mic/Camera) survive upgrades and no reset is needed. If that
# certificate is ever missing, fail fast rather than silently producing an
# app with a fresh identity that orphans the grants.
if ! security find-identity -v -p codesigning | grep -q "Zeigen Dev Signing"; then
    echo "error: 'Zeigen Dev Signing' certificate not found in keychain." >&2
    echo "Recreate it (self-signed, code signing) or permissions will break on every build." >&2
    exit 1
fi

echo "==> Building release bundle"
# app bundle only — the dmg step scripts Finder and fails in non-interactive
# shells, and we install by copying the .app anyway
npm run tauri build -- --bundles app

if [ ! -d "$BUILT_APP" ]; then
    echo "error: expected build output at $BUILT_APP, not found" >&2
    exit 1
fi

# The executable inside the bundle is lowercase "zeigen" — that's the
# process name, so match it case-insensitively or the quit step never fires
# and the old instance keeps running through the install.
if pgrep -xqi "zeigen"; then
    echo "==> Quitting running Zeigen"
    osascript -e 'tell application "Zeigen" to quit' || true
    for _ in $(seq 1 20); do
        pgrep -xqi "zeigen" || break
        sleep 0.5
    done
    # AppleScript quit can fail (e.g. a stray process shadowing the bundle
    # id); don't install under a live instance.
    pkill -xi "zeigen" 2>/dev/null || true
    pkill -x "recording-engine" 2>/dev/null || true
    sleep 1
fi

echo "==> Removing existing installs"
for existing in "$INSTALL_DIR"/Zeigen*.app; do
    [ -d "$existing" ] || continue
    installed_id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$existing/Contents/Info.plist" 2>/dev/null || echo "")
    if [ "$installed_id" = "$BUNDLE_ID" ]; then
        echo "    removing $existing"
        rm -rf "$existing"
    else
        echo "    skipping $existing (bundle id '$installed_id' != $BUNDLE_ID)"
    fi
done

echo "==> Installing fresh build"
# ditto --noextattr: the project lives in iCloud-synced Documents, so build
# outputs carry file-provider xattrs (com.apple.provenance, com.apple.macl)
# that codesign rejects as "detritus". A clean copy is the only reliable way
# to shed them — com.apple.macl cannot be deleted in place.
ditto --norsrc --noextattr --noacl "$BUILT_APP" "$INSTALL_DIR/Zeigen.app"

echo "==> Signing with Zeigen Dev Signing"
# No hardened runtime (--options runtime): it blocks camera/mic access unless
# every binary carries device entitlements — getUserMedia in the webview fails
# with NotAllowedError and the engine's mic capture hangs. Hardened runtime is
# only required for notarization, which a locally-built app doesn't need.
# Nested sidecar binaries (Contents/MacOS/*) must be signed inside-out before
# the bundle, or --deep --strict rejects them. Both externalBin sidecars:
codesign --force -s "Zeigen Dev Signing" \
    "$INSTALL_DIR/Zeigen.app/Contents/MacOS/recording-engine"
codesign --force -s "Zeigen Dev Signing" \
    "$INSTALL_DIR/Zeigen.app/Contents/MacOS/cicompositor"
codesign --force -s "Zeigen Dev Signing" "$INSTALL_DIR/Zeigen.app"
codesign --verify --deep --strict "$INSTALL_DIR/Zeigen.app"

version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$INSTALL_DIR/Zeigen.app/Contents/Info.plist")
echo "==> Installed Zeigen $version to $INSTALL_DIR/Zeigen.app"
