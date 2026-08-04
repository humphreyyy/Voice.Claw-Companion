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
        <span className="eyebrow">VoiceClaw Companion</span>
        <h1>Your private voice bridge on Linux</h1>
        <p>
          Let your iPhone and Apple Watch reach OpenClaw, Hermes Agent, or Codex
          through one local companion and your existing private network.
        </p>
      </section>
      <section className="launch-panel">
        <div>
          <strong>Launch at startup</strong>
          <span>Open VoiceClaw automatically when you sign in to Linux.</span>
        </div>
        <button
          className={enabled ? 'switch switch-on' : 'switch'}
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Launch at startup"
          disabled={busy || !snapshot}
          onClick={() => void onSetLaunchAtLogin(!enabled)}
        >
          <span />
        </button>
      </section>
    </div>
  );
}
