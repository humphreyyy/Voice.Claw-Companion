// @vitest-environment node

import { promises as fs } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { CommandResult, CommandRunner } from './command-runner';
import { TailscaleInspector } from './tailscale';

function fakeRunner(
  calls: Array<[string, string[]]>,
  outputs: Record<string, string>,
): CommandRunner {
  return {
    async run(executable, args): Promise<CommandResult> {
      const copiedArgs = [...args];
      calls.push([executable, copiedArgs]);
      return {
        stdout: outputs[copiedArgs.join(' ')] ?? '',
        stderr: '',
        exitCode: 0,
      };
    },
  };
}

function failingRunner(
  calls: Array<[string, string[]]>,
  failure: NodeJS.ErrnoException,
): CommandRunner {
  return {
    async run(executable, args): Promise<CommandResult> {
      calls.push([executable, [...args]]);
      throw failure;
    },
  };
}

describe('TailscaleInspector', () => {
  it('uses exactly the two approved read-only Tailscale commands', async () => {
    const calls: Array<[string, string[]]> = [];
    const runner = fakeRunner(calls, {
      'status --json': JSON.stringify({
        BackendState: 'Running',
        Self: { DNSName: 'openclaw.tailnet.ts.net.' },
      }),
      'serve status --json': JSON.stringify({
        Web: {
          'openclaw.tailnet.ts.net:12321': {
            Handlers: { '/': { Proxy: 'http://127.0.0.1:12321' } },
          },
        },
      }),
    });

    const status = await new TailscaleInspector(runner).status(12_321);

    expect(calls).toEqual([
      ['tailscale', ['status', '--json']],
      ['tailscale', ['serve', 'status', '--json']],
    ]);
    expect(status.connected).toBe(true);
    expect(status.serveMapped).toBe(true);
    expect(status.serveURL).toBe('https://openclaw.tailnet.ts.net:12321');
  });

  it('treats missing Tailscale as a warning without a repair attempt', async () => {
    const calls: Array<[string, string[]]> = [];
    const runner = failingRunner(calls, Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const status = await new TailscaleInspector(runner).status(12_321);

    expect(calls).toEqual([['tailscale', ['status', '--json']]]);
    expect(status.installed).toBe(false);
    expect(status.summary).toBe('Tailscale CLI is not available.');
  });

  it('reuses an existing path-based Serve mapping without changing it', async () => {
    const calls: Array<[string, string[]]> = [];
    const runner = fakeRunner(calls, {
      'status --json': JSON.stringify({
        BackendState: 'Running',
        Self: { DNSName: 'openclaw-ubuntu.galago-stonecat.ts.net.' },
      }),
      'serve status --json': JSON.stringify({
        Web: {
          'openclaw-ubuntu.galago-stonecat.ts.net:443': {
            Handlers: { '/voice': { Proxy: 'http://127.0.0.1:3334/voice' } },
          },
        },
      }),
    });

    const status = await new TailscaleInspector(runner).status(3_334);

    expect(status.serveMapped).toBe(true);
    expect(status.serveBasePath).toBe('/voice');
    expect(status.serveURL).toBe('https://openclaw-ubuntu.galago-stonecat.ts.net/voice');
  });

  it('contains no mutating Tailscale command vocabulary', async () => {
    const source = await fs.readFile(new URL('./tailscale.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\[['"](?:up|down|set|reset)['"]/u);
    expect(source).not.toMatch(/\[['"]serve['"],\s*['"](?:--yes|reset|https)['"]/u);
  });
});
