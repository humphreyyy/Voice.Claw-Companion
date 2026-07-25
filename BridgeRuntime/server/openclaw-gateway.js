import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { GatewayClient } from '@openclaw/gateway-client';
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from '@openclaw/gateway-protocol/client-info';
import { PROTOCOL_VERSION } from '@openclaw/gateway-protocol/version';

import { configuredOpenClawAgents, parseOpenClawConfig } from './openclaw-config.js';

const DEFAULT_OPENCLAW_BIN = '/opt/homebrew/bin/openclaw';
const DEFAULT_OPENCLAW_CONFIG = join(homedir(), '.openclaw', 'openclaw.json');
const DIRECT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const MAX_CLI_OUTPUT_BYTES = 16 * 1024 * 1024;
const CAPABILITY_CACHE_TTL_MS = 5000;

const OPENCLAW_OPERATION_METHODS = Object.freeze({
  agentTurn: 'agent',
  abortRun: 'chat.abort',
  listAgents: 'agents.list',
  readConfiguration: 'config.get',
  listSessions: 'sessions.list',
  createSession: 'sessions.create',
  resolveSession: 'sessions.resolve',
  patchSession: 'sessions.patch',
  compactSession: 'sessions.compact',
  steerSession: 'sessions.steer',
  abortSession: 'sessions.abort',
});

let directConnection = null;
let capabilityCache = null;
let spawnRunner = spawn;

function nonEmptyString(value) {
  return String(value ?? '').trim();
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return '';
  }
}

function safeStat(path) {
  try {
    const stat = statSync(path);
    return { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) };
  } catch {
    return { size: 0, mtimeMs: 0 };
  }
}

