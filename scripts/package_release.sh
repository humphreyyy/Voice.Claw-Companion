#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="VoiceClaw Companion"
EXECUTABLE_NAME="VoiceClawBridge"
DISPLAY_NAME="VoiceClaw Companion"
BUNDLE_ID="ai.voiceclaw.bridge"
VERSION="${VOICECLAW_BRIDGE_VERSION:-0.1.46}"
BUILD_NUMBER="${VOICECLAW_BRIDGE_BUILD:-$(date -u +%Y%m%d%H%M)}"
SPARKLE_FEED_URL="${VOICECLAW_SPARKLE_FEED_URL:-https://raw.githubusercontent.com/bdjben/Voice.Claw-Companion/main/appcast.xml}"
SPARKLE_PUBLIC_ED_KEY="${VOICECLAW_SPARKLE_PUBLIC_ED_KEY:-8W2Hfu+vPDKDjcFHcr3daoCiOStBTyJNc1X+UPpyqGo=}"
DIST_DIR="$ROOT_DIR/dist"
RELEASE_DIR="$DIST_DIR/release"
APP_DIR="$RELEASE_DIR/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
FRAMEWORKS_DIR="$CONTENTS_DIR/Frameworks"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
RUNTIME_DIR="$RESOURCES_DIR/BridgeRuntime"
RUNTIME_SOURCE_DIR="$ROOT_DIR/BridgeRuntime"
ZIP_PATH="$DIST_DIR/VoiceClawCompanion-$VERSION-$BUILD_NUMBER.zip"
DMG_PATH="$DIST_DIR/VoiceClawCompanion-$VERSION-$BUILD_NUMBER.dmg"
SIGN_IDENTITY="${DEVELOPER_ID_APPLICATION:-Developer ID Application: Benjamin Badejo (6VFF5BZWJU)}"

cd "$ROOT_DIR"
swift build -c release

rm -rf "$RELEASE_DIR" "$ZIP_PATH" "$DMG_PATH"
mkdir -p "$MACOS_DIR" "$FRAMEWORKS_DIR" "$RESOURCES_DIR" "$RUNTIME_DIR"

cp "$ROOT_DIR/.build/release/$EXECUTABLE_NAME" "$MACOS_DIR/$EXECUTABLE_NAME"

SPARKLE_FRAMEWORK="$ROOT_DIR/.build/release/Sparkle.framework"
if [[ ! -d "$SPARKLE_FRAMEWORK" ]]; then
  SPARKLE_FRAMEWORK="$ROOT_DIR/.build/arm64-apple-macosx/release/Sparkle.framework"
fi
if [[ ! -d "$SPARKLE_FRAMEWORK" ]]; then
  echo "Sparkle.framework was not found after swift build." >&2
  exit 1
fi
rsync -a --delete "$SPARKLE_FRAMEWORK/" "$FRAMEWORKS_DIR/Sparkle.framework/"
if ! otool -l "$MACOS_DIR/$EXECUTABLE_NAME" | grep -Fq "@executable_path/../Frameworks"; then
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$MACOS_DIR/$EXECUTABLE_NAME"
fi

cat > "$CONTENTS_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>$DISPLAY_NAME</string>
  <key>CFBundleExecutable</key>
  <string>$EXECUTABLE_NAME</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIconName</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$DISPLAY_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$VERSION</string>
  <key>CFBundleVersion</key>
  <string>$BUILD_NUMBER</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>SUEnableAutomaticChecks</key>
  <true/>
  <key>SUAutomaticallyUpdate</key>
  <true/>
  <key>SUFeedURL</key>
  <string>$SPARKLE_FEED_URL</string>
  <key>SUPublicEDKey</key>
  <string>$SPARKLE_PUBLIC_ED_KEY</string>
  <key>SUScheduledCheckInterval</key>
  <integer>21600</integer>
</dict>
</plist>
PLIST

ICON_SOURCE="$ROOT_DIR/Assets/AppIcon-1024.png"
if [[ -f "$ICON_SOURCE" ]]; then
  ICONSET="$RELEASE_DIR/AppIcon.iconset"
  mkdir -p "$ICONSET"
  sips -z 16 16 "$ICON_SOURCE" --out "$ICONSET/icon_16x16.png" >/dev/null
  sips -z 32 32 "$ICON_SOURCE" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
  sips -z 32 32 "$ICON_SOURCE" --out "$ICONSET/icon_32x32.png" >/dev/null
  sips -z 64 64 "$ICON_SOURCE" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
  sips -z 128 128 "$ICON_SOURCE" --out "$ICONSET/icon_128x128.png" >/dev/null
  sips -z 256 256 "$ICON_SOURCE" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
  sips -z 256 256 "$ICON_SOURCE" --out "$ICONSET/icon_256x256.png" >/dev/null
  sips -z 512 512 "$ICON_SOURCE" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
  sips -z 512 512 "$ICON_SOURCE" --out "$ICONSET/icon_512x512.png" >/dev/null
  cp "$ICON_SOURCE" "$ICONSET/icon_512x512@2x.png"
  iconutil -c icns "$ICONSET" -o "$RESOURCES_DIR/AppIcon.icns"
  rm -rf "$ICONSET"
fi

rsync -a --delete "$RUNTIME_SOURCE_DIR/" "$RUNTIME_DIR/"
(
  cd "$RUNTIME_DIR"
  npm ci --omit=dev --ignore-scripts
)

if security find-identity -v -p codesigning | grep -Fq "$SIGN_IDENTITY"; then
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$FRAMEWORKS_DIR/Sparkle.framework"
  codesign --force --deep --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP_DIR"
else
  echo "Developer ID identity not found; creating an ad-hoc signed app for local testing." >&2
  codesign --force --deep --sign - "$APP_DIR"
fi

codesign --verify --deep --strict --verbose=2 "$APP_DIR"
ditto -c -k --keepParent "$APP_DIR" "$ZIP_PATH"

DMG_STAGING="$RELEASE_DIR/dmg"
mkdir -p "$DMG_STAGING"
cp -R "$APP_DIR" "$DMG_STAGING/"
ln -s /Applications "$DMG_STAGING/Applications"
hdiutil create -volname "$DISPLAY_NAME" -srcfolder "$DMG_STAGING" -ov -format UDZO "$DMG_PATH" >/dev/null

if security find-identity -v -p codesigning | grep -Fq "$SIGN_IDENTITY"; then
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG_PATH"
fi

cat <<SUMMARY
Packaged $DISPLAY_NAME.
App: $APP_DIR
Zip: $ZIP_PATH
DMG: $DMG_PATH

For public GitHub releases, notarize the DMG before publishing:
  xcrun notarytool submit "$DMG_PATH" --key /path/to/AuthKey.p8 --key-id KEY_ID --issuer ISSUER_ID --wait
  xcrun stapler staple "$DMG_PATH"
SUMMARY
