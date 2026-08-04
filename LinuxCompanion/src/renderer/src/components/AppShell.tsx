import type { ReactNode } from 'react';

import type { CompanionSnapshot } from '../../../shared/contracts';
import type { CompanionSection } from '../use-companion';
import { StatusBadge } from './StatusBadge';

const NAVIGATION: Array<{ id: CompanionSection; label: string; marker: string; detail: string }> = [
  { id: 'setup', label: 'Set Up', marker: '01', detail: 'Bridge and runtimes' },
  { id: 'access', label: 'Access', marker: '02', detail: 'Host readiness' },
  { id: 'tasks', label: 'Tasks & Files', marker: '03', detail: 'Runtime activity' },
  { id: 'pairing', label: 'Pair Phone', marker: '04', detail: 'Manual handoff' },
  { id: 'tailscale', label: 'Tailscale', marker: '05', detail: 'Private network' },
  { id: 'diagnostics', label: 'Diagnostics', marker: '06', detail: 'Checks and status' },
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
            <strong>VoiceClaw</strong>
            <span>Linux Companion</span>
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
          <div>
            <span className="eyebrow">Local control plane</span>
            <strong>{snapshot?.service.active ? 'Bridge online' : 'Setup needed'}</strong>
          </div>
          <button
            className="button button-ghost"
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? 'Refreshing…' : 'Refresh Status'}
          </button>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
