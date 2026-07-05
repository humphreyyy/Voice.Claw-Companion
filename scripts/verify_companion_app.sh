#!/usr/bin/env bash
set -euo pipefail

APP_PATH="${1:-}"
EXPECTED_BUNDLE_ID="${VOICECLAW_EXPECTED_BUNDLE_ID:-ai.voiceclaw.bridge}"

fail() {
  echo "VoiceClaw Companion app verification failed: $*" >&2
  exit 1
}

require_path() {
  local path="$1"
  [[ -e "$path" ]] || fail "missing path or dangling symlink: $path"
}

require_executable() {
  local path="$1"
  [[ -x "$path" ]] || fail "missing executable or not executable: $path"
}

plist_value() {
  local plist="$1"
  local key="$2"
  /usr/libexec/PlistBuddy -c "Print :$key" "$plist" 2>/dev/null || true
}

[[ -n "$APP_PATH" ]] || fail "usage: scripts/verify_companion_app.sh /path/to/VoiceClaw\\ Companion.app"
[[ -d "$APP_PATH" ]] || fail "app bundle does not exist: $APP_PATH"
[[ "$APP_PATH" == *.app ]] || fail "path is not an .app bundle: $APP_PATH"

CONTENTS_DIR="$APP_PATH/Contents"
INFO_PLIST="$CONTENTS_DIR/Info.plist"
require_path "$INFO_PLIST"

BUNDLE_ID="$(plist_value "$INFO_PLIST" CFBundleIdentifier)"
[[ "$BUNDLE_ID" == "$EXPECTED_BUNDLE_ID" ]] || fail "unexpected bundle id: ${BUNDLE_ID:-missing}"

BUNDLE_VERSION="$(plist_value "$INFO_PLIST" CFBundleVersion)"
SHORT_VERSION="$(plist_value "$INFO_PLIST" CFBundleShortVersionString)"
EXECUTABLE_NAME="$(plist_value "$INFO_PLIST" CFBundleExecutable)"
SPARKLE_FEED_URL="$(plist_value "$INFO_PLIST" SUFeedURL)"
SPARKLE_PUBLIC_KEY="$(plist_value "$INFO_PLIST" SUPublicEDKey)"
SPARKLE_AUTOMATIC_CHECKS="$(plist_value "$INFO_PLIST" SUEnableAutomaticChecks)"
SPARKLE_AUTOMATIC_UPDATES="$(plist_value "$INFO_PLIST" SUAutomaticallyUpdate)"

[[ -n "$BUNDLE_VERSION" ]] || fail "CFBundleVersion is missing"
[[ -n "$SHORT_VERSION" ]] || fail "CFBundleShortVersionString is missing"
[[ -n "$EXECUTABLE_NAME" ]] || fail "CFBundleExecutable is missing"
[[ "$SPARKLE_FEED_URL" == https://* ]] || fail "SUFeedURL is missing or not https: ${SPARKLE_FEED_URL:-missing}"
[[ -n "$SPARKLE_PUBLIC_KEY" ]] || fail "SUPublicEDKey is missing"
[[ "$SPARKLE_AUTOMATIC_CHECKS" == "true" ]] || fail "SUEnableAutomaticChecks is not true"
[[ "$SPARKLE_AUTOMATIC_UPDATES" == "true" ]] || fail "SUAutomaticallyUpdate is not true"

MAIN_EXECUTABLE="$CONTENTS_DIR/MacOS/$EXECUTABLE_NAME"
require_executable "$MAIN_EXECUTABLE"

SPARKLE_BUNDLE="$CONTENTS_DIR/Frameworks/Sparkle.framework"
require_path "$SPARKLE_BUNDLE"

REQUIRED_SPARKLE_PATHS=(
  "$SPARKLE_BUNDLE/Versions/Current/Autoupdate"
  "$SPARKLE_BUNDLE/Versions/Current/Updater.app"
  "$SPARKLE_BUNDLE/Versions/Current/XPCServices/Downloader.xpc"
  "$SPARKLE_BUNDLE/Versions/Current/XPCServices/Installer.xpc"
  "$SPARKLE_BUNDLE/Autoupdate"
  "$SPARKLE_BUNDLE/Updater.app"
  "$SPARKLE_BUNDLE/XPCServices/Downloader.xpc"
  "$SPARKLE_BUNDLE/XPCServices/Installer.xpc"
)

REQUIRED_SPARKLE_EXECUTABLES=(
  "$SPARKLE_BUNDLE/Versions/Current/Autoupdate"
  "$SPARKLE_BUNDLE/Versions/Current/Updater.app/Contents/MacOS/Updater"
  "$SPARKLE_BUNDLE/Versions/Current/XPCServices/Downloader.xpc/Contents/MacOS/Downloader"
  "$SPARKLE_BUNDLE/Versions/Current/XPCServices/Installer.xpc/Contents/MacOS/Installer"
)

for required_path in "${REQUIRED_SPARKLE_PATHS[@]}"; do
  require_path "$required_path"
done

for required_executable in "${REQUIRED_SPARKLE_EXECUTABLES[@]}"; do
  require_executable "$required_executable"
done

codesign --verify --deep --strict --verbose=2 "$SPARKLE_BUNDLE"
codesign --verify --deep --strict --verbose=2 "$SPARKLE_BUNDLE/Versions/Current/Updater.app"
codesign --verify --deep --strict --verbose=2 "$SPARKLE_BUNDLE/Versions/Current/XPCServices/Downloader.xpc"
codesign --verify --deep --strict --verbose=2 "$SPARKLE_BUNDLE/Versions/Current/XPCServices/Installer.xpc"
codesign --verify --strict --verbose=2 "$SPARKLE_BUNDLE/Versions/Current/Autoupdate"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

echo "VoiceClaw Companion app verification passed: $SHORT_VERSION ($BUNDLE_VERSION)"
