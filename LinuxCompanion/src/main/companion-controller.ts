import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

import type {
  ArtifactSummary,
  BridgeConfig,
  CompanionSnapshot,
  PairingOptions,
  PublicBridgeConfig,
  RouteTaskSummary,
  ServiceStatus,
  SetupInput,
  StatusItem,
  TailscaleStatus,
} from '../shared/contracts';
import type { LinuxOwnedPaths } from './linux/paths';
import type { BridgeLaunch } from './linux/systemd';

type UnknownRecord = Record<string, unknown>;

interface ConfigStoreLike {
  read(): Promise<BridgeConfig>;
  write(input: SetupInput): Promise<BridgeConfig>;
  updateNetwork(dnsName: string, baseURL: string): Promise<BridgeConfig>;
  remove(): Promise<void>;
}

interface TailscaleLike {
  status(port: number): Promise<TailscaleStatus>;
}

interface SystemdLike {
  installAndStart(launch: BridgeLaunch): Promise<ServiceStatus>;
  restart(): Promise<ServiceStatus>;
  status(): Promise<ServiceStatus>;
  logTail(lines: number): Promise<string>;
  remove(): Promise<void>;
}

interface AutostartLike {
  setEnabled(enabled: boolean, executablePath: string): Promise<boolean>;
}

interface DiagnosticsLike {
  check(
    config: BridgeConfig,
    service: ServiceStatus,
    bridge: UnknownRecord,
  ): Promise<StatusItem[]>;
}

export interface BridgeClientLike {
  health(): Promise<UnknownRecord>;
  status(): Promise<UnknownRecord>;
  authStatus(): Promise<UnknownRecord>;
  setupPayload(options: PairingOptions): Promise<Record<string, unknown>>;
  tasks(): Promise<RouteTaskSummary[]>;
  artifacts(): Promise<ArtifactSummary[]>;
  deleteArtifact(artifactID: string): Promise<void>;
  emptyArtifacts(): Promise<void>;
}

export interface CompanionControllerDependencies {
  configStore: ConfigStoreLike;
  tailscale: TailscaleLike;
  systemd: SystemdLike;
  autostart: AutostartLike;
  diagnostics: DiagnosticsLike;
  paths: LinuxOwnedPaths;
  executablePath: string;
  serviceEntryPath: string;
  bridgeClientFactory(config: BridgeConfig): BridgeClientLike;
  waitForHealth?: (client: BridgeClientLike, timeoutMs: number) => Promise<void>;
}

function fallbackConfig(): BridgeConfig {
  return {
    port: 12_321,
    openClawInstallPath: join(homedir(), '.openclaw'),
    openClawAgentName: 'main',
    realtimeAuthMode: 'openclaw-oauth',
    realtimeAuthFallbackToAPIKey: false,
    openAIAPIKey: '',
    gatewayToken: '',
    tailscaleDNSName: '',
    tailscaleBaseURL: '',
  };
}

function unavailableService(): ServiceStatus {
  return {
    installed: false,
    enabled: false,
    active: false,
    loadState: 'unknown',
    activeState: 'inactive',
    subState: 'unknown',
    summary: 'The systemd user service is unavailable.',
  };
}

function unavailableTailscale(): TailscaleStatus {
  return {
    installed: false,
    connected: false,
    dnsName: '',
    serveURL: '',
    serveMapped: false,
    summary: 'Tailscale status is unavailable.',
  };
}

function publicConfig(config: BridgeConfig): PublicBridgeConfig {
  return {
    port: config.port,
    openClawInstallPath: config.openClawInstallPath,
    openClawAgentName: config.openClawAgentName,
    realtimeAuthMode: config.realtimeAuthMode,
    realtimeAuthFallbackToAPIKey: config.realtimeAuthFallbackToAPIKey,
    hasOpenAIAPIKey: config.openAIAPIKey.length > 0,
  };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\bsk-[A-Za-z0-9_-]+\b/gu, '[REDACTED]')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]')
    .slice(0, 4_096);
}

function resultItem(
  id: string,
  label: string,
  result: PromiseSettledResult<unknown>,
): StatusItem {
  return result.status === 'fulfilled'
    ? {
      id,
      label,
      state: 'ready',
      summary: `${label} is available.`,
      detail: '',
    }
    : {
      id,
      label,
      state: 'warning',
      summary: `${label} is unavailable.`,
      detail: safeError(result.reason),
    };
}

