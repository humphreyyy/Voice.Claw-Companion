# VoiceClaw Realtime Companion Development Notes

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

For public distribution, notarize and staple the generated DMG, then generate
the Sparkle appcast for that exact notarized DMG:

```sh
./scripts/make_appcast.sh dist/VoiceClawCompanion-<version>-<build>.dmg
```

Create the GitHub Release as a draft and upload all three assets before making
the release public:

- the notarized/stapled DMG
- the matching zip
- the generated `appcast.xml`

The app's primary Sparkle URL is
`https://github.com/bdjben/Voice.Claw-Companion/releases/latest/download/appcast.xml`.
Publishing a fully populated draft changes that stable URL and its matching DMG
at the same time, so the updater cannot observe a new release with an old feed.

After publishing, download the stable appcast URL and verify that its first item
matches the release version, numeric build, DMG filename, size, and signature.
Then commit and push `appcast.xml` to `main` as the compatibility feed for
Companion versions released before 0.1.149.
