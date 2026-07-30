import type { CompanionSnapshot } from '../../../shared/contracts';
import { StatusBadge } from '../components/StatusBadge';

export function TailscaleScreen({ snapshot }: { snapshot: CompanionSnapshot | null }) {
  const tailscale = snapshot?.tailscale;
  const cards = [
    ['CLI installed', tailscale?.installed ? 'Detected' : 'Not detected', tailscale?.installed],
    ['Tailnet connected', tailscale?.connected ? 'Connected' : 'Disconnected', tailscale?.connected],
    ['DNS name', tailscale?.dnsName || 'Unavailable', Boolean(tailscale?.dnsName)],
    ['Serve mapping', tailscale?.serveMapped ? 'Mapped' : 'Not mapped', tailscale?.serveMapped],
  ] as const;
  return (
    <section className="screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">Read-only network view</span>
          <h1>Tailscale</h1>
          <p>{tailscale?.summary ?? 'Checking your existing Tailscale state…'}</p>
        </div>
      </div>
      <div className="callout">
        This Linux port reads your existing Tailscale state. It never creates,
        changes, or removes a Serve mapping.
      </div>
      <div className="metric-grid">
        {cards.map(([label, value, ready]) => (
          <article className="metric-card" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <StatusBadge state={ready ? 'ready' : 'warning'} />
          </article>
        ))}
      </div>
      <section className="panel detected-url">
        <div className="panel-title"><span>Detected remote URL</span></div>
        <code>{tailscale?.serveURL || 'No matching Serve URL detected for this bridge port.'}</code>
      </section>
    </section>
  );
}
