# VoiceClaw Realtime Companion

VoiceClaw Realtime Companion is the macOS bridge for VoiceClaw Realtime on iPhone and Apple Watch.
It lets the mobile app reach agent tools that run on your own Mac, including
OpenClaw and Hermes Agent, through a private Tailscale URL.

The Companion app installs a local bridge, keeps it running with a user
LaunchAgent, configures Tailscale Serve, checks the Mac permissions VoiceClaw
Realtime needs, and gives VoiceClaw Realtime a QR code or setup link for pairing. It is meant for people
who want VoiceClaw Realtime to use their own Mac, their own tailnet, their own local
models, and their own API credentials instead of routing work through someone
else's computer.

![VoiceClaw Realtime Companion setup screen](docs/assets/voiceclaw-companion-github.png)

## Who This Is For

Use VoiceClaw Realtime Companion if you want to:

- Talk to OpenClaw from VoiceClaw Realtime on iPhone or Apple Watch.
- Route spoken requests to Hermes Agent when the `hermes` CLI is installed.
- Use VoiceClaw Realtime iOS/watchOS with a Mac-side bridge for private computer
  access.
- Keep the bridge local to your Mac and reachable only through your Tailscale
  tailnet by default.
- Pair, diagnose, and update the Mac bridge without manually editing local
  launch agents or Tailscale Serve mappings.
- Monitor delegated OpenClaw, Hermes Agent, and Codex tasks and manage files
  explicitly returned to the Companion Artifact Inbox.

You probably do not need this app if you only want a standalone iPhone voice
assistant and do not need your phone or watch to reach agent tools on a Mac.

## How It Fits Together

```text
VoiceClaw Realtime on iPhone / Apple Watch
        |
        | private HTTPS URL from Tailscale Serve
        v
VoiceClaw Realtime Companion on Mac
        |
        | local bridge on 127.0.0.1, default port 12321
        v
OpenClaw / Hermes Agent / Codex routes and GPT Realtime setup
```

The iPhone/watch app owns the mobile voice experience. VoiceClaw Realtime Companion owns
the Mac-side bridge. Tailscale supplies the private network path between them.

The bridge can expose several route types to VoiceClaw Realtime:

- **Tailscale/OpenClaw**: sends requests to an OpenClaw install on this Mac,
  usually at `~/.openclaw`.
- **Tailscale/Hermes**: sends requests to Hermes Agent through the `hermes`
  command or `HERMES_BIN`.
- **GPT Realtime Live**: uses OpenAI Realtime from the mobile app, with the
  Companion available for Mac-side tools and auth setup.
- **Codex**: sends durable work through Codex app-server without modifying the
  user's Codex installation.

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
- VoiceClaw Realtime installed on iPhone and signed in.
- At least one Mac-side agent route:
  - OpenClaw installed on the Mac, usually at `~/.openclaw`, with
    `openclaw.json` in that folder.
  - Or Hermes Agent installed so `hermes --help` works in Terminal.

For **GPT Realtime Live**, use API Key mode for current sessions. You can
include the OpenAI API key in the setup QR, enter it on iPhone, or make it
available to the Companion runtime. The OpenClaw OAuth option is present for
future Sign in with ChatGPT Realtime support and should not be treated as the
default path today.

The dormant Companion Voice and Powerhouse implementations are preserved for a
possible future release, but current product policy hides their controls and
excludes their dependencies from setup guidance and overall readiness.

## Install

1. Open the [latest VoiceClaw Realtime Companion release][latest-release].
2. Download the `.dmg` attached to the release.
3. Open the DMG and drag **VoiceClaw Realtime Companion** into **Applications**.
4. Open **VoiceClaw Realtime Companion**.
5. Approve the macOS open prompt if one appears.
6. Click **Install and Start**.
7. Open **Access** and use the buttons there to prepare Login Items, Local
   Network, Microphone, Files and Folders, Full Disk Access, and OpenClaw/Hermes
   folders before your first real session.

**Install and Start** creates `~/.voiceclaw/bridge.json`, installs
`~/Library/LaunchAgents/ai.voiceclaw.bridge.plist`, starts the bridge, and
configures Tailscale Serve for the selected port.

The default bridge port is `12321`. Leave it unchanged unless that port is
already in use or you are deliberately testing a fresh pairing. If you change
the port, pair the iPhone again with the new QR code.

## Pair iPhone

1. Finish **Install and Start** on the Mac.
2. Open **Pair Phone** in VoiceClaw Realtime Companion.
3. Open VoiceClaw Realtime settings on iPhone.
4. Scan the QR code, or copy the setup link/JSON if scanning is inconvenient.
5. Choose the route you want in VoiceClaw Realtime, such as Tailscale/OpenClaw,
   Tailscale/Hermes, Codex, or GPT Realtime.

