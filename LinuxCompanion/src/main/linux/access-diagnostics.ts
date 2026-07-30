import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  BridgeConfig,
  ReadinessState,
  ServiceStatus,
  StatusItem,
} from '../../shared/contracts';
import type { CommandRunner } from './command-runner';
import type { LinuxOwnedPaths } from './paths';

type UnknownRecord = Record<string, unknown>;

export interface AccessDiagnosticsOptions {
  paths: LinuxOwnedPaths;
  runner: CommandRunner;
  env?: Record<string, string | undefined>;
  runtimeEntryPath: string;
}

function item(
  id: string,
  label: string,
  ready: boolean,
  summary: string,
  detail = '',
  path?: string,
): StatusItem {
  return {
    id,
    label,
    state: ready ? 'ready' : 'needs_action',
    summary,
    detail,
    ...(path ? { path } : {}),
  };
}

async function pathItem(
  id: string,
  label: string,
  path: string,
): Promise<StatusItem> {
  const available = await access(path, constants.R_OK | constants.W_OK)
    .then(() => true, () => false);
  return item(
    id,
    label,
    available,
    available ? `${label} is accessible.` : `${label} is not accessible.`,
    available ? path : `Check access to ${path}.`,
    path,
  );
}

async function commandAvailable(
  runner: CommandRunner,
  executable: string,
  args: string[],
): Promise<boolean> {
  try {
    return (await runner.run(executable, args, { timeoutMs: 5_000 })).exitCode === 0;
  } catch {
    return false;
  }
}

export class AccessDiagnostics {
  private readonly env: Record<string, string | undefined>;

  public constructor(private readonly options: AccessDiagnosticsOptions) {
    this.env = options.env ?? process.env;
  }

  public async check(
    config: BridgeConfig,
    service: ServiceStatus,
    bridge: UnknownRecord,
  ): Promise<StatusItem[]> {
    const [configItem, dataItem, cacheItem, logsItem, runtimeItem, openClawItem] =
      await Promise.all([
        pathItem('config', 'Protected configuration', this.options.paths.configFile),
        pathItem('data', 'Application data', this.options.paths.dataDir),
        pathItem('cache', 'Application cache', this.options.paths.cacheDir),
        pathItem('logs', 'Bridge logs', join(this.options.paths.dataDir, 'logs')),
        pathItem('runtime', 'Packaged bridge runtime', this.options.runtimeEntryPath),
        pathItem(
          'openclaw',
          'OpenClaw configuration',
          join(config.openClawInstallPath, 'openclaw.json'),
        ),
      ]);

    const hermesAvailable = await commandAvailable(this.options.runner, 'hermes', ['--help']);
    const pactlAvailable = await commandAvailable(this.options.runner, 'pactl', ['info']);
    const audioAvailable = pactlAvailable
      || await commandAvailable(this.options.runner, 'arecord', ['-l']);
    const desktopValues = [
      this.env.XDG_CURRENT_DESKTOP,
      this.env.XDG_SESSION_TYPE,
      this.env.DBUS_SESSION_BUS_ADDRESS,
    ].filter(Boolean);
    const bridgeReady = bridge.ok === true;
    const serializedBridge = JSON.stringify(bridge).toLowerCase();
    const codexAvailable = bridgeReady && serializedBridge.includes('codex');

    const stateForCodex: ReadinessState = codexAvailable ? 'ready' : 'warning';
    return [
      item(
        'systemd',
        'Bridge service',
        service.active,
        service.summary,
        `${service.activeState}/${service.subState}`,
        this.options.paths.unitFile,
      ),
      configItem,
      dataItem,
      cacheItem,
      logsItem,
      runtimeItem,
      item(
        'bridge',
        'Local bridge',
        bridgeReady,
        bridgeReady ? 'The loopback bridge is responding.' : 'The loopback bridge is unavailable.',
        `http://127.0.0.1:${config.port}/healthz`,
      ),
      openClawItem,
      item(
        'hermes',
        'Hermes CLI',
        hermesAvailable,
        hermesAvailable ? 'Hermes CLI is available.' : 'Hermes CLI is not available.',
      ),
      {
        id: 'codex',
        label: 'Codex bridge',
        state: stateForCodex,
        summary: codexAvailable
          ? 'Codex support is advertised by the bridge.'
          : 'Codex support is not currently advertised by the bridge.',
        detail: '',
      },
      item(
        'audio',
        'Audio input',
        audioAvailable,
        audioAvailable ? 'An audio service or capture device is available.' : 'No audio capture service was detected.',
      ),
      item(
        'desktop',
        'Desktop session',
        desktopValues.length === 3,
        desktopValues.length === 3
          ? 'The desktop session environment is available.'
          : 'The desktop session environment is incomplete.',
        desktopValues.join(' · '),
      ),
      item(
        'network',
        'Network access',
        service.active,
        config.tailscaleBaseURL
          ? 'Remote pairing metadata is available.'
          : 'Loopback access is available; remote pairing is not configured.',
        config.tailscaleBaseURL || `http://127.0.0.1:${config.port}`,
      ),
    ];
  }
}
