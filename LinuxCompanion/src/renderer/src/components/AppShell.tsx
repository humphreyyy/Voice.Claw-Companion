import type { ReactNode } from 'react';

import type { CompanionSnapshot } from '../../../shared/contracts';
import type { CompanionSection } from '../use-companion';
import { StatusBadge } from './StatusBadge';

const NAVIGATION: Array<{ id: CompanionSection; label: string; marker: string; detail: string }> = [
  { id: 'setup', label: 'Set Up', marker: '✦', detail: 'Install bridge' },
  { id: 'access', label: 'Access', marker: '✓', detail: 'Permissions' },
  { id: 'tasks', label: 'Tasks & Files', marker: '▣', detail: 'Runs and inbox' },
  { id: 'pairing', label: 'Pair Phone', marker: '▦', detail: 'QR and JSON' },
  { id: 'tailscale', label: 'Tailscale', marker: '◎', detail: 'Private URL' },
  { id: 'diagnostics', label: 'Diagnostics', marker: '☷', detail: 'Status checks' },
];

interface AppShellProps {
  snapshot: CompanionSnapshot | null;
  selected: CompanionSection;
  onSelect(section: CompanionSection): void;
  onRefresh(): void;
  refreshing: boolean;
  children: ReactNode;
}

export function AppShell({
  snapshot,
  selected,
  onSelect,
  onRefresh,
  refreshing,
  children,
}: AppShellProps) {
  const bridgeState = snapshot?.service.active ? 'ready' : 'needs_action';
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">VC</span>
          <div>
            <strong>VoiceClaw Realtime</strong>
            <span>Companion</span>
          </div>
        </div>
        <nav aria-label="Companion sections">
          {NAVIGATION.map((item) => (
            <button
              key={item.id}
              className={selected === item.id ? 'nav-item nav-item-active' : 'nav-item'}
              type="button"
              aria-label={item.label}
              onClick={() => onSelect(item.id)}
            >
              <span className="nav-marker" aria-hidden="true">{item.marker}</span>
              <span className="nav-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>
            </button>
          ))}
        </nav>
        <div className="sidebar-status">
          <div>
            <span>Bridge</span>
            <StatusBadge state={bridgeState} />
          </div>
          <p>{snapshot?.service.summary ?? 'Checking local service…'}</p>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            className="button button-ghost"
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? 'Checking Runtime' : 'Verify Runtime'}
          </button>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
