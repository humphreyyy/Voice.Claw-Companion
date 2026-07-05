# VoiceClaw Companion

VoiceClaw Companion is the macOS bridge for VoiceClaw on iPhone and Apple Watch.
It lets the mobile app reach agent tools that run on your own Mac, including
OpenClaw and Hermes Agent, through a private Tailscale URL.

The Companion app installs a local bridge, keeps it running with a user
LaunchAgent, configures Tailscale Serve, checks the Mac permissions VoiceClaw
needs, installs the local speech-to-speech runtime for Companion Realtime Voice,
and gives VoiceClaw a QR code or setup link for pairing. It is meant for people
who want VoiceClaw to use their own Mac, their own tailnet, their own local
models, and their own API credentials instead of routing work through someone
else's computer.

![VoiceClaw Companion setup screen](docs/assets/voiceclaw-companion-github.png)

## Who This Is For

Use VoiceClaw Companion if you want to:

- Talk to OpenClaw from VoiceClaw on iPhone or Apple Watch.
- Route spoken requests to Hermes Agent when the `hermes` CLI is installed.
- Use VoiceClaw Realtime iOS/watchOS with a Mac-side bridge for private computer
  access.
- Keep the bridge local to your Mac and reachable only through your Tailscale
  tailnet by default.
- Pair, diagnose, and update the Mac bridge without manually editing local
  launch agents or Tailscale Serve mappings.
- Install and verify the local Companion Realtime Voice stack from the app
  instead of hand-assembling Python environments and model caches.

You probably do not need this app if you only want a standalone iPhone voice
assistant and do not need your phone or watch to reach agent tools on a Mac.

## How It Fits Together

```text
VoiceClaw on iPhone / Apple Watch
        |
        | private HTTPS URL from Tailscale Serve
        v
VoiceClaw Companion on Mac
        |
        | local bridge on 127.0.0.1, default port 12321
        v
OpenClaw / Hermes Agent routes, GPT-Realtime-2 setup, or Companion Realtime Voice
```

The iPhone/watch app owns the mobile voice experience. VoiceClaw Companion owns
the Mac-side bridge. Tailscale supplies the private network path between them.

The bridge can expose several route types to VoiceClaw:

- **Tailscale/OpenClaw**: sends requests to an OpenClaw install on this Mac,
  usually at `~/.openclaw`.
- **Tailscale/Hermes**: sends requests to Hermes Agent through the `hermes`
  command or `HERMES_BIN`.
- **GPT-Realtime-2 Live**: uses OpenAI Realtime from the mobile app, with the
  Companion available for Mac-side tools and auth setup.
- **Companion Realtime Voice**: runs a local speech-to-speech pipeline on the
  Mac using a Hugging Face / MLX runtime, local speech models, the selected
  middle brain, and optional OpenClaw/Hermes routing.

Realtime should handle ordinary conversation directly when it can. OpenClaw or
Hermes should be used when the request needs the Mac, local files, local tools,
or a specific agent route.

## Requirements

Before installing, prepare:

- A Mac running macOS 13 Ventura or later. Current release builds are intended
  for Apple silicon Macs.
