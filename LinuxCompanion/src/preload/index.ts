import { contextBridge, ipcRenderer } from 'electron';

import type {
  PairingOptions,
  SetupInput,
  VoiceClawDesktopAPI,
} from '../shared/contracts';
import { IPC_CHANNELS } from '../main/ipc';

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function createDesktopAPI(invoke: Invoke): VoiceClawDesktopAPI {
  return {
    getSnapshot: () => invoke(IPC_CHANNELS.getSnapshot) as ReturnType<VoiceClawDesktopAPI['getSnapshot']>,
    installAndStart: (input: SetupInput) => invoke(
      IPC_CHANNELS.installBridge,
      input,
    ) as ReturnType<VoiceClawDesktopAPI['installAndStart']>,
    restartBridge: () => invoke(
      IPC_CHANNELS.restartBridge,
    ) as ReturnType<VoiceClawDesktopAPI['restartBridge']>,
    resetBridge: (confirmed: true) => invoke(
      IPC_CHANNELS.resetBridge,
      confirmed,
    ) as ReturnType<VoiceClawDesktopAPI['resetBridge']>,
    suggestPort: () => invoke(
      IPC_CHANNELS.suggestPort,
    ) as ReturnType<VoiceClawDesktopAPI['suggestPort']>,
    setLaunchAtLogin: (enabled: boolean) => invoke(
      IPC_CHANNELS.setAutostart,
      enabled,
    ) as ReturnType<VoiceClawDesktopAPI['setLaunchAtLogin']>,
    getPairingPayload: (options: PairingOptions) => invoke(
      IPC_CHANNELS.getPairing,
      options,
    ) as ReturnType<VoiceClawDesktopAPI['getPairingPayload']>,
    deleteArtifact: (artifactID: string) => invoke(
      IPC_CHANNELS.deleteArtifact,
      artifactID,
    ) as ReturnType<VoiceClawDesktopAPI['deleteArtifact']>,
    emptyArtifactInbox: () => invoke(
      IPC_CHANNELS.emptyArtifacts,
    ) as ReturnType<VoiceClawDesktopAPI['emptyArtifactInbox']>,
    copyText: (value: string) => invoke(
      IPC_CHANNELS.copyText,
      value,
    ) as ReturnType<VoiceClawDesktopAPI['copyText']>,
    openPath: (path: string) => invoke(
      IPC_CHANNELS.openPath,
      path,
    ) as ReturnType<VoiceClawDesktopAPI['openPath']>,
    openURL: (url: string) => invoke(
      IPC_CHANNELS.openURL,
      url,
    ) as ReturnType<VoiceClawDesktopAPI['openURL']>,
  };
}

contextBridge.exposeInMainWorld(
  'voiceclaw',
  createDesktopAPI((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
);
