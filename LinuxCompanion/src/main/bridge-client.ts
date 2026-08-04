import type {
  ArtifactSummary,
  PairingOptions,
  RouteTaskSummary,
} from '../shared/contracts';

const MAX_ERROR_DETAIL = 4_096;

type UnknownRecord = Record<string, unknown>;

export class BridgeRequestError extends Error {
  public readonly code = 'bridge_request_failed';

  public constructor(public readonly detail: string) {
    super('The VoiceClaw bridge request failed.');
  }
}

export interface BridgeClientOptions {
  port: number;
  token: string;
  basePath?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function text(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function routeTask(value: unknown): RouteTaskSummary {
  const task = record(value);
  const target = record(task.target);
  const timestamps = record(task.timestamps);
  return {
    taskID: text(task.taskID),
    state: text(task.state),
    runtime: text(target.runtime || record(task.runtime).name || task.runtime),
    route: text(target.route),
    progress: text(task.progress),
    result: text(task.result),
    error: text(task.error),
    updatedAt: number(timestamps.updatedAt),
  };
}

function artifact(value: unknown): ArtifactSummary {
  const item = record(value);
  return {
    artifactID: text(item.artifactID),
    taskID: text(item.taskID),
    displayName: text(item.displayName),
    contentType: text(item.contentType),
    byteCount: number(item.byteCount),
    sha256: text(item.sha256),
    createdAt: number(item.admittedAt || item.createdAt),
  };
}

export class BridgeClient {
  private readonly origin: string;
  private readonly baseURL: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(private readonly options: BridgeClientOptions) {
    this.origin = `http://127.0.0.1:${options.port}`;
    const basePath = options.basePath?.trim().replace(/\/+$/u, '') ?? '';
    this.baseURL = `${this.origin}${basePath}`;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  public health(): Promise<UnknownRecord> {
    return this.request('/healthz', { authenticated: false, originOnly: true });
  }

  public status(): Promise<UnknownRecord> {
    return this.request('/realtime/status');
  }

  public authStatus(): Promise<UnknownRecord> {
    return this.request('/realtime/auth/status');
  }

  public setupPayload(options: PairingOptions): Promise<UnknownRecord> {
    const query = new URLSearchParams({
      include_openai_key: options.includeOpenAIAPIKey ? '1' : '0',
      include_cerebras_key: options.includeCerebrasAPIKey ? '1' : '0',
      include_bridge_credentials: options.includeBridgeCredentials ? '1' : '0',
      include_chatgpt_oauth: options.includeChatGPTOAuth ? '1' : '0',
    });
    return this.request(`/realtime/setup-payload?${query.toString()}`);
  }

  public async tasks(): Promise<RouteTaskSummary[]> {
    const response = await this.request('/realtime/tasks?limit=100');
    return Array.isArray(response.tasks) ? response.tasks.map(routeTask) : [];
  }

  public async artifacts(): Promise<ArtifactSummary[]> {
    const response = await this.request('/realtime/artifacts');
    return Array.isArray(response.artifacts) ? response.artifacts.map(artifact) : [];
  }

  public async deleteArtifact(artifactID: string): Promise<void> {
    await this.request(`/realtime/artifacts/${encodeURIComponent(artifactID)}`, {
      method: 'DELETE',
    });
  }

  public async emptyArtifacts(): Promise<void> {
    const confirmation = await this.request('/realtime/artifacts/empty-confirmation', {
      method: 'POST',
    });
    const token = text(confirmation.confirmationToken);
    if (!token) {
      throw new BridgeRequestError('The bridge did not return an empty-inbox confirmation.');
    }
    await this.request('/realtime/artifacts', {
      method: 'DELETE',
      headers: { 'X-VoiceClaw-Empty-Confirmation': token },
    });
  }

  private async request(
    path: string,
    options: {
      authenticated?: boolean;
      originOnly?: boolean;
      method?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<UnknownRecord> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    const headers: Record<string, string> = { ...options.headers };
    if (options.authenticated !== false) {
      headers.Authorization = `Bearer ${this.options.token}`;
    }

    try {
      const response = await this.fetchImplementation(`${options.originOnly ? this.origin : this.baseURL}${path}`, {
        method: options.method ?? 'GET',
        headers,
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        throw new BridgeRequestError(
          `Bridge returned HTTP ${response.status}: ${body}`.slice(0, MAX_ERROR_DETAIL),
        );
      }
      try {
        return record(JSON.parse(body));
      } catch {
        throw new BridgeRequestError(
          `Bridge returned an invalid JSON response: ${body}`.slice(0, MAX_ERROR_DETAIL),
        );
      }
    } catch (error) {
      if (error instanceof BridgeRequestError) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new BridgeRequestError(detail.slice(0, MAX_ERROR_DETAIL));
    } finally {
      clearTimeout(timeout);
    }
  }
}
