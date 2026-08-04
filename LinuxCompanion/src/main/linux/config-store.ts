import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeSetupInput,
  type BridgeConfig,
  type SetupInput,
  type RealtimeAuthInput,
} from '../../shared/contracts';
import type { LinuxOwnedPaths } from './paths';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DNS_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u;

type StoredConfig = Partial<Record<keyof BridgeConfig, unknown>>;

function validToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

function storedText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function storedBasePath(value: unknown): string {
  const path = storedText(value).trim();
  return path === '' || /^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/u.test(path)
    ? path.replace(/\/+$/u, '')
    : '';
}

export class ConfigStore {
  public constructor(private readonly paths: LinuxOwnedPaths) {}

  public async read(): Promise<BridgeConfig> {
    const raw: StoredConfig = await this.readRaw().catch((): StoredConfig => ({}));
    const defaults: SetupInput = {
      port: 12_321,
      openClawInstallPath: join(homedir(), '.openclaw'),
      openClawAgentName: 'main',
      realtimeAuthMode: 'openclaw-oauth',
      realtimeAuthFallbackToAPIKey: false,
      openAIAPIKey: '',
    };

    const normalized = normalizeSetupInput({
      ...defaults,
      ...raw,
      openAIAPIKey: storedText(raw.openAIAPIKey),
    });

    return {
      ...normalized,
      gatewayToken: validToken(raw.gatewayToken)
        ? raw.gatewayToken
        : randomBytes(32).toString('base64url'),
      tailscaleDNSName: storedText(raw.tailscaleDNSName),
      tailscaleBaseURL: storedText(raw.tailscaleBaseURL),
      basePath: storedBasePath(raw.basePath),
      watchPublicBridgeURL: storedText(raw.watchPublicBridgeURL),
    };
  }

  public async write(input: SetupInput): Promise<BridgeConfig> {
    const existing: StoredConfig = await this.readRaw().catch((): StoredConfig => ({}));
    const normalized = normalizeSetupInput(input);
    const next: BridgeConfig = {
      ...normalized,
      openAIAPIKey: normalized.openAIAPIKey || storedText(existing.openAIAPIKey),
      gatewayToken: validToken(existing.gatewayToken)
        ? existing.gatewayToken
        : randomBytes(32).toString('base64url'),
      tailscaleDNSName: storedText(existing.tailscaleDNSName),
      tailscaleBaseURL: storedText(existing.tailscaleBaseURL),
      basePath: storedBasePath(existing.basePath),
      watchPublicBridgeURL: storedText(existing.watchPublicBridgeURL),
    };
    return this.writeConfig(next);
  }

  public async updateNetwork(
    dnsName: string,
    baseURL: string,
    basePath = '',
  ): Promise<BridgeConfig> {
    const normalizedDNS = dnsName.trim().replace(/\.$/u, '');
    const normalizedURL = baseURL.trim();

    if (normalizedDNS === '' && normalizedURL === '') {
      const current = await this.read();
      return this.writeConfig({
        ...current,
        tailscaleDNSName: '',
        tailscaleBaseURL: '',
        basePath: '',
      });
    }

    if (
      normalizedDNS.length > 253
      || !DNS_PATTERN.test(normalizedDNS)
      || /[\r\n]/u.test(dnsName)
    ) {
      throw new Error('Tailscale DNS name is invalid.');
    }

    let parsedURL: URL;
    try {
      parsedURL = new URL(normalizedURL);
    } catch {
      throw new Error('Tailscale base URL is invalid.');
    }
    if (
      parsedURL.protocol !== 'https:'
      || parsedURL.hostname.toLowerCase() !== normalizedDNS.toLowerCase()
      || parsedURL.username !== ''
      || parsedURL.password !== ''
    ) {
      throw new Error('Tailscale base URL is invalid.');
    }

    const current = await this.read();
    return this.writeConfig({
      ...current,
      tailscaleDNSName: normalizedDNS,
      tailscaleBaseURL: normalizedURL,
      basePath: storedBasePath(basePath),
    });
  }

  public async updateRealtimeAuth(input: RealtimeAuthInput): Promise<BridgeConfig> {
    const current = await this.read();
    return this.writeConfig({
      ...current,
      realtimeAuthMode: input.realtimeAuthMode,
      realtimeAuthFallbackToAPIKey: input.realtimeAuthFallbackToAPIKey,
      openAIAPIKey: input.openAIAPIKey.trim() || current.openAIAPIKey,
      watchPublicBridgeURL: input.watchPublicBridgeURL.trim(),
    });
  }

  public async remove(): Promise<void> {
    await unlink(this.paths.configFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  }

  private async readRaw(): Promise<StoredConfig> {
    return JSON.parse(await readFile(this.paths.configFile, 'utf8')) as StoredConfig;
  }

  private async writeConfig(next: BridgeConfig): Promise<BridgeConfig> {
    const tempFile = `${this.paths.configFile}.tmp`;
    await mkdir(this.paths.configDir, { recursive: true, mode: 0o700 });
    await chmod(this.paths.configDir, 0o700);
    await writeFile(tempFile, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(tempFile, 0o600);
    await rename(tempFile, this.paths.configFile);
    return next;
  }
}
