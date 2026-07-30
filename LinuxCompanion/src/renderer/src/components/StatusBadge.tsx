import type { ReadinessState } from '../../../shared/contracts';

const LABELS: Record<ReadinessState, string> = {
  ready: 'Ready',
  working: 'Working',
  warning: 'Warning',
  needs_action: 'Needs action',
  blocked: 'Blocked',
  unavailable: 'Unavailable',
  idle: 'Idle',
};

export function StatusBadge({ state }: { state: ReadinessState }) {
  return <span className={`status-badge status-${state}`}>{LABELS[state]}</span>;
}
