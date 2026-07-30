import type { CompanionSnapshot } from '../../../shared/contracts';
import { StatusRow } from '../components/StatusRow';

export function AccessScreen({ snapshot }: { snapshot: CompanionSnapshot | null }) {
  return (
    <section className="screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">Capability audit</span>
          <h1>Access</h1>
          <p>Read-only checks for every local dependency the companion relies on.</p>
        </div>
      </div>
      <div className="status-grid">
        {snapshot?.access.map((item) => <StatusRow key={item.id} item={item} />)}
      </div>
    </section>
  );
}
