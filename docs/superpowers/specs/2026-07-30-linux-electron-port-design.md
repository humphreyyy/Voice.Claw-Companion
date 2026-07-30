# VoiceClaw Companion Linux Electron Port Design

**Date:** 2026-07-30

**Status:** Approved in conversation

## Goal

Create a Linux desktop edition of VoiceClaw Companion that runs on the user's
Ubuntu 24.04 x86-64 machine. The Linux edition must provide the operational
desktop experience of the current macOS SwiftUI app while reusing the existing
Node.js bridge runtime.

The completed work will live in the authenticated GitHub fork
`humphreyyy/Voice.Claw-Companion` on the `linux-electron-port` branch and produce
an installable Debian package.

## Scope

Linux v1 includes:

- an Electron desktop window and tray menu;
- Linux-native bridge installation and supervision through a user-level
  `systemd` service;
- setup, access checks, task and artifact management, pairing output,
  read-only Tailscale status, and diagnostics;
- an Ubuntu 24.04 x86-64 `.deb`;
- local installation and launch verification on the target machine.

Linux v1 does not:

- configure, replace, or reset any Tailscale Serve mapping;
- pair or test an iPhone automatically;
- automatically download or install application updates;
- replace or rewrite the existing macOS SwiftUI application;
- enable the dormant Companion Voice or Powerhouse product surfaces;
- claim support for Linux distributions other than the target Ubuntu release;
- publish a public Linux release.

## Compatibility Strategy

The macOS sources, Swift package, Sparkle integration, and macOS release scripts
remain intact. Linux code is added alongside them so that future upstream
changes can be merged without forcing macOS and Linux into one UI framework.

`BridgeRuntime` remains the shared protocol and route implementation. Changes
inside it are limited to platform-neutral path selection and other behavior
needed for the existing runtime to operate correctly on Linux. Existing wire
contracts and endpoint behavior remain unchanged.

## Architecture

### Electron desktop

A new `LinuxCompanion` package contains:

- a TypeScript Electron main process;
- a context-isolated preload script exposing a small typed API;
- a React renderer implementing the Companion screens;
- shared request and response contracts used on both sides of IPC;
- Linux integration modules for systemd, XDG autostart, filesystem paths,
  process discovery, desktop URL/folder opening, and Tailscale inspection;
- packaging metadata for an Ubuntu x86-64 Debian package.

The renderer has no direct Node.js, filesystem, or process access.
`nodeIntegration` is disabled, `contextIsolation` is enabled, and all privileged
operations cross an allow-listed IPC boundary.

### Bridge service

The bridge runs separately from the window as
`voiceclaw-companion-bridge.service` in the user's systemd manager. Closing the
window or tray application does not terminate the bridge.

The package uses Electron's embedded Node runtime in Node mode to launch the
packaged BridgeRuntime. This avoids depending on the user's interactive shell,
NVM configuration, or a distribution-provided Node version. The service unit
uses explicit executable and runtime paths and does not invoke a shell.

The unit is written to:

`~/.config/systemd/user/voiceclaw-companion-bridge.service`

Clicking **Install and Start** performs only these service operations:

1. validate the requested bridge configuration;
2. atomically write the VoiceClaw-owned config and service unit;
3. run `systemctl --user daemon-reload`;
4. run `systemctl --user enable --now voiceclaw-companion-bridge.service`;
5. verify the local bridge health endpoint.

Restart and stop actions target only this exact unit.

### Runtime paths

The compatibility configuration remains:

`~/.voiceclaw/bridge.json`

It is written atomically with file mode `0600`.

Linux bulk application state uses:

`${XDG_DATA_HOME:-~/.local/share}/voiceclaw-companion`

Linux cache and downloaded model state use:

`${XDG_CACHE_HOME:-~/.cache}/voiceclaw-companion`

A shared BridgeRuntime platform-path module replaces hard-coded
`~/Library/Application Support/...` defaults while preserving the existing
macOS locations on Darwin. Explicit environment overrides remain authoritative.
Artifact Inbox, task attachments, route-task state, voice-session state, logs,
and optional model paths use this shared resolver.

### Tailscale boundary

The Linux app may execute only read-only Tailscale commands:

- `tailscale status --json`
- `tailscale serve status --json`

It may display the current DNS name, connection state, and existing Serve
mapping and may use those results when composing pairing output.

No Linux UI control or IPC method invokes `tailscale serve`, `tailscale set`,
`tailscale up`, `tailscale down`, or any reset or removal operation. Missing or
unexpected Tailscale state is reported as a warning, never repaired.

## Desktop Behavior

### Set Up

The screen provides the current bridge port, OpenClaw installation path, and
OpenClaw agent fields. It includes:

- **Use Default Port**
- **Fresh Test Port**
- **Install and Start**
- **Restart Bridge**
- **Check Again**
- guarded reset actions that remove only VoiceClaw-owned Linux state

Install and reset summaries explicitly state that Tailscale is not modified.

### Access

Linux-specific checks cover:

- the systemd user manager;
- VoiceClaw config, data, cache, and log directories;
- packaged bridge runtime identity;
- local bridge reachability;
- the configured OpenClaw folder and agent;
- Hermes command and home, when present;
- Codex app-server and computer-control readiness reported by the bridge;
- PipeWire, PulseAudio, or ALSA microphone visibility;
- desktop portal and filesystem access relevant to local tasks;
- network reachability needed by enabled product surfaces.

