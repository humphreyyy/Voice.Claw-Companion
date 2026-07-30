import { useCallback, useEffect, useState } from 'react';

import type {
  CompanionSnapshot,
  SetupInput,
  VoiceClawDesktopAPI,
} from '../../shared/contracts';

export type CompanionSection =
  | 'setup'
  | 'access'
  | 'tasks'
  | 'pairing'
  | 'tailscale'
  | 'diagnostics';

export function useCompanion(api: VoiceClawDesktopAPI) {
  const [snapshot, setSnapshot] = useState<CompanionSnapshot | null>(null);
  const [selectedSection, setSelectedSection] = useState<CompanionSection>('setup');
  const [busyAction, setBusyAction] = useState('');
  const [error, setError] = useState('');

  const perform = useCallback(async (
    action: string,
    operation: () => Promise<CompanionSnapshot>,
  ): Promise<void> => {
    setBusyAction(action);
    setError('');
    try {
      setSnapshot(await operation());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyAction('');
    }
  }, []);

  const refresh = useCallback(
    () => perform('refresh', () => api.getSnapshot()),
    [api, perform],
  );
  const install = useCallback(
    (input: SetupInput) => perform('install', () => api.installAndStart(input)),
    [api, perform],
  );
  const restart = useCallback(
    () => perform('restart', () => api.restartBridge()),
    [api, perform],
  );
  const reset = useCallback(
    () => perform('reset', () => api.resetBridge(true)),
    [api, perform],
  );
  const suggestPort = useCallback(() => api.suggestPort(), [api]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return {
    snapshot,
    setSnapshot,
    selectedSection,
    setSelectedSection,
    busyAction,
    error,
    refresh,
    install,
    restart,
    reset,
    suggestPort,
  };
}
