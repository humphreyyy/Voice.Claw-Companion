import type { StatusItem } from '../../../shared/contracts';
import { StatusBadge } from './StatusBadge';

export function StatusRow({ item }: { item: StatusItem }) {
  return (
    <article className="status-row">
      <div className="status-row-heading">
        <h3>{item.label}</h3>
        <StatusBadge state={item.state} />
      </div>
      <p>{item.summary}</p>
      {item.detail && <small>{item.detail}</small>}
      {item.path && <code>{item.path}</code>}
    </article>
  );
}