Buttons open a relevant folder, URL, or supported desktop settings surface when
one exists. Unsupported Linux permission concepts are explained rather than
presented as macOS controls.

### Tasks & Files

The screen consumes the existing authenticated local bridge APIs. It displays
route-task state and Artifact Inbox usage and supports the existing per-file
delete and guarded empty-inbox flows. Destructive actions retain the server's
confirmation-token contract and add a desktop confirmation dialog.

### Pair Phone

The screen generates the same compatible setup document, deep link, and QR code
expected by the iPhone application. It provides copy controls and redacts
secrets in previews. The user performs phone pairing manually.

### Tailscale

The screen displays current Tailscale and Serve status, detected private URL,
and explanatory help. It contains no configuration or cleanup button.

### Diagnostics

Diagnostics reports:

- Electron app version and package build;
- systemd unit installation, enablement, and active state;
- packaged and running BridgeRuntime identity;
- local bridge health and authenticated route status;
- OpenClaw, Hermes, Codex, and Tailscale readiness;
- a bounded, redacted service-log tail;
- a concrete suggested next action.

Linux v1 may open the fork's releases page but does not install an update.

### Tray and startup

The tray menu provides:

- show or focus the main window;
- refresh status;
- copy phone setup when available;
- start or restart the bridge;
- show current bridge state;
- quit the desktop UI.

An optional launch-at-login setting writes or removes only
`~/.config/autostart/voiceclaw-companion.desktop`. This controls the desktop UI,
not the separately enabled bridge service.

## Data Flow

1. The React renderer requests a typed operation through the preload API.
2. The preload script validates the channel and forwards the request to the
   Electron main process.
3. The main process validates the payload and calls a focused Linux integration
   module.
4. Integration modules use `execFile` with explicit argument arrays, atomic
   filesystem operations, or authenticated loopback HTTP requests.
5. Results are normalized into serializable status objects before returning to
   the renderer.

The renderer never receives raw process objects, unrestricted filesystem paths,
environment variables, or arbitrary command execution.

The desktop reads bridge authentication material in the main process and sends
only the authorization header needed for loopback API requests. Secrets may
enter pairing output only through the existing explicit inclusion controls.

## Security and Ownership

- Commands use `execFile`; no user-controlled value is interpolated into a
  shell command.
- IPC request schemas reject unknown operations and invalid field types.
- Config files are created atomically with restrictive permissions.
- API keys and tokens are excluded from logs, diagnostics, errors, renderer
  state snapshots, and setup previews.
- The package never mutates OpenClaw, Hermes, Codex, or Tailscale
  installations.
- Service, autostart, reset, and cleanup code recognizes only exact
  VoiceClaw-owned paths and identifiers.
- Reset requires confirmation and refuses targets that do not match the
  expected owned files.

## Error Handling

The desktop window remains usable when any external dependency is missing.
Errors are represented as typed states with:

- a short user-facing summary;
- a bounded technical detail;
- the exact safe next action;
- an optional relevant path or documentation URL.

Failures from systemd and other commands retain exit status and bounded stderr
after secret redaction. A missing systemd user bus is a setup error, not an app
crash. A missing Tailscale mapping is a warning. A missing OpenClaw
configuration blocks only OpenClaw readiness.

Service verification uses bounded polling and reports a timeout instead of
waiting indefinitely.

## Testing

All new behavior follows red-green-refactor development.

Automated coverage includes:

- platform-path tests proving Darwin compatibility, Linux XDG defaults, and
  environment override precedence;
- Linux systemd unit rendering and lifecycle tests using a fake `systemctl`;
- XDG autostart ownership and lifecycle tests;
- Tailscale command tests proving only the two approved read-only invocations
  are possible;
- config atomicity, mode, validation, and redaction tests;
- typed IPC contract and handler tests;
- renderer component tests for the six sections and tray-relevant state;
- bridge API client tests for authentication, errors, and destructive
  confirmations;
- Electron startup smoke coverage.

Regression gates are:

```sh
node scripts/check_runtime_contract.mjs
(
  cd BridgeRuntime
  npm ci
  npm run check
)
(
  cd LinuxCompanion
  npm ci
  npm test
  npm run lint
  npm run build
  npm run package:deb
)
```

## Target-Machine Verification

The final package is verified on the current Ubuntu 24.04 x86-64 host by:

1. inspecting the Debian package metadata and contents;
2. installing the package locally;
3. launching the Electron window and tray;
4. confirming each screen renders and diagnostics completes;
5. exercising service management against an isolated VoiceClaw configuration
   and unused local port;
6. confirming the bridge health endpoint and packaged runtime identity;
7. confirming existing Tailscale state did not change;
8. uninstalling only temporary smoke-test state while leaving the installed
   application available.

Phone pairing is intentionally left to the user and is not an acceptance gate.

## Acceptance Criteria

The port is complete when:

- the fork and `linux-electron-port` branch contain the Linux source and build
  configuration;
- all existing BridgeRuntime checks and all new Linux tests complete without
  failures;
- an Ubuntu x86-64 `.deb` builds successfully;
- the installed app opens as a desktop application with a working tray;
- all six operational areas render and return bounded states;
- the VoiceClaw bridge can run under its user-level systemd unit on an isolated
  port;
- the local health endpoint reports the packaged runtime identity;
- automated evidence proves that no Tailscale mutation command is implemented
  or invoked;
- the existing macOS source and build path remain intact.