- [Tailscale for Mac](https://tailscale.com/download/mac), signed in to the same
  tailnet as the iPhone.
- Tailscale HTTPS certificates enabled for the tailnet. If you are not the
  tailnet owner or admin, ask that person to enable them.
- Node.js installed on the Mac. Companion checks common Homebrew and system
  locations and links to the installer if it is missing.
- VoiceClaw installed on iPhone and signed in.
- At least one Mac-side agent route:
  - OpenClaw installed on the Mac, usually at `~/.openclaw`, with
    `openclaw.json` in that folder.
  - Or Hermes Agent installed so `hermes --help` works in Terminal.

For **GPT-Realtime-2 Live**, use API Key mode for current sessions. You can
include the OpenAI API key in the setup QR, enter it on iPhone, or make it
available to the Companion runtime. The OpenClaw OAuth option is present for
future Sign in with ChatGPT Realtime support and should not be treated as the
default path today.

For **Companion Realtime Voice**, open **Companion Voice** or **Access** and use
the install action. The app creates a user-local Python runtime under
`~/.voiceclaw/hf-runtime` and downloads the required Hugging Face / MLX models to
your normal Hugging Face cache.

The current HF realtime stack checks for:

- Faster Whisper speech-to-text:
  `Systran/faster-whisper-base.en`
- Qwen 3.5 2B local middle brain when Local Qwen is selected:
  `mlx-community/Qwen3.5-2B-4bit`
- Qwen3 local text-to-speech:
  `mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit`

The older turn-upload fallback can still use `ffmpeg`, `whisper-cli`, Ollama
`qwen3.5:2b`, Piper, OpenAI TTS, or macOS `say`, but new installs should use the
HF realtime installer first.

The normal OpenClaw and Hermes bridge routes can still work before every
Companion Realtime Voice dependency is ready.

## Install

1. Open the [latest VoiceClaw Companion release][latest-release].
2. Download the `.dmg` attached to the release.
3. Open the DMG and drag **VoiceClaw Companion** into **Applications**.
4. Open **VoiceClaw Companion**.
5. Approve the macOS open prompt if one appears.
6. Click **Install and Start**.
7. Open **Access** and use the buttons there to prepare Login Items, Local
   Network, Microphone, Files and Folders, Full Disk Access, OpenClaw/Hermes
   folders, and the Hugging Face model cache before your first real session.
8. Open **Companion Voice** and click **Install Voice Dependencies** if the HF
   speech-to-speech runtime is not already ready.

**Install and Start** creates `~/.voiceclaw/bridge.json`, installs
`~/Library/LaunchAgents/ai.voiceclaw.bridge.plist`, starts the bridge, and
configures Tailscale Serve for the selected port.

The default bridge port is `12321`. Leave it unchanged unless that port is
already in use or you are deliberately testing a fresh pairing. If you change
the port, pair the iPhone again with the new QR code.

## Pair iPhone

1. Finish **Install and Start** on the Mac.
2. Open **Pair Phone** in VoiceClaw Companion.
3. Open VoiceClaw settings on iPhone.
4. Scan the QR code, or copy the setup link/JSON if scanning is inconvenient.
5. Choose the route you want in VoiceClaw, such as Tailscale/OpenClaw,
   Tailscale/Hermes, GPT-Realtime-2, or Companion Realtime Voice.

The **Include API Key in Setup QR** toggle controls whether the setup payload
includes your OpenAI API key. When enabled, the iPhone can store the key in its
Keychain during pairing. The Companion preview redacts the key so you can inspect
the setup payload without displaying the full secret.

The **Non-Tailscale HTTPS Bridge** field is optional and advanced. Leave it empty
for the normal private Tailscale setup. Only enter a public HTTPS tunnel if you
intentionally want VoiceClaw to reach this Mac outside Tailscale and you
understand the exposure.

## What The App Provides

- Native macOS setup, pairing, Tailscale, and diagnostics screens.
- An **Access** screen that checks and opens the macOS settings panes users need
  before voice sessions get blocked by missing permissions.
- A menu bar item for status checks, setup copying, update checks, and app
  access.
- Private Tailscale Serve publishing for the local bridge.
- QR code, setup link, and setup JSON generation for iPhone pairing.
- OpenClaw path configuration for installs that are not at `~/.openclaw`.
- Hermes routing through the existing CLI environment rather than a separate
  Hermes path field.
- Readiness checks for the local bridge, Tailscale Serve, OpenClaw, Hermes,
  Realtime auth, app updates, Hugging Face model cache, and Companion Realtime
  Voice dependencies.
- A one-click installer for the user-local HF speech-to-speech runtime and the
  required local STT, middle-brain, and TTS models.
- Signed update checks through GitHub Releases.
- Reset actions that remove only VoiceClaw Companion state and, when proven safe,
  only the matching Tailscale Serve mapping.

## OpenClaw And Hermes Routes

### OpenClaw

Set **OpenClaw Install Path** to the folder that directly contains
`openclaw.json`. The usual value is:

```text
~/.openclaw
```

VoiceClaw Companion uses this path when creating the bridge configuration and
when reporting readiness. Do not point the field at a parent folder unless that
parent folder itself contains `openclaw.json`.

### Hermes

VoiceClaw Companion does not have a Hermes install path field. The bridge calls
Hermes through the Mac user's command-line environment.

Check Hermes in Terminal first:

```sh
hermes --help
```

If `hermes` is installed somewhere unusual, set `HERMES_BIN` for the bridge
environment. Hermes can also use `HERMES_HOME` when your Hermes setup requires
it.

## Privacy And Local Runtime

VoiceClaw Companion is designed around local ownership:

- The bridge listens locally on `127.0.0.1` and is forwarded by Tailscale Serve.
- The Tailscale URL is private to your tailnet by default.
- Bridge configuration is stored at `~/.voiceclaw/bridge.json`.
- The user LaunchAgent is stored at
  `~/Library/LaunchAgents/ai.voiceclaw.bridge.plist`.
- The OpenAI API key is stored by the Companion app in Keychain.
- Setup QR codes and setup links can include secrets if you choose to include
  them.
- Setup previews redact the API key, but screenshots, logs, setup JSON, setup
  links, and bridge URLs may still reveal private tailnet hostnames or tokens.

Do not share setup payloads, bridge URLs, screenshots, or logs unless you have
checked that they do not contain private hostnames, tokens, or API keys.

VoiceClaw Companion does not make your Mac public unless you intentionally
configure a separate public HTTPS tunnel and put that URL into the advanced
Non-Tailscale field.

## Updates

VoiceClaw Companion checks GitHub Releases for signed updates. Automatic checks
are enabled by default and can be adjusted in **Diagnostics**.

When an update is available, the main window and menu bar item show it. Use the
in-app update action or open the GitHub release and download the notarized DMG
manually.

## Troubleshooting

### Phone cannot connect after scanning

- Confirm Tailscale is installed and signed in on both Mac and iPhone.
- Confirm both devices are in the same tailnet.
- Confirm Tailscale HTTPS certificates are enabled in the tailnet admin console.
- In VoiceClaw Companion, open **Diagnostics** and click **Check Again**.
- If the bridge port changed, scan the current QR code again.

### Companion says the Tailscale command is missing

Install Tailscale's command-line integration:

1. Open **Tailscale** on the Mac.
2. Go to **Settings**.
3. Find **CLI integration** and click **Show me how**.
4. Choose **Add "tailscale" command to PATH**.
5. Return to VoiceClaw Companion and click **Install and Start** again.

![Tailscale command line integration troubleshooting](docs/assets/tailscale-cli-integration-troubleshooting.png)

### Setup says OpenClaw config was not found

Set **OpenClaw Install Path** to the folder that contains `openclaw.json`,
usually `~/.openclaw`, then run **Install and Start** again.

### Hermes routes do not work

Run `hermes --help` in Terminal. If that fails, install or repair Hermes first.
If it works only from a custom shell setup, configure `HERMES_BIN` for the bridge
environment so Companion can call the same executable.

### GPT-Realtime-2 does not start

Use **API Key** mode for current GPT-Realtime-2 Live sessions. Add an OpenAI API
key in **Pair Phone** and either include it in the setup QR or enter it on
iPhone. OAuth is visible for future support, but current GPT-Realtime-2 Live
sessions should not rely on Companion-minted OAuth.

### Companion Realtime Voice says it needs setup

Open **Companion Voice** or **Access** and read the Companion Realtime Voice row.
It reports the missing local dependency and offers an install action when the
missing item can be installed automatically. Common fixes are:

- Click **Install Voice Dependencies** to install the HF realtime runtime.
- Make sure the Hugging Face model cache is writable.
- Confirm the required Faster Whisper STT and Qwen3 TTS models are cached; Qwen
  3.5 2B is also required when Local Qwen is the selected middle brain.
- If you select the Cerebras middle brain, add a Cerebras API key before pairing
  or in VoiceClaw Realtime on iPhone.
- If you deliberately use the legacy fallback, install `ffmpeg`, `whisper-cli`,
  the Whisper model, and a TTS fallback such as Piper, OpenAI TTS, or macOS
  `say`.

### Resetting setup

**Reset First-Run State** removes only VoiceClaw Companion's local bridge state:

- `~/Library/LaunchAgents/ai.voiceclaw.bridge.plist`
- `~/.voiceclaw/bridge.json`

It does not uninstall Tailscale, change tailnet settings, remove OpenClaw,
remove Node.js, remove Hermes, or delete iPhone settings.

**Reset App + Tailscale Mapping** also removes the selected Tailscale Serve
mapping only when diagnostics prove that mapping points exactly to VoiceClaw's
local bridge. It refuses to remove unrelated Serve mappings and does not run
Tailscale's full `serve reset` command.

## More Documentation

- [Companion feature inventory](docs/COMPANION_FEATURE_INVENTORY.md)
- [Development notes](docs/DEVELOPMENT.md)

[latest-release]: https://github.com/bdjben/Voice.Claw-Companion/releases/latest
