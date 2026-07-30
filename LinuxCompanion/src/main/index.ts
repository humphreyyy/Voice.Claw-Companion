import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
} from 'electron';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BridgeClient } from './bridge-client';
import { CompanionController } from './companion-controller';
import { registerCompanionIPC, type DesktopActions } from './ipc';
import { AccessDiagnostics } from './linux/access-diagnostics';
import { AutostartStore } from './linux/autostart';
import { ExecFileCommandRunner } from './linux/command-runner';
import { ConfigStore } from './linux/config-store';
import { linuxPaths } from './linux/paths';
import { SystemdService } from './linux/systemd';
import { TailscaleInspector } from './linux/tailscale';
import { companionWindowOptions, isElectronSmokeTest } from './window-options';

const moduleDirectory = fileURLToPath(new URL('.', import.meta.url));
const APPROVED_WEB_HOSTS = new Set([
  'github.com',
  'docs.github.com',
  'tailscale.com',
  'login.tailscale.com',
  'openai.com',
  'platform.openai.com',
  'help.openai.com',
]);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

function isWithin(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder));
}

function createDesktopActions(
  configStore: ConfigStore,
  paths: ReturnType<typeof linuxPaths>,
): DesktopActions {
  return {
    async copyText(value) {
      clipboard.writeText(value);
    },
    async openPath(path) {
      const candidate = await realpath(resolve(path));
      const config = await configStore.read();
      const roots = [
        paths.configDir,
        paths.dataDir,
        paths.cacheDir,
        config.openClawInstallPath,
      ];
      const canonicalRoots = await Promise.all(
        roots.map((root) => realpath(root).catch(() => resolve(root))),
      );
      if (!canonicalRoots.some((root) => isWithin(root, candidate))) {
        throw new Error('The requested path is outside VoiceClaw-owned locations.');
      }
      const result = await shell.openPath(candidate);
      if (result) {
        throw new Error(result);
      }
    },
    async openURL(value) {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !APPROVED_WEB_HOSTS.has(url.hostname)) {
        throw new Error('The requested URL is not an approved VoiceClaw destination.');
      }
      await shell.openExternal(url.toString());
    },
  };
}

function createController(): CompanionController {
  const paths = linuxPaths();
  const runner = new ExecFileCommandRunner();
  const configStore = new ConfigStore(paths);
  const serviceEntryPath = app.isPackaged
    ? join(process.resourcesPath, 'service', 'bridge-entry.mjs')
    : join(app.getAppPath(), 'service', 'bridge-entry.mjs');
  const runtimeEntryPath = app.isPackaged
    ? join(process.resourcesPath, 'BridgeRuntime', 'server', 'index.js')
    : join(app.getAppPath(), '..', 'BridgeRuntime', 'server', 'index.js');
  const controller = new CompanionController({
    configStore,
    tailscale: new TailscaleInspector(runner),
    systemd: new SystemdService(runner, paths),
    autostart: new AutostartStore(paths),
    diagnostics: new AccessDiagnostics({
      paths,
      runner,
      runtimeEntryPath,
    }),
    paths,
    executablePath: process.execPath,
    serviceEntryPath,
    bridgeClientFactory: (config) => new BridgeClient({
      port: config.port,
      token: config.gatewayToken,
    }),
  });
  registerCompanionIPC(
    ipcMain,
    controller,
    createDesktopActions(configStore, paths),
  );
  return controller;
}

function createMainWindow(controller: CompanionController): BrowserWindow {
  const preloadPath = join(moduleDirectory, '..', 'preload', 'index.mjs');
  const window = new BrowserWindow(companionWindowOptions(preloadPath));
  const rendererURL = process.env.ELECTRON_RENDERER_URL;
  if (rendererURL) {
    void window.loadURL(rendererURL);
  } else {
    void window.loadFile(join(moduleDirectory, '..', 'renderer', 'index.html'));
  }

  window.on('close', (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      window.hide();
    }
  });
  window.once('ready-to-show', () => {
    if (!isElectronSmokeTest(process.argv)) {
      window.show();
    }
  });

  if (isElectronSmokeTest(process.argv)) {
    const smokeTimeout = setTimeout(() => {
      console.error('VOICECLAW_ELECTRON_SMOKE_TIMEOUT');
      app.exit(1);
    }, 15_000);
    window.once('ready-to-show', () => {
      clearTimeout(smokeTimeout);
      console.log('VOICECLAW_ELECTRON_SMOKE_READY');
      app.exit(0);
    });
  } else {
    createTray(controller, window);
  }
  return window;
}

function createTray(controller: CompanionController, window: BrowserWindow): void {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), '..', 'Assets', 'AppIcon-1024.png');
  const image = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
  tray = new Tray(image);
  tray.setToolTip('VoiceClaw Companion');

  const refreshMenu = async (): Promise<void> => {
    const snapshot = await controller.getSnapshot().catch(() => null);
    const state = snapshot?.service.active ? 'Running' : 'Stopped';
    tray?.setContextMenu(Menu.buildFromTemplate([
      {
        label: 'Show VoiceClaw Companion',
        click: () => {
          window.show();
          window.focus();
        },
      },
      {
        label: 'Refresh Status',
        click: () => {
          void refreshMenu();
        },
      },
      {
        label: 'Copy Phone Setup',
        click: () => {
          void controller.getPairingPayload({
            includeOpenAIAPIKey: false,
            includeCerebrasAPIKey: false,
            includeBridgeCredentials: true,
            includeChatGPTOAuth: true,
          }).then((payload) => clipboard.writeText(JSON.stringify(payload, null, 2)));
        },
      },
      {
        label: 'Start or Restart Bridge',
        click: () => {
          void controller.getSnapshot().then((current) => current.service.active
            ? controller.restartBridge()
            : controller.installAndStart({
              port: current.config.port,
              openClawInstallPath: current.config.openClawInstallPath,
              openClawAgentName: current.config.openClawAgentName,
              realtimeAuthMode: current.config.realtimeAuthMode,
              realtimeAuthFallbackToAPIKey:
                current.config.realtimeAuthFallbackToAPIKey,
              openAIAPIKey: '',
            })).then(() => refreshMenu());
        },
      },
      { label: `Bridge: ${state}`, enabled: false },
      { type: 'separator' },
      {
        label: 'Quit VoiceClaw Companion',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]));
  };

  tray.on('click', () => {
    window.show();
    window.focus();
  });
  void refreshMenu();
}

async function start(): Promise<void> {
  const controller = createController();
  mainWindow = createMainWindow(controller);

  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => {
  if (!tray) {
    app.quit();
  }
});

app.whenReady().then(start).catch((error) => {
  console.error(`[voiceclaw-desktop] ${error instanceof Error ? error.message : 'Startup failed.'}`);
  app.exit(1);
});
