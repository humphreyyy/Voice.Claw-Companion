import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { selectCodexAppServerExecutable } from './bin-paths.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_REALTIME_TIMEOUT_MS = 30_000;
const DEFAULT_STATE_PATH = join(homedir(), '.voiceclaw', 'codex-app-server-sessions.json');
const DEFAULT_WORKSPACE_PATH = join(homedir(), '.voiceclaw', 'codex-workspace');
const DEFAULT_CODEX_SANDBOX = process.env.VOICECLAW_CODEX_SANDBOX || 'workspace-write';
const DEFAULT_CODEX_APPROVAL_POLICY = process.env.VOICECLAW_CODEX_APPROVAL_POLICY || 'never';
const REALTIME_FEATURE_NAME = 'realtime_conversation';
const SESSION_SCHEMA_VERSION = 3;
const MAX_STDERR_CHARS = 16_384;
const CODEX_REALTIME_RELAY_MAX_INPUT_BYTES = 1_000_000;
const CODEX_REALTIME_RELAY_MAX_BUFFERED_OUTPUT_BYTES = 8_000_000;
const CODEX_REALTIME_INITIAL_ITEM_LIMIT = 128;
const CODEX_REALTIME_INITIAL_TEXT_CHAR_LIMIT = 1_000_000;
const CODEX_REALTIME_STRING_LIMIT = 1_000_000;
const CODEX_REALTIME_APPEND_TEXT_CHAR_LIMIT = 64_000;
const CODEX_REALTIME_TEXT_IDEMPOTENCY_LIMIT = 256;
const CODEX_REALTIME_TEXT_IDEMPOTENCY_TTL_MS = 5 * 60_000;
const CODEX_REALTIME_V3_VOICES = new Set([
  'juniper',
  'maple',
  'spruce',
  'ember',
  'vale',
  'breeze',
  'arbor',
  'sol',
  'cove',
]);
const CODEX_RESPONSE_HANDOFF_MODES = new Set(['thinking', 'commentary', 'bemTags']);

export const CODEX_REALTIME_V3_DEFAULTS = Object.freeze({
  version: 'v3',
  model: 'gpt-live-1-boulder-alpha',
  voice: 'ember',
  outputModality: 'audio',
  clientManagedHandoffs: true,
  codexResponsesAsItems: false,
  codexResponseHandoffMode: 'bemTags',
});

const VOICECLAW_CODEX_DEVELOPER_INSTRUCTIONS = `You are the Codex reasoning layer used by VoiceClaw Realtime.
Respond with concise plain text suitable for speech unless the user explicitly asks for detail.
Do not claim that an iPhone, Mac, OpenClaw, or Hermes action happened unless a tool result explicitly confirms it.
Do not expose hidden reasoning. Preserve concrete results, warnings, and next steps when they matter.`;

function boundedTimeout(value, fallback, minimum = 100, maximum = 30 * 60_000) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(numeric)));
}

function safeModel(value = '') {
  const model = String(value || '').trim();
  if (!model) return '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model)) {
    throw new Error('Codex model contains unsupported characters.');
  }
  return model;
}

function safeVoice(value = '') {
  const voice = String(value || '').trim().toLowerCase();
  if (!voice) return '';
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(voice)) {
    throw new Error('Codex realtime voice contains unsupported characters.');
  }
  return voice;
}

function safeRealtimeVersion(value = '', fallback = 'v3') {
  const version = String(value || '').trim().toLowerCase();
  return ['v1', 'v2', 'v3'].includes(version) ? version : fallback;
}

function codexRealtimeRequestError(message, code = 'CODEX_REALTIME_INVALID_REQUEST') {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

function strictRealtimeVersion(value = 'v3') {
  const version = String(value || 'v3').trim().toLowerCase();
  if (!['v1', 'v2', 'v3'].includes(version)) {
    throw codexRealtimeRequestError(`Unsupported Codex realtime version: ${version || '(missing)'}.`);
  }
  return version;
}

function optionalNullableBoolean(source, key, defaultValue = undefined) {
  if (!Object.hasOwn(source, key) || source[key] === undefined) return defaultValue;
  if (source[key] === null || typeof source[key] === 'boolean') return source[key];
  throw codexRealtimeRequestError(`Codex realtime ${key} must be a boolean or null.`);
}

function optionalNullableString(source, key, {
  defaultValue = undefined,
  maximumLength = CODEX_REALTIME_STRING_LIMIT,
  trim = false,
} = {}) {
  if (!Object.hasOwn(source, key) || source[key] === undefined) return defaultValue;
  if (source[key] === null) return null;
  if (typeof source[key] !== 'string') {
    throw codexRealtimeRequestError(`Codex realtime ${key} must be a string or null.`);
  }
  const value = trim ? source[key].trim() : source[key];
  if (value.length > maximumLength) {
    throw codexRealtimeRequestError(`Codex realtime ${key} is too large.`);
  }
  return value;
}

function normalizeRealtimeInitialItems(value, version) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (version !== 'v3') {
    throw codexRealtimeRequestError('Codex realtime initialItems are supported only by V3.');
  }
  if (!Array.isArray(value) || value.length > CODEX_REALTIME_INITIAL_ITEM_LIMIT) {
    throw codexRealtimeRequestError(`Codex realtime initialItems must contain at most ${CODEX_REALTIME_INITIAL_ITEM_LIMIT} items.`);
  }
  let totalCharacters = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw codexRealtimeRequestError(`Codex realtime initialItems[${index}] must be an object.`);
    }
    const role = String(item.role || '').trim().toLowerCase();
    if (!['user', 'developer', 'assistant'].includes(role)) {
      throw codexRealtimeRequestError(`Codex realtime initialItems[${index}].role is invalid.`);
    }
    if (typeof item.text !== 'string' || !item.text.trim()) {
      throw codexRealtimeRequestError(`Codex realtime initialItems[${index}].text is required.`);
    }
    totalCharacters += item.text.length;
    if (totalCharacters > CODEX_REALTIME_INITIAL_TEXT_CHAR_LIMIT) {
      throw codexRealtimeRequestError('Codex realtime initialItems text is too large.');
    }
    return { role, text: item.text };
  });
}

/**
 * Normalize the generated ThreadRealtimeStartParams V3 surface without inventing
 * private protocol fields. Undefined optional fields are omitted; explicit nulls
 * are retained because the generated app-server schema accepts them.
 */
export function normalizeCodexRealtimeWebRTCOptions(options = {}) {
  const source = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const version = strictRealtimeVersion(source.version || CODEX_REALTIME_V3_DEFAULTS.version);
  const outputModality = String(source.outputModality || CODEX_REALTIME_V3_DEFAULTS.outputModality)
    .trim()
    .toLowerCase();
  if (!['text', 'audio'].includes(outputModality)) {
    throw codexRealtimeRequestError('Codex realtime outputModality must be text or audio.');
  }
  if (version === 'v3' && outputModality !== 'audio') {
    throw codexRealtimeRequestError(
      'GPT Live V3 currently admits audio output only.',
      'CODEX_REALTIME_V3_AUDIO_REQUIRED',
    );
  }

  const model = safeModel(source.model || (version === 'v3' ? CODEX_REALTIME_V3_DEFAULTS.model : ''));
  const voice = safeVoice(source.voice || (version === 'v3' ? CODEX_REALTIME_V3_DEFAULTS.voice : ''));
  if (version === 'v3' && !CODEX_REALTIME_V3_VOICES.has(voice)) {
    throw codexRealtimeRequestError(`Unsupported GPT Live V3 voice: ${voice || '(missing)'}.`);
  }

  const clientManagedHandoffs = optionalNullableBoolean(
    source,
    'clientManagedHandoffs',
    version === 'v3' ? CODEX_REALTIME_V3_DEFAULTS.clientManagedHandoffs : undefined,
  );
  const flushTranscriptTailOnSessionEnd = optionalNullableBoolean(source, 'flushTranscriptTailOnSessionEnd');
  const codexResponsesAsItems = optionalNullableBoolean(
    source,
    'codexResponsesAsItems',
    version === 'v3' ? CODEX_REALTIME_V3_DEFAULTS.codexResponsesAsItems : undefined,
  );
  const includeStartupContext = optionalNullableBoolean(source, 'includeStartupContext');
  const codexResponseItemPrefix = optionalNullableString(source, 'codexResponseItemPrefix');
  const prompt = optionalNullableString(source, 'prompt');
  const realtimeSessionId = optionalNullableString(source, 'realtimeSessionId', {
    maximumLength: 512,
    trim: true,
  });
  const initialItems = normalizeRealtimeInitialItems(source.initialItems, version);

  let codexResponseHandoffMode;
  if (!Object.hasOwn(source, 'codexResponseHandoffMode') || source.codexResponseHandoffMode === undefined) {
    codexResponseHandoffMode = version === 'v3'
      ? CODEX_REALTIME_V3_DEFAULTS.codexResponseHandoffMode
      : undefined;
  } else if (source.codexResponseHandoffMode === null) {
    codexResponseHandoffMode = null;
  } else {
    codexResponseHandoffMode = String(source.codexResponseHandoffMode || '').trim();
    if (!CODEX_RESPONSE_HANDOFF_MODES.has(codexResponseHandoffMode)) {
      throw codexRealtimeRequestError('Codex realtime codexResponseHandoffMode is invalid.');
    }
  }

  return {
    version,
    model,
    voice,
    outputModality,
    clientManagedHandoffs,
    flushTranscriptTailOnSessionEnd,
    codexResponsesAsItems,
    codexResponseItemPrefix,
    codexResponseHandoffMode,
    includeStartupContext,
    initialItems,
    prompt,
    realtimeSessionId,
  };
}

function validatedRealtimeWebRTCOffer(value) {
  // SDP is a wire-format document. Preserve its CRLF terminator exactly; trimming it causes
  // the Realtime call endpoint to reject otherwise valid browser offers with invalid_offer/EOF.
  const offer = String(value || '');
  if (!offer.startsWith('v=0')) {
    throw codexRealtimeRequestError('Codex realtime needs a valid WebRTC SDP offer.');
  }
  if (offer.length > 2_000_000) {
    throw codexRealtimeRequestError('Codex realtime SDP offer is too large.');
  }
  return offer;
}

function safeReasoningEffort(value = '') {
  const effort = String(value || '').trim().toLowerCase();
  if (!effort) return '';
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra'].includes(effort)) {
    throw new Error(`Unsupported Codex reasoning effort: ${effort}`);
  }
  return effort;
}

function safeSessionKey(value = '') {
  const key = String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (key || 'voiceclaw-codex-default').slice(0, 160);
}

