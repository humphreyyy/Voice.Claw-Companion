# Voice.Claw Companion

Voice.Claw Companion is the macOS bridge app for VoiceClaw on iPhone. It connects the iPhone app to the user's own OpenClaw installation through their private Tailscale network, without using another person's Mac, Tailnet, or API credentials.

## Requirements

- macOS 13 or later.
- Tailscale installed and signed in on the Mac.
- Tailscale HTTPS certificates enabled for the user's tailnet.
- Node.js installed on the Mac.
- OpenClaw installed on the Mac. The install path should be the folder that contains `openclaw.json`, usually `~/.openclaw`.
- VoiceClaw installed on iPhone from TestFlight.

## Install

Download the latest DMG from GitHub Releases, open it, and drag **VoiceClaw Bridge** into Applications.

Open the app and click **Install and Start**. The companion will:

- create `~/.voiceclaw/bridge.json`;
- generate a private pairing token;
- install `~/Library/LaunchAgents/ai.voiceclaw.bridge.plist`;
- publish the local bridge through Tailscale Serve;
- show a QR code and setup JSON for pairing the iPhone.

Tailscale Serve is Tailscale's private HTTPS reverse proxy. It forwards a private Tailscale URL on the Mac to the local Voice.Claw bridge service. The default bridge port is `3191`; users should change it only if the port is already in use or they intentionally want a separate test bridge.

The pairing payload does not include the user's OpenAI API key. The API key is entered in VoiceClaw on iPhone and stored in iOS Keychain.

## Reset First-Run State

The companion includes **Reset First-Run State** for testing onboarding. It removes only Voice.Claw's LaunchAgent and local bridge config:

- `~/Library/LaunchAgents/ai.voiceclaw.bridge.plist`
- `~/.voiceclaw/bridge.json`

It does not uninstall Tailscale, change tailnet settings, remove OpenClaw, remove Node.js, or delete iPhone settings.

## Develop

```sh
swift build
./scripts/build_and_run.sh
```

Runtime checks:

```sh
cd BridgeRuntime
npm install
npm run check
```

Package a GitHub release artifact:

```sh
./scripts/package_release.sh
```

For public distribution, notarize and staple the generated DMG before uploading it to a GitHub Release.
