import type { CompanionSnapshot } from '../../../shared/contracts';
import { StatusRow } from '../components/StatusRow';

export function AccessScreen({ snapshot }: { snapshot: CompanionSnapshot | null }) {
  return (
    <section className="screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">Capability audit</span>
          <h1>Access</h1>
          <p>Prepare this Linux host so the phone can reach OpenClaw, Hermes Agent, or Codex through VoiceClaw.</p>
        </div>
      </div>
      <div className="callout">
        <strong>Current readiness.</strong> These checks are read-only. VoiceClaw verifies its service, runtime commands, local files, audio session, and private-network metadata without changing those runtimes.
      </div>
      <div className="status-grid">
        {snapshot?.access.map((item) => <StatusRow key={item.id} item={item} />)}
      </div>
    </section>
  );
}
