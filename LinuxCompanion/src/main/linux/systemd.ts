import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';

import type { ServiceStatus } from '../../shared/contracts';
import type { CommandRunner } from './command-runner';
import type { LinuxOwnedPaths } from './paths';

const UNIT_NAME = 'voiceclaw-companion-bridge.service';
const MAX_JOURNAL_CHARS = 64 * 1024;
const UNSAFE_UNIT_VALUE = /[\u0000\r\n"]/u;

export interface BridgeLaunch {
  executablePath: string;
  serviceEntryPath: string;
  configFile: string;
  dataDir: string;
  cacheDir: string;
}

function assertSafeLaunchValue(value: string): void {
  if (value.length === 0 || UNSAFE_UNIT_VALUE.test(value)) {
    throw new Error('Bridge launch path contains unsupported characters.');
  }
}

export function renderBridgeUnit(launch: BridgeLaunch): string {
  Object.values(launch).forEach(assertSafeLaunchValue);
  return `[Unit]
Description=VoiceClaw Companion Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=ELECTRON_RUN_AS_NODE=1
Environment=VOICECLAW_CONFIG_PATH=${launch.configFile}
Environment=VOICECLAW_APP_SUPPORT_DIR=${launch.dataDir}
Environment=VOICECLAW_CACHE_DIR=${launch.cacheDir}
WorkingDirectory=${launch.dataDir}
UMask=0077
ExecStart="${launch.executablePath}" "${launch.serviceEntryPath}"
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

function propertyMap(output: string): Record<string, string> {
  return Object.fromEntries(
    output.split(/\r?\n/u).flatMap((line) => {
      const separator = line.indexOf('=');
      return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
    }),
  );
}

function unavailableStatus(summary: string): ServiceStatus {
  return {
    installed: false,
    enabled: false,
    active: false,
    loadState: 'not-found',
    activeState: 'inactive',
    subState: 'dead',
    summary,
  };
}

function redactJournal(output: string): string {
  return output
    .replace(/\bsk-[A-Za-z0-9_-]+\b/gu, '[REDACTED]')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(
      /((?:OPENAI_API_KEY|VOICECLAW_BRIDGE_TOKEN|gatewayToken|openAIAPIKey)\s*[:=]\s*)[^\s,}]+/giu,
      '$1[REDACTED]',
    )
    .slice(-MAX_JOURNAL_CHARS);
}

export class SystemdService {
  public constructor(
    private readonly runner: CommandRunner,
    private readonly paths: LinuxOwnedPaths,
  ) {}

  public async installAndStart(launch: BridgeLaunch): Promise<ServiceStatus> {
    const tempFile = `${this.paths.unitFile}.tmp`;
    await Promise.all([
      mkdir(this.paths.systemdDir, { recursive: true, mode: 0o700 }),
      mkdir(launch.dataDir, { recursive: true, mode: 0o700 }),
      mkdir(launch.cacheDir, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(tempFile, renderBridgeUnit(launch), { mode: 0o644 });
    await chmod(tempFile, 0o644);
    await rename(tempFile, this.paths.unitFile);

    await this.runner.run('systemctl', ['--user', 'daemon-reload']);
    await this.runner.run('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);
    return this.status();
  }

  public async restart(): Promise<ServiceStatus> {
    await this.runner.run('systemctl', ['--user', 'restart', UNIT_NAME]);
    return this.status();
  }

  public async status(): Promise<ServiceStatus> {
    let result;
    try {
      result = await this.runner.run('systemctl', [
        '--user',
        'show',
        UNIT_NAME,
        '--property=LoadState,UnitFileState,ActiveState,SubState',
        '--no-pager',
      ]);
    } catch {
      return unavailableStatus('The systemd user service is unavailable.');
    }
    if (result.exitCode !== 0) {
      return unavailableStatus('The VoiceClaw bridge service is not installed.');
    }

    const properties = propertyMap(result.stdout);
    const loadState = properties.LoadState || 'unknown';
    const unitFileState = properties.UnitFileState || 'unknown';
    const activeState = properties.ActiveState || 'unknown';
    const subState = properties.SubState || 'unknown';
    const installed = loadState === 'loaded';
    const enabled = unitFileState === 'enabled' || unitFileState === 'enabled-runtime';
    const active = activeState === 'active';

    return {
      installed,
      enabled,
      active,
      loadState,
      activeState,
      subState,
      summary: active
        ? 'The VoiceClaw bridge service is running.'
        : installed
          ? 'The VoiceClaw bridge service is installed but not running.'
          : 'The VoiceClaw bridge service is not installed.',
    };
  }

  public async logTail(lines: number): Promise<string> {
    const boundedLines = Math.max(1, Math.min(500, Math.trunc(lines)));
    const result = await this.runner.run('journalctl', [
      '--user',
      `--unit=${UNIT_NAME}`,
      '--no-pager',
      `--lines=${boundedLines}`,
      '--output=short-iso',
    ]);
    return redactJournal(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`);
  }
}
