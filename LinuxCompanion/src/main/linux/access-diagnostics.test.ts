// @vitest-environment node

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BridgeConfig, ServiceStatus } from '../../shared/contracts';
import { AccessDiagnostics } from './access-diagnostics';
import type { CommandResult, CommandRunner } from './command-runner';
import { linuxPaths, type LinuxOwnedPaths } from './paths';

describe('AccessDiagnostics', () => {
  let root: string;
  let paths: LinuxOwnedPaths;
  let config: BridgeConfig;
  let service: ServiceStatus;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'voiceclaw-access-'));
    paths = linuxPaths({
      home: join(root, 'home'),
      env: {
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CACHE_HOME: join(root, 'cache'),
      },
    });
    await Promise.all([
      fs.mkdir(paths.configDir, { recursive: true }),
      fs.mkdir(join(paths.dataDir, 'logs'), { recursive: true }),
      fs.mkdir(paths.cacheDir, { recursive: true }),
      fs.mkdir(join(root, 'openclaw'), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(paths.configFile, '{}'),
      fs.writeFile(join(root, 'runtime.mjs'), ''),
      fs.writeFile(join(root, 'openclaw', 'openclaw.json'), '{}'),
    ]);
    config = {
      port: 12_321,
      openClawInstallPath: join(root, 'openclaw'),
      openClawAgentName: 'main',
      realtimeAuthMode: 'openclaw-oauth',
      realtimeAuthFallbackToAPIKey: false,
      openAIAPIKey: '',
      gatewayToken: 'A'.repeat(43),
      tailscaleDNSName: '',
      tailscaleBaseURL: '',
    };
    service = {
      installed: true,
      enabled: true,
      active: true,
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      summary: 'running',
    };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('produces stable readiness items without changing the desktop environment', async () => {
    const calls: Array<[string, string[]]> = [];
    const runner: CommandRunner = {
      async run(executable, args): Promise<CommandResult> {
        calls.push([executable, [...args]]);
        return { stdout: 'available', stderr: '', exitCode: 0 };
      },
    };
    const environment = {
      XDG_CURRENT_DESKTOP: 'GNOME',
      XDG_SESSION_TYPE: 'wayland',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    };
    const diagnostics = new AccessDiagnostics({
      paths,
      runner,
      env: environment,
      runtimeEntryPath: join(root, 'runtime.mjs'),
    });

    const items = await diagnostics.check(config, service, { ok: true });

    expect(items.map((item) => item.id)).toEqual([
      'systemd',
      'config',
      'data',
      'cache',
      'logs',
      'runtime',
      'bridge',
      'openclaw',
      'hermes',
      'codex',
      'audio',
      'desktop',
      'network',
    ]);
    expect(calls).toContainEqual(['pactl', ['info']]);
    expect(calls).not.toContainEqual(['arecord', ['-l']]);
    expect(environment).toEqual({
      XDG_CURRENT_DESKTOP: 'GNOME',
      XDG_SESSION_TYPE: 'wayland',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    });
  });

  it('falls back to arecord only when pactl is unavailable', async () => {
    const calls: Array<[string, string[]]> = [];
    const runner: CommandRunner = {
      async run(executable, args): Promise<CommandResult> {
        calls.push([executable, [...args]]);
        if (executable === 'pactl') {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    const diagnostics = new AccessDiagnostics({
      paths,
      runner,
      env: {},
      runtimeEntryPath: join(root, 'runtime.mjs'),
    });

    await diagnostics.check(config, service, { ok: false });
    expect(calls).toContainEqual(['arecord', ['-l']]);
  });
});