function readConfiguration(configPath) {
  try {
    return parseOpenClawConfig(readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

function environmentSecret(reference, env = process.env) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return '';
  if (nonEmptyString(reference.source).toLowerCase() !== 'env') return '';
  const key = nonEmptyString(reference.id || reference.name || reference.key || reference.variable);
  return key ? nonEmptyString(env[key]) : '';
}

function gatewayAuthentication(parsed, env = process.env) {
  const auth = parsed?.gateway?.auth && typeof parsed.gateway.auth === 'object'
    ? parsed.gateway.auth
    : {};
  const mode = nonEmptyString(auth.mode || 'token').toLowerCase();
  const token = nonEmptyString(
    env.VOICECLAW_OPENCLAW_GATEWAY_TOKEN
      || env.OPENCLAW_GATEWAY_TOKEN
      || (typeof auth.token === 'string' ? auth.token : environmentSecret(auth.token, env)),
  );
  const password = nonEmptyString(
    env.VOICECLAW_OPENCLAW_GATEWAY_PASSWORD
      || env.OPENCLAW_GATEWAY_PASSWORD
      || (typeof auth.password === 'string' ? auth.password : environmentSecret(auth.password, env)),
  );
  return {
    mode,
    ...(token ? { token } : {}),
    ...(password ? { password } : {}),
    directAvailable: mode === 'none' || Boolean(token) || Boolean(password),
  };
}

function gatewayURL(parsed, env = process.env) {
  const explicit = nonEmptyString(env.VOICECLAW_OPENCLAW_GATEWAY_URL || env.OPENCLAW_GATEWAY_URL);
  if (explicit) return explicit;
  const port = Number(parsed?.gateway?.port);
  return `ws://127.0.0.1:${Number.isSafeInteger(port) && port > 0 ? port : 18789}`;
}

function authFingerprint(auth) {
  return createHash('sha256')
    .update(`${auth.mode}\0${auth.token || ''}\0${auth.password || ''}`)
    .digest('hex')
    .slice(0, 16);
}

export function resolveOpenClawRuntimeIdentity({
  bin = process.env.OPENCLAW_BIN || DEFAULT_OPENCLAW_BIN,
  configPath = process.env.OPENCLAW_CONFIG || DEFAULT_OPENCLAW_CONFIG,
} = {}) {
  const executable = nonEmptyString(bin);
  const realpath = safeRealpath(executable);
  const executableStat = safeStat(realpath || executable);
  const configRealpath = safeRealpath(configPath) || configPath;
  const configStat = safeStat(configRealpath);
  const parsed = readConfiguration(configRealpath);
  const auth = gatewayAuthentication(parsed);
  const url = gatewayURL(parsed);
  const key = createHash('sha256')
    .update([
      realpath || executable,
      executableStat.size,
      executableStat.mtimeMs,
      configRealpath,
      configStat.size,
      configStat.mtimeMs,
      url,
      authFingerprint(auth),
    ].join('\0'))
    .digest('hex');
  return {
    key,
    executable,
    realpath,
    executableExists: Boolean(realpath && existsSync(realpath)),
    executableSize: executableStat.size,
    executableModifiedAt: executableStat.mtimeMs,
    configPath: configRealpath,
    configModifiedAt: configStat.mtimeMs,
    url,
    auth,
    parsed,
  };
}

export class OpenClawRuntimeError extends Error {
  constructor(code, message, {
    status = 503,
    retryable = false,
    subsystem = 'openclaw-gateway',
    details = undefined,
    cause = undefined,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'OpenClawRuntimeError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.subsystem = subsystem;
    this.details = details;
  }
}

function classifyRuntimeError(error, context = {}) {
  if (error instanceof OpenClawRuntimeError) return error;
  const message = nonEmptyString(error?.message || error) || 'OpenClaw Gateway request failed.';
  const gatewayCode = nonEmptyString(error?.gatewayCode || error?.code).toUpperCase();
  const text = `${gatewayCode} ${message}`;
  const baseDetails = {
    method: context.method || '',
    transport: context.transport || '',
    gatewayCode,
    ...(error?.details !== undefined ? { gatewayDetails: error.details } : {}),
  };
  if (/unknown method|method not found|unsupported method|INVALID_REQUEST.*method/i.test(text)) {
    return new OpenClawRuntimeError('session_rpc_unavailable', message, {
      status: 501,
      retryable: false,
      details: baseDetails,
      cause: error,
    });
  }
  if (/protocol|hello-ok|incompatible|unsupported version/i.test(text)) {
    return new OpenClawRuntimeError('gateway_protocol_mismatch', message, {
      status: 409,
      retryable: false,
      details: baseDetails,
      cause: error,
    });
  }
  if (/unauthori[sz]ed|forbidden|authentication|invalid token|missing token|AUTH/i.test(text)) {
    return new OpenClawRuntimeError('gateway_authentication_failed', message, {
      status: 401,
      retryable: false,
      details: baseDetails,
      cause: error,
    });
  }
  if (/schema|newer state|database version|unsupported config/i.test(text)) {
    return new OpenClawRuntimeError('unsupported_newer_state_schema', message, {
      status: 409,
      retryable: false,
      details: baseDetails,
      cause: error,
    });
  }
  if (/agent.*not found|unknown agent/i.test(text)) {
    return new OpenClawRuntimeError('agent_not_found', message, {
      status: 404,
      retryable: false,
      details: baseDetails,
      cause: error,
    });
  }
  if (/timeout|timed out|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|socket|closed|connect/i.test(text)) {
    return new OpenClawRuntimeError('gateway_unavailable', message, {
      status: 503,
      retryable: true,
      details: baseDetails,
      cause: error,
    });
  }
  return new OpenClawRuntimeError('runtime_request_failed', message, {
    status: Number(error?.status) || 502,
    retryable: error?.retryable === true,
    details: baseDetails,
    cause: error,
  });
}

function disconnectDirectConnection() {
  if (!directConnection) return;
  directConnection.client.stop();
  directConnection = null;
}

async function connectDirect(identity) {
  if (!identity.executableExists) {
    throw new OpenClawRuntimeError(
      'runtime_executable_missing',
      `The configured OpenClaw executable was not found: ${identity.executable || '(empty)'}.`,
      { status: 503, retryable: false },
    );
  }
  if (!identity.auth.directAvailable) {
    throw new OpenClawRuntimeError(
      'gateway_direct_auth_unavailable',
      'The OpenClaw Gateway credential is not directly resolvable; use the exact OpenClaw CLI compatibility transport.',
      { status: 503, retryable: false },
    );
  }
  if (directConnection?.key === identity.key && directConnection.connected) return directConnection;
  if (directConnection?.key !== identity.key) disconnectDirectConnection();
  if (directConnection?.connecting) return directConnection.connecting;

  let resolveHello;
  let rejectHello;
  const helloPromise = new Promise((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  const client = new GatewayClient({
    url: identity.url,
    ...(identity.auth.token ? { token: identity.auth.token } : {}),
    ...(identity.auth.password ? { password: identity.auth.password } : {}),
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    connectChallengeTimeoutMs: DIRECT_CONNECT_TIMEOUT_MS,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: 'VoiceClaw Realtime Companion',
    clientVersion: '1',
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    role: 'operator',
    scopes: ['operator.admin'],
    onHelloOk: (hello) => resolveHello(hello),
    onConnectError: (error) => rejectHello(error),
    onReconnectPaused: (info) => rejectHello(new Error(info.reason || info.detailCode || 'Gateway reconnect paused.')),
  });
  const state = {
    key: identity.key,
    client,
    identity,
    connected: false,
    hello: null,
    connecting: null,
  };
  directConnection = state;
  state.connecting = (async () => {
    client.start();
    let timer;
    try {
      const hello = await Promise.race([
        helloPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('OpenClaw Gateway hello timed out.')), DIRECT_CONNECT_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      state.connected = true;
      state.hello = hello;
      return state;
    } catch (error) {
      client.stop();
      if (directConnection === state) directConnection = null;
      throw classifyRuntimeError(error, { transport: 'gateway-client' });
    } finally {
      if (timer) clearTimeout(timer);
      state.connecting = null;
    }
  })();
  return state.connecting;
}

function parseCLIJSON(stdout, stderr) {
  const output = nonEmptyString(stdout);
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new OpenClawRuntimeError('invalid_runtime_response', 'OpenClaw CLI returned invalid JSON.', {
      status: 502,
      details: {
        stdoutPreview: output.slice(0, 512),
        stderrPreview: nonEmptyString(stderr).slice(0, 512),
      },
      cause: error,
    });
  }
}

function callViaCLI(identity, {
  method,
  params = {},
  expectFinal = false,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  onAccepted = null,
  signal = null,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OpenClawRuntimeError('runtime_request_cancelled', 'OpenClaw request was cancelled.', {
        status: 409,
        retryable: true,
      }));
      return;
    }
    const args = [
      'gateway', 'call', method,
      '--json',
      '--params', JSON.stringify(params || {}),
      '--timeout', String(Math.max(1, Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS)),
    ];
    if (expectFinal) args.push('--expect-final');
    let stdout = '';
    let stderr = '';
    let settled = false;
    let accepted = false;
    const child = spawnRunner(identity.realpath || identity.executable, args, {
      env: {
        ...process.env,
        OPENCLAW_CONFIG: identity.configPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => {
      child.kill('SIGTERM');
      finish(() => reject(new OpenClawRuntimeError(
        'runtime_request_cancelled',
        'OpenClaw request was cancelled.',
        { status: 409, retryable: true },
      )));
    };
    child.once('spawn', () => {
      if (typeof onAccepted !== 'function' || accepted) return;
      accepted = true;
      onAccepted({
        status: 'accepted',
        runId: nonEmptyString(params.idempotencyKey),
        sessionKey: nonEmptyString(params.sessionKey || params.key),
      });
    });
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_CLI_OUTPUT_BYTES) stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_CLI_OUTPUT_BYTES) stderr += String(chunk);
    });
    child.once('error', (error) => finish(() => reject(classifyRuntimeError(error, {
      method,
      transport: 'exact-binary-cli',
    }))));
    child.once('close', (code) => finish(() => {
      try {
        const payload = parseCLIJSON(stdout, stderr);
        if (code !== 0 || payload?.ok === false) {
          const runtimeError = payload?.error && typeof payload.error === 'object'
            ? Object.assign(new Error(payload.error.message || 'OpenClaw Gateway request failed.'), {
                code: payload.error.code,
                gatewayCode: payload.error.code,
                details: payload.error.details,
                retryable: payload.error.retryable,
              })
            : new Error(nonEmptyString(stderr) || `OpenClaw CLI exited with status ${code}.`);
          reject(classifyRuntimeError(runtimeError, { method, transport: 'exact-binary-cli' }));
          return;
        }
        resolve(payload);
      } catch (error) {
        reject(classifyRuntimeError(error, { method, transport: 'exact-binary-cli' }));
      }
    }));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function shouldUseCLIFallback(error) {
  return error?.code === 'gateway_direct_auth_unavailable'
    || error?.code === 'gateway_protocol_mismatch'
    || error?.code === 'gateway_authentication_failed'
    || error?.code === 'gateway_unavailable';
}

export async function callOpenClawGateway({
  method,
  params = {},
  expectFinal = false,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  onAccepted = null,
  signal = null,
  onSignalAbort = null,
} = {}) {
  const normalizedMethod = nonEmptyString(method);
  if (!normalizedMethod) throw new OpenClawRuntimeError('invalid_request', 'Gateway method is required.', { status: 422 });
  const identity = resolveOpenClawRuntimeIdentity();
  let connection;
  try {
    connection = await connectDirect(identity);
  } catch (error) {
    const classified = classifyRuntimeError(error, { method: normalizedMethod, transport: 'gateway-client' });
    if (!shouldUseCLIFallback(classified)) throw classified;
    return callViaCLI(identity, {
      method: normalizedMethod,
      params,
      expectFinal,
      timeoutMs,
      onAccepted,
      signal,
    });
  }

  const request = (requestMethod, requestParams, options = {}) => connection.client.request(
    requestMethod,
    requestParams,
    {
      timeoutMs: options.timeoutMs ?? timeoutMs,
      expectFinal: options.expectFinal ?? false,
    },
  );
  let abortListener = null;
  if (signal && typeof onSignalAbort === 'function') {
    abortListener = () => {
      Promise.resolve(onSignalAbort(request)).catch(() => {});
    };
    signal.addEventListener('abort', abortListener, { once: true });
  }
  try {
    return await connection.client.request(normalizedMethod, params, {
      timeoutMs,
      expectFinal,
      ...(onAccepted ? { onAccepted } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw classifyRuntimeError(error, { method: normalizedMethod, transport: 'gateway-client' });
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}

function gatewayAgentRows(value) {
  if (Array.isArray(value)) return value;
  for (const candidate of [value?.agents, value?.data?.agents, value?.result?.agents]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function gatewayConfiguration(value) {
  for (const candidate of [value?.parsed, value?.config, value?.data?.parsed, value?.result?.parsed]) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
  }
  return null;
}

function mergeAgentCatalog({ configured, runtime, selectedAgentID }) {
  const records = new Map();
  const add = (agent, source) => {
    const id = nonEmptyString(agent?.id || agent?.agentId || agent?.agentID);
    if (!id) return;
    const key = id.toLowerCase();
    const current = records.get(key) || {
      runtime: 'openclaw',
      id,
      label: nonEmptyString(agent?.name || agent?.label || id),
      workspace: '',
      isDefault: false,
      configured: false,
      runtimeVisible: false,
      sources: [],
    };
    current.workspace = nonEmptyString(agent?.workspace) || current.workspace;
    current.isDefault ||= agent?.isDefault === true;
    current.configured ||= source.startsWith('config');
    current.runtimeVisible ||= source.startsWith('gateway');
    if (!current.sources.includes(source)) current.sources.push(source);
    records.set(key, current);
  };

  for (const agent of configured?.agents || []) {
    add(agent, (agent.sources || []).map((source) => `config:${source}`).join('+') || 'config');
  }
  for (const agent of gatewayAgentRows(runtime)) add(agent, 'gateway:agents.list');

  const runtimeDefaultID = nonEmptyString(runtime?.defaultId || runtime?.defaultID);
  const configuredDefaultID = nonEmptyString(configured?.defaultAgentID);
  const selected = nonEmptyString(selectedAgentID);
  const defaultID = runtimeDefaultID || configuredDefaultID || selected || records.values().next().value?.id || 'main';
  if (!records.has(defaultID.toLowerCase())) {
    add({ id: defaultID, isDefault: true }, runtimeDefaultID ? 'gateway:default' : 'config:default');
  }
  for (const record of records.values()) record.isDefault = record.id.toLowerCase() === defaultID.toLowerCase();
  return {
    agents: [...records.values()].sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      return left.label.localeCompare(right.label);
    }),
    defaultAgentID: defaultID,
  };
}

export async function discoverOpenClawAgents({ selectedAgentID = '' } = {}) {
  const identity = resolveOpenClawRuntimeIdentity();
  const [configResult, runtimeResult] = await Promise.allSettled([
    callOpenClawGateway({ method: 'config.get', params: {}, timeoutMs: 15000 }),
    callOpenClawGateway({ method: 'agents.list', params: {}, timeoutMs: 15000 }),
  ]);
  const gatewayConfig = configResult.status === 'fulfilled' ? gatewayConfiguration(configResult.value) : null;
  const parsed = gatewayConfig || identity.parsed;
  const configured = parsed ? configuredOpenClawAgents(parsed) : { agents: [], defaultAgentID: '' };
  const runtime = runtimeResult.status === 'fulfilled' ? runtimeResult.value : null;
  const catalog = mergeAgentCatalog({ configured, runtime, selectedAgentID });
  if (catalog.agents.length === 0) {
    throw new OpenClawRuntimeError('agent_catalog_unavailable', 'OpenClaw did not expose an agent catalog.', {
      status: 503,
      retryable: true,
      details: {
        configError: configResult.status === 'rejected' ? nonEmptyString(configResult.reason?.message) : '',
        runtimeError: runtimeResult.status === 'rejected' ? nonEmptyString(runtimeResult.reason?.message) : '',
      },
    });
  }
  return {
    ...catalog,
    source: runtime ? (gatewayConfig ? 'gateway-config-and-runtime' : 'runtime-with-config-fallback') : 'config-fallback',
    degradedReasons: [
      ...(configResult.status === 'rejected' ? ['gateway_config_unavailable'] : []),
      ...(runtimeResult.status === 'rejected' ? ['gateway_agent_catalog_unavailable'] : []),
    ],
    identity,
  };
}

export async function openClawRuntimeCapabilities({ selectedAgentID = '', force = false } = {}) {
  const identity = resolveOpenClawRuntimeIdentity();
  if (!force && capabilityCache?.identityKey === identity.key
      && Date.now() - capabilityCache.createdAt < CAPABILITY_CACHE_TTL_MS) {
    return capabilityCache.value;
  }
  const [health, catalog] = await Promise.allSettled([
    callOpenClawGateway({ method: 'health', params: {}, timeoutMs: 10000 }),
    discoverOpenClawAgents({ selectedAgentID }),
  ]);
  const activeConnection = directConnection?.key === identity.key && directConnection.connected
    ? directConnection
    : null;
  const degradedReasons = [];
  if (health.status === 'rejected') degradedReasons.push(health.reason?.code || 'gateway_health_unavailable');
  if (catalog.status === 'rejected') degradedReasons.push(catalog.reason?.code || 'agent_catalog_unavailable');
  if (catalog.status === 'fulfilled') degradedReasons.push(...catalog.value.degradedReasons);
  const status = health.status === 'fulfilled' ? (degradedReasons.length ? 'degraded' : 'ready') : 'unavailable';
  const value = {
    contractVersion: 1,
    runtime: 'openclaw',
    status,
    retryable: health.status === 'rejected' ? health.reason?.retryable === true : false,
    transport: activeConnection ? 'gateway-client' : 'exact-binary-cli',
    protocol: activeConnection ? {
      negotiated: activeConnection.hello?.protocol ?? PROTOCOL_VERSION,
      client: PROTOCOL_VERSION,
    } : { client: PROTOCOL_VERSION },
    runtimeIdentity: {
      executable: identity.executable,
      realpath: identity.realpath,
      executableModifiedAt: identity.executableModifiedAt,
      configPath: identity.configPath,
      configModifiedAt: identity.configModifiedAt,
    },
    verifiedMethods: [
      ...(health.status === 'fulfilled' ? ['health'] : []),
      ...(catalog.status === 'fulfilled' ? ['agents.list', 'config.get'] : []),
    ],
    operations: Object.fromEntries(Object.keys(OPENCLAW_OPERATION_METHODS).map((key) => [key, true])),
    agentCatalogSource: catalog.status === 'fulfilled' ? catalog.value.source : 'unavailable',
    agents: catalog.status === 'fulfilled' ? catalog.value.agents : [],
    defaultAgentID: catalog.status === 'fulfilled' ? catalog.value.defaultAgentID : '',
    degradedReasons: [...new Set(degradedReasons)],
    checkedAt: Date.now(),
  };
  capabilityCache = { identityKey: identity.key, createdAt: Date.now(), value };
  return value;
}

export const __openClawGatewayTestHooks = Object.freeze({
  gatewayAuthentication,
  gatewayURL,
  mergeAgentCatalog,
  classifyRuntimeError,
  setSpawnForTest(runner) {
    spawnRunner = runner;
  },
  resetSpawnForTest() {
    spawnRunner = spawn;
  },
  resetConnectionsForTest() {
    disconnectDirectConnection();
    capabilityCache = null;
  },
});
