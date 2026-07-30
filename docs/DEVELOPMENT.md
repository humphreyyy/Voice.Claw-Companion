# VoiceClaw Realtime Companion Development And Release

These notes are for development and release operations. The repository README
remains focused on installation and user troubleshooting.

## Repository And Scope

Use:

`/Users/assistant/Documents/Voice.Claw-Companion`

Before editing:

```sh
git status --short
git log -5 --oneline --decorate
```

Preserve unrelated work. Do not install, replace, or launch the copy in
`/Applications` unless the user explicitly requests a local installation.

## Product Contract Ownership

Keep prompt and runtime ownership explicit:

- iOS/watchOS owns user-visible Voice Engine prompts, app capability knowledge,
  route offers, and execution guidance.
- Companion owns transport, runtime supervision, QR/setup payload generation,
  Tailscale/HTTPS bridge behavior, and computer-side route execution.
- Companion may consume versioned structured guidance from iOS. It must not
  retain an independently drifting prose copy of the Voice Engine prompt.

When either side changes a shared contract, validate:

- capability and tool registry versions
- route switch, steer, restart, and lifecycle receipts
- OpenClaw, Hermes, and Codex session identities
- QR/setup fields and refresh behavior
- Tailscale and personal HTTPS tunnel endpoints
- OAuth/API-key transfer and authentication preference

## Local Development

Build:

```sh
swift build
```

Run the development bundle:

```sh
./scripts/build_and_run.sh
```

Run Swift tests:

```sh
swift test
```

Run the bridge/runtime contract and JavaScript checks:

```sh
node scripts/check_runtime_contract.mjs
(
  cd BridgeRuntime
  npm install
  npm run check
)
```

Validate the privacy manifest:

```sh
plutil -lint PrivacyInfo.xcprivacy
```

## Public Version Requirements

A public release requires:

- `VOICECLAW_BRIDGE_VERSION`: a visible version strictly newer than the first
  item in the current appcast
- `VOICECLAW_BRIDGE_BUILD`: a strictly increasing numeric Sparkle build

Sparkle compares `CFBundleVersion` / `sparkle:version`, not only
`CFBundleShortVersionString`. A newer visible version with an old numeric build
can still be rejected as not newer.

Inspect all three sources before choosing values:

1. source/appcast
2. latest GitHub release
3. installed `/Applications/VoiceClaw Companion.app`, when present

The packaging script enforces monotonicity for public releases.

## Signing And Notarization Prerequisites

The default signing identity is:

`Developer ID Application: Benjamin Badejo (6VFF5BZWJU)`

Override it only when intentionally using a different valid identity:

```sh
export DEVELOPER_ID_APPLICATION="Developer ID Application: Name (TEAMID)"
```

The default notarytool keychain profile is:

`VoiceClaw Companion`

Confirm prerequisites without exposing credentials:

```sh
security find-identity -v -p codesigning
xcrun notarytool history --keychain-profile "VoiceClaw Companion"
```

The packaging script must never fall back to ad-hoc signing for a public
release.

## Package A Release

Choose a fresh version/build and package:

```sh
export VOICECLAW_BRIDGE_VERSION=0.1.153
export VOICECLAW_BRIDGE_BUILD="$(date -u +%Y%m%d%H%M)"
./scripts/package_release.sh
```

The public packaging path performs or enforces:

1. shared runtime contract check
2. BridgeRuntime test/check suite
3. Release Swift build
4. Sparkle framework/helper presence and executable checks
5. runtime manifest generation and packaged-runtime validation
6. Developer ID signing
7. deep code-signature verification
8. DMG creation/signing
9. Apple notarization
10. DMG stapling
11. Gatekeeper checks
12. final ZIP/DMG artifact production

Run the packaged-app verifier when inspecting a built bundle directly:

```sh
./scripts/verify_companion_app.sh \
  "dist/release/VoiceClaw Companion.app"
```

## Generate The Exact Sparkle Feed

Generate the appcast only after the final DMG is signed, notarized, and stapled:

```sh
VOICECLAW_BRIDGE_VERSION="$VOICECLAW_BRIDGE_VERSION" \
VOICECLAW_SPARKLE_RELEASE_NOTES_HTML='<h2>VoiceClaw Realtime Companion 0.1.153</h2><ul><li>Bug fixes</li></ul>' \
./scripts/make_appcast.sh \
  "dist/VoiceClawCompanion-$VOICECLAW_BRIDGE_VERSION-$VOICECLAW_BRIDGE_BUILD.dmg"
```

`make_appcast.sh` verifies that the appcast's visible version, numeric build,
DMG filename, byte length, and Sparkle signature match the mounted final DMG.

## Atomic GitHub/Sparkle Publication

Use the two-commit release flow.

### 1. Source And Tag Commit

- Commit only the approved source, version, and release-note changes.
- Tag that exact source commit `v<version>`.
- Push the source commit and tag.
- Build release artifacts from that tagged source state.

### 2. Fully Populated Draft

Create a draft GitHub release for the tag. Upload all assets before publishing:

- notarized/stapled DMG
- matching ZIP
- generated `appcast.xml`

Verify the draft contains all three exact files. Then publish once.

The primary feed is:

`https://github.com/bdjben/Voice.Claw-Companion/releases/latest/download/appcast.xml`

Publishing a fully populated draft advances the stable appcast and its
referenced DMG together. Do not publish an empty release and add assets later;
that exposes Sparkle clients to a new release with missing or stale feed data.

### 3. Compatibility Appcast Commit

After public remote verification, commit the verified `appcast.xml` to `main`.
This remains necessary for older Companion versions that use the repository
compatibility feed.

## Remote Verification

Download the public artifacts from the stable/latest release URLs into a fresh
temporary directory. Do not validate only the local `dist` files.

Verify:

```sh
shasum -a 256 \
  dist/VoiceClawCompanion-<version>-<build>.dmg \
  /tmp/remote/VoiceClawCompanion-<version>-<build>.dmg

shasum -a 256 \
  dist/VoiceClawCompanion-<version>-<build>.zip \
  /tmp/remote/VoiceClawCompanion-<version>-<build>.zip

spctl -a -vv -t install \
  /tmp/remote/VoiceClawCompanion-<version>-<build>.dmg

xcrun stapler validate \
  /tmp/remote/VoiceClawCompanion-<version>-<build>.dmg
```

Inspect the first appcast item and require:

- exact visible version
- exact numeric Sparkle build
- exact DMG filename and release URL
- exact byte length
- non-empty EdDSA signature

Also verify through GitHub that:

- the release tag is correct
- `draft=false`
- `prerelease=false`, unless deliberately requested
- all expected assets are public
- release notes contain only approved text

## Release Evidence

Record:

- visible version and numeric build
- source/tag commit
- compatibility-appcast commit
- GitHub release URL
- notary submission ID and accepted result
- DMG and ZIP filenames, sizes, and SHA-256 hashes
- runtime/Swift test results
- codesign, staple, Gatekeeper, and remote appcast results
- whether iOS/watchOS changed or was deliberately untouched
- whether local installation was deliberately not performed

Do not call the release complete until public artifacts and the stable appcast
have been verified remotely.
