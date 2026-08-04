import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  CompanionSnapshot,
  VoiceClawDesktopAPI,
} from '../../../shared/contracts';
import { TasksFilesScreen } from './TasksFilesScreen';

const snapshot: CompanionSnapshot = {
  config: {
    port: 12_321,
    openClawInstallPath: '/home/tester/.openclaw',
    openClawAgentName: 'main',
    realtimeAuthMode: 'openclaw-oauth',
    realtimeAuthFallbackToAPIKey: false,
    hasOpenAIAPIKey: false,
    watchPublicBridgeURL: '',
  },
  service: {
    installed: true,
    enabled: true,
    active: true,
    loadState: 'loaded',
    activeState: 'active',
    subState: 'running',
    summary: 'running',
  },
  tailscale: {
    installed: true,
    connected: true,
    dnsName: 'host.ts.net',
    serveURL: 'https://host.ts.net:12321',
    serveMapped: true,
    pairingCompatible: true,
    summary: 'mapped',
  },
  access: [],
  diagnostics: [],
  tasks: [{
    taskID: 'task-1',
    state: 'completed',
    runtime: 'codex',
    route: 'Codex task',
    progress: 'Finished',
    result: 'Done',
    error: '',
    updatedAt: 1,
  }],
  artifacts: [{
    artifactID: 'artifact-1',
    taskID: 'task-1',
    displayName: 'report.pdf',
    contentType: 'application/pdf',
    byteCount: 1_024,
    sha256: 'a'.repeat(64),
    createdAt: 1,
  }],
  launchAtLoginEnabled: false,
  pairingAvailable: true,
  checkedAt: 1,
};

function api(): VoiceClawDesktopAPI {
  return {
    getSnapshot: vi.fn(async () => snapshot),
    installAndStart: vi.fn(async () => snapshot),
    restartBridge: vi.fn(async () => snapshot),
    resetBridge: vi.fn(async () => snapshot),
    suggestPort: vi.fn(async () => 12_321),
    setLaunchAtLogin: vi.fn(async (value) => value),
    getPairingPayload: vi.fn(async () => ({})),
    updateRealtimeAuth: vi.fn(async () => snapshot),
    deleteArtifact: vi.fn(async () => snapshot),
    emptyArtifactInbox: vi.fn(async () => snapshot),
    copyText: vi.fn(async () => undefined),
    openPath: vi.fn(async () => undefined),
    openURL: vi.fn(async () => undefined),
  };
}

describe('TasksFilesScreen', () => {
  it('shows task state and requires confirmation before deleting an artifact', async () => {
    const desktopAPI = api();
    const refresh = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(
      <TasksFilesScreen snapshot={snapshot} api={desktopAPI} onRefresh={refresh} />,
    );
    expect(screen.getByText('Codex task')).toBeVisible();
    expect(screen.getByText('report.pdf')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Delete report.pdf' }));
    expect(desktopAPI.deleteArtifact).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm Delete' }));
    expect(desktopAPI.deleteArtifact).toHaveBeenCalledWith('artifact-1');
  });

  it('requires a second confirmation for Empty Inbox', async () => {
    const desktopAPI = api();
    const user = userEvent.setup();
    render(
      <TasksFilesScreen
        snapshot={snapshot}
        api={desktopAPI}
        onRefresh={vi.fn(async () => undefined)}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Empty Inbox' }));
    expect(desktopAPI.emptyArtifactInbox).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm Empty Inbox' }));
    expect(desktopAPI.emptyArtifactInbox).toHaveBeenCalledOnce();
  });
});
