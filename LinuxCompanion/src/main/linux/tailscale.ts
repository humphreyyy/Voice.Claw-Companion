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
    pairingCompatible: false,
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
    pairingCompatible: false,
    summary: 'Tailscale status could not be read.',
  };
}

interface SelectedProxy {
  publicBasePath: string;
  targetBasePath: string;
  publicPort: string;
}

function selectedProxy(value: UnknownRecord, port: number): SelectedProxy | undefined {
  const web = record(value.Web);
  if (!web) {
    return undefined;
  }

  const candidates: SelectedProxy[] = [];
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
          candidates.push({
            publicBasePath: normalizedHandler,
            targetBasePath: normalizedTarget,
            publicPort: webAddress.split(':').at(-1) || '443',
          });
        }
      } catch {
        continue;
      }
    }
  }

  return candidates.sort((left, right) => {
    const leftPathPenalty = left.publicBasePath === '' ? 0 : 1;
    const rightPathPenalty = right.publicBasePath === '' ? 0 : 1;
    if (leftPathPenalty !== rightPathPenalty) return leftPathPenalty - rightPathPenalty;
    return Number(left.publicPort) - Number(right.publicPort);
  })[0];
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
        pairingCompatible: false,
        summary: 'Tailscale is not connected.',
      };
    }

    let serveMapped = false;
    let serveBasePath = '';
    let servePublicBasePath = '';
    let serveURL = '';
    let pairingCompatible = false;
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
        serveBasePath = mapping.targetBasePath;
        servePublicBasePath = mapping.publicBasePath;
        pairingCompatible = mapping.publicBasePath === '';
        const portSuffix = mapping.publicPort === '443' ? '' : `:${mapping.publicPort}`;
        serveURL = `https://${dnsName}${portSuffix}${mapping.publicBasePath}`;
      }
    } catch {
      serveMapped = false;
      pairingCompatible = false;
    }

    return {
      installed: true,
      connected: true,
      dnsName,
      serveURL,
      serveMapped,
      pairingCompatible,
      serveBasePath,
      servePublicBasePath,
      summary: serveMapped
        ? pairingCompatible
          ? 'Tailscale Serve is mapped to the VoiceClaw bridge.'
          : `Tailscale Serve reaches this bridge under ${servePublicBasePath}, but iPhone WebRTC pairing requires a dedicated HTTPS origin or port.`
        : 'Tailscale is connected; Serve is not mapped to this bridge.',
    };
  }
}
