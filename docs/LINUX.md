# VoiceClaw Companion for Linux

The Linux port runs the existing VoiceClaw bridge inside a native desktop
shell for Ubuntu 24.04 x86-64. It uses Electron for the desktop, a systemd user
service for the bridge, and XDG directories for app-owned data.

The Linux app deliberately treats Tailscale as read-only. It inspects
`tailscale status --json` and `tailscale serve status --json`; it never creates,
changes, or removes a Serve mapping. Configure or pair Tailscale yourself.

## Install

Build or download `voiceclaw-companion_0.1.4_amd64.deb`, then install it:

```sh
sudo dpkg -i voiceclaw-companion_0.1.4_amd64.deb
```

Launch **VoiceClaw Companion** from the desktop menu or run:

```sh
voiceclaw-companion
```

Open **Set Up**, confirm the existing OpenClaw path and agent, then choose
**Install and Start**. This creates only:

- `~/.voiceclaw/bridge.json` with mode `0600`;
- `~/.config/systemd/user/voiceclaw-companion-bridge.service`;
- `${XDG_DATA_HOME:-~/.local/share}/voiceclaw-companion`;
- `${XDG_CACHE_HOME:-~/.cache}/voiceclaw-companion`;
- optionally `~/.config/autostart/voiceclaw-companion.desktop`.

The bridge listens on `127.0.0.1` and defaults to port `12321`.

## Desktop sections

- **Set Up** installs, starts, restarts, or explicitly resets app-owned state.
- **Access** checks the service, storage, runtime, OpenClaw, Hermes, Codex,
  audio, desktop session, and network without changing those dependencies.
- **Tasks & Files** shows routed work and uses confirmations before deleting
  artifacts or emptying the inbox.
- **Pair Phone** builds a setup JSON, deep link, and QR code from explicit
  inclusion toggles. Pairing remains a manual iPhone action.
- **Tailscale** displays the currently detected CLI, DNS name, Serve mapping,
  and URL without exposing any network mutation control.
- **Diagnostics** keeps individual dependency failures visible even when the
  bridge or an optional runtime is unavailable.

## Logs and service control

The bridge is a systemd user unit:

```sh
systemctl --user status voiceclaw-companion-bridge.service
journalctl --user --unit=voiceclaw-companion-bridge.service --no-pager
```

Use the desktop app for normal start/restart operations. The Diagnostics view
redacts common API keys, bearer tokens, and gateway tokens.

## Reset and uninstall

**Reset Companion State** requires confirmation and removes only the exact
VoiceClaw user unit, protected config, XDG app data/cache, and app-owned
autostart entry. It does not remove or edit OpenClaw, Hermes, Codex, Tailscale,
or phone state.

Uninstall the desktop package with:

```sh
sudo apt remove voiceclaw-linux-companion
```

Package removal does not silently delete your user data. Use the in-app reset
first if you also want the VoiceClaw-owned user state removed.

## Development

```sh
cd LinuxCompanion
npm ci
npm test
npm run lint
npm run dev
```

Build and verify the Debian package:

```sh
npm run package:deb
../scripts/verify_linux_companion.sh \
  dist/voiceclaw-companion_0.1.6_amd64.deb
```
