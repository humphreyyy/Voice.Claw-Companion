#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="VoiceClaw Companion"
EXECUTABLE_NAME="VoiceClawBridge"
DISPLAY_NAME="VoiceClaw Companion"
BUNDLE_ID="ai.voiceclaw.bridge"
VERSION="${VOICECLAW_BRIDGE_VERSION:-}"
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
RELEASE_MODE="${VOICECLAW_RELEASE_MODE:-public}"
NOTARY_PROFILE="${VOICECLAW_NOTARY_PROFILE:-VoiceClaw Companion}"

version_gt() {
  local left="$1" right="$2" i
  IFS='.' read -r -a left_parts <<< "$left"
  IFS='.' read -r -a right_parts <<< "$right"
  local count="${#left_parts[@]}"
  if (( ${#right_parts[@]} > count )); then count="${#right_parts[@]}"; fi
  for ((i = 0; i < count; i += 1)); do
    local l="${left_parts[$i]:-0}"
    local r="${right_parts[$i]:-0}"
    if ((10#$l > 10#$r)); then return 0; fi
    if ((10#$l < 10#$r)); then return 1; fi
  done
  return 1
}

numeric_gt() {
  local left="$1" right="$2"
  [[ "$left" =~ ^[0-9]+$ ]] || return 1
  [[ "$right" =~ ^[0-9]+$ ]] || return 1
  [[ "$left" -gt "$right" ]]
}

latest_appcast_info() {
  /usr/bin/python3 - <<'PY'
import pathlib
import xml.etree.ElementTree as ET
path = pathlib.Path("appcast.xml")
if not path.exists():
    raise SystemExit(0)
root = ET.parse(path).getroot()
ns = {"sparkle": "http://www.andymatuschak.org/xml-namespaces/sparkle"}
item = root.find("./channel/item")
if item is None:
    raise SystemExit(0)
version = item.findtext("sparkle:shortVersionString", namespaces=ns) or item.findtext("title") or ""
build = item.findtext("sparkle:version", namespaces=ns) or ""
print(version.strip() + "\t" + build.strip())
PY
}

installed_companion_info() {
  local installed_app="/Applications/$APP_NAME.app"
  local info_plist="$installed_app/Contents/Info.plist"
  if [[ ! -f "$info_plist" ]]; then
    return 0
  fi
  /usr/bin/python3 - "$info_plist" <<'PY'
import plistlib
import sys
with open(sys.argv[1], "rb") as handle:
    info = plistlib.load(handle)
print(str(info.get("CFBundleShortVersionString", "")).strip() + "\t" + str(info.get("CFBundleVersion", "")).strip())
PY
}

if [[ -z "$VERSION" ]]; then
  echo "VOICECLAW_BRIDGE_VERSION must be set explicitly for packaging." >&2
  echo "Example: VOICECLAW_BRIDGE_VERSION=0.1.91 VOICECLAW_BRIDGE_BUILD=$BUILD_NUMBER scripts/package_release.sh" >&2
  exit 1
fi

if [[ ! "$BUILD_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "VOICECLAW_BRIDGE_BUILD must be numeric for Sparkle monotonic comparison; got '$BUILD_NUMBER'." >&2
  exit 1
fi

LATEST_VERSION=""
LATEST_BUILD=""
LATEST_INFO="$(latest_appcast_info || true)"
if [[ -n "$LATEST_INFO" ]]; then
  LATEST_VERSION="${LATEST_INFO%%$'\t'*}"
  LATEST_BUILD="${LATEST_INFO#*$'\t'}"
fi

INSTALLED_VERSION=""
INSTALLED_BUILD=""
INSTALLED_INFO="$(installed_companion_info || true)"
if [[ -n "$INSTALLED_INFO" ]]; then
  INSTALLED_VERSION="${INSTALLED_INFO%%$'\t'*}"
  INSTALLED_BUILD="${INSTALLED_INFO#*$'\t'}"
fi

if [[ "$RELEASE_MODE" == "public" ]]; then
  if [[ -n "$LATEST_VERSION" ]] && ! version_gt "$VERSION" "$LATEST_VERSION"; then
    echo "Refusing to package public release $VERSION because appcast latest short version is $LATEST_VERSION." >&2
    echo "Set VOICECLAW_RELEASE_MODE=local only for explicit non-public test packaging." >&2
    exit 1
  fi
  if [[ -n "$LATEST_BUILD" ]] && ! numeric_gt "$BUILD_NUMBER" "$LATEST_BUILD"; then
    echo "Refusing to package public release $VERSION build $BUILD_NUMBER because appcast latest Sparkle build is $LATEST_BUILD." >&2
    echo "Sparkle compares CFBundleVersion/sparkle:version; build numbers must always increase." >&2
    exit 1
  fi
  if [[ -n "$INSTALLED_BUILD" ]] && ! numeric_gt "$BUILD_NUMBER" "$INSTALLED_BUILD"; then
    echo "Refusing to package public release $VERSION build $BUILD_NUMBER because /Applications/$APP_NAME.app is $INSTALLED_VERSION build $INSTALLED_BUILD." >&2
    echo "A published Sparkle update must be newer than the installed app's CFBundleVersion, even if its short version is newer." >&2
    exit 1
  fi
fi

cd "$ROOT_DIR"
node "$ROOT_DIR/scripts/check_runtime_contract.mjs"
(
  cd "$RUNTIME_SOURCE_DIR"
  npm run check
)
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
SPARKLE_BUNDLE="$FRAMEWORKS_DIR/Sparkle.framework"
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
for required_sparkle_path in "${REQUIRED_SPARKLE_PATHS[@]}"; do
  if [[ ! -e "$required_sparkle_path" ]]; then
    echo "Required Sparkle updater helper is missing or points to a missing target: $required_sparkle_path" >&2
    echo "Refusing to package an app whose in-app updater cannot launch the installer." >&2
    exit 1
  fi
done
for required_sparkle_executable in "${REQUIRED_SPARKLE_EXECUTABLES[@]}"; do
  if [[ ! -x "$required_sparkle_executable" ]]; then
    echo "Required Sparkle updater executable is missing or not executable: $required_sparkle_executable" >&2
    echo "Refusing to package an app whose in-app updater cannot launch the installer." >&2
    exit 1
  fi
done
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
  <key>NSDesktopFolderUsageDescription</key>
  <string>VoiceClaw Companion may need access to folders you choose so OpenClaw or Hermes Agent routes can work with files you ask the agent to inspect or edit.</string>
  <key>NSDocumentsFolderUsageDescription</key>
  <string>VoiceClaw Companion may need access to folders you choose so OpenClaw or Hermes Agent routes can work with documents you ask the agent to inspect or edit.</string>
  <key>NSDownloadsFolderUsageDescription</key>
  <string>VoiceClaw Companion downloads signed updates and may access downloaded files only when you choose or open them.</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSLocalNetworkUsageDescription</key>
  <string>VoiceClaw Companion runs a local bridge so your paired iPhone and Apple Watch can reach this Mac on your private network.</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>VoiceClaw Companion may use the microphone for local voice diagnostics or Mac-side voice capture when you explicitly start those features.</string>
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
  <integer>1800</integer>
</dict>
</plist>
PLIST

cp "$ROOT_DIR/PrivacyInfo.xcprivacy" "$RESOURCES_DIR/PrivacyInfo.xcprivacy"

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
  if ! iconutil -c icns "$ICONSET" -o "$RESOURCES_DIR/AppIcon.icns"; then
    FALLBACK_ICON_SOURCE=""
    if [[ -f "$ROOT_DIR/Assets/AppIcon.icns" ]]; then
      FALLBACK_ICON_SOURCE="$ROOT_DIR/Assets/AppIcon.icns"
    elif [[ -f "/Applications/$APP_NAME.app/Contents/Resources/AppIcon.icns" ]]; then
      FALLBACK_ICON_SOURCE="/Applications/$APP_NAME.app/Contents/Resources/AppIcon.icns"
    fi
    if [[ -n "$FALLBACK_ICON_SOURCE" ]]; then
      echo "iconutil rejected the generated iconset; using fallback icon $FALLBACK_ICON_SOURCE." >&2
      cp "$FALLBACK_ICON_SOURCE" "$RESOURCES_DIR/AppIcon.icns"
    else
      echo "iconutil rejected the generated iconset and no fallback AppIcon.icns was available." >&2
      exit 1
    fi
  fi
  rm -rf "$ICONSET"
fi

rsync -a --delete \
  --exclude 'node_modules/' \
  --exclude 'ops-node/' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '*.log' \
  --exclude '*.jsonl' \
  --exclude '*.sqlite' \
  "$RUNTIME_SOURCE_DIR/" "$RUNTIME_DIR/"
(
  cd "$RUNTIME_DIR"
  npm ci --omit=dev --ignore-scripts
  node scripts/check-runtime-imports.mjs
  node scripts/check-realtime-prompts.mjs
)

/usr/bin/python3 - "$RUNTIME_DIR" "$VERSION" "$BUILD_NUMBER" <<'PY'
import hashlib
import json
import pathlib
import subprocess
import sys
from datetime import datetime, timezone

runtime_dir = pathlib.Path(sys.argv[1])
version = sys.argv[2]
build = sys.argv[3]

package_path = runtime_dir / "package.json"
try:
    package = json.loads(package_path.read_text())
except Exception:
    package = {}

source_commit = ""
try:
    source_commit = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], text=True).strip()
except Exception:
    pass

excluded_dirs = {"node_modules", "ops-node", ".git"}
excluded_names = {"runtime-manifest.json", ".DS_Store"}
included_roots = {"server", "scripts", "client"}
included_files = {"package.json", "package-lock.json"}

digest = hashlib.sha256()
for path in sorted(runtime_dir.rglob("*")):
    if not path.is_file():
        continue
    relative = path.relative_to(runtime_dir)
    parts = set(relative.parts)
    if parts & excluded_dirs:
        continue
    if path.name in excluded_names:
        continue
    if relative.parts[0] not in included_roots and str(relative) not in included_files:
        continue
    rel_text = relative.as_posix()
    digest.update(rel_text.encode("utf-8"))
    digest.update(b"\0")
    digest.update(path.read_bytes())
    digest.update(b"\0")

manifest = {
    "schema": 1,
    "product": "VoiceClaw Companion",
    "version": version,
    "build": build,
    "runtimePackageVersion": str(package.get("version", "")),
    "runtimeHash": digest.hexdigest(),
    "entryPoint": "server/index.js",
    "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "sourceCommit": source_commit,
}
(runtime_dir / "runtime-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(f"Generated runtime manifest {manifest['runtimeHash']} for {version} ({build}).")
PY

if security find-identity -v -p codesigning | grep -Fq "$SIGN_IDENTITY"; then
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$FRAMEWORKS_DIR/Sparkle.framework"
  codesign --force --deep --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP_DIR"
elif [[ "$RELEASE_MODE" == "local" ]]; then
  echo "Developer ID identity not found; creating an explicit local-only ad-hoc signed app." >&2
  codesign --force --deep --sign - "$APP_DIR"
else
  echo "Developer ID identity not found: $SIGN_IDENTITY" >&2
  echo "Refusing to create a public-looking Companion release without Developer ID signing." >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$APP_DIR"
"$ROOT_DIR/scripts/verify_companion_app.sh" "$APP_DIR"
ditto -c -k --keepParent "$APP_DIR" "$ZIP_PATH"

DMG_STAGING="$RELEASE_DIR/dmg"
mkdir -p "$DMG_STAGING"
cp -R "$APP_DIR" "$DMG_STAGING/"
ln -s /Applications "$DMG_STAGING/Applications"
hdiutil create -volname "$DISPLAY_NAME" -srcfolder "$DMG_STAGING" -ov -format UDZO "$DMG_PATH" >/dev/null

if security find-identity -v -p codesigning | grep -Fq "$SIGN_IDENTITY"; then
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG_PATH"
fi

if [[ "$RELEASE_MODE" == "public" ]]; then
  xcrun notarytool submit "$DMG_PATH" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG_PATH"
  spctl -a -vv --type execute "$APP_DIR"
  spctl -a -vv -t open --context context:primary-signature "$DMG_PATH"
else
  echo "Skipping notarization because VOICECLAW_RELEASE_MODE=$RELEASE_MODE." >&2
fi

cat <<SUMMARY
Packaged $DISPLAY_NAME.
App: $APP_DIR
Zip: $ZIP_PATH
DMG: $DMG_PATH
Release mode: $RELEASE_MODE
SUMMARY
