import type { CompanionSnapshot } from '../../../shared/contracts';
import { StatusRow } from '../components/StatusRow';

export function DiagnosticsScreen({
  snapshot,
}: {
  snapshot: CompanionSnapshot | null;
}) {
  const items = [...(snapshot?.diagnostics ?? []), ...(snapshot?.access ?? [])];
  return (
    <section className="screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">Troubleshooting</span>
          <h1>Diagnostics</h1>
          <p>Review bridge, runtime, authentication, startup, audio, and private-network readiness in one place.</p>
        </div>
      </div>
      <div className="diagnostic-summary">
        <span>Last checked</span>
        <strong>{snapshot ? new Date(snapshot.checkedAt).toLocaleString() : 'Checking…'}</strong>
        <span>Launch at startup</span>
        <strong>{snapshot?.launchAtLoginEnabled ? 'Enabled' : 'Disabled'}</strong>
      </div>
      <div className="status-grid">
        {items.map((item, index) => (
          <StatusRow key={`${item.id}-${index}`} item={item} />
        ))}
      </div>
    </section>
  );
}
