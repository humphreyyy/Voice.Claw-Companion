import { useEffect, useState } from 'react';

import type { CompanionSnapshot, SetupInput } from '../../../shared/contracts';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { StatusBadge } from '../components/StatusBadge';

interface SetupScreenProps {
  snapshot: CompanionSnapshot | null;
  busy: string;
  onInstall(input: SetupInput): Promise<void>;
  onVerify(): Promise<void>;
  onReset(): Promise<void>;
  onSuggestPort(): Promise<number>;
}

export function SetupScreen({
  snapshot,
  busy,
  onInstall,
  onVerify,
  onReset,
  onSuggestPort,
}: SetupScreenProps) {
  const [port, setPort] = useState(12_321);
  const [openClawInstallPath, setOpenClawInstallPath] = useState('/home/michael/.openclaw');
  const [openClawAgentName, setOpenClawAgentName] = useState('main');
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (!snapshot) return;
    setPort(snapshot.config.port);
    setOpenClawInstallPath(snapshot.config.openClawInstallPath);
    setOpenClawAgentName(snapshot.config.openClawAgentName);
  }, [snapshot]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void onInstall({
      port,
      openClawInstallPath,
      openClawAgentName,
      realtimeAuthMode: snapshot?.config.realtimeAuthMode ?? 'openclaw-oauth',
      realtimeAuthFallbackToAPIKey:
        snapshot?.config.realtimeAuthFallbackToAPIKey ?? false,
      openAIAPIKey: '',
    });
  };
  const setupAdvice = snapshot?.service.active
    ? 'The bridge is running. Open Pair Phone to scan the setup code, or Verify Runtime after changing a dependency.'
    : 'Click Install and Start to install the bridge and reuse the existing Tailscale Serve mapping for this port.';

  return (
    <section className="screen panel parity-panel">
      <div className="screen-heading">
        <div>
          <h1>Linux Setup</h1>
          <p>Install the local bridge, start it at login, and publish it privately through Tailscale Serve.</p>
        </div>
        <StatusBadge state={snapshot?.service.active ? 'ready' : 'needs_action'} />
      </div>

      <form className="parity-form" onSubmit={submit}>
        <label>
          <strong>Bridge Port</strong>
          <div>
            <div className="inline-field parity-inline-field">
              <input
                aria-label="Bridge Port"
                type="number"
                min="1"
                max="65535"
                value={port}
                onChange={(event) => setPort(Number(event.target.value))}
              />
              <button className="button button-secondary" type="button" onClick={() => setPort(12_321)}>
                Use Default
              </button>
              <button
                className="button button-secondary"
                type="button"
                onClick={() => void onSuggestPort().then(setPort)}
              >
                Fresh Test Port
              </button>
            </div>
            <small>Default is 12321. Fresh Test Port chooses an unused high port without changing your Linux host, which is useful when you want to test onboarding without reusing an old Tailscale Serve mapping. The phone URL will include this port, and changing it means pairing the phone again.</small>
          </div>
        </label>

        <label>
          <strong>OpenClaw Install Path</strong>
          <div>
            <input value={openClawInstallPath} onChange={(event) => setOpenClawInstallPath(event.target.value)} />
            <small>Choose the folder that contains openclaw.json. This is only for OpenClaw routes; Hermes Agent routes use the installed hermes command and HERMES_HOME, so no Hermes install path is needed here. On most Linux hosts the OpenClaw path is ~/.openclaw.</small>
          </div>
        </label>

        <label>
          <strong>OpenClaw Agent</strong>
          <div>
            <input value={openClawAgentName} onChange={(event) => setOpenClawAgentName(event.target.value)} />
            <small>Leave this as main unless setup fails and you want to try another OpenClaw agent. Hermes routes do not use this field; the Companion resumes Hermes CLI sessions by VoiceClaw Realtime session token.</small>
          </div>
        </label>

        <div className="info-card"><strong>What Install and Start Changes</strong><span>This button creates VoiceClaw Realtime&apos;s local config, installs a systemd user service, and starts the bridge. The same bridge serves OpenClaw routes, Hermes Agent routes, Codex routes, GPT Realtime signaling, and Apple Watch relay. On Linux, VoiceClaw reuses your existing Tailscale Serve mapping without changing it.</span></div>
        <div className="info-card"><strong>Hermes Agent Routes</strong><span>Hermes via Tailscale and Hermes HTTPS Tunnel do not need a Hermes path in this app. The bridge starts normally, then calls the hermes CLI from the user&apos;s PATH (or HERMES_BIN) with HERMES_HOME. Use Hermes routes in the phone or watch app after installing Hermes Agent and confirming it works in Terminal.</span></div>
        <div className="info-card"><strong>Testing First-Run Setup</strong><span>Reset First-Run State removes only VoiceClaw Realtime&apos;s Linux bridge service and local Companion state. The Linux port never resets or changes Tailscale Serve mappings.</span></div>
        <div className="info-card"><strong>Recommended Next Step</strong><span>{setupAdvice}</span></div>

        <div className="form-actions parity-actions">
          <button className="button button-primary" type="submit" disabled={Boolean(busy)}>
            {busy === 'install' ? 'Installing…' : 'Install and Start'}
          </button>
          <button className="button button-secondary" type="button" disabled={Boolean(busy)} onClick={() => void onVerify()}>
            {busy === 'refresh' ? 'Checking Runtime' : 'Verify Runtime'}
          </button>
          <button className="button button-danger-outline" type="button" disabled={Boolean(busy)} onClick={() => setConfirmReset(true)}>
            Reset First-Run State
          </button>
        </div>
      </form>

      <ConfirmDialog
        open={confirmReset}
        title="Reset First-Run State"
        confirmLabel="Reset First-Run State"
        destructive
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          void onReset();
        }}
      >
        <p>This removes VoiceClaw Realtime&apos;s systemd user service and local Companion state. Tailscale, OpenClaw, Hermes, Codex, and Node.js remain installed.</p>
      </ConfirmDialog>
    </section>
  );
}
