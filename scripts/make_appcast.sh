#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DMG_PATH="${1:-}"
VERSION="${VOICECLAW_BRIDGE_VERSION:-}"
FEED_URL="${VOICECLAW_SPARKLE_FEED_URL:-https://raw.githubusercontent.com/bdjben/Voice.Claw-Companion/main/appcast.xml}"
SPARKLE_ACCOUNT="${VOICECLAW_SPARKLE_ACCOUNT:-VoiceClaw Companion}"

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
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cp -f "$DMG_PATH" "$TMP_DIR/$DMG_NAME"
if [[ -f "$ROOT_DIR/appcast.xml" ]]; then
  cp -f "$ROOT_DIR/appcast.xml" "$TMP_DIR/appcast.xml"
fi

NOTES_HTML="$TMP_DIR/${DMG_NAME%.dmg}.html"
cat > "$NOTES_HTML" <<HTML
<h2>VoiceClaw Companion ${VERSION}</h2>
<ul>
  <li>Adds in-app Sparkle updates so users can install signed GitHub Release builds without manually downloading a DMG.</li>
  <li>Adds automatic update checks, automatic signed update install controls, and menu bar status indicators when updates are manual or available.</li>
</ul>
HTML

DOWNLOAD_URL_PREFIX="${VOICECLAW_SPARKLE_DOWNLOAD_URL_PREFIX:-https://github.com/bdjben/Voice.Claw-Companion/releases/download/v${VERSION}/}"

"$GENERATE_APPCAST" \
  --account "$SPARKLE_ACCOUNT" \
  --download-url-prefix "$DOWNLOAD_URL_PREFIX" \
  --embed-release-notes \
  --link "$FEED_URL" \
  "$TMP_DIR"

cp -f "$TMP_DIR/appcast.xml" "$ROOT_DIR/appcast.xml"
echo "Generated appcast.xml for $DMG_NAME."
