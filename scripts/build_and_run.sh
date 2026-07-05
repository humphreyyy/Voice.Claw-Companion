#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="VoiceClaw Companion"
EXECUTABLE_NAME="VoiceClawBridge"
BUNDLE_DIR="$ROOT_DIR/dist/$APP_NAME.app"
EXECUTABLE="$ROOT_DIR/.build/debug/$EXECUTABLE_NAME"
RUNTIME_DIR="$ROOT_DIR/BridgeRuntime"

killall "$EXECUTABLE_NAME" >/dev/null 2>&1 || true

cd "$ROOT_DIR"
swift build

rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR/Contents/MacOS" "$BUNDLE_DIR/Contents/Frameworks" "$BUNDLE_DIR/Contents/Resources"
cp "$EXECUTABLE" "$BUNDLE_DIR/Contents/MacOS/$EXECUTABLE_NAME"

SPARKLE_FRAMEWORK="$ROOT_DIR/.build/debug/Sparkle.framework"
if [[ ! -d "$SPARKLE_FRAMEWORK" ]]; then
  SPARKLE_FRAMEWORK="$ROOT_DIR/.build/arm64-apple-macosx/debug/Sparkle.framework"
fi
if [[ ! -d "$SPARKLE_FRAMEWORK" ]]; then
  echo "Sparkle.framework was not found after swift build." >&2
  exit 1
fi
rsync -a --delete "$SPARKLE_FRAMEWORK/" "$BUNDLE_DIR/Contents/Frameworks/Sparkle.framework/"
if ! otool -l "$BUNDLE_DIR/Contents/MacOS/$EXECUTABLE_NAME" | grep -Fq "@executable_path/../Frameworks"; then
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$BUNDLE_DIR/Contents/MacOS/$EXECUTABLE_NAME"
fi

cat > "$BUNDLE_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>$EXECUTABLE_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>ai.voiceclaw.bridge</string>
  <key>CFBundleName</key>
  <string>VoiceClaw Companion</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSDesktopFolderUsageDescription</key>
  <string>VoiceClaw Companion may need access to folders you choose so OpenClaw or Hermes Agent routes can work with files you ask the agent to inspect or edit.</string>
  <key>NSDocumentsFolderUsageDescription</key>
  <string>VoiceClaw Companion may need access to folders you choose so OpenClaw or Hermes Agent routes can work with documents you ask the agent to inspect or edit.</string>
  <key>NSDownloadsFolderUsageDescription</key>
  <string>VoiceClaw Companion downloads signed updates and may access downloaded files only when you choose or open them.</string>
  <key>NSLocalNetworkUsageDescription</key>
  <string>VoiceClaw Companion runs a local bridge so your paired iPhone and Apple Watch can reach this Mac on your private network.</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>VoiceClaw Companion may use the microphone for local voice diagnostics or Mac-side voice capture when you explicitly start those features.</string>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST

cp "$ROOT_DIR/PrivacyInfo.xcprivacy" "$BUNDLE_DIR/Contents/Resources/PrivacyInfo.xcprivacy"

codesign --force --deep --sign - "$BUNDLE_DIR" >/dev/null

VOICECLAW_BRIDGE_ROOT="$RUNTIME_DIR" /usr/bin/open -n "$BUNDLE_DIR"

if [[ "${1:-}" == "--verify" ]]; then
  sleep 4
  pgrep -x "$EXECUTABLE_NAME" >/dev/null
  echo "$APP_NAME launched"
fi
