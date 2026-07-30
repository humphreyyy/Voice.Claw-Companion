#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /path/to/voiceclaw-companion.deb" >&2
  exit 2
fi

PACKAGE=$1
if [ ! -f "$PACKAGE" ]; then
  echo "Package not found: $PACKAGE" >&2
  exit 2
fi

dpkg-deb --info "$PACKAGE"
dpkg-deb --contents "$PACKAGE"

VERIFY_ROOT=$(mktemp -d)
trap 'rm -rf "$VERIFY_ROOT"' EXIT HUP INT TERM
dpkg-deb --extract "$PACKAGE" "$VERIFY_ROOT"

for REQUIRED_PATH in \
  "/opt/VoiceClaw Companion/voiceclaw-companion" \
  "/opt/VoiceClaw Companion/resources/BridgeRuntime/package.json" \
  "/opt/VoiceClaw Companion/resources/BridgeRuntime/runtime-manifest.json" \
  "/opt/VoiceClaw Companion/resources/BridgeRuntime/server/index.js" \
  "/opt/VoiceClaw Companion/resources/BridgeRuntime/node_modules/ws/package.json" \
  "/opt/VoiceClaw Companion/resources/BridgeRuntime/node_modules/json5/package.json" \
  "/opt/VoiceClaw Companion/resources/BridgeRuntime/node_modules/@openclaw/gateway-client/package.json" \
  "/opt/VoiceClaw Companion/resources/service/bridge-entry.mjs" \
  "/usr/share/applications/voiceclaw-companion.desktop"
do
  if [ ! -e "$VERIFY_ROOT$REQUIRED_PATH" ]; then
    echo "Required package path is missing: $REQUIRED_PATH" >&2
    exit 1
  fi
done

node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (manifest.product !== "VoiceClaw Companion") {
    throw new Error("Packaged runtime product is invalid.");
  }
  if (manifest.entryPoint !== "server/index.js") {
    throw new Error("Packaged runtime entry point is invalid.");
  }
  if (!/^[a-f0-9]{64}$/.test(String(manifest.runtimeHash || ""))) {
    throw new Error("Packaged runtime hash is invalid.");
  }
  console.log(`[voiceclaw-package] verified runtime ${manifest.runtimeHash}`);
' "$VERIFY_ROOT/opt/VoiceClaw Companion/resources/BridgeRuntime/runtime-manifest.json"
