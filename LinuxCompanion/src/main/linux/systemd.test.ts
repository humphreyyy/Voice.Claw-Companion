// @vitest-environment node

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CommandResult, CommandRunner } from './command-runner';
import { linuxPaths, type LinuxOwnedPaths } from './paths';
import {
  renderBridgeUnit,
  SystemdService,
  type BridgeLaunch,
} from './systemd';

describe('systemd lifecycle', () => {
  let root: string;
  let paths: LinuxOwnedPaths;
  let launch: BridgeLaunch;
  let calls: Array<[string, string[]]>;
  let runner: CommandRunner;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'voiceclaw-systemd-'));
    paths = linuxPaths({
      home: join(root, 'home'),
      env: {
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CACHE_HOME: join(root, 'cache'),
      },
    });
    launch = {
      executablePath: '/opt/VoiceClaw Companion/voiceclaw-companion',
      serviceEntryPath: '/opt/VoiceClaw Companion/resources/service/bridge-entry.mjs',
      configFile: paths.configFile,
      dataDir: paths.dataDir,
      cacheDir: paths.cacheDir,
    };
    calls = [];
    runner = {
      async run(executable, args): Promise<CommandResult> {
        const copiedArgs = [...args];
        calls.push([executable, copiedArgs]);
        if (executable === 'systemctl' && copiedArgs.includes('show')) {
          return {
            stdout: [
              'LoadState=loaded',
              'UnitFileState=enabled',
              'ActiveState=active',
              'SubState=running',
              '',
            ].join('\n'),
            stderr: '',
            exitCode: 0,
          };
        }
        if (executable === 'journalctl') {
          return {
            stdout: 'Authorization: Bearer bridge-secret\nOPENAI_API_KEY=sk-secret\nhealthy',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('renders an exact user service using Electron embedded Node', () => {
    expect(renderBridgeUnit({
      executablePath: '/opt/VoiceClaw Companion/voiceclaw-companion',
      serviceEntryPath: '/opt/VoiceClaw Companion/resources/service/bridge-entry.mjs',
      configFile: '/home/tester/.voiceclaw/bridge.json',
      dataDir: '/home/tester/.local/share/voiceclaw-companion',
      cacheDir: '/home/tester/.cache/voiceclaw-companion',
    })).toBe(`[Unit]
Description=VoiceClaw Companion Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=ELECTRON_RUN_AS_NODE=1
Environment=VOICECLAW_CONFIG_PATH=/home/tester/.voiceclaw/bridge.json
Environment=VOICECLAW_APP_SUPPORT_DIR=/home/tester/.local/share/voiceclaw-companion
Environment=VOICECLAW_CACHE_DIR=/home/tester/.cache/voiceclaw-companion
WorkingDirectory=/home/tester/.local/share/voiceclaw-companion
UMask=0077
ExecStart="/opt/VoiceClaw Companion/voiceclaw-companion" "/opt/VoiceClaw Companion/resources/service/bridge-entry.mjs"
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`);
  });

  it('installs and starts only the exact VoiceClaw user unit', async () => {
    const service = new SystemdService(runner, paths);
    await service.installAndStart(launch);
    expect(calls).toEqual([
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', 'voiceclaw-companion-bridge.service']],
      ['systemctl', [
        '--user',
        'show',
        'voiceclaw-companion-bridge.service',
        '--property=LoadState,UnitFileState,ActiveState,SubState',
        '--no-pager',
      ]],
    ]);
  });

  it('returns a bounded redacted journal tail', async () => {
    const service = new SystemdService(runner, paths);
    const output = await service.logTail(120);
    expect(calls.at(-1)).toEqual([
      'journalctl',
      [
        '--user',
        '--unit=voiceclaw-companion-bridge.service',
        '--no-pager',
        '--lines=120',
        '--output=short-iso',
      ],
    ]);
    expect(output).not.toContain('sk-secret');
    expect(output).not.toContain('bridge-secret');
    expect(output.length).toBeLessThanOrEqual(64 * 1024);
  });
});
