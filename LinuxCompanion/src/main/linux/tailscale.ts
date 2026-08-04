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

interface SelectedProxy {
  basePath: string;
  publicPort: string;
}

function selectedProxy(value: UnknownRecord, port: number): SelectedProxy | undefined {
  const web = record(value.Web);
  if (!web) {
    return undefined;
  }

  for (const [webAddress, webEntry] of Object.entries(web)) {
    const handlers = record(record(webEntry)?.Handlers);
    if (!handlers) continue;
    for (const [handlerPath, handler] of Object.entries(handlers)) {
      const proxy = record(handler)?.Proxy;
      if (typeof proxy !== 'string') continue;
      try {
        const target = new URL(proxy);
        if (target.hostname === '127.0.0.1' && Number(target.port) === port) {
          const normalizedHandler = handlerPath === '/' ? '' : handlerPath.replace(/\/+$/u, '');
          const normalizedTarget = target.pathname === '/' ? '' : target.pathname.replace(/\/+$/u, '');
          return {
            basePath: normalizedTarget || normalizedHandler,
            publicPort: webAddress.split(':').at(-1) || '443',
          };
        }
      } catch {
        continue;
      }
    }
  }
  return undefined;
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
    let serveBasePath = '';
    let serveURL = '';
    try {
      const serveResult = await this.runner.run(
        'tailscale',
        ['serve', 'status', '--json'],
        { timeoutMs: 5_000 },
      );
      const parsedServe = serveResult.exitCode === 0
        ? parseJSON(serveResult.stdout)
        : undefined;
      const mapping = parsedServe === undefined ? undefined : selectedProxy(parsedServe, port);
      serveMapped = mapping !== undefined;
      if (mapping) {
        serveBasePath = mapping.basePath;
        const portSuffix = mapping.publicPort === '443' ? '' : `:${mapping.publicPort}`;
        serveURL = `https://${dnsName}${portSuffix}${mapping.basePath}`;
      }
    } catch {
      serveMapped = false;
    }

    return {
      installed: true,
      connected: true,
      dnsName,
      serveURL,
      serveMapped,
      serveBasePath,
      summary: serveMapped
        ? 'Tailscale Serve is mapped to the VoiceClaw bridge.'
        : 'Tailscale is connected; Serve is not mapped to this bridge.',
    };
  }
}