The **Include API Key in Setup QR** toggle controls whether the setup payload
includes your OpenAI API key. When enabled, the iPhone can store the key in its
Keychain during pairing. The Companion preview redacts the key so you can inspect
the setup payload without displaying the full secret.

The **Non-Tailscale HTTPS Bridge** field is optional and advanced. Leave it empty
for the normal private Tailscale setup. Only enter a public HTTPS tunnel if you
intentionally want VoiceClaw Realtime to reach this Mac outside Tailscale and you
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
  Realtime auth, required Mac access, and app updates.
- A **Tasks & Files** screen for route-task status and a bounded Artifact Inbox
  with authenticated metadata, 50 MB per-file and 500 MB total limits, and
  explicit manual deletion. Files are never evicted automatically.
- Authenticated task-scoped input uploads for iPhone requests. The iPhone
  preallocates a task ID, uploads each attachment before task creation, and
  then creates the task with the uploaded attachment IDs. The Companion
  verifies byte count and SHA-256 before giving an ordinary route turn the
  exact private file paths; it does not modify OpenClaw, Hermes, or Codex.
- Signed update checks through GitHub Releases.
- Reset actions that remove only VoiceClaw Realtime Companion state and, when proven safe,
  only the matching Tailscale Serve mapping.

Task input attachments use a separate private store at
`~/Library/Application Support/VoiceClaw Realtime Companion/Input Attachments`.
The authenticated raw `PUT /realtime/tasks/:taskID/attachments/:attachmentID`
contract accepts `Content-Type`, `Content-Length`,
`X-VoiceClaw-Filename-Base64`, `X-VoiceClaw-Content-SHA256`, and
`X-VoiceClaw-Byte-Count`. Each file is limited to 50 MB, each task to 20 files,
and the store to 500 MB. Verified input files are removed when their task
completes, fails, or is cancelled. Uploads whose task is never created are
removed after 24 hours. These input files never enter the Artifact Inbox.

## OpenClaw And Hermes Routes

### OpenClaw

Set **OpenClaw Install Path** to the folder that directly contains
`openclaw.json`. The usual value is:

```text
~/.openclaw
```

VoiceClaw Realtime Companion uses this path when creating the bridge configuration and
when reporting readiness. Do not point the field at a parent folder unless that
parent folder itself contains `openclaw.json`.

### Hermes

VoiceClaw Realtime Companion does not have a Hermes install path field. The bridge calls
Hermes through the Mac user's command-line environment.

Check Hermes in Terminal first:

```sh
hermes --help
```

If `hermes` is installed somewhere unusual, set `HERMES_BIN` for the bridge
environment. Hermes can also use `HERMES_HOME` when your Hermes setup requires
it.

## Privacy And Local Runtime

VoiceClaw Realtime Companion is designed around local ownership:

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

VoiceClaw Realtime Companion does not make your Mac public unless you intentionally
configure a separate public HTTPS tunnel and put that URL into the advanced
Non-Tailscale field.

## Updates

VoiceClaw Realtime Companion checks GitHub Releases for signed updates. Automatic checks
are enabled by default and can be adjusted in **Diagnostics**.

When an update is available, the main window and menu bar item show it. Use the
in-app update action or open the GitHub release and download the notarized DMG
manually.

## Troubleshooting

### Phone cannot connect after scanning

- Confirm Tailscale is installed and signed in on both Mac and iPhone.
- Confirm both devices are in the same tailnet.
- Confirm Tailscale HTTPS certificates are enabled in the tailnet admin console.
- In VoiceClaw Realtime Companion, open **Diagnostics** and click **Check Again**.
- If the bridge port changed, scan the current QR code again.

### Companion says the Tailscale command is missing

Install Tailscale's command-line integration:

1. Open **Tailscale** on the Mac.
2. Go to **Settings**.
3. Find **CLI integration** and click **Show me how**.
4. Choose **Add "tailscale" command to PATH**.
5. Return to VoiceClaw Realtime Companion and click **Install and Start** again.

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

### Resetting setup

**Reset First-Run State** removes only VoiceClaw Realtime Companion's local bridge state:

- `~/Library/LaunchAgents/ai.voiceclaw.bridge.plist`
- `~/.voiceclaw/bridge.json`

It does not uninstall Tailscale, change tailnet settings, remove OpenClaw,
remove Node.js, remove Hermes, or delete iPhone settings.

**Reset App + Tailscale Mapping** also removes the selected Tailscale Serve
mapping only when diagnostics prove that mapping points exactly to VoiceClaw Realtime's
local bridge. It refuses to remove unrelated Serve mappings and does not run
Tailscale's full `serve reset` command.

## More Documentation

- [Companion feature inventory](docs/COMPANION_FEATURE_INVENTORY.md)
- [Development notes](docs/DEVELOPMENT.md)

[latest-release]: https://github.com/bdjben/Voice.Claw-Companion/releases/latest