function safeDeveloperInstructions(value = '') {
  const instructions = String(value || '').trim();
  if (!instructions) return VOICECLAW_CODEX_DEVELOPER_INSTRUCTIONS;
  if (instructions.length > CODEX_REALTIME_STRING_LIMIT) {
    throw codexRealtimeRequestError('Codex developer instructions are too large.');
  }
  return instructions;
}

function safePromptContractHash(value = '') {
  const hash = String(value || '').trim().toLowerCase();
  if (!hash) return '';
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw codexRealtimeRequestError('Codex prompt contract hash is invalid.');
  }
  return hash;
}

function safePromptContractID(value = '') {
  const contractID = String(value || '').trim();
  if (!contractID) return '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(contractID)) {
    throw codexRealtimeRequestError('Codex prompt contract id is invalid.');
  }
  return contractID;
}

function safePromptRevisionHash(value = '') {
  return safePromptContractHash(value);
}

function safeLifecycleID(value = '') {
  const lifecycleID = String(value || '').trim();
  if (!lifecycleID) return randomUUID();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(lifecycleID)) {
    throw codexRealtimeRequestError('Codex realtime lifecycleID contains unsupported characters.');
  }
  return lifecycleID;
}

function isRealtimeAlreadyStoppedError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('already stopped')
    || message.includes('not running')
    || message.includes('not active')
    || message.includes('session is closed')
    || message.includes('session closed');
}

function realtimeLifecycleSnapshot(lease) {
  if (!lease) return null;
  return {
    lifecycleID: lease.ownerID,
    sessionKey: lease.sessionKey,
    threadID: lease.threadID,
    transport: lease.transport || null,
    version: lease.version || null,
    model: lease.model || null,
    voice: lease.voice || null,
    status: lease.status || null,
    realtimeSessionID: lease.realtimeSessionID || null,
    acquiredAt: lease.acquiredAt,
    touchedAt: lease.touchedAt,
    closedAt: lease.closedAt || null,
    closeReason: lease.closeReason || null,
    error: lease.error || null,
    clientManagedHandoffs: lease.clientManagedHandoffs === true,
    broker: lease.broker ? {
      anchorTurnsObserved: lease.broker.anchorTurnsObserved,
      anchorTurnsInterrupted: lease.broker.anchorTurnsInterrupted,
      interruptFailures: lease.broker.interruptFailures,
      lastInterruptedTurnID: lease.broker.lastInterruptedTurnID || null,
      lastInterruptError: lease.broker.lastInterruptError || null,
    } : null,
  };
}

function errorFromRPC(error, method = '') {
  const message = String(error?.message || `Codex app-server request failed: ${method}`);
  const result = new Error(message);
  result.name = 'CodexAppServerRPCError';
  result.code = error?.code;
  result.data = error?.data;
  result.method = method;
  return result;
}

function turnFailure(turn = {}) {
  const message = turn?.error?.message || `Codex turn ${turn?.status || 'failed'}.`;
  const error = new Error(message);
  error.name = 'CodexTurnError';
  error.code = turn?.error?.codexErrorInfo || 'CODEX_TURN_FAILED';
  error.turn = turn;
  return error;
}

function isCodexContextOverflow(error) {
  const code = String(error?.code || error?.data?.code || '').toLowerCase();
  const message = String(error?.message || error || '').toLowerCase();
  return code.includes('context_window')
    || code.includes('context_overflow')
    || code.includes('prompt_too_large')
    || message.includes('context overflow')
    || message.includes('context window exceeded')
    || message.includes('context_window_exceeded')
    || message.includes('prompt too large')
    || message.includes('maximum context length')
    || message.includes('input is too long');
}

function absoluteWorkspacePath(value = '') {
  const requested = String(value || '').trim() || DEFAULT_WORKSPACE_PATH;
  return isAbsolute(requested) ? requested : resolve(requested);
}

function publicAccount(accountResult = {}) {
  const envelope = accountResult?.result && typeof accountResult.result === 'object'
    ? accountResult.result
    : (accountResult?.data && typeof accountResult.data === 'object' ? accountResult.data : accountResult);
  const account = envelope?.account;
  if (!account || typeof account !== 'object') {
    return {
      signedIn: false,
      type: null,
      planType: null,
      requiresOpenaiAuth: envelope?.requiresOpenaiAuth !== false,
    };
  }
  return {
    signedIn: true,
    type: String(account.type || ''),
    planType: account.planType ? String(account.planType) : null,
    requiresOpenaiAuth: envelope?.requiresOpenaiAuth !== false,
  };
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstString(...values) {
  return values.map((value) => String(value ?? '').trim()).find(Boolean) || '';
}

export function codexAppServerNegotiation(initializeResult = {}) {
  const root = objectValue(initializeResult);
  const serverInfo = objectValue(root.serverInfo || root.server_info);
  const userAgent = firstString(root.userAgent, root.user_agent, serverInfo.userAgent, serverInfo.user_agent);
  const inferredVersion = userAgent.match(/\bcodex(?:_cli_rs)?\/([^\s;)]+)/i)?.[1] || '';
  const appServerVersion = firstString(
    root.appServerVersion,
    root.app_server_version,
    serverInfo.version,
    serverInfo.appServerVersion,
    inferredVersion,
  );
  const protocolVersion = firstString(
    root.protocolVersion,
    root.protocol_version,
    serverInfo.protocolVersion,
    serverInfo.protocol_version,
  );
  return Object.freeze({
    mode: protocolVersion
      ? 'explicit-protocol'
      : (appServerVersion ? 'server-version' : 'legacy-unversioned'),
    compatible: true,
    appServerVersion: appServerVersion || null,
    protocolVersion: protocolVersion || null,
    userAgent,
    platformFamily: firstString(root.platformFamily, root.platform_family, serverInfo.platformFamily),
    platformOs: firstString(root.platformOs, root.platform_os, serverInfo.platformOs),
  });
}

function newTurnTracker(threadID, turnID) {
  return {
    threadID,
    turnID,
    status: 'inProgress',
    error: null,
    messageOrder: [],
    messages: new Map(),
    waiters: new Set(),
    completedAt: 0,
  };
}

