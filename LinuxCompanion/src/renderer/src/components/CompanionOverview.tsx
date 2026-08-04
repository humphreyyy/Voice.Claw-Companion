import type { CompanionSnapshot } from '../../../shared/contracts';

export function CompanionOverview({
  snapshot,
  busy,
  onSetLaunchAtLogin,
}: {
  snapshot: CompanionSnapshot | null;
  busy: boolean;
  onSetLaunchAtLogin(enabled: boolean): Promise<void>;
}) {
  const enabled = snapshot?.launchAtLoginEnabled ?? false;
  return (
    <div className="overview-stack">
      <section className="hero-panel">
        <h1>VoiceClaw Realtime Companion</h1>
        <p>
          Install and manage the private Linux companion that lets VoiceClaw Realtime
          on your phone or watch reach OpenClaw, Hermes Agent, or Codex on this Linux
          host through Tailscale or an HTTPS tunnel.
        </p>
      </section>
      <section className="launch-panel">
        <div>
          <strong>Launch upon Startup</strong>
          <span>{enabled ? 'VoiceClaw Realtime Companion opens automatically when this Linux user logs in.' : 'VoiceClaw Realtime Companion does not open automatically when this Linux user logs in.'}</span>
        </div>
        <button
          className={enabled ? 'switch switch-on' : 'switch'}
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Launch upon Startup"
          disabled={busy || !snapshot}
          onClick={() => void onSetLaunchAtLogin(!enabled)}
        >
          <span />
        </button>
      </section>
    </div>
  );
}
