import type { TailscaleStatus } from '../../shared/contracts';
import type { CommandRunner } from './command-runner';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function parseJSON(value: string): UnknownRecord | undefined {
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function missingStatus(): TailscaleStatus {
  return {
    installed: false,
    connected: false,
    dnsName: '',
    serveURL: '',
    serveMapped: false,
    summary: 'Tailscale CLI is not available.',
  };
}

function malformedStatus(): TailscaleStatus {
  return {
    installed: true,
    connected: false,
    dnsName: '',
    serveURL: '',
    serveMapped: false,
    summary: 'Tailscale status could not be read.',
  };
}

function hasSelectedProxy(value: UnknownRecord, port: number): boolean {
  const web = record(value.Web);
  if (!web) {
    return false;
  }

  const expectedProxy = `http://127.0.0.1:${port}`;
  return Object.values(web).some((webEntry) => {
    const handlers = record(record(webEntry)?.Handlers);
    return handlers !== undefined && Object.values(handlers).some(
      (handler) => record(handler)?.Proxy === expectedProxy,
    );
  });
}

export class TailscaleInspector {
  public constructor(private readonly runner: CommandRunner) {}

  public async status(port: number): Promise<TailscaleStatus> {
    let statusResult;
    try {
      statusResult = await this.runner.run('tailscale', ['status', '--json'], {
        timeoutMs: 5_000,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return missingStatus();
      }
      return malformedStatus();
    }

    if (statusResult.exitCode !== 0) {
      return malformedStatus();
    }
    const parsedStatus = parseJSON(statusResult.stdout);
    const self = record(parsedStatus?.Self);
    const rawDNSName = typeof self?.DNSName === 'string' ? self.DNSName : '';
    const dnsName = rawDNSName.replace(/\.$/u, '');
    const connected = parsedStatus?.BackendState === 'Running' && dnsName !== '';
    if (!connected) {
      return {
        installed: true,
        connected: false,
        dnsName,
        serveURL: '',
        serveMapped: false,
        summary: 'Tailscale is not connected.',
      };
    }

    let serveMapped = false;
    try {
      const serveResult = await this.runner.run(
        'tailscale',
        ['serve', 'status', '--json'],
        { timeoutMs: 5_000 },
      );
      const parsedServe = serveResult.exitCode === 0
        ? parseJSON(serveResult.stdout)
        : undefined;
      serveMapped = parsedServe !== undefined && hasSelectedProxy(parsedServe, port);
    } catch {
      serveMapped = false;
    }

    return {
      installed: true,
      connected: true,
      dnsName,
      serveURL: serveMapped ? `https://${dnsName}:${port}` : '',
      serveMapped,
      summary: serveMapped
        ? 'Tailscale Serve is mapped to the VoiceClaw bridge.'
        : 'Tailscale is connected; Serve is not mapped to this bridge.',
    };
  }
}
