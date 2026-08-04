import { useEffect, useState } from 'react';

import type {
  CompanionSnapshot,
  SetupInput,
} from '../../../shared/contracts';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { StatusBadge } from '../components/StatusBadge';

interface SetupScreenProps {
  snapshot: CompanionSnapshot | null;
  busy: string;
  onInstall(input: SetupInput): Promise<void>;
  onRestart(): Promise<void>;
  onReset(): Promise<void>;
  onSuggestPort(): Promise<number>;
}

export function SetupScreen({
  snapshot,
  busy,
  onInstall,
  onRestart,
  onReset,
  onSuggestPort,
}: SetupScreenProps) {
  const [port, setPort] = useState(12_321);
  const [openClawInstallPath, setOpenClawInstallPath] =
    useState('/home/michael/.openclaw');
  const [openClawAgentName, setOpenClawAgentName] = useState('main');
  const [realtimeAuthMode, setRealtimeAuthMode] =
    useState<SetupInput['realtimeAuthMode']>('openclaw-oauth');
  const [realtimeAuthFallbackToAPIKey, setFallback] = useState(false);
  const [openAIAPIKey, setOpenAIAPIKey] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    setPort(snapshot.config.port);
    setOpenClawInstallPath(snapshot.config.openClawInstallPath);
    setOpenClawAgentName(snapshot.config.openClawAgentName);
    setRealtimeAuthMode(snapshot.config.realtimeAuthMode);
    setFallback(snapshot.config.realtimeAuthFallbackToAPIKey);
  }, [snapshot]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void onInstall({
      port,
      openClawInstallPath,
      openClawAgentName,
      realtimeAuthMode,
      realtimeAuthFallbackToAPIKey,
      openAIAPIKey,
    });
  };

  return (
    <section className="screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">Host configuration</span>
          <h1>Linux Setup</h1>
          <p>Install the private bridge used by OpenClaw, Hermes Agent, Codex, realtime voice, and phone relay routes.</p>
        </div>
        <StatusBadge state={snapshot?.service.active ? 'ready' : 'needs_action'} />
      </div>

      <div className="setup-grid">
        <form className="panel setup-form" onSubmit={submit}>
          <div className="panel-title">
            <span>Bridge settings</span>
            <small>Stored in ~/.voiceclaw/bridge.json with mode 0600</small>
          </div>
          <label>
            Bridge port
            <div className="inline-field">
              <input
                aria-label="Bridge port"
                type="number"
                min="1"
                max="65535"
                value={port}
                onChange={(event) => setPort(Number(event.target.value))}
              />
              <button
                className="button button-secondary"
                type="button"
                onClick={() => void onSuggestPort().then(setPort)}
              >
                Find free port
              </button>
            </div>
          </label>
          <label>
            OpenClaw install path
            <input
              value={openClawInstallPath}
              onChange={(event) => setOpenClawInstallPath(event.target.value)}
            />
            <small>Used only by OpenClaw routes. Hermes uses the installed <code>hermes</code> command and its HERMES_HOME; Codex uses the installed <code>codex</code> command.</small>
          </label>
          <label>
            OpenClaw agent
            <input
              value={openClawAgentName}
              onChange={(event) => setOpenClawAgentName(event.target.value)}
            />
            <small>Selects the OpenClaw agent only. Hermes and Codex choose their runtime context per task.</small>
          </label>
          <label>
            Realtime authentication
            <select
              value={realtimeAuthMode}
              onChange={(event) => setRealtimeAuthMode(
                event.target.value as SetupInput['realtimeAuthMode'],
              )}
            >
              <option value="openclaw-oauth">OpenClaw OAuth</option>
              <option value="api-key">OpenAI API key</option>
            </select>
          </label>
          <label>
            OpenAI API key
            <input
              type="password"
              value={openAIAPIKey}
              placeholder={snapshot?.config.hasOpenAIAPIKey ? 'Stored key remains unchanged' : 'Optional'}
              onChange={(event) => setOpenAIAPIKey(event.target.value)}
            />
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={realtimeAuthFallbackToAPIKey}
              onChange={(event) => setFallback(event.target.checked)}
            />
            Allow API-key fallback for realtime
          </label>
          <div className="form-actions">
            <button className="button button-primary" type="submit" disabled={Boolean(busy)}>
              {busy === 'install' ? 'Installing…' : 'Install and Start'}
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={Boolean(busy) || !snapshot?.service.installed}
              onClick={() => void onRestart()}
            >
              Restart Bridge
            </button>
          </div>
        </form>

        <aside className="panel setup-summary">
          <div className="panel-title"><span>What this changes</span></div>
          <ul className="change-list">
            <li><strong>systemd</strong><span>One user service owned by VoiceClaw.</span></li>
            <li><strong>Storage</strong><span>XDG data and cache directories only.</span></li>
            <li><strong>Network</strong><span>Loopback bridge on 127.0.0.1.</span></li>
            <li><strong>Runtime routes</strong><span>One bridge serves OpenClaw, Hermes Agent, Codex, and realtime voice.</span></li>
            <li><strong>Tailscale</strong><span>Read-only inspection of your existing state.</span></li>
          </ul>
          <div className="info-stack">
            <div className="info-card">
              <strong>Hermes Agent routes</strong>
              <span>Hermes is discovered from your shell and HERMES_HOME. The OpenClaw path and agent fields do not configure it.</span>
            </div>
            <div className="info-card">
              <strong>Codex routes</strong>
              <span>Codex is discovered from the local CLI and invoked only when a phone task chooses the Codex route.</span>
            </div>
            <div className="info-card">
              <strong>Testing first-run setup</strong>
              <span>Install and Start writes VoiceClaw-owned files, starts its user service, then verifies the loopback bridge.</span>
            </div>
          </div>
          <div className="danger-zone">
            <span className="eyebrow">Danger zone</span>
            <p>Remove only VoiceClaw-owned Linux state. OpenClaw, Hermes, Codex, and Tailscale stay untouched.</p>
            <button
              className="button button-danger-outline"
              type="button"
              onClick={() => setConfirmReset(true)}
            >
              Reset Companion State
            </button>
          </div>
        </aside>
      </div>
      <ConfirmDialog
        open={confirmReset}
        title="Reset Companion State"
        confirmLabel="Confirm Reset"
        destructive
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          void onReset();
        }}
      >
        <p>This removes the VoiceClaw bridge service, protected config, app data, cache, and autostart entry.</p>
      </ConfirmDialog>
    </section>
  );
}