function trackerText(tracker) {
  return tracker.messageOrder
    .map((itemID) => String(tracker.messages.get(itemID) || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function codexAppServerSpawnArguments(environment = {}) {
  const argumentsList = [];
  const computerUsePipe = String(
    environment?.SKY_CUA_SERVICE_NATIVE_PIPE_PATH
      || environment?.SKY_CUA_NATIVE_PIPE_PATH
      || '',
  ).trim();
  if (computerUsePipe) {
    argumentsList.push(
      '-c',
      `mcp_servers.node_repl.env.SKY_CUA_NATIVE_PIPE_PATH=${JSON.stringify(computerUsePipe)}`,
      '-c',
      `mcp_servers.node_repl.env.SKY_CUA_SERVICE_NATIVE_PIPE_PATH=${JSON.stringify(computerUsePipe)}`,
    );
  }
  argumentsList.push('app-server', '--stdio');
  return argumentsList;
}

export class CodexAppServerClient {
  constructor({
    codexPath = '',
    codexSelection = null,
    spawnProcess = spawn,
    clientVersion = process.env.VOICECLAW_COMPANION_VERSION || 'dev',
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    realtimeTimeoutMs = DEFAULT_REALTIME_TIMEOUT_MS,
    environment = process.env,
    environmentProvider = null,
  } = {}) {
    const selectedBinary = codexSelection || (codexPath
      ? {
          path: String(codexPath),
          source: 'explicit',
          version: null,
          available: true,
          verifiedV3Build: false,
          reason: 'constructor-override',
        }
      : selectCodexAppServerExecutable());
    this.codexPath = selectedBinary.path;
    this.codexSelection = Object.freeze({ ...selectedBinary });
    this.spawnProcess = spawnProcess;
    this.clientVersion = String(clientVersion || 'dev');
    this.requestTimeoutMs = boundedTimeout(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.turnTimeoutMs = boundedTimeout(turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS);
    this.realtimeTimeoutMs = boundedTimeout(realtimeTimeoutMs, DEFAULT_REALTIME_TIMEOUT_MS);
    this.environment = environment;
    this.environmentProvider = typeof environmentProvider === 'function'
      ? environmentProvider
      : null;
    this.spawnEnvironmentRevision = null;
    this.child = null;
    this.stdoutLines = null;
    this.startPromise = null;
    this.ready = false;
    this.generation = 0;
    this.nextRequestID = 1;
    this.pending = new Map();
    this.notificationListeners = new Set();
    this.turnTrackers = new Map();
    this.stderrTail = '';
    this.initializeResult = null;
    this.initializeNegotiation = null;
    this.lastExit = null;
    this.lastRealtimeProbes = new Map();
  }

  async start() {
    const environment = this.#resolvedEnvironment();
    const environmentRevision = this.#environmentRevision(environment);
    if (this.ready && this.child && this.spawnEnvironmentRevision === environmentRevision) {
      return this.initializeResult;
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#startProcess(environment, environmentRevision);
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  #resolvedEnvironment() {
    const dynamicEnvironment = this.environmentProvider?.() || {};
    return {
      ...this.environment,
      ...dynamicEnvironment,
    };
  }

  #environmentRevision(environment) {
    return createHash('sha256')
      .update(JSON.stringify({
        openAIAPIKey: String(environment?.OPENAI_API_KEY || ''),
        computerUsePipe: String(
          environment?.SKY_CUA_SERVICE_NATIVE_PIPE_PATH
            || environment?.SKY_CUA_NATIVE_PIPE_PATH
            || '',
        ),
      }))
      .digest('hex');
  }

  async #startProcess(environment, environmentRevision) {
    this.stop('restart');
    this.stderrTail = '';
    this.lastExit = null;
    const child = this.spawnProcess(
      this.codexPath,
      codexAppServerSpawnArguments(environment),
      {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...environment },
      },
    );
    this.child = child;
    this.spawnEnvironmentRevision = environmentRevision;
    this.generation += 1;

    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${String(chunk || '')}`.slice(-MAX_STDERR_CHARS);
    });

    this.stdoutLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.stdoutLines.on('line', (line) => this.#handleLine(line));
    child.once('error', (error) => this.#handleExit(child, null, null, error));
    child.once('exit', (code, signal) => this.#handleExit(child, code, signal));

    const initialized = await this.request('initialize', {
      clientInfo: {
        name: 'voiceclaw_companion',
        title: 'VoiceClaw Realtime Companion',
        version: this.clientVersion,
      },
      capabilities: {
        experimentalApi: true,
      },
    }, { skipStart: true, timeoutMs: this.requestTimeoutMs });
    this.notify('initialized', {});
    this.initializeResult = initialized;
    this.initializeNegotiation = codexAppServerNegotiation(initialized);
    this.ready = true;
    return initialized;
  }

  stop(reason = 'stopped') {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.initializeResult = null;
    this.initializeNegotiation = null;
    this.spawnEnvironmentRevision = null;
    this.stdoutLines?.close?.();
    this.stdoutLines = null;
    const error = new Error(`Codex app-server ${reason}.`);
    error.code = 'CODEX_APP_SERVER_STOPPED';
    this.#rejectPending(error);
    if (child && !child.killed) {
      try { child.kill('SIGTERM'); } catch {}
    }
  }

  async request(method, params = {}, { timeoutMs = this.requestTimeoutMs, skipStart = false } = {}) {
    if (!skipStart) await this.start();
    const child = this.child;
    if (!child?.stdin?.writable) throw new Error('Codex app-server stdin is unavailable.');
    const id = this.nextRequestID++;
    const timeout = boundedTimeout(timeoutMs, this.requestTimeoutMs);
    return await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex app-server request timed out: ${method}`);
        error.code = 'CODEX_APP_SERVER_TIMEOUT';
        error.method = method;
        rejectPromise(error);
      }, timeout);
      timer.unref?.();
      this.pending.set(id, {
        method,
        resolve: (result) => {
          clearTimeout(timer);
          resolvePromise(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
      });
      try {
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        rejectPromise(error);
      }
    });
  }

  notify(method, params = {}) {
    const child = this.child;
    if (!child?.stdin?.writable) throw new Error('Codex app-server stdin is unavailable.');
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async callMCPTool({
    server,
    threadID,
    tool,
    arguments: toolArguments = {},
    timeoutMs = this.requestTimeoutMs,
  } = {}) {
    const serverName = String(server || '').trim();
    const thread = String(threadID || '').trim();
    const toolName = String(tool || '').trim();
    if (!serverName || !thread || !toolName) {
      throw new Error('Codex MCP tool calls require server, threadID, and tool.');
    }
    return await this.request('mcpServer/tool/call', {
      server: serverName,
      threadId: thread,
      tool: toolName,
      arguments: toolArguments && typeof toolArguments === 'object'
        ? toolArguments
        : {},
    }, { timeoutMs });
  }

  onNotification(listener) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async readAccount({ refreshToken = false } = {}) {
    await this.start();
    return publicAccount(await this.request('account/read', {
      refreshToken: refreshToken === true,
    }));
  }

  async status({ refreshToken = false } = {}) {
    await this.start();
    const account = await this.readAccount({ refreshToken });
    let featureResult = {};
    let featureListError = null;
    try {
      featureResult = await this.request('experimentalFeature/list', { limit: 100 });
    } catch (error) {
      featureListError = error?.message || String(error);
    }
    const features = Array.isArray(featureResult?.data) ? featureResult.data : [];
    const realtimeFeature = features.find((feature) => feature?.name === REALTIME_FEATURE_NAME) || null;
    const webSocketProbe = this.lastRealtimeProbes.get('websocket') || null;
    const webRTCProbe = this.lastRealtimeProbes.get('webrtc') || null;
    const protocolProbes = [...this.lastRealtimeProbes.entries()]
      .filter(([key]) => key.includes(':'))
      .map(([, probe]) => probe);
    const probes = protocolProbes.length ? protocolProbes : [webSocketProbe, webRTCProbe].filter(Boolean);
    const verifiedTransport = probes.find((probe) => probe?.ok) || null;
    const verifiedV1 = probes.find((probe) => probe?.ok && probe?.version === 'v1') || null;
    const verifiedV3 = probes.find((probe) => probe?.ok && probe?.version === 'v3') || null;
    const verifiedV2 = probes.find((probe) => probe?.ok && probe?.version === 'v2') || null;
    return {
      state: 'ready',
      binary: this.codexPath,
      binarySelection: this.codexSelection,
      generation: this.generation,
      userAgent: this.initializeNegotiation?.userAgent || '',
      platformFamily: this.initializeNegotiation?.platformFamily || '',
      platformOs: this.initializeNegotiation?.platformOs || '',
      appServer: {
        version: this.initializeNegotiation?.appServerVersion || null,
        protocolVersion: this.initializeNegotiation?.protocolVersion || null,
        negotiation: this.initializeNegotiation?.mode || 'legacy-unversioned',
        compatible: this.initializeNegotiation?.compatible !== false,
      },
      account,
      realtime: {
        method: 'thread/realtime/start',
        experimental: true,
        localFeaturePresent: !!realtimeFeature,
        localFeatureEnabled: realtimeFeature?.enabled === true,
        featureListAvailable: !featureListError,
        featureListError,
        stage: realtimeFeature?.stage || null,
        backendAdmission: verifiedTransport
          ? 'verified'
          : (probes.length ? 'rejected' : 'unverified'),
        available: !!verifiedTransport,
        availablePaths: probes
          .filter((probe) => probe?.ok)
          .map((probe) => ({
            transport: probe.transport,
            version: probe.version,
            model: probe.model || null,
            voice: probe.voice || null,
            verifiedAt: probe.at,
          })),
        protocols: {
          v1: {
            name: 'Legacy Bidi',
            endpoint: '/v1/realtime',
            backendAdmission: verifiedV1 ? 'verified' : (probes.some((probe) => probe.version === 'v1') ? 'rejected' : 'unverified'),
          },
          v2: {
            name: 'Realtime Voice',
            endpoint: '/v1/realtime',
            backendAdmission: verifiedV2 ? 'verified' : (probes.some((probe) => probe.version === 'v2') ? 'rejected' : 'unverified'),
          },
          v3: {
            name: 'Frameless Bidi',
            endpoint: '/v1/live',
            backendAdmission: verifiedV3 ? 'verified' : (probes.some((probe) => probe.version === 'v3') ? 'rejected' : 'unverified'),
            supportedConfiguration: {
              ...CODEX_REALTIME_V3_DEFAULTS,
              transport: 'webrtc',
              auth: 'chatgpt-login-managed-by-codex-app-server',
            },
          },
        },
        transports: {
          websocket: {
            supportedByAppServer: true,
            mediaPath: 'thread/realtime/appendAudio and thread/realtime/outputAudio/delta',
            authPath: 'OpenAI API key in the current Codex core implementation',
            backendAdmission: webSocketProbe ? (webSocketProbe.ok ? 'verified' : 'rejected') : 'unverified',
            lastProbeAt: webSocketProbe?.at || null,
            lastError: webSocketProbe?.ok === false ? webSocketProbe.error : null,
            lastVersion: webSocketProbe?.version || null,
            lastModel: webSocketProbe?.model || null,
            lastVoice: webSocketProbe?.voice || null,
          },
          webrtc: {
            supportedByAppServer: true,
            mediaPath: 'client RTCPeerConnection plus Codex sideband',
            authPath: 'Codex app-server managed call creation',
            backendAdmission: webRTCProbe ? (webRTCProbe.ok ? 'verified' : 'rejected') : 'unverified',
            lastProbeAt: webRTCProbe?.at || null,
            lastError: webRTCProbe?.ok === false ? webRTCProbe.error : null,
            lastVersion: webRTCProbe?.version || null,
            lastModel: webRTCProbe?.model || null,
            lastVoice: webRTCProbe?.voice || null,
          },
        },
      },
    };
  }

  async startThread({
    model = '',
    cwd,
    developerInstructions = VOICECLAW_CODEX_DEVELOPER_INSTRUCTIONS,
  } = {}) {
    return await this.request('thread/start', {
      ...(safeModel(model) ? { model: safeModel(model) } : {}),
      cwd: absoluteWorkspacePath(cwd),
      approvalPolicy: DEFAULT_CODEX_APPROVAL_POLICY,
      sandbox: DEFAULT_CODEX_SANDBOX,
      personality: 'pragmatic',
      serviceName: 'voiceclaw_companion',
      developerInstructions,
      ephemeral: false,
    });
  }

  async resumeThread(threadID) {
    const value = String(threadID || '').trim();
    if (!value) throw new Error('Codex thread id is required.');
    return await this.request('thread/resume', { threadId: value });
  }

  async compactThread(threadID, { timeoutMs = this.turnTimeoutMs } = {}) {
    const targetThreadID = String(threadID || '').trim();
    if (!targetThreadID) throw new Error('Codex thread id is required for compaction.');
    await this.start();

    let removeListener = () => {};
    let timeout = null;
    const compacted = new Promise((resolvePromise, rejectPromise) => {
      removeListener = this.onNotification((message) => {
        if (message?.method !== 'thread/compacted') return;
        if (String(message?.params?.threadId || '') !== targetThreadID) return;
        resolvePromise(message.params || {});
      });
      timeout = setTimeout(() => {
        const error = new Error(`Codex thread compaction timed out: ${targetThreadID}`);
        error.code = 'CODEX_COMPACTION_TIMEOUT';
        rejectPromise(error);
      }, boundedTimeout(timeoutMs, this.turnTimeoutMs));
      timeout.unref?.();
    });

    try {
      await this.request('thread/compact/start', { threadId: targetThreadID }, { timeoutMs });
      await compacted;
      return { threadID: targetThreadID, compacted: true };
    } finally {
      if (timeout) clearTimeout(timeout);
      removeListener();
    }
  }

  async runTextTurn({
    threadID,
    text,
    model = '',
    reasoningEffort = '',
    timeoutMs = this.turnTimeoutMs,
    signal = null,
    onTurnStarted = null,
  } = {}) {
    const message = String(text || '').trim();
    if (!message) throw new Error('Codex turn text is required.');
    const response = await this.request('turn/start', {
      threadId: String(threadID || '').trim(),
      clientUserMessageId: randomUUID(),
      input: [{ type: 'text', text: message, text_elements: [] }],
      ...(safeModel(model) ? { model: safeModel(model) } : {}),
      ...(safeReasoningEffort(reasoningEffort) ? { effort: safeReasoningEffort(reasoningEffort) } : {}),
    }, { timeoutMs });
    const turnID = String(response?.turn?.id || '').trim();
    if (!turnID) throw new Error('Codex app-server did not return a turn id.');
    const targetThreadID = String(threadID || '').trim();
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({ threadID: targetThreadID, turnID });
    }
    const interrupt = () => {
      void this.interruptTurn({
        threadID: targetThreadID,
        turnID,
      }).catch(() => {});
    };
    if (signal?.aborted) {
      interrupt();
      throw signal.reason || new Error('Codex turn cancelled.');
    }
    signal?.addEventListener?.('abort', interrupt, { once: true });
    try {
      return await this.#waitForTurn(targetThreadID, turnID, timeoutMs);
    } finally {
      signal?.removeEventListener?.('abort', interrupt);
    }
  }

  async prepareRealtimeWebRTC(options = {}) {
    const normalized = normalizeCodexRealtimeWebRTCOptions(options);
    let account = null;
    if (normalized.version === 'v3') {
      account = await this.readAccount();
      if (!account.signedIn || String(account.type || '').toLowerCase() !== 'chatgpt') {
        const error = new Error('GPT Live V3 currently requires a ChatGPT login managed by Codex app-server.');
        error.code = 'CODEX_REALTIME_CHATGPT_LOGIN_REQUIRED';
        error.statusCode = 409;
        this.#recordRealtimeProbe('webrtc', false, error, normalized);
        throw error;
      }
    }
    return { normalized, account };
  }

  async startRealtimeWebRTC({
    threadID,
    sdp,
    model = '',
    version = 'v3',
    voice = '',
    outputModality = 'audio',
    clientManagedHandoffs,
    flushTranscriptTailOnSessionEnd,
    codexResponsesAsItems,
    codexResponseItemPrefix,
    codexResponseHandoffMode,
    includeStartupContext,
    initialItems,
    prompt,
    realtimeSessionId,
    timeoutMs = this.realtimeTimeoutMs,
    prepared = null,
  } = {}) {
    const offer = validatedRealtimeWebRTCOffer(sdp);
    const targetThreadID = String(threadID || '').trim();
    if (!targetThreadID) throw new Error('Codex realtime thread id is required.');
    const timeout = boundedTimeout(timeoutMs, this.realtimeTimeoutMs);
    const readiness = prepared || await this.prepareRealtimeWebRTC({
      model,
      version,
      voice,
      outputModality,
      clientManagedHandoffs,
      flushTranscriptTailOnSessionEnd,
      codexResponsesAsItems,
      codexResponseItemPrefix,
      codexResponseHandoffMode,
      includeStartupContext,
      initialItems,
      prompt,
      realtimeSessionId,
    });
    const { normalized, account } = readiness;
    const answerPromise = this.#waitForNotification(
      (message) => message?.method === 'thread/realtime/sdp'
        && message?.params?.threadId === targetThreadID,
      timeout,
      'Codex realtime did not return an SDP answer before timeout.',
      (message) => String(message?.params?.sdp || ''),
    );
    const errorPromise = this.#waitForNotification(
      (message) => message?.method === 'thread/realtime/error'
        && message?.params?.threadId === targetThreadID,
      timeout,
      'Codex realtime did not report a terminal result before timeout.',
      (message) => {
        throw new Error(String(message?.params?.message || 'Codex realtime failed.'));
      },
    );
    try {
      const requestParams = {
        threadId: targetThreadID,
        outputModality: normalized.outputModality,
        version: normalized.version,
        ...(normalized.model ? { model: normalized.model } : {}),
        ...(normalized.voice ? { voice: normalized.voice } : {}),
        transport: { type: 'webrtc', sdp: offer },
      };
      for (const key of [
        'clientManagedHandoffs',
        'flushTranscriptTailOnSessionEnd',
        'codexResponsesAsItems',
        'codexResponseItemPrefix',
        'codexResponseHandoffMode',
        'includeStartupContext',
        'initialItems',
        'prompt',
        'realtimeSessionId',
      ]) {
        if (normalized[key] !== undefined) requestParams[key] = normalized[key];
      }
      await this.request('thread/realtime/start', requestParams, { timeoutMs: timeout });
      const answer = await Promise.race([answerPromise, errorPromise]);
      if (!answer.startsWith('v=0')) throw new Error('Codex realtime returned an invalid SDP answer.');
      this.#recordRealtimeProbe('webrtc', true, null, {
        version: normalized.version,
        model: normalized.model,
        voice: normalized.voice,
      });
      return {
        threadID: targetThreadID,
        sdp: answer,
        transport: 'webrtc',
        version: normalized.version,
        model: normalized.model || null,
        voice: normalized.voice || null,
        outputModality: normalized.outputModality,
        auth: account ? {
          type: 'chatgpt',
          managedBy: 'codex-app-server',
          credentialsExposed: false,
        } : null,
      };
    } catch (error) {
      this.#recordRealtimeProbe('webrtc', false, error, {
        version: normalized.version,
        model: normalized.model,
        voice: normalized.voice,
      });
      throw error;
    }
  }

  async startRealtimeWebSocket({
    threadID,
    model = '',
    version = 'v3',
    voice = '',
    outputModality = 'audio',
    timeoutMs = this.realtimeTimeoutMs,
  } = {}) {
    const targetThreadID = String(threadID || '').trim();
    if (!targetThreadID) throw new Error('Codex realtime thread id is required.');
    const timeout = boundedTimeout(timeoutMs, this.realtimeTimeoutMs);
    const requestedVersion = safeRealtimeVersion(version);
    const requestedModel = safeModel(model);
    const requestedVoice = safeVoice(voice);
    const startedPromise = this.#waitForNotification(
      (message) => message?.method === 'thread/realtime/started'
        && message?.params?.threadId === targetThreadID,
      timeout,
      'Codex realtime WebSocket did not report startup before timeout.',
      (message) => ({
        realtimeSessionID: message?.params?.realtimeSessionId || null,
        negotiatedVersion: message?.params?.version || version,
      }),
    );
    const errorPromise = this.#waitForNotification(
      (message) => message?.method === 'thread/realtime/error'
        && message?.params?.threadId === targetThreadID,
      timeout,
      'Codex realtime WebSocket did not report a terminal result before timeout.',
      (message) => {
        throw new Error(String(message?.params?.message || 'Codex realtime WebSocket failed.'));
      },
    );
    try {
      await this.request('thread/realtime/start', {
        threadId: targetThreadID,
        outputModality: outputModality === 'text' ? 'text' : 'audio',
        version: requestedVersion,
        ...(requestedModel ? { model: requestedModel } : {}),
        ...(requestedVoice ? { voice: requestedVoice } : {}),
        transport: { type: 'websocket' },
      }, { timeoutMs: timeout });
      const started = await Promise.race([startedPromise, errorPromise]);
      this.#recordRealtimeProbe('websocket', true, null, {
        version: started.negotiatedVersion || requestedVersion,
        model: requestedModel,
        voice: requestedVoice,
      });
      return {
        threadID: targetThreadID,
        transport: 'websocket',
        version: started.negotiatedVersion,
        model: requestedModel || null,
        voice: requestedVoice || null,
        outputModality,
        realtimeSessionID: started.realtimeSessionID,
      };
    } catch (error) {
      this.#recordRealtimeProbe('websocket', false, error, {
        version: requestedVersion,
        model: requestedModel,
        voice: requestedVoice,
      });
      throw error;
    }
  }

  async appendRealtimeAudio({ threadID, data, sampleRate, numChannels = 1, samplesPerChannel, itemID } = {}) {
    const targetThreadID = String(threadID || '').trim();
    const audioData = String(data || '').trim();
    if (!targetThreadID) throw new Error('Codex realtime thread id is required.');
    if (!audioData) throw new Error('Codex realtime audio data is required.');
    const rate = Number(sampleRate);
    const channels = Number(numChannels);
    if (!Number.isInteger(rate) || rate < 8_000 || rate > 192_000) throw new Error('Codex realtime sample rate is invalid.');
    if (!Number.isInteger(channels) || channels < 1 || channels > 8) throw new Error('Codex realtime channel count is invalid.');
    return await this.request('thread/realtime/appendAudio', {
      threadId: targetThreadID,
      audio: {
        data: audioData,
        sampleRate: rate,
        numChannels: channels,
        ...(Number.isInteger(Number(samplesPerChannel)) ? { samplesPerChannel: Number(samplesPerChannel) } : {}),
        ...(itemID ? { itemId: String(itemID) } : {}),
      },
    });
  }

  async appendRealtimeText({ threadID, text, role = 'user' } = {}) {
    const targetThreadID = String(threadID || '').trim();
    const value = String(text || '').trim();
    if (!targetThreadID || !value) throw new Error('Codex realtime thread id and text are required.');
    const normalizedRole = ['user', 'developer', 'assistant'].includes(role) ? role : 'user';
    return await this.request('thread/realtime/appendText', {
      threadId: targetThreadID,
      text: value,
      role: normalizedRole,
    });
  }

  async appendRealtimeSpeech({ threadID, text } = {}) {
    const targetThreadID = String(threadID || '').trim();
    const value = String(text || '').trim();
    if (!targetThreadID || !value) throw new Error('Codex realtime thread id and speech text are required.');
    return await this.request('thread/realtime/appendSpeech', { threadId: targetThreadID, text: value });
  }

  async interruptTurn({ threadID, turnID } = {}) {
    const targetThreadID = String(threadID || '').trim();
    const targetTurnID = String(turnID || '').trim();
    if (!targetThreadID || !targetTurnID) {
      throw new Error('Codex thread and turn ids are required for interruption.');
    }
    return await this.request('turn/interrupt', {
      threadId: targetThreadID,
      turnId: targetTurnID,
    });
  }

  async stopRealtime(threadID) {
    const targetThreadID = String(threadID || '').trim();
    if (!targetThreadID) throw new Error('Codex realtime thread id is required.');
    return await this.request('thread/realtime/stop', { threadId: targetThreadID });
  }

  #recordRealtimeProbe(transport, ok, error = null, metadata = {}) {
    const probe = {
      transport,
      ok,
      at: new Date().toISOString(),
      error: ok ? '' : String(error?.message || error || 'Unknown realtime error.'),
      version: safeRealtimeVersion(metadata.version || '', ''),
      model: safeModel(metadata.model || ''),
      voice: safeVoice(metadata.voice || ''),
    };
    this.lastRealtimeProbes.set(transport, probe);
    if (probe.version) this.lastRealtimeProbes.set(`${transport}:${probe.version}`, probe);
  }

  #waitForNotification(predicate, timeoutMs, timeoutMessage, transform = (message) => message) {
    return new Promise((resolvePromise, rejectPromise) => {
      const unsubscribe = this.onNotification((message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        unsubscribe();
        try {
          resolvePromise(transform(message));
        } catch (error) {
          rejectPromise(error);
        }
      });
      const timer = setTimeout(() => {
        unsubscribe();
        const error = new Error(timeoutMessage);
        error.code = 'CODEX_REALTIME_TIMEOUT';
        rejectPromise(error);
      }, timeoutMs);
      timer.unref?.();
    });
  }

  #waitForTurn(threadID, turnID, timeoutMs) {
    const tracker = this.#turnTracker(threadID, turnID);
    if (tracker.completedAt) return this.#turnResult(tracker);
    const timeout = boundedTimeout(timeoutMs, this.turnTimeoutMs);
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = { resolve: resolvePromise, reject: rejectPromise, timer: null };
      waiter.timer = setTimeout(() => {
        tracker.waiters.delete(waiter);
        const error = new Error(`Codex turn timed out: ${turnID}`);
        error.code = 'CODEX_TURN_TIMEOUT';
        rejectPromise(error);
      }, timeout);
      waiter.timer.unref?.();
      tracker.waiters.add(waiter);
    });
  }

  #turnTracker(threadID, turnID) {
    let tracker = this.turnTrackers.get(turnID);
    if (!tracker) {
      tracker = newTurnTracker(threadID, turnID);
      this.turnTrackers.set(turnID, tracker);
    }
    return tracker;
  }

  #turnResult(tracker) {
    if (tracker.status !== 'completed') throw turnFailure(tracker.error || { status: tracker.status });
    return {
      threadID: tracker.threadID,
      turnID: tracker.turnID,
      status: tracker.status,
      text: trackerText(tracker),
    };
  }

  #handleLine(line) {
    const raw = String(line || '').trim();
    if (!raw) return;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      this.stderrTail = `${this.stderrTail}\n[non-json stdout] ${raw}`.slice(-MAX_STDERR_CHARS);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(errorFromRPC(message.error, pending.method));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      this.#rejectServerRequest(message);
      return;
    }
    if (message.method) this.#handleNotification(message);
  }

  #rejectServerRequest(message) {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify({
      id: message.id,
      error: {
        code: -32601,
        message: `VoiceClaw Realtime Companion does not handle server request ${message.method}.`,
      },
    })}\n`);
  }

  #handleNotification(message) {
    const params = message?.params || {};
    const turnID = String(params?.turnId || params?.turn?.id || '').trim();
    const threadID = String(params?.threadId || '').trim();
    if (turnID) {
      const tracker = this.#turnTracker(threadID, turnID);
      if (message.method === 'item/agentMessage/delta') {
        const itemID = String(params.itemId || 'agent-message');
        if (!tracker.messages.has(itemID)) tracker.messageOrder.push(itemID);
        tracker.messages.set(itemID, `${tracker.messages.get(itemID) || ''}${String(params.delta || '')}`);
      } else if (message.method === 'item/completed' && params?.item?.type === 'agentMessage') {
        const itemID = String(params.item.id || 'agent-message');
        if (!tracker.messages.has(itemID)) tracker.messageOrder.push(itemID);
        tracker.messages.set(itemID, String(params.item.text || ''));
      } else if (message.method === 'turn/completed') {
        tracker.status = String(params?.turn?.status || 'failed');
        tracker.error = params?.turn || { status: tracker.status };
        tracker.completedAt = Date.now();
        for (const waiter of tracker.waiters) {
          clearTimeout(waiter.timer);
          try {
            waiter.resolve(this.#turnResult(tracker));
          } catch (error) {
            waiter.reject(error);
          }
        }
        tracker.waiters.clear();
        const cleanup = setTimeout(() => this.turnTrackers.delete(turnID), 5 * 60_000);
        cleanup.unref?.();
      }
    }
    for (const listener of this.notificationListeners) {
      try { listener(message); } catch {}
    }
  }

  #handleExit(exitedChild, code, signal, cause = null) {
    if (this.child !== exitedChild) return;
    this.child = null;
    this.ready = false;
    this.initializeResult = null;
    this.initializeNegotiation = null;
    this.lastExit = {
      code,
      signal: signal || null,
      at: new Date().toISOString(),
      error: cause?.message || '',
    };
    const suffix = this.stderrTail.trim() ? ` ${this.stderrTail.trim().slice(-2000)}` : '';
    const error = cause || new Error(`Codex app-server exited (code=${code ?? 'unknown'}, signal=${signal || 'none'}).${suffix}`);
    error.code = error.code || 'CODEX_APP_SERVER_EXITED';
    this.#rejectPending(error);
    for (const tracker of this.turnTrackers.values()) {
      for (const waiter of tracker.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      tracker.waiters.clear();
    }
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export class CodexAppServerBridge {
  constructor({
    client = new CodexAppServerClient(),
    statePath = process.env.VOICECLAW_CODEX_SESSION_STATE || DEFAULT_STATE_PATH,
    workspacePath = process.env.VOICECLAW_CODEX_CWD || DEFAULT_WORKSPACE_PATH,
  } = {}) {
    this.client = client;
    this.statePath = statePath;
    this.workspacePath = absoluteWorkspacePath(workspacePath);
    this.sessions = new Map();
    this.loadedGeneration = 0;
    this.sessionLocks = new Map();
    this.realtimeOperationLock = Promise.resolve();
    this.realtimeLease = null;
    this.lastRealtimeLifecycle = null;
    this.realtimeTextRequests = new Map();
    this.realtimeSpeechRequests = new Map();
    this.loadPromise = this.#loadState();
    this.client.onNotification((message) => {
      const lease = this.realtimeLease;
      if (!lease || message?.params?.threadId !== lease.threadID) return;
      if (message?.method === 'thread/realtime/started') {
        lease.status = 'active';
        lease.touchedAt = Date.now();
        lease.realtimeSessionID = message?.params?.realtimeSessionId || null;
        if (message?.params?.version) lease.version = String(message.params.version);
      } else if (message?.method === 'thread/realtime/closed') {
        this.#finishRealtimeLifecycle(lease, {
          status: 'closed',
          reason: String(message?.params?.reason || 'app-server closed'),
        });
      } else if (message?.method === 'turn/started' && lease.clientManagedHandoffs) {
        const turnID = firstString(message?.params?.turn?.id, message?.params?.turnId);
        if (!turnID || lease.interruptedTurnIDs.has(turnID)) return;
        lease.interruptedTurnIDs.add(turnID);
        lease.broker.anchorTurnsObserved += 1;
        lease.touchedAt = Date.now();
        void this.client.interruptTurn({
          threadID: lease.threadID,
          turnID,
        }).then(() => {
          if (this.realtimeLease?.ownerID !== lease.ownerID) return;
          lease.broker.anchorTurnsInterrupted += 1;
          lease.broker.lastInterruptedTurnID = turnID;
          lease.broker.lastInterruptError = null;
          lease.touchedAt = Date.now();
        }).catch((error) => {
          if (this.realtimeLease?.ownerID !== lease.ownerID) return;
          lease.broker.interruptFailures += 1;
          lease.broker.lastInterruptError = String(error?.message || error);
          lease.touchedAt = Date.now();
        });
      }
    });
  }

  async status(options = {}) {
    await this.loadPromise;
    const status = await this.client.status(options);
    return {
      ...status,
      workspacePath: this.workspacePath,
      persistedSessionCount: this.sessions.size,
      supported: {
        account: 'account/read',
        textTurns: ['thread/start', 'thread/resume', 'turn/start'],
        realtime: 'thread/realtime/start (experimental; availability is verified independently by protocol and transport negotiation)',
      },
      realtimeLease: this.realtimeLease ? {
        sessionKey: this.realtimeLease.sessionKey,
        threadID: this.realtimeLease.threadID,
        ownerID: this.realtimeLease.ownerID,
        acquiredAt: this.realtimeLease.acquiredAt,
        touchedAt: this.realtimeLease.touchedAt,
      } : null,
      realtimeLifecycle: {
        active: realtimeLifecycleSnapshot(this.realtimeLease),
        last: realtimeLifecycleSnapshot(this.lastRealtimeLifecycle),
      },
    };
  }

  async runTurn({
    sessionKey = '',
    sessionMode = 'attach',
    text,
    model = '',
    reasoningEffort = '',
    timeoutMs,
    beforeTurn = null,
    signal = null,
    onTurnStarted = null,
    allowContextOverflowReplay = true,
  } = {}) {
    const key = safeSessionKey(sessionKey);
    return await this.#withSessionLock(key, async () => {
      const session = await this.#ensureSession({
        sessionKey: key,
        sessionMode,
        model,
      });
      if (typeof beforeTurn === 'function') {
        await beforeTurn({
          client: this.client,
          threadID: session.threadID,
          sessionKey: key,
        });
      }
      let result;
      let recoveredByCompaction = false;
      try {
        result = await this.client.runTextTurn({
          threadID: session.threadID,
          text,
          model,
          reasoningEffort,
          timeoutMs,
          signal,
          onTurnStarted,
        });
      } catch (error) {
        if (!isCodexContextOverflow(error)) throw error;
        await this.client.compactThread(session.threadID, { timeoutMs });
        recoveredByCompaction = true;
        if (!allowContextOverflowReplay) {
          const retryRequired = new Error(
            'Codex compacted the session after a context overflow, but VoiceClaw did not replay the computer-capable turn because dispatch had already begun. Confirm any visible side effects, then retry the request if needed.');
          retryRequired.code = 'CODEX_CONTEXT_COMPACTED_RETRY_REQUIRED';
          retryRequired.statusCode = 409;
          throw retryRequired;
        }
        result = await this.client.runTextTurn({
          threadID: session.threadID,
          text,
          model,
          reasoningEffort,
          timeoutMs,
          signal,
          onTurnStarted,
        });
      }
      session.updatedAt = new Date().toISOString();
      await this.#saveState();
      return {
        ...result,
        sessionKey: key,
        model: safeModel(model) || null,
        recoveredByCompaction,
      };
    });
  }

  async startRealtimeWebRTC({
    sessionKey = '',
    sessionMode = 'attach',
    sdp,
    model = '',
    threadModel = '',
    version = 'v3',
    voice = '',
    outputModality = 'audio',
    clientManagedHandoffs,
    flushTranscriptTailOnSessionEnd,
    codexResponsesAsItems,
    codexResponseItemPrefix,
    codexResponseHandoffMode,
    includeStartupContext,
    initialItems,
    prompt,
    developerInstructions = '',
    promptContractHash = '',
    promptContractID = '',
    promptRevisionHash = '',
    realtimeSessionId,
    timeoutMs,
    lifecycleID = '',
  } = {}) {
    const offer = validatedRealtimeWebRTCOffer(sdp);
    const key = safeSessionKey(sessionKey);
    const normalized = normalizeCodexRealtimeWebRTCOptions({
      model,
      version,
      voice,
      outputModality,
      clientManagedHandoffs,
      flushTranscriptTailOnSessionEnd,
      codexResponsesAsItems,
      codexResponseItemPrefix,
      codexResponseHandoffMode,
      includeStartupContext,
      initialItems,
      prompt,
      realtimeSessionId,
    });
    return await this.#withRealtimeLock(async () => {
      const prepared = await this.client.prepareRealtimeWebRTC(normalized);
      return await this.#withSessionLock(key, async () => {
        const session = await this.#ensureSession({
          sessionKey: key,
          sessionMode,
          model: threadModel,
          developerInstructions,
          promptContractHash,
          promptContractID,
          promptRevisionHash,
        });
        const lease = await this.#acquireRealtimeLease({
          sessionKey: key,
          threadID: session.threadID,
          ownerID: safeLifecycleID(lifecycleID),
          transport: 'webrtc',
          version: normalized.version,
          model: normalized.model,
          voice: normalized.voice,
          clientManagedHandoffs: normalized.clientManagedHandoffs === true,
        });
        try {
          const result = await this.client.startRealtimeWebRTC({
            threadID: session.threadID,
            sdp: offer,
            ...normalized,
            timeoutMs,
            prepared,
          });
          if (this.realtimeLease?.ownerID === lease.ownerID) {
            lease.status = 'active';
            lease.touchedAt = Date.now();
          }
          return {
            ...result,
            sessionKey: key,
            promptContractHash: session.promptContractHash || null,
            promptContractID: session.promptContractID || null,
            promptRevisionHash: session.promptRevisionHash || null,
            lifecycleID: lease.ownerID,
            lifecycle: realtimeLifecycleSnapshot(lease),
          };
        } catch (error) {
          this.#finishRealtimeLifecycle(lease, {
            status: 'failed',
            reason: 'start failed',
            error,
          });
          throw error;
        }
      });
    });
  }

  async reconfigureRealtimeWebRTC({
    sessionKey = '',
    threadID = '',
    promptContractHash = '',
    promptContractID = '',
    promptRevisionHash = '',
    prompt = '',
  } = {}) {
    const key = safeSessionKey(sessionKey);
    const targetThreadID = String(threadID || '').trim();
    if (!targetThreadID) {
      throw codexRealtimeRequestError('Codex realtime reconfiguration requires threadID.');
    }
    const normalizedPromptContractHash = safePromptContractHash(promptContractHash);
    const normalizedPromptContractID = safePromptContractID(promptContractID);
    const normalizedPromptRevisionHash = safePromptRevisionHash(promptRevisionHash);
    const normalizedPrompt = String(prompt || '').trim();
    return await this.#withRealtimeLock(async () => {
      return await this.#withSessionLock(key, async () => {
        await this.loadPromise;
        const session = this.sessions.get(key) || null;
        if (!session || session.threadID !== targetThreadID) {
          const error = new Error('The requested GPT Live prompt-contract session was not found.');
          error.code = 'CODEX_REALTIME_SESSION_NOT_FOUND';
          error.statusCode = 404;
          throw error;
        }
        const lease = this.realtimeLease;
        if (!lease
            || lease.transport !== 'webrtc'
            || lease.threadID !== targetThreadID
            || lease.sessionKey !== key) {
          const error = new Error('The requested GPT Live WebRTC session is not active.');
          error.code = 'CODEX_REALTIME_SESSION_NOT_ACTIVE';
          error.statusCode = 409;
          throw error;
        }
        if (normalizedPromptRevisionHash
            && session.promptRevisionHash !== normalizedPromptRevisionHash) {
          const error = new Error(
            'The GPT Live thread instructions changed and require a new voice session.');
          error.code = 'CODEX_REALTIME_PROMPT_REVISION_REQUIRES_RESTART';
          error.statusCode = 409;
          throw error;
        }
        const contractChanged = normalizedPromptContractHash
          && session.promptContractHash !== normalizedPromptContractHash;
        if (contractChanged && !normalizedPrompt) {
          const error = new Error(
            'GPT Live prompt-contract reconfiguration requires the exact updated prompt.');
          error.code = 'CODEX_REALTIME_PROMPT_PAYLOAD_REQUIRED';
          error.statusCode = 400;
          throw error;
        }
        let promptApplied = false;
        if (normalizedPrompt) {
          await this.appendRealtimeTextIdempotent({
            threadID: targetThreadID,
            text: normalizedPrompt,
            role: 'developer',
            requestID: `prompt-contract-${normalizedPromptContractHash}`,
          });
          promptApplied = true;
        }
        session.promptContractHash = normalizedPromptContractHash || null;
        session.promptContractID = normalizedPromptContractID || null;
        session.promptRevisionHash = normalizedPromptRevisionHash
          || session.promptRevisionHash
          || null;
        session.updatedAt = new Date().toISOString();
        await this.#saveState();
        return {
          reconfigured: true,
          sessionKey: key,
          threadID: targetThreadID,
          promptContractHash: session.promptContractHash,
          promptContractID: session.promptContractID,
          promptRevisionHash: session.promptRevisionHash,
          promptApplied,
        };
      });
    });
  }

  async startRealtimeWebSocket({
    sessionKey = '',
    sessionMode = 'attach',
    model = '',
    version = 'v3',
    voice = '',
    outputModality = 'audio',
    timeoutMs,
    leaseOwnerID = '',
  } = {}) {
    const key = safeSessionKey(sessionKey);
    return await this.#withRealtimeLock(async () => {
      return await this.#withSessionLock(key, async () => {
        const session = await this.#ensureSession({ sessionKey: key, sessionMode, model });
        await this.#acquireRealtimeLease({
          sessionKey: key,
          threadID: session.threadID,
          ownerID: String(leaseOwnerID || randomUUID()),
          transport: 'websocket',
          version: safeRealtimeVersion(version),
          model: safeModel(model),
          voice: safeVoice(voice),
        });
        const lease = this.realtimeLease;
        const ownerID = lease?.ownerID || null;
        try {
          const result = await this.client.startRealtimeWebSocket({
            threadID: session.threadID,
            model,
            version,
            voice,
            outputModality,
            timeoutMs,
          });
          if (this.realtimeLease?.ownerID === ownerID) {
            lease.status = 'active';
            lease.touchedAt = Date.now();
            lease.realtimeSessionID = result.realtimeSessionID || null;
            lease.version = result.version || lease.version;
          }
          return { ...result, sessionKey: key, leaseOwnerID: ownerID };
        } catch (error) {
          // A rejected admission must not consume the single Codex realtime slot.
          this.#finishRealtimeLifecycle(lease, {
            status: 'failed',
            reason: 'start failed',
            error,
          });
          throw error;
        }
      });
    });
  }

  touchRealtimeLease(ownerID) {
    if (!this.realtimeLease || this.realtimeLease.ownerID !== ownerID) return false;
    this.realtimeLease.touchedAt = Date.now();
    return true;
  }

  async releaseRealtimeLease(ownerID, reason = 'relay stopped') {
    return await this.#withRealtimeLock(async () => {
      const lease = this.realtimeLease;
      if (!lease || (ownerID && lease.ownerID !== ownerID)) return false;
      const result = await this.#stopRealtimeLease(lease, reason);
      return result.stopped || result.alreadyStopped;
    });
  }

  onNotification(listener) {
    return this.client.onNotification(listener);
  }

  async appendRealtimeAudio(options = {}) {
    return await this.client.appendRealtimeAudio(options);
  }

  async appendRealtimeText(options = {}) {
    return await this.client.appendRealtimeText(options);
  }

  async appendRealtimeTextIdempotent({
    threadID,
    text,
    role = 'user',
    requestID = '',
  } = {}) {
    const targetThreadID = String(threadID || '').trim();
    if (!targetThreadID) throw codexRealtimeRequestError('Codex realtime threadID is required.');
    if (typeof text !== 'string' || !text.trim()) {
      throw codexRealtimeRequestError('Codex realtime text is required.');
    }
    if (text.length > CODEX_REALTIME_APPEND_TEXT_CHAR_LIMIT) {
      throw codexRealtimeRequestError(`Codex realtime text exceeds ${CODEX_REALTIME_APPEND_TEXT_CHAR_LIMIT} characters.`);
    }
    const normalizedRole = String(role || 'user').trim().toLowerCase();
    if (!['user', 'developer', 'assistant'].includes(normalizedRole)) {
      throw codexRealtimeRequestError('Codex realtime text role is invalid.');
    }
    const id = safeLifecycleID(requestID);
    const dedupeKey = `${targetThreadID}:${id}`;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ threadID: targetThreadID, text, role: normalizedRole }))
      .digest('hex');
    this.#pruneRealtimeTextRequests();
    const existing = this.realtimeTextRequests.get(dedupeKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        const error = new Error('Codex realtime requestID was reused with a different text payload.');
        error.code = 'CODEX_REALTIME_IDEMPOTENCY_CONFLICT';
        error.statusCode = 409;
        throw error;
      }
      return { ...await existing.promise, duplicate: true };
    }

    const lease = this.realtimeLease;
    if (!lease || lease.transport !== 'webrtc' || lease.threadID !== targetThreadID) {
      const error = new Error('The requested GPT Live WebRTC session is not active.');
      error.code = 'CODEX_REALTIME_SESSION_NOT_ACTIVE';
      error.statusCode = 409;
      throw error;
    }

    const promise = this.client.appendRealtimeText({
      threadID: targetThreadID,
      text,
      role: normalizedRole,
    }).then(() => ({
      appended: true,
      duplicate: false,
      threadID: targetThreadID,
      requestID: id,
      role: normalizedRole,
    }));
    this.realtimeTextRequests.set(dedupeKey, {
      fingerprint,
      createdAt: Date.now(),
      promise,
    });
    this.#pruneRealtimeTextRequests();
    try {
      return await promise;
    } catch (error) {
      if (this.realtimeTextRequests.get(dedupeKey)?.promise === promise) {
        this.realtimeTextRequests.delete(dedupeKey);
      }
      throw error;
    }
  }

  async appendRealtimeSpeech(options = {}) {
    return await this.client.appendRealtimeSpeech(options);
  }

  async appendRealtimeSpeechIdempotent({
    threadID,
    text,
    requestID = '',
  } = {}) {
    const targetThreadID = String(threadID || '').trim();
    if (!targetThreadID) throw codexRealtimeRequestError('Codex realtime threadID is required.');
    if (typeof text !== 'string' || !text.trim()) {
      throw codexRealtimeRequestError('Codex realtime speech text is required.');
    }
    if (text.length > CODEX_REALTIME_APPEND_TEXT_CHAR_LIMIT) {
      throw codexRealtimeRequestError(`Codex realtime speech exceeds ${CODEX_REALTIME_APPEND_TEXT_CHAR_LIMIT} characters.`);
    }
    const id = safeLifecycleID(requestID);
    const dedupeKey = `${targetThreadID}:${id}`;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ threadID: targetThreadID, text }))
      .digest('hex');
    this.#pruneRealtimeSpeechRequests();
    const existing = this.realtimeSpeechRequests.get(dedupeKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        const error = new Error('Codex realtime requestID was reused with a different speech payload.');
        error.code = 'CODEX_REALTIME_IDEMPOTENCY_CONFLICT';
        error.statusCode = 409;
        throw error;
      }
      return { ...await existing.promise, duplicate: true };
    }

    const lease = this.realtimeLease;
    if (!lease || lease.transport !== 'webrtc' || lease.threadID !== targetThreadID) {
      const error = new Error('The requested GPT Live WebRTC session is not active.');
      error.code = 'CODEX_REALTIME_SESSION_NOT_ACTIVE';
      error.statusCode = 409;
      throw error;
    }

    const promise = this.client.appendRealtimeSpeech({
      threadID: targetThreadID,
      text,
    }).then(() => ({
      appended: true,
      duplicate: false,
      threadID: targetThreadID,
      requestID: id,
    }));
    this.realtimeSpeechRequests.set(dedupeKey, {
      fingerprint,
      createdAt: Date.now(),
      promise,
    });
    this.#pruneRealtimeSpeechRequests();
    try {
      return await promise;
    } catch (error) {
      if (this.realtimeSpeechRequests.get(dedupeKey)?.promise === promise) {
        this.realtimeSpeechRequests.delete(dedupeKey);
      }
      throw error;
    }
  }

  async stopRealtimeWebRTC({
    threadID,
    sessionKey,
    lifecycleID = '',
  } = {}) {
    const targetThreadID = String(threadID || '').trim();
    const rawSessionKey = String(sessionKey || '').trim();
    if (!targetThreadID || !rawSessionKey) {
      throw codexRealtimeRequestError('Codex realtime stop requires threadID and sessionKey.');
    }
    const key = safeSessionKey(rawSessionKey);
    const requestedLifecycleID = lifecycleID ? safeLifecycleID(lifecycleID) : '';
    return await this.#withRealtimeLock(async () => {
      return await this.#withSessionLock(key, async () => {
        const lease = this.realtimeLease;
        const matchesSession = lease
          && lease.transport === 'webrtc'
          && lease.threadID === targetThreadID
          && lease.sessionKey === key;
        if (matchesSession && requestedLifecycleID && lease.ownerID !== requestedLifecycleID) {
          return {
            stopped: false,
            alreadyStopped: true,
            stale: true,
            threadID: targetThreadID,
            sessionKey: key,
            lifecycleID: requestedLifecycleID,
            status: 'stopped',
          };
        }
        if (matchesSession) return await this.#stopRealtimeLease(lease, 'client stop');

        const last = this.lastRealtimeLifecycle;
        const previouslyClosed = last
          && last.transport === 'webrtc'
          && last.threadID === targetThreadID
          && last.sessionKey === key
          && (!requestedLifecycleID || last.ownerID === requestedLifecycleID);
        return {
          stopped: false,
          alreadyStopped: true,
          stale: !!lease && !previouslyClosed,
          threadID: targetThreadID,
          sessionKey: key,
          lifecycleID: requestedLifecycleID || (previouslyClosed ? last.ownerID : null),
          status: 'stopped',
        };
      });
    });
  }

  async stopRealtime(threadID) {
    return await this.#withRealtimeLock(async () => {
      const targetThreadID = String(threadID || '').trim();
      const lease = this.realtimeLease;
      if (lease?.threadID === targetThreadID) {
        return await this.#stopRealtimeLease(lease, 'bridge stop');
      }
      try {
        return await this.client.stopRealtime(targetThreadID);
      } catch (error) {
        if (isRealtimeAlreadyStoppedError(error)) return {};
        throw error;
      }
    });
  }

  stop() {
    if (this.realtimeLease) {
      this.#finishRealtimeLifecycle(this.realtimeLease, {
        status: 'closed',
        reason: 'bridge stopped',
      });
    }
    this.realtimeTextRequests.clear();
    this.realtimeSpeechRequests.clear();
    this.client.stop();
  }

  async #acquireRealtimeLease({
    sessionKey,
    threadID,
    ownerID,
    transport = '',
    version = '',
    model = '',
    voice = '',
    clientManagedHandoffs = false,
  }) {
    const current = this.realtimeLease;
    if (current) {
      // Codex currently admits one realtime session. A new VoiceClaw start owns that
      // slot and replaces the prior lease so stale/disconnected clients cannot strand it.
      try { await this.client.stopRealtime(current.threadID); } catch {}
      this.#finishRealtimeLifecycle(current, {
        status: 'closed',
        reason: 'replaced by a newer realtime session',
      });
    }
    const now = Date.now();
    const lease = {
      sessionKey,
      threadID,
      ownerID,
      transport,
      version,
      model: model || null,
      voice: voice || null,
      clientManagedHandoffs: clientManagedHandoffs === true,
      interruptedTurnIDs: new Set(),
      broker: {
        anchorTurnsObserved: 0,
        anchorTurnsInterrupted: 0,
        interruptFailures: 0,
        lastInterruptedTurnID: null,
        lastInterruptError: null,
      },
      status: 'starting',
      realtimeSessionID: null,
      acquiredAt: now,
      touchedAt: now,
      closedAt: null,
      closeReason: null,
      error: null,
    };
    this.realtimeLease = lease;
    return lease;
  }

  async #stopRealtimeLease(lease, reason) {
    lease.status = 'stopping';
    lease.touchedAt = Date.now();
    let alreadyStopped = false;
    try {
      await this.client.stopRealtime(lease.threadID);
    } catch (error) {
      if (!isRealtimeAlreadyStoppedError(error)) {
        if (this.realtimeLease?.ownerID === lease.ownerID) lease.status = 'active';
        throw error;
      }
      alreadyStopped = true;
    }
    this.#finishRealtimeLifecycle(lease, {
      status: 'closed',
      reason: alreadyStopped ? 'already stopped' : reason,
    });
    return {
      stopped: !alreadyStopped,
      alreadyStopped,
      stale: false,
      threadID: lease.threadID,
      sessionKey: lease.sessionKey,
      lifecycleID: lease.ownerID,
      status: 'stopped',
    };
  }

  #finishRealtimeLifecycle(lease, {
    status = 'closed',
    reason = '',
    error = null,
  } = {}) {
    if (!lease) return;
    lease.status = status;
    lease.touchedAt = Date.now();
    lease.closedAt = Date.now();
    lease.closeReason = reason;
    lease.error = error ? String(error?.message || error) : null;
    if (this.realtimeLease?.ownerID === lease.ownerID) this.realtimeLease = null;
    this.lastRealtimeLifecycle = { ...lease };
  }

  #pruneRealtimeTextRequests() {
    const cutoff = Date.now() - CODEX_REALTIME_TEXT_IDEMPOTENCY_TTL_MS;
    for (const [key, entry] of this.realtimeTextRequests) {
      if (entry.createdAt >= cutoff) continue;
      this.realtimeTextRequests.delete(key);
    }
    while (this.realtimeTextRequests.size > CODEX_REALTIME_TEXT_IDEMPOTENCY_LIMIT) {
      const oldest = this.realtimeTextRequests.keys().next().value;
      if (!oldest) break;
      this.realtimeTextRequests.delete(oldest);
    }
  }

  #pruneRealtimeSpeechRequests() {
    const cutoff = Date.now() - CODEX_REALTIME_TEXT_IDEMPOTENCY_TTL_MS;
    for (const [key, entry] of this.realtimeSpeechRequests) {
      if (entry.createdAt >= cutoff) continue;
      this.realtimeSpeechRequests.delete(key);
    }
    while (this.realtimeSpeechRequests.size > CODEX_REALTIME_TEXT_IDEMPOTENCY_LIMIT) {
      const oldest = this.realtimeSpeechRequests.keys().next().value;
      if (!oldest) break;
      this.realtimeSpeechRequests.delete(oldest);
    }
  }

  async #ensureSession({
    sessionKey,
    sessionMode,
    model,
    developerInstructions = '',
    promptContractHash = '',
    promptContractID = '',
    promptRevisionHash = '',
  }) {
    await this.loadPromise;
    await mkdir(this.workspacePath, { recursive: true });
    await this.client.start();
    if (this.loadedGeneration !== this.client.generation) {
      this.loadedGeneration = this.client.generation;
      for (const session of this.sessions.values()) session.loadedGeneration = 0;
    }
    const mode = String(sessionMode || 'attach').trim().toLowerCase();
    const normalizedDeveloperInstructions = safeDeveloperInstructions(developerInstructions);
    const normalizedPromptContractHash = safePromptContractHash(promptContractHash);
    const normalizedPromptContractID = safePromptContractID(promptContractID);
    const normalizedPromptRevisionHash = safePromptRevisionHash(promptRevisionHash);
    let session = this.sessions.get(sessionKey) || null;
    if (mode === 'new') session = null;
    if (session
        && normalizedPromptRevisionHash
        && session.promptRevisionHash !== normalizedPromptRevisionHash) {
      // Developer instructions are fixed at thread creation. A contract
      // revision that changes them receives a fresh Codex thread. A legacy
      // record with no revision is also replaced because its instructions
      // cannot be proven equivalent. Route/auth metadata changes alone retain
      // a thread only after the revision identity is established.
      session = null;
    }
    if (session && session.loadedGeneration !== this.client.generation) {
      try {
        await this.client.resumeThread(session.threadID);
        session.loadedGeneration = this.client.generation;
        session.promptContractHash = normalizedPromptContractHash || session.promptContractHash;
        session.promptContractID = normalizedPromptContractID || session.promptContractID;
        session.promptRevisionHash = normalizedPromptRevisionHash
          || session.promptRevisionHash
          || null;
        session.updatedAt = new Date().toISOString();
        await this.#saveState();
        return session;
      } catch {
        session = null;
      }
    }
    if (session) {
      session.promptContractHash = normalizedPromptContractHash || session.promptContractHash;
      session.promptContractID = normalizedPromptContractID || session.promptContractID;
      session.promptRevisionHash = normalizedPromptRevisionHash
        || session.promptRevisionHash
        || null;
      session.updatedAt = new Date().toISOString();
      await this.#saveState();
      return session;
    }
    const started = await this.client.startThread({
      model,
      cwd: this.workspacePath,
      developerInstructions: normalizedDeveloperInstructions,
    });
    const threadID = String(started?.thread?.id || '').trim();
    if (!threadID) throw new Error('Codex app-server did not return a thread id.');
    session = {
      sessionKey,
      threadID,
      model: safeModel(model) || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      promptContractHash: normalizedPromptContractHash || null,
      promptContractID: normalizedPromptContractID || null,
      promptRevisionHash: normalizedPromptRevisionHash || null,
      loadedGeneration: this.client.generation,
    };
    this.sessions.set(sessionKey, session);
    await this.#saveState();
    return session;
  }

  async #withSessionLock(sessionKey, operation) {
    const previous = this.sessionLocks.get(sessionKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.sessionLocks.set(sessionKey, current);
    try {
      return await current;
    } finally {
      if (this.sessionLocks.get(sessionKey) === current) this.sessionLocks.delete(sessionKey);
    }
  }

  async #withRealtimeLock(operation) {
    const previous = this.realtimeOperationLock;
    const current = previous.catch(() => {}).then(operation);
    this.realtimeOperationLock = current;
    try {
      return await current;
    } finally {
      if (this.realtimeOperationLock === current) this.realtimeOperationLock = Promise.resolve();
    }
  }

  async #loadState() {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (![1, 2, SESSION_SCHEMA_VERSION].includes(parsed?.schemaVersion)
          || !Array.isArray(parsed.sessions)) return;
      for (const session of parsed.sessions) {
        const sessionKey = safeSessionKey(session?.sessionKey);
        const threadID = String(session?.threadID || '').trim();
        if (!threadID) continue;
        this.sessions.set(sessionKey, {
          sessionKey,
          threadID,
          model: session?.model ? safeModel(session.model) : null,
          createdAt: session?.createdAt || null,
          updatedAt: session?.updatedAt || null,
          promptContractHash: session?.promptContractHash
            ? safePromptContractHash(session.promptContractHash)
            : null,
          promptContractID: session?.promptContractID
            ? safePromptContractID(session.promptContractID)
            : null,
          promptRevisionHash: session?.promptRevisionHash
            ? safePromptRevisionHash(session.promptRevisionHash)
            : null,
          loadedGeneration: 0,
        });
      }
    } catch {}
  }

  async #saveState() {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      sessions: [...this.sessions.values()].map(({ loadedGeneration: _ignored, ...session }) => session),
    };
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.statePath);
  }
}

function relaySocketOpen(ws) {
  return ws?.readyState === 1;
}

function relayJSON(ws, payload) {
  if (!relaySocketOpen(ws)) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

function decodeRelayAudio(value) {
  const encoded = String(value || '').trim();
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('Codex realtime input_audio.data must be valid base64 PCM16 audio.');
  }
  const audio = Buffer.from(encoded, 'base64');
  if (!audio.length || audio.length > CODEX_REALTIME_RELAY_MAX_INPUT_BYTES) {
    throw new Error(`Codex realtime input audio must be between 1 and ${CODEX_REALTIME_RELAY_MAX_INPUT_BYTES} bytes.`);
  }
  return audio;
}

function relaySamplesPerChannel(audio, channels) {
  const frameBytes = 2 * channels;
  if (audio.length % frameBytes !== 0) {
    throw new Error('Codex realtime input audio must contain complete signed 16-bit PCM frames.');
  }
  return audio.length / frameBytes;
}

/**
 * Relays the verified Codex app-server V2 WebSocket media path to an authenticated
 * VoiceClaw client. V3 is deliberately not accepted here: its `/v1/live` backend
 * admission is a separate capability and must never be inferred from V2 success.
 */
export function attachCodexRealtimeRelaySocket({
  ws,
  bridge,
  defaultModel = 'gpt-realtime-2.1-mini',
  defaultVoice = 'marin',
} = {}) {
  if (!ws || !bridge) throw new Error('Codex realtime relay requires a socket and bridge.');

  let activeThreadID = '';
  let inputSampleRate = 24_000;
  let inputChannels = 1;
  let closed = false;
  const leaseOwnerID = randomUUID();
  let operationQueue = Promise.resolve();

  const sendError = (error, code = 'CODEX_REALTIME_RELAY_ERROR') => {
    relayJSON(ws, {
      type: 'error',
      code: String(error?.code || code),
      message: String(error?.message || error || 'Codex realtime relay failed.'),
    });
  };

  const appendAudio = async (audio) => {
    if (!activeThreadID) throw new Error('Start the Codex realtime relay before sending audio.');
    if (audio.length > CODEX_REALTIME_RELAY_MAX_INPUT_BYTES) {
      throw new Error(`Codex realtime input audio exceeds ${CODEX_REALTIME_RELAY_MAX_INPUT_BYTES} bytes.`);
    }
    await bridge.appendRealtimeAudio({
      threadID: activeThreadID,
      data: audio.toString('base64'),
      sampleRate: inputSampleRate,
      numChannels: inputChannels,
      samplesPerChannel: relaySamplesPerChannel(audio, inputChannels),
    });
    bridge.touchRealtimeLease(leaseOwnerID);
  };

  const unsubscribe = bridge.onNotification((message) => {
    const method = String(message?.method || '');
    const params = message?.params || {};
    if (!activeThreadID || params.threadId !== activeThreadID || !method.startsWith('thread/realtime/')) return;

    if (method === 'thread/realtime/outputAudio/delta') {
      const audio = params.audio || {};
      let decoded;
      try {
        decoded = decodeRelayAudio(audio.data);
      } catch (error) {
        sendError(error, 'CODEX_REALTIME_OUTPUT_AUDIO_INVALID');
        return;
      }
      const projectedBytes = Number(ws.bufferedAmount || 0) + decoded.length;
      if (projectedBytes > CODEX_REALTIME_RELAY_MAX_BUFFERED_OUTPUT_BYTES) {
        sendError(new Error('Codex realtime output exceeded the client backpressure limit.'), 'CODEX_REALTIME_OUTPUT_BACKPRESSURE');
        try { ws.close(1013, 'output backpressure'); } catch {}
        return;
      }
      relayJSON(ws, {
        type: 'output_audio',
        byteLength: decoded.length,
        sampleRate: Number(audio.sampleRate || 0),
        numChannels: Number(audio.numChannels || 0),
        samplesPerChannel: audio.samplesPerChannel ?? null,
        itemID: audio.itemId || null,
      });
      if (relaySocketOpen(ws)) ws.send(decoded, { binary: true });
      return;
    }

    relayJSON(ws, {
      type: 'codex_realtime_event',
      method,
      params,
    });
    if (method === 'thread/realtime/closed') activeThreadID = '';
  });

  const processControl = async (message) => {
    const type = String(message?.type || '').trim().toLowerCase();
    if (type === 'start') {
      if (activeThreadID) await bridge.stopRealtime(activeThreadID).catch(() => {});
      if (message.allowAPIKeyAuth !== true) {
        const error = new Error('Codex Realtime Voice requires API key authentication. Select API Key authentication or enable API-key fallback in VoiceClaw Realtime.');
        error.code = 'CODEX_REALTIME_API_KEY_NOT_AUTHORIZED';
        throw error;
      }
      const requestedVersion = String(message.version || 'v2').trim().toLowerCase();
      if (requestedVersion !== 'v2') {
        const error = new Error('This relay exposes only verified Codex Realtime Voice V2. GPT Live V3 requires separate backend admission.');
        error.code = 'CODEX_REALTIME_VERSION_NOT_ADMITTED';
        throw error;
      }
      const format = message.inputAudio && typeof message.inputAudio === 'object' ? message.inputAudio : {};
      const encoding = String(format.encoding || 'pcm_s16le').trim().toLowerCase();
      inputSampleRate = Number(format.sampleRate || 24_000);
      inputChannels = Number(format.numChannels || 1);
      if (encoding !== 'pcm_s16le') throw new Error('Codex realtime relay input must use pcm_s16le.');
      if (!Number.isInteger(inputSampleRate) || inputSampleRate < 8_000 || inputSampleRate > 192_000) {
        throw new Error('Codex realtime relay input sample rate is invalid.');
      }
      if (!Number.isInteger(inputChannels) || inputChannels < 1 || inputChannels > 2) {
        throw new Error('Codex realtime relay input channel count is invalid.');
      }
      const result = await bridge.startRealtimeWebSocket({
        sessionKey: message.sessionKey || message.sessionToken || '',
        sessionMode: message.sessionMode || 'attach',
        version: 'v2',
        model: message.model || defaultModel,
        voice: message.voice || defaultVoice,
        outputModality: message.outputModality || 'audio',
        timeoutMs: message.timeoutMs,
        leaseOwnerID,
      });
      if (closed) {
        await bridge.stopRealtime(result.threadID).catch(() => {});
        return;
      }
      activeThreadID = result.threadID;
      relayJSON(ws, {
        type: 'started',
        protocol: 'v2',
        transport: 'codex-app-server-websocket',
        sessionKey: result.sessionKey,
        model: result.model,
        voice: result.voice,
        outputModality: result.outputModality,
        realtimeSessionID: result.realtimeSessionID,
        inputAudio: {
          encoding: 'pcm_s16le',
          sampleRate: inputSampleRate,
          numChannels: inputChannels,
        },
      });
      return;
    }
    if (type === 'input_audio') {
      bridge.touchRealtimeLease(leaseOwnerID);
      await appendAudio(decodeRelayAudio(message.data));
      return;
    }
    if (type === 'input_text') {
      if (!activeThreadID) throw new Error('Start the Codex realtime relay before sending text.');
      await bridge.appendRealtimeText({ threadID: activeThreadID, text: message.text, role: message.role || 'user' });
      bridge.touchRealtimeLease(leaseOwnerID);
      return;
    }
    if (type === 'input_speech') {
      if (!activeThreadID) throw new Error('Start the Codex realtime relay before sending speech.');
      await bridge.appendRealtimeSpeech({ threadID: activeThreadID, text: message.text });
      bridge.touchRealtimeLease(leaseOwnerID);
      return;
    }
    if (type === 'stop') {
      if (activeThreadID) await bridge.releaseRealtimeLease(leaseOwnerID, 'client stop');
      activeThreadID = '';
      relayJSON(ws, { type: 'stopped' });
      return;
    }
    if (type === 'ping') {
      relayJSON(ws, { type: 'pong' });
      return;
    }
    throw new Error(`Unsupported Codex realtime relay control: ${type || '(missing)'}`);
  };

  const onMessage = (data, isBinary) => {
    operationQueue = operationQueue
      .then(async () => {
        if (closed) return;
        if (isBinary) {
          const audio = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
          await appendAudio(audio);
          return;
        }
        let message;
        try {
          message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data || ''));
        } catch {
          throw new Error('Codex realtime relay controls must be valid JSON.');
        }
        await processControl(message);
      })
      .catch((error) => sendError(error));
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    ws.off?.('message', onMessage);
    unsubscribe?.();
    if (activeThreadID) {
      operationQueue = operationQueue
        .catch(() => {})
        .then(() => bridge.releaseRealtimeLease(leaseOwnerID, 'relay disconnected'))
        .catch(() => {});
    }
    activeThreadID = '';
  };

  ws.on('message', onMessage);
  ws.once?.('close', cleanup);
  ws.once?.('error', cleanup);
  relayJSON(ws, {
    type: 'ready',
    protocol: 'v2',
    transport: 'codex-app-server-websocket',
    defaultModel,
    defaultVoice,
  });

  return {
    close: cleanup,
    whenIdle: () => operationQueue,
  };
}

export const __codexAppServerTestHooks = Object.freeze({
  safeModel,
  safeReasoningEffort,
  safeSessionKey,
  trackerText,
  realtimeFeatureName: REALTIME_FEATURE_NAME,
});
