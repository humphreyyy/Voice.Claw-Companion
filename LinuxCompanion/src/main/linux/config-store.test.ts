// @vitest-environment node

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SetupInput } from '../../shared/contracts';
import { ConfigStore } from './config-store';
import { linuxPaths, type LinuxOwnedPaths } from './paths';

const validSetup: SetupInput = {
  port: 12_321,
  openClawInstallPath: '/home/tester/.openclaw',
  openClawAgentName: 'main',
  realtimeAuthMode: 'openclaw-oauth',
  realtimeAuthFallbackToAPIKey: false,
  openAIAPIKey: 'sk-test',
};

async function pathExists(path: string): Promise<boolean> {
  return fs.access(path).then(() => true, () => false);
}

describe('ConfigStore', () => {
  let root: string;
  let paths: LinuxOwnedPaths;
  let store: ConfigStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'voiceclaw-config-'));
    paths = linuxPaths({
      home: join(root, 'home'),
      env: {
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CACHE_HOME: join(root, 'cache'),
      },
    });
    store = new ConfigStore(paths);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes config atomically with mode 0600 and preserves the gateway token', async () => {
    const first = await store.write(validSetup);
    const second = await store.write({ ...validSetup, port: 23_456 });
    const stat = await fs.stat(paths.configFile);
    const stored = JSON.parse(await fs.readFile(paths.configFile, 'utf8')) as Record<string, unknown>;

    expect(stat.mode & 0o777).toBe(0o600);
    expect(first.gatewayToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.gatewayToken).toBe(first.gatewayToken);
    expect(stored.port).toBe(23_456);
    expect(await pathExists(`${paths.configFile}.tmp`)).toBe(false);
  });

  it('uses only VoiceClaw-owned XDG and compatibility paths', () => {
    expect(linuxPaths({
      home: '/home/tester',
      env: {
        XDG_CONFIG_HOME: '/config',
        XDG_DATA_HOME: '/data',
        XDG_CACHE_HOME: '/cache',
      },
    })).toEqual({
      configDir: '/home/tester/.voiceclaw',
      configFile: '/home/tester/.voiceclaw/bridge.json',
      systemdDir: '/config/systemd/user',
      unitFile: '/config/systemd/user/voiceclaw-companion-bridge.service',
      autostartDir: '/config/autostart',
      autostartFile: '/config/autostart/voiceclaw-companion.desktop',
      dataDir: '/data/voiceclaw-companion',
      cacheDir: '/cache/voiceclaw-companion',
    });
  });

  it('removes only the exact compatibility config file', async () => {
    await store.write(validSetup);
    await fs.writeFile(join(paths.configDir, 'keep.txt'), 'keep');
    await store.remove();
    expect(await pathExists(paths.configFile)).toBe(false);
    expect(await fs.readFile(join(paths.configDir, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('updates only validated Tailscale pairing fields', async () => {
    const before = await store.write(validSetup);
    const after = await store.updateNetwork(
      'openclaw.tailnet.ts.net',
      'https://openclaw.tailnet.ts.net:12321',
    );
    expect(after.gatewayToken).toBe(before.gatewayToken);
    expect(after.tailscaleDNSName).toBe('openclaw.tailnet.ts.net');
    expect(after.tailscaleBaseURL).toBe('https://openclaw.tailnet.ts.net:12321');
    await expect(store.updateNetwork('bad\nname', 'https://example.test'))
      .rejects.toThrow('Tailscale DNS name is invalid.');
  });
});