async function defaultWaitForHealth(
  client: BridgeClientLike,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error('The bridge did not become healthy.');
  while (Date.now() < deadline) {
    try {
      if ((await client.health()).ok === true) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError;
}

export class CompanionController {
  public constructor(private readonly dependencies: CompanionControllerDependencies) {}

  public async getSnapshot(): Promise<CompanionSnapshot> {
    const config = await this.dependencies.configStore.read().catch(() => fallbackConfig());
    const client = this.dependencies.bridgeClientFactory(config);
    const [
      serviceResult,
      tailscaleResult,
      healthResult,
      statusResult,
      authResult,
      tasksResult,
      artifactsResult,
    ] = await Promise.allSettled([
      this.dependencies.systemd.status(),
      this.dependencies.tailscale.status(config.port),
      client.health(),
      client.status(),
      client.authStatus(),
      client.tasks(),
      client.artifacts(),
    ]);

    const service = serviceResult.status === 'fulfilled'
      ? serviceResult.value
      : unavailableService();
    const tailscale = tailscaleResult.status === 'fulfilled'
      ? tailscaleResult.value
      : unavailableTailscale();
    const health = healthResult.status === 'fulfilled' ? healthResult.value : {};
    const access = await this.dependencies.diagnostics.check(config, service, health)
      .catch((error: unknown): StatusItem[] => [{
        id: 'access',
        label: 'Access diagnostics',
        state: 'warning',
        summary: 'Access diagnostics are unavailable.',
        detail: safeError(error),
      }]);

    return {
      config: publicConfig(config),
      service,
      tailscale,
      access,
      diagnostics: [
        resultItem('bridge-health', 'Bridge health', healthResult),
        resultItem('bridge-status', 'Realtime status', statusResult),
        resultItem('bridge-auth', 'Realtime authentication', authResult),
      ],
      tasks: tasksResult.status === 'fulfilled' ? tasksResult.value : [],
      artifacts: artifactsResult.status === 'fulfilled' ? artifactsResult.value : [],
      pairingAvailable: service.active && tailscale.serveMapped && health.ok === true,
      checkedAt: Date.now(),
    };
  }

  public async installAndStart(input: SetupInput): Promise<CompanionSnapshot> {
    let config = await this.dependencies.configStore.write(input);
    const tailscale = await this.dependencies.tailscale.status(config.port)
      .catch(() => unavailableTailscale());
    config = await this.dependencies.configStore.updateNetwork(
      tailscale.serveMapped ? tailscale.dnsName : '',
      tailscale.serveMapped ? tailscale.serveURL : '',
    );
    await this.dependencies.systemd.installAndStart(this.launch());
    const client = this.dependencies.bridgeClientFactory(config);
    await (this.dependencies.waitForHealth ?? defaultWaitForHealth)(client, 15_000);
    return this.getSnapshot();
  }

  public async restartBridge(): Promise<CompanionSnapshot> {
    const config = await this.dependencies.configStore.read();
    await this.dependencies.systemd.restart();
    const client = this.dependencies.bridgeClientFactory(config);
    await (this.dependencies.waitForHealth ?? defaultWaitForHealth)(client, 15_000);
    return this.getSnapshot();
  }

  public async resetBridge(confirmed: true): Promise<CompanionSnapshot> {
    if (confirmed !== true) {
      throw new Error('Bridge reset requires explicit confirmation.');
    }
    await this.dependencies.systemd.remove();
    await this.dependencies.configStore.remove();
    await this.dependencies.autostart.setEnabled(false, this.dependencies.executablePath);
    await Promise.all([
      rm(this.dependencies.paths.dataDir, { recursive: true, force: true }),
      rm(this.dependencies.paths.cacheDir, { recursive: true, force: true }),
    ]);
    return this.getSnapshot();
  }

  public suggestPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        server.close((error) => error ? reject(error) : resolve(port));
      });
    });
  }

  public setLaunchAtLogin(enabled: boolean): Promise<boolean> {
    return this.dependencies.autostart.setEnabled(
      enabled,
      this.dependencies.executablePath,
    );
  }

  public async getPairingPayload(
    options: PairingOptions,
  ): Promise<Record<string, unknown>> {
    const config = await this.dependencies.configStore.read();
    return this.dependencies.bridgeClientFactory(config).setupPayload(options);
  }

  public async deleteArtifact(artifactID: string): Promise<CompanionSnapshot> {
    const config = await this.dependencies.configStore.read();
    await this.dependencies.bridgeClientFactory(config).deleteArtifact(artifactID);
    return this.getSnapshot();
  }

  public async emptyArtifactInbox(): Promise<CompanionSnapshot> {
    const config = await this.dependencies.configStore.read();
    await this.dependencies.bridgeClientFactory(config).emptyArtifacts();
    return this.getSnapshot();
  }

  private launch(): BridgeLaunch {
    return {
      executablePath: this.dependencies.executablePath,
      serviceEntryPath: this.dependencies.serviceEntryPath,
      configFile: this.dependencies.paths.configFile,
      dataDir: this.dependencies.paths.dataDir,
      cacheDir: this.dependencies.paths.cacheDir,
    };
  }
}
