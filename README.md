# VoiceClaw Companion

**VoiceClaw Companion is the Mac app that lets VoiceClaw on iPhone and Apple
Watch reach your own Mac agent tools.** It installs a small local bridge, starts
it at login, and publishes it privately through Tailscale Serve so your phone can
talk to OpenClaw or Hermes Agent on this Mac.

It is designed for people who want VoiceClaw to use their own Mac, their own
tailnet, and their own API credentials. It does not route your VoiceClaw setup
through another person's computer or account.

![VoiceClaw Companion setup screen](docs/assets/voiceclaw-companion-github.png)

## What It Does

- Connects VoiceClaw on iPhone and Apple Watch to OpenClaw routes on your Mac.
- Connects VoiceClaw to Hermes Agent routes when the `hermes` command is
  installed and working in Terminal.
- Publishes the local bridge through a private Tailscale HTTPS URL.
- Generates a QR code and setup link for pairing the iPhone app.
- Stores the local bridge config in your home folder and can start the bridge
  automatically at login.
- Checks GitHub Releases for signed VoiceClaw Companion updates.
- Reports setup, Tailscale, Realtime, and Companion Realtime Voice readiness from
  the Diagnostics screen.

## Requirements

Before installing, you need:

- A Mac with macOS 13 Ventura or later. Current release builds are for Apple
  silicon.
