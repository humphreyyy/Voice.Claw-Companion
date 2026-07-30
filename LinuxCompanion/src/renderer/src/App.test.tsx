import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  CompanionSnapshot,
  VoiceClawDesktopAPI,
} from '../../shared/contracts';
import { App } from './App';

function snapshotWithWarnings(): CompanionSnapshot {
  return {
    config: {
      port: 12_321,
      openClawInstallPath: '/home/michael/.openclaw',
      openClawAgentName: 'main',
      realtimeAuthMode: 'openclaw-oauth',
      realtimeAuthFallbackToAPIKey: false,
      hasOpenAIAPIKey: false,
    },
    service: {
      installed: false,
      enabled: false,
      active: false,
      loadState: 'not-found',
      activeState: 'inactive',
      subState: 'dead',
      summary: 'Bridge service is not installed.',
    },
    tailscale: {
      installed: false,
      connected: false,
      dnsName: '',
      serveURL: '',
      serveMapped: false,
      summary: 'Tailscale CLI is not available.',
    },
    access: [{
      id: 'openclaw',
      label: 'OpenClaw configuration',
      state: 'needs_action',
      summary: 'OpenClaw configuration was not found.',
      detail: '/home/michael/.openclaw/openclaw.json',
    }],
    diagnostics: [{
      id: 'tailscale',
      label: 'Tailscale',
      state: 'warning',
      summary: 'Tailscale CLI is not available.',
      detail: '',
    }],
    tasks: [],
    artifacts: [],
    pairingAvailable: false,
    checkedAt: 1,
  };
}

function apiFor(snapshot = snapshotWithWarnings()): VoiceClawDesktopAPI {
  return {
    getSnapshot: vi.fn(async () => snapshot),
    installAndStart: vi.fn(async () => snapshot),
    restartBridge: vi.fn(async () => snapshot),
    resetBridge: vi.fn(async () => snapshot),
    suggestPort: vi.fn(async () => 12_321),
    setLaunchAtLogin: vi.fn(async (enabled) => enabled),
    getPairingPayload: vi.fn(async () => ({ TailscaleBaseURL: 'https://host.ts.net' })),
    deleteArtifact: vi.fn(async () => snapshot),
    emptyArtifactInbox: vi.fn(async () => snapshot),
    copyText: vi.fn(async () => undefined),
    openPath: vi.fn(async () => undefined),
    openURL: vi.fn(async () => undefined),
  };
}

describe('App', () => {
  it('renders all six navigation destinations', async () => {
    render(<App api={apiFor()} />);
    for (const label of [
      'Set Up',
      'Access',
      'Tasks & Files',
      'Pair Phone',
      'Tailscale',
      'Diagnostics',
    ]) {
      expect(await screen.findByRole('button', { name: label })).toBeVisible();
    }
  });

  it('installs the bridge without offering a Tailscale mutation', async () => {
    const api = apiFor();
    const user = userEvent.setup();
    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: 'Install and Start' }));
    expect(api.installAndStart).toHaveBeenCalledWith(expect.objectContaining({
      port: 12_321,
      openClawInstallPath: '/home/michael/.openclaw',
      openClawAgentName: 'main',
    }));
    expect(screen.queryByRole('button', { name: /configure tailscale/i }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reset tailscale/i }))
      .not.toBeInTheDocument();
  });

  it('keeps diagnostics visible when dependencies are unavailable', async () => {
    render(<App api={apiFor()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Diagnostics' }));
    expect(await screen.findByText('Tailscale CLI is not available.')).toBeVisible();
    expect(screen.getByText('OpenClaw configuration was not found.')).toBeVisible();
  });

  it('requires confirmation before resetting VoiceClaw-owned Linux state', async () => {
    const api = apiFor();
    const user = userEvent.setup();
    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: 'Reset Companion State' }));
    expect(api.resetBridge).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm Reset' }));
    expect(api.resetBridge).toHaveBeenCalledWith(true);
  });
});
