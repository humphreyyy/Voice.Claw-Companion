export type ReadinessState =
  | 'ready'
  | 'working'
  | 'warning'
  | 'needs_action'
  | 'blocked'
  | 'unavailable'
  | 'idle';

export interface SetupInput {
  port: number;
  openClawInstallPath: string;
  openClawAgentName: string;
  realtimeAuthMode: 'api-key' | 'openclaw-oauth';
  realtimeAuthFallbackToAPIKey: boolean;
  openAIAPIKey: string;
}

export interface BridgeConfig extends SetupInput {
  gatewayToken: string;
  tailscaleDNSName: string;
  tailscaleBaseURL: string;
}

export interface PublicBridgeConfig extends Omit<SetupInput, 'openAIAPIKey'> {
  hasOpenAIAPIKey: boolean;
}

export interface StatusItem {
  id: string;
  label: string;
  state: ReadinessState;
  summary: string;
  detail: string;
  action?: string;
  path?: string;
}

export interface ServiceStatus {
  installed: boolean;
  enabled: boolean;
  active: boolean;
  loadState: string;
  activeState: string;
  subState: string;
  summary: string;
}

export interface TailscaleStatus {
  installed: boolean;
  connected: boolean;
  dnsName: string;
  serveURL: string;
  serveMapped: boolean;
  summary: string;
}

export interface RouteTaskSummary {
  taskID: string;
  state: string;
  runtime: string;
  route: string;
  progress: string;
  result: string;
  error: string;
  updatedAt: number;
}

export interface ArtifactSummary {
  artifactID: string;
  taskID: string;
  displayName: string;
  contentType: string;
  byteCount: number;
  sha256: string;
  createdAt: number;
}

export interface PairingOptions {
  includeOpenAIAPIKey: boolean;
  includeCerebrasAPIKey: boolean;
  includeBridgeCredentials: boolean;
  includeChatGPTOAuth: boolean;
}

export interface CompanionSnapshot {
  config: PublicBridgeConfig;
  service: ServiceStatus;
  tailscale: TailscaleStatus;
  access: StatusItem[];
  diagnostics: StatusItem[];
  tasks: RouteTaskSummary[];
  artifacts: ArtifactSummary[];
  pairingAvailable: boolean;
  checkedAt: number;
}

export interface VoiceClawDesktopAPI {
  getSnapshot(): Promise<CompanionSnapshot>;
  installAndStart(input: SetupInput): Promise<CompanionSnapshot>;
  restartBridge(): Promise<CompanionSnapshot>;
  resetBridge(confirmed: true): Promise<CompanionSnapshot>;
  suggestPort(): Promise<number>;
  setLaunchAtLogin(enabled: boolean): Promise<boolean>;
  getPairingPayload(options: PairingOptions): Promise<Record<string, unknown>>;
  deleteArtifact(artifactID: string): Promise<CompanionSnapshot>;
  emptyArtifactInbox(): Promise<CompanionSnapshot>;
  copyText(value: string): Promise<void>;
  openPath(path: string): Promise<void>;
  openURL(url: string): Promise<void>;
}

type UnknownSetupInput = {
  port?: unknown;
  openClawInstallPath?: unknown;
  openClawAgentName?: unknown;
  realtimeAuthMode?: unknown;
  realtimeAuthFallbackToAPIKey?: unknown;
  openAIAPIKey?: unknown;
};

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export function normalizeSetupInput(value: UnknownSetupInput): SetupInput {
  const port = typeof value.port === 'string' && value.port.trim() !== ''
    ? Number(value.port)
    : value.port;

  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
    throw new Error('Bridge port must be an integer from 1 through 65535.');
  }

  const openClawInstallPath = typeof value.openClawInstallPath === 'string'
    ? value.openClawInstallPath.trim()
    : '';
  if (!openClawInstallPath.startsWith('/')) {
    throw new Error('OpenClaw install path must be an absolute Linux path.');
  }

  const openClawAgentName = typeof value.openClawAgentName === 'string'
    ? value.openClawAgentName.trim()
    : '';
  if (
    openClawAgentName.length === 0
    || openClawAgentName.length > 128
    || CONTROL_CHARACTER.test(openClawAgentName)
  ) {
    throw new Error('OpenClaw agent is invalid.');
  }

  if (value.realtimeAuthMode !== 'api-key' && value.realtimeAuthMode !== 'openclaw-oauth') {
    throw new Error('Realtime authentication mode is invalid.');
  }
  if (typeof value.realtimeAuthFallbackToAPIKey !== 'boolean') {
    throw new Error('Realtime API key fallback must be a boolean.');
  }
  if (typeof value.openAIAPIKey !== 'string') {
    throw new Error('OpenAI API key must be a string.');
  }

  return {
    port: port as number,
    openClawInstallPath,
    openClawAgentName,
    realtimeAuthMode: value.realtimeAuthMode,
    realtimeAuthFallbackToAPIKey: value.realtimeAuthFallbackToAPIKey,
    openAIAPIKey: value.openAIAPIKey.trim(),
  };
}
