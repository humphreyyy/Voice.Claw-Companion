import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type {
  CompanionSnapshot,
  VoiceClawDesktopAPI,
} from '../../../shared/contracts';
import {
  redactedPairingPreview,
} from '../pairing';
import { PairingScreen } from './PairingScreen';

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn(async () => 'data:image/png;base64,cXJjb2Rl'),
  },
}));

const emptySnapshot = {} as CompanionSnapshot;

function api(): VoiceClawDesktopAPI {
  return {
    getSnapshot: vi.fn(async () => emptySnapshot),
    installAndStart: vi.fn(async () => emptySnapshot),
    restartBridge: vi.fn(async () => emptySnapshot),
    resetBridge: vi.fn(async () => emptySnapshot),
    suggestPort: vi.fn(async () => 12_321),
    setLaunchAtLogin: vi.fn(async (value) => value),
    getPairingPayload: vi.fn(async () => ({
      TailscaleBaseURL: 'https://host.tailnet.ts.net:12321',
      gatewayToken: 'bridge-secret',
    })),
    deleteArtifact: vi.fn(async () => emptySnapshot),
    emptyArtifactInbox: vi.fn(async () => emptySnapshot),
    copyText: vi.fn(async () => undefined),
    openPath: vi.fn(async () => undefined),
    openURL: vi.fn(async () => undefined),
  };
}

describe('manual pairing', () => {
  it('redacts all supported secret aliases without changing the source', () => {
    const payload = {
      OpenAIAPIKey: 'sk-secret',
      gatewayToken: 'bridge-secret',
      ChatGPTOAuthAccessToken: 'oauth-secret',
      TailscaleBaseURL: 'https://host.tailnet.ts.net:12321',
    };
    expect(redactedPairingPreview(payload)).toEqual({
      OpenAIAPIKey: '••••••••',
      gatewayToken: '••••••••',
      ChatGPTOAuthAccessToken: '••••••••',
      TailscaleBaseURL: 'https://host.tailnet.ts.net:12321',
    });
    expect(payload.OpenAIAPIKey).toBe('sk-secret');
  });

  it('shows QR, JSON, and deep-link copy controls without pairing automatically', async () => {
    render(<PairingScreen api={api()} bridgeAvailable pairingAvailable />);
    expect(await screen.findByAltText('VoiceClaw phone setup QR code')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy Setup JSON' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy Setup Link' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /pair iphone now/i }))
      .not.toBeInTheDocument();
  });

  it('shows setup guidance without calling the bridge when it is offline', async () => {
    const desktopAPI = api();
    render(<PairingScreen api={desktopAPI} bridgeAvailable={false} pairingAvailable={false} />);
    expect(screen.getByText(/Install and Start the VoiceClaw bridge/)).toBeVisible();
    expect(desktopAPI.getPairingPayload).not.toHaveBeenCalled();
  });
});
