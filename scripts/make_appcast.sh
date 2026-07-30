#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DMG_PATH="${1:-}"
VERSION="${VOICECLAW_BRIDGE_VERSION:-}"
FEED_URL="${VOICECLAW_SPARKLE_FEED_URL:-https://github.com/bdjben/Voice.Claw-Companion/releases/latest/download/appcast.xml}"
SPARKLE_ACCOUNT="${VOICECLAW_SPARKLE_ACCOUNT:-VoiceClaw Companion}"
APP_NAME="VoiceClaw Companion"

if [[ -z "$DMG_PATH" ]]; then
  echo "Usage: scripts/make_appcast.sh dist/VoiceClawCompanion-<version>-<build>.dmg" >&2
  exit 1
fi
if [[ ! -f "$DMG_PATH" ]]; then
  echo "DMG not found: $DMG_PATH" >&2
  exit 1
fi

DMG_DIR="$(cd "$(dirname "$DMG_PATH")" && pwd)"
DMG_NAME="$(basename "$DMG_PATH")"
if [[ -z "$VERSION" ]]; then
  if [[ "$DMG_NAME" =~ ^VoiceClawCompanion-([0-9]+(\.[0-9]+){1,3})-[0-9]+\.dmg$ ]]; then
    VERSION="${BASH_REMATCH[1]}"
  else
    echo "Could not infer version from $DMG_NAME; set VOICECLAW_BRIDGE_VERSION." >&2
    exit 1
  fi
fi

GENERATE_APPCAST="$ROOT_DIR/.build/artifacts/sparkle/Sparkle/bin/generate_appcast"
if [[ ! -x "$GENERATE_APPCAST" ]]; then
  GENERATE_APPCAST="$(find "$ROOT_DIR/.build" -type f -path "*/artifacts/sparkle/Sparkle/bin/generate_appcast" -print -quit 2>/dev/null || true)"
fi
if [[ -z "$GENERATE_APPCAST" || ! -x "$GENERATE_APPCAST" ]]; then
  echo "Sparkle generate_appcast was not found. Run swift build first." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
DMG_MOUNT=""
cleanup() {
  if [[ -n "$DMG_MOUNT" && -d "$DMG_MOUNT" ]]; then
    hdiutil detach "$DMG_MOUNT" -quiet || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cp -f "$DMG_PATH" "$TMP_DIR/$DMG_NAME"
if [[ -f "$ROOT_DIR/appcast.xml" ]]; then
  cp -f "$ROOT_DIR/appcast.xml" "$TMP_DIR/appcast.xml"
fi

NOTES_HTML="$TMP_DIR/${DMG_NAME%.dmg}.html"
if [[ -n "${VOICECLAW_SPARKLE_RELEASE_NOTES_HTML:-}" ]]; then
  printf '%s\n' "$VOICECLAW_SPARKLE_RELEASE_NOTES_HTML" > "$NOTES_HTML"
else
  cat > "$NOTES_HTML" <<HTML
<h2>VoiceClaw Companion ${VERSION}</h2>
<ul>
  <li>Includes the latest VoiceClaw Companion improvements.</li>
</ul>
HTML
fi

DOWNLOAD_URL_PREFIX="${VOICECLAW_SPARKLE_DOWNLOAD_URL_PREFIX:-https://github.com/bdjben/Voice.Claw-Companion/releases/download/v${VERSION}/}"

"$GENERATE_APPCAST" \
  --account "$SPARKLE_ACCOUNT" \
  --download-url-prefix "$DOWNLOAD_URL_PREFIX" \
  --embed-release-notes \
  --link "$FEED_URL" \
  "$TMP_DIR"

cp -f "$TMP_DIR/appcast.xml" "$ROOT_DIR/appcast.xml"

DMG_MOUNT="$TMP_DIR/mount"
mkdir -p "$DMG_MOUNT"
hdiutil attach "$DMG_PATH" -readonly -nobrowse -mountpoint "$DMG_MOUNT" -quiet
APP_INFO="$DMG_MOUNT/$APP_NAME.app/Contents/Info.plist"
if [[ ! -f "$APP_INFO" ]]; then
  echo "Could not find $APP_NAME.app Info.plist inside $DMG_PATH; refusing to publish unchecked appcast." >&2
  exit 1
fi

/usr/bin/python3 - "$ROOT_DIR/appcast.xml" "$APP_INFO" "$DMG_NAME" "$DMG_PATH" <<'PY'
import pathlib
import plistlib
import sys
import xml.etree.ElementTree as ET

appcast_path = pathlib.Path(sys.argv[1])
info_path = pathlib.Path(sys.argv[2])
dmg_name = sys.argv[3]
dmg_path = pathlib.Path(sys.argv[4])

with info_path.open("rb") as handle:
    info = plistlib.load(handle)
bundle_short = str(info.get("CFBundleShortVersionString", "")).strip()
bundle_build = str(info.get("CFBundleVersion", "")).strip()

root = ET.parse(appcast_path).getroot()
ns = {"sparkle": "http://www.andymatuschak.org/xml-namespaces/sparkle"}
item = root.find("./channel/item")
if item is None:
    raise SystemExit("appcast.xml does not contain a channel/item")
short = (item.findtext("sparkle:shortVersionString", namespaces=ns) or "").strip()
build = (item.findtext("sparkle:version", namespaces=ns) or "").strip()
enclosure = item.find("enclosure")
if enclosure is None:
    raise SystemExit("appcast.xml latest item has no enclosure")
url = enclosure.attrib.get("url", "")
length = enclosure.attrib.get("length", "")
signature = enclosure.attrib.get("{http://www.andymatuschak.org/xml-namespaces/sparkle}edSignature", "")
expected_length = str(dmg_path.stat().st_size)
errors = []
if short != bundle_short:
    errors.append(f"appcast shortVersion {short!r} does not match DMG bundle {bundle_short!r}")
if build != bundle_build:
    errors.append(f"appcast sparkle:version {build!r} does not match DMG CFBundleVersion {bundle_build!r}")
if dmg_name not in url:
    errors.append(f"appcast enclosure URL does not point at {dmg_name}: {url}")
if length != expected_length:
    errors.append(f"appcast enclosure length {length!r} does not match DMG size {expected_length!r}")
if not signature:
    errors.append("appcast enclosure is missing Sparkle EdDSA signature")
if errors:
    raise SystemExit("\n".join(errors))
print(f"Verified appcast {short} ({build}) matches {dmg_name}.")
PY

echo "Generated appcast.xml for $DMG_NAME."