- [Tailscale for Mac](https://tailscale.com/download/mac), signed in to the same
  tailnet your iPhone uses.
- Tailscale HTTPS certificates enabled for your tailnet. If you are not the
  tailnet owner/admin, ask that person to enable them.
- Node.js installed on the Mac. The app looks in normal Homebrew and system
  locations.
- The VoiceClaw iPhone app installed and signed in.
- At least one local agent route:
  - OpenClaw installed on the Mac, usually at `~/.openclaw`, with
    `openclaw.json` inside that folder.
  - Or Hermes Agent installed so `hermes` works from Terminal. Hermes routes use
    the `hermes` command and `HERMES_HOME`; there is no Hermes path field in the
    Companion app.

For **GPT-Realtime-2 Live** sessions, use API Key mode for now. Pair with an
OpenAI API key included in the QR code, enter the key on iPhone, or make the key
available to the Companion runtime. The OpenClaw OAuth option is reserved for
future Sign in with ChatGPT Realtime support.

For **Companion Realtime Voice**, the bridge also checks for local speech
dependencies:

- `ffmpeg`
- `whisper-cli`
- a Whisper model at `~/.openclaw/models/ggml-small.bin` or
  `~/.openclaw/models/ggml-medium.bin`, unless `WHISPER_MODEL` is set
- Ollama running with `qwen3.5:2b` installed (`ollama pull qwen3.5:2b`)
- a TTS option: OpenAI TTS key in OpenClaw config, a supported Piper model, or
  macOS `say`

The normal OpenClaw/Hermes bridge can still be useful before every Companion
Realtime Voice dependency is ready.

## Install

1. Open the [latest VoiceClaw Companion release][latest-release].
2. Download the `.dmg` attached to the release.
3. Open the DMG and drag **VoiceClaw Companion** into **Applications**.
4. Open **VoiceClaw Companion**.
5. If macOS asks for permission to open the app, approve it.

After the app opens, click **Install and Start**. This creates the local bridge
config, installs the user LaunchAgent, starts the bridge, and configures
Tailscale Serve for the selected port.

By default, the bridge uses port `12321`. You normally should leave it alone.
Use **Fresh Test Port** only when you are testing a clean pairing flow or you
know the default port is already in use. If you change the port, pair the iPhone
again with the new QR code.

## Pair iPhone

1. Complete **Install and Start** on the Mac.
2. Open **Pair Phone** in VoiceClaw Companion.
3. Open VoiceClaw settings on iPhone and scan the QR code, or copy the setup
   link/JSON if scanning is inconvenient.
4. Leave **Include API Key in Setup QR** on if you want the iPhone to receive
   your OpenAI API key during pairing. The app stores the key securely and
   redacts it in the setup preview.
5. In VoiceClaw on iPhone, choose the route you want to use: Tailscale/OpenClaw,
   Tailscale/Hermes, GPT-Realtime-2, Companion Realtime Voice, or another
   available route.

The Tailscale bridge URL is private to your tailnet. Do not put a public HTTPS
tunnel in the **Non-Tailscale HTTPS Bridge** field unless you intentionally want
the phone or watch to reach this Mac through a public tunnel instead of
Tailscale.

## Updates

VoiceClaw Companion checks GitHub Releases for signed updates. Automatic checks
are on by default and can be adjusted in **Diagnostics**.

When a signed update is available, the main window and menu bar item show it.
Use **Install Update** to let Sparkle download and install the signed release in
the app. You can also open the GitHub release and download the notarized DMG
manually.

## Troubleshooting

### The phone cannot connect after scanning the QR code

- Make sure Tailscale is installed and signed in on both Mac and iPhone.
- Confirm both devices are in the same tailnet.
- Enable Tailscale HTTPS certificates in the tailnet admin console.
- In VoiceClaw Companion, click **Diagnostics** > **Check Again**.
- If the selected port changed, scan the new QR code.

### Companion says the Tailscale command is missing

Install Tailscale's command line integration:

1. Open **Tailscale** on the Mac.
2. Go to **Settings**.
3. Find **CLI integration** and click **Show me how**.
4. Choose **Add "tailscale" command to PATH**.
5. Return to VoiceClaw Companion and click **Install and Start** again.

![Tailscale command line integration troubleshooting](docs/assets/tailscale-cli-integration-troubleshooting.png)

### Setup says OpenClaw config was not found

Set **OpenClaw Install Path** to the folder that contains `openclaw.json`. On
most Macs this is:

```text
~/.openclaw
```

Do not point it at a parent folder unless that parent folder directly contains
`openclaw.json`.

### Hermes routes do not work

VoiceClaw Companion does not ask for a Hermes install path. It starts the bridge,
then calls the `hermes` CLI from the Mac user's `PATH`, or from `HERMES_BIN`
when that is set.

Check Hermes in Terminal first:

```sh
hermes --help
```

Then reopen VoiceClaw Companion and click **Install and Start** again.

### GPT-Realtime-2 does not start

Use **API Key** mode for current GPT-Realtime-2 Live sessions. Add an OpenAI API
key in the Pair Phone screen and either include it in the setup QR or enter it
on iPhone. OAuth is visible for future support, but current GPT-Realtime-2 Live
sessions should not rely on Companion-minted OAuth.

### Companion Realtime Voice says it needs setup

Open **Diagnostics** and read the Companion Realtime Voice row. It reports which
local dependency is missing. Common fixes:

- Install `ffmpeg`.
- Install `whisper-cli`.
- Put a Whisper model at `~/.openclaw/models/ggml-small.bin` or
  `~/.openclaw/models/ggml-medium.bin`, or set `WHISPER_MODEL`.
- Open Ollama and run `ollama pull qwen3.5:2b`.
- Configure a TTS option: OpenAI TTS key in OpenClaw config, supported Piper
  model files, or macOS `say`.

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

## Privacy And Security

- VoiceClaw Companion is meant to run on your Mac, with your own local agent
  tools and credentials.
- The Tailscale URL is private to your tailnet. Tailscale Serve forwards that
  private URL to `127.0.0.1` on this Mac.
- The bridge config is stored at `~/.voiceclaw/bridge.json`.
- The setup QR/link can include your OpenAI API key when you choose to include
  it. The preview redacts the key, and the paired iPhone stores it securely.
- Do not share screenshots, setup JSON, setup links, bridge URLs, or logs if
  they contain private tailnet hostnames, tokens, or API keys.
- VoiceClaw Companion should not be used to expose your Mac publicly unless you
  intentionally configure a separate public HTTPS tunnel and understand the
  risk.

## More Documentation

- [Companion feature inventory](docs/COMPANION_FEATURE_INVENTORY.md)
- [Development notes](docs/DEVELOPMENT.md)

[latest-release]: https://github.com/bdjben/Voice.Claw-Companion/releases/latest
