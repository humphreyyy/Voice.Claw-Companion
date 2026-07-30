// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn() },
}));

import { createDesktopAPI } from './index';

describe('preload API', () => {
  it('exposes no generic invoke, send, shell, or filesystem primitive', () => {
    const api = createDesktopAPI(vi.fn());
    expect(Object.keys(api).sort()).toEqual([
      'copyText',
      'deleteArtifact',
      'emptyArtifactInbox',
      'getPairingPayload',
      'getSnapshot',
      'installAndStart',
      'openPath',
      'openURL',
      'resetBridge',
      'restartBridge',
      'setLaunchAtLogin',
      'suggestPort',
    ]);
  });
});
