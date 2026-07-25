# VoiceClaw Realtime Companion Feature Inventory

Reviewed from source on 2026-05-15.

This document inventories the macOS Companion app and its bundled bridge runtime.

## Purpose

VoiceClaw Realtime Companion is the Mac bridge for the iOS and watchOS VoiceClaw Realtime apps. It installs and runs a local Node bridge, connects it to the user's OpenClaw installation, and publishes the bridge privately through Tailscale Serve. It can also provide a public HTTPS bridge URL for Watch cellular use if the user intentionally configures one outside the app.

## Main Window

The Companion is a native SwiftUI macOS app with a sidebar and six visible sections:

- Set Up
- Access
- Tasks & Files
- Pair Phone
- Tailscale
- Diagnostics

Companion Voice and Powerhouse implementations remain in source but are hidden
by `VoiceClawProductSurfacePolicy` and do not participate in setup guidance or
overall readiness while the policy disables them.

The toolbar has:

- Check Status: re-runs local diagnostics.

## Menu Bar

The app has a menu bar extra named `VoiceClaw Realtime` with:

- Show VoiceClaw Realtime Companion
- Check Status
- Copy iPhone Setup
- Check for Updates
- Download update DMG when an update is available
- current bridge status
- Quit VoiceClaw Realtime Companion

The menu bar icon uses the system `waveform.circle.fill` symbol. If a custom branded status item is desired later, that is not currently implemented.

## Set Up Section

Fields:

- Bridge Port: default `12321`.
- OpenClaw Install Path: default `~/.openclaw`.
- OpenClaw Agent: default `main`; users should change it only when debugging a non-default OpenClaw agent name.

Buttons:

- Use Default: resets the Bridge Port field to `12321` and clears the generated pairing payload.
- Fresh Test Port: asks the setup script for an unused high port. It does not change the Mac until Install and Start is clicked.
- Install and Start: creates config, installs LaunchAgent, starts the bridge, and configures Tailscale Serve.
- Check Again: read-only diagnostics refresh.
- Reset First-Run State: removes only VoiceClaw Realtime local LaunchAgent/config.
- Reset App + Tailscale Mapping: removes VoiceClaw Realtime local state and only the selected Tailscale Serve mapping when diagnostics prove it points exactly to the VoiceClaw Realtime bridge.

Install and Start runs the setup script with:

- `--install`
- `--start`
- `--tailscale`
- `--json`
- `--port`
- `--openclaw-path`
- `--realtime-auth-mode`
- fallback mode flag

It does not uninstall Tailscale, OpenClaw, or Node.js.

## Pair iPhone Section

Fields and toggles:

- Realtime Auth: OpenAI API key or OpenClaw OAuth.
- Fall back to OpenAI API key if OpenClaw OAuth fails.
- OpenAI API Key.
- Include API Key in Setup QR.
- Include Bridge Credentials in Setup QR.
- Include ChatGPT OAuth in Setup QR.
- Optional Non-Tailscale HTTPS Bridge.
- OpenAI Auth Status: shows whether API-key mode is configured and, when OpenClaw OAuth is selected, whether the Companion can mint a GPT-Realtime-2 client secret through the local OpenClaw login.

Pairing outputs:

- QR code.
- setup JSON preview with secrets redacted.
- setup link/deep link.
- Copy Setup JSON.
- Copy Setup Link.

Important behavior:

- Include API Key in Setup QR is on by default.
- When enabled, the setup payload includes the user's OpenAI key so the iPhone can store it in Keychain.
- The displayed preview redacts the key.
- The iPhone can override auth mode later.
- Optional Non-Tailscale HTTPS Bridge should be an intentionally public HTTPS URL, not a private Tailscale URL with a custom port.

## Tasks & Files Section

The Tasks & Files screen uses the authenticated local bridge to show:

- current and recent route-task state, runtime, route, agent, progress, result,
  and error metadata;
- Artifact Inbox usage, per-file and total capacity, content type, task ID, and
  SHA-256 metadata;
- Open Inbox, per-file Delete, and Empty Inbox actions.

Empty Inbox requires both an explicit macOS confirmation and a short-lived
server confirmation token. The inbox has no automatic eviction behavior.

