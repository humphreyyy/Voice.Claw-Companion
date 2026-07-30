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
          <p>Every failed integration remains visible without hiding the rest of the app.</p>
        </div>
      </div>
      <div className="status-grid">
        {items.map((item, index) => (
          <StatusRow key={`${item.id}-${index}`} item={item} />
        ))}
      </div>
    </section>
  );
}
