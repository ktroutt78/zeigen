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

echo "==> Building release bundle"
npm run tauri build

if [ ! -d "$BUILT_APP" ]; then
    echo "error: expected build output at $BUILT_APP, not found" >&2
    exit 1
fi

if pgrep -x "Zeigen" > /dev/null; then
    echo "==> Quitting running Zeigen"
    osascript -e 'tell application "Zeigen" to quit' || true
    for _ in $(seq 1 20); do
        pgrep -x "Zeigen" > /dev/null || break
        sleep 0.5
    done
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
cp -R "$BUILT_APP" "$INSTALL_DIR/Zeigen.app"
xattr -dr com.apple.quarantine "$INSTALL_DIR/Zeigen.app" 2>/dev/null || true

version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$INSTALL_DIR/Zeigen.app/Contents/Info.plist")
echo "==> Installed Zeigen $version to $INSTALL_DIR/Zeigen.app"