Task-scoped input attachments are stored separately under
`~/Library/Application Support/VoiceClaw Realtime Companion/Input Attachments`.
The iPhone must preallocate the task ID, upload files through the authenticated
raw PUT endpoint, and include those attachment IDs when it creates the task.
The bridge requires exact `Content-Length`, `X-VoiceClaw-Byte-Count`, and
`X-VoiceClaw-Content-SHA256` values and resolves only verified regular files.
Limits are 50 MB per file, 20 files per task, and 500 MB total. Terminal tasks
are cleaned immediately; uploads not followed by task creation expire after 24
hours. Route instructions receive verified paths without changing any external
OpenClaw, Hermes, or Codex installation.

## Tailscale Section

The Tailscale section explains:

- what Tailscale Serve is.
- why the VoiceClaw Realtime URL has a port.
- what must be allowed in the tailnet.
- why VoiceClaw Realtime avoids a full Tailscale Serve reset.

Buttons:

- Get Tailscale: opens the Mac download page.
- Admin Console: opens the Tailscale admin DNS/certificates page.
- Serve Help: opens Tailscale Serve docs.
- Check Again: read-only status refresh.

## Diagnostics Section

Diagnostics shows:

- Local Bridge status.
- Tailscale Serve status.
- Realtime Runtime status.
- Realtime Auth mode, fallback state, and OAuth readiness summary.
- Recommended Next Step.
- App Updates status.
- Update Checks status.
- Updates Checked timestamp.
- Last Checked timestamp.
- Last log output.
- app version/build footer.

Buttons:

- Check Again.
- Get Node.js.
- Open OpenClaw Folder.
- Check Updates.
- Download and Open DMG, when an update is available.
- Open Release, when an update is available.
- Automatically check GitHub Releases for notarized DMG updates.

## Update System

The Companion checks GitHub Releases at:

`https://api.github.com/repos/bdjben/Voice.Claw-Companion/releases/latest`

It compares release tag versions against the app bundle version. It looks for a DMG asset and only presents the DMG path in the UI. Automatic update checks run every six hours while the app is running.

The updater does not silently install. It downloads the DMG to Downloads, verifies a SHA-256 digest if GitHub provides one, opens the DMG, and tells the user to drag the app into Applications.

Release policy: only notarized DMG artifacts should be published for users.

## Runtime Bridge

The bundled Node runtime lives under `BridgeRuntime`.

Key endpoints:

- `GET /healthz`: local health check.
- `GET /config`: pairing/runtime config for the phone.
- `POST /realtime/session`: creates a GPT-Realtime-2 WebRTC session via OpenAI Realtime Calls, using API key or OpenClaw OAuth based on preferences.
- `GET /realtime/status`: reports runtime, queue, active OpenClaw, sideband, and auth state.
- `GET /realtime/auth/status`: reports OpenClaw OAuth/API-key auth status.
- `POST /realtime/prewarm`: prewarms OpenClaw processing.
- `POST /realtime/openclaw-turn`: sends one OpenClaw turn.
- `POST /realtime/steer`: sends follow-up instructions into active OpenClaw work.
- `POST /realtime/cancel`: cancels active OpenClaw work.
- `POST /realtime/disconnect`: disconnects a realtime session while preserving useful cleanup.
- `GET /realtime` and `/realtime.html`: local web client routes retained for runtime/debugging.

## Realtime Auth

The runtime supports:

- API-key auth.
- OpenClaw OAuth auth through the user's local OpenClaw login.
- API-key fallback when OpenClaw OAuth fails and fallback is enabled.

The Companion UI writes the preferred auth mode and fallback setting into the bridge config. The iPhone can also request an auth mode when it creates a realtime session.

## Realtime Prompt And Tooling

The Companion runtime prompt keeps GPT-Realtime-2 as the live voice layer and provides tools for:

- OpenClaw turn start.
- OpenClaw steering.
- OpenClaw stop/cancel.
- bridge status.
- iPhone-side tools when the iPhone supplies/owns them.
- GPT-5.5 Instant handoff where configured.

Important routing policy:

- GPT-Realtime-2 should answer normal conversation directly.
- OpenClaw should be invoked only when the user asks for OpenClaw or private Mac/computer capability is truly required.
- If OpenClaw is already working and the user gives a correction or follow-up, GPT-Realtime-2 should use steering rather than starting a new turn.

## Files And Local State

Expected local state:

- `~/.voiceclaw/bridge.json`
- `~/Library/LaunchAgents/ai.voiceclaw.bridge.plist`
- selected OpenClaw install folder, usually `~/.openclaw`

Secrets:

- The Companion stores its OpenAI API key in Keychain.
- The setup JSON preview redacts the API key.
- The runtime must not log or publish secrets.
