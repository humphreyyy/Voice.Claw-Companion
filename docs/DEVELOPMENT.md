# VoiceClaw Companion Development Notes

These notes are kept out of the repository landing page so the README can stay focused on users installing and troubleshooting the Companion app.

## Local Build

```sh
swift build
./scripts/build_and_run.sh
```

## Runtime Checks

```sh
cd BridgeRuntime
npm install
npm run check
```

## Release Packaging

Package a GitHub release artifact:

```sh
./scripts/package_release.sh
```

For public releases, set both `VOICECLAW_BRIDGE_VERSION` and a strictly
monotonic numeric `VOICECLAW_BRIDGE_BUILD`. Sparkle compares
`CFBundleVersion` / `sparkle:version`, not only the visible
`CFBundleShortVersionString`. The packaging script refuses to build a public
release whose build number is not newer than the current appcast and the
installed `/Applications/VoiceClaw Companion.app`, when present.

For public distribution, notarize and staple the generated DMG before uploading it to a GitHub Release. Then generate the Sparkle appcast for the notarized DMG:

```sh
./scripts/make_appcast.sh dist/VoiceClawCompanion-<version>-<build>.dmg
```

Commit and push `appcast.xml` after the matching GitHub Release asset is uploaded.
