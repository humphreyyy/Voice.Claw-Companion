import {
  normalizeSetupInput,
  type PairingOptions,
} from '../shared/contracts';
import type { CompanionController } from './companion-controller';

export const IPC_CHANNELS = {
  getSnapshot: 'voiceclaw:snapshot:get',
  installBridge: 'voiceclaw:bridge:install',
  restartBridge: 'voiceclaw:bridge:restart',
  resetBridge: 'voiceclaw:bridge:reset',
  suggestPort: 'voiceclaw:port:suggest',
  setAutostart: 'voiceclaw:autostart:set',
  getPairing: 'voiceclaw:pairing:get',
  deleteArtifact: 'voiceclaw:artifacts:delete',
  emptyArtifacts: 'voiceclaw:artifacts:empty',
  copyText: 'voiceclaw:clipboard:copy',
  openPath: 'voiceclaw:open:path',
  openURL: 'voiceclaw:open:url',
} as const;

interface IpcRegistrar {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown,
  ): void;
}

export interface DesktopActions {
  copyText(value: string): Promise<void>;
  openPath(path: string): Promise<void>;
  openURL(url: string): Promise<void>;
}

const unavailableActions: DesktopActions = {
  async copyText() {
    throw new Error('Clipboard access is unavailable.');
  },
  async openPath() {
    throw new Error('Path opening is unavailable.');
  },
  async openURL() {
    throw new Error('URL opening is unavailable.');
  },
};

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || /[\u0000]/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function pairingOptions(value: unknown): PairingOptions {
  const input = value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  for (const field of [
    'includeOpenAIAPIKey',
    'includeCerebrasAPIKey',
    'includeBridgeCredentials',
    'includeChatGPTOAuth',
  ]) {
    if (typeof input[field] !== 'boolean') {
      throw new Error('Pairing options are invalid.');
    }
  }
  return input as unknown as PairingOptions;
}

export function registerCompanionIPC(
  ipc: IpcRegistrar,
  controller: CompanionController,
  actions: DesktopActions = unavailableActions,
): void {
  ipc.handle(IPC_CHANNELS.getSnapshot, () => controller.getSnapshot());
  ipc.handle(
    IPC_CHANNELS.installBridge,
    (_event, input) => controller.installAndStart(normalizeSetupInput(
      input as Parameters<typeof normalizeSetupInput>[0],
    )),
  );
  ipc.handle(IPC_CHANNELS.restartBridge, () => controller.restartBridge());
  ipc.handle(IPC_CHANNELS.resetBridge, (_event, confirmed) => {
    if (confirmed !== true) {
      throw new Error('Bridge reset requires explicit confirmation.');
    }
    return controller.resetBridge(true);
  });
  ipc.handle(IPC_CHANNELS.suggestPort, () => controller.suggestPort());
  ipc.handle(IPC_CHANNELS.setAutostart, (_event, enabled) => {
    if (typeof enabled !== 'boolean') {
      throw new Error('Autostart preference must be a boolean.');
    }
    return controller.setLaunchAtLogin(enabled);
  });
  ipc.handle(
    IPC_CHANNELS.getPairing,
    (_event, options) => controller.getPairingPayload(pairingOptions(options)),
  );
  ipc.handle(
    IPC_CHANNELS.deleteArtifact,
    (_event, artifactID) => controller.deleteArtifact(
      requiredString(artifactID, 'Artifact identifier', 256),
    ),
  );
  ipc.handle(IPC_CHANNELS.emptyArtifacts, () => controller.emptyArtifactInbox());
  ipc.handle(
    IPC_CHANNELS.copyText,
    (_event, value) => actions.copyText(requiredString(value, 'Clipboard value', 1024 * 1024)),
  );
  ipc.handle(
    IPC_CHANNELS.openPath,
    (_event, path) => actions.openPath(requiredString(path, 'Path', 4_096)),
  );
  ipc.handle(
    IPC_CHANNELS.openURL,
    (_event, url) => actions.openURL(requiredString(url, 'URL', 4_096)),
  );
}
