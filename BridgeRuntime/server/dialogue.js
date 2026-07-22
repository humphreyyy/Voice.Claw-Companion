// Dialogue module — OpenClaw intercom agent bridge.
// Processing is selectable per turn via route presets that map to real
// backend behavior the current CLI path can actually invoke.

import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw';
const HERMES_BIN = process.env.HERMES_BIN || join(os.homedir(), '.local', 'bin', 'hermes');
const HERMES_HOME = process.env.HERMES_HOME || join(os.homedir(), '.hermes');
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || join(os.homedir(), '.openclaw', 'openclaw.json');
const OPENCLAW_INSTALL_PATH = process.env.OPENCLAW_INSTALL_PATH || join(os.homedir(), '.openclaw');
const OPENCLAW_GATEWAY_MODULE = process.env.OPENCLAW_GATEWAY_MODULE || '';
const DEFAULT_AGENT = process.env.INTERCOM_AGENT || process.env.OPENCLAW_AGENT || 'main';
const DEFAULT_SESSION = process.env.INTERCOM_SESSION_ID || 'voice-intercom-default';
const DEFAULT_THINKING = process.env.INTERCOM_THINKING || 'minimal';
const INSTANT_RAW_MODEL = 'openai/chat-latest';
const BRIDGE_DEFAULT_MODEL = process.env.INTERCOM_DEFAULT_MODEL || 'openai/gpt-5.5';
const BRIDGE_DEFAULT_LABEL = process.env.INTERCOM_DEFAULT_MODEL_LABEL || 'GPT-5.5 (OpenClaw tools)';
const DIRECT_GPT55_ROUTE_ID = 'gpt55-direct';
const DIRECT_GPT55_MODEL = 'openai/gpt-5.5';
const DIRECT_OPENAI_MODEL_ROUTES = [
  {
    id: DIRECT_GPT55_ROUTE_ID,
    label: 'GPT-5.5 Direct (raw/no OpenClaw)',
    model: DIRECT_GPT55_MODEL,
    aliases: ['gpt55-direct', 'gpt55direct', 'gpt-5.5-direct', 'gpt-5.5-without-openclaw', 'without-openclaw'],
  },
  {
    id: 'gpt54-direct',
    label: 'GPT-5.4 Direct (raw/no OpenClaw)',
    model: 'openai/gpt-5.4',
    aliases: ['gpt54-direct', 'gpt54direct', 'gpt-5.4-direct', 'gpt-5.4', 'gpt54'],
  },
  {
    id: 'gpt54-mini-direct',
    label: 'GPT-5.4-mini Direct (raw/no OpenClaw)',
    model: 'openai/gpt-5.4-mini',
    aliases: ['gpt54-mini-direct', 'gpt54mini-direct', 'gpt-5.4-mini-direct', 'gpt-5.4-mini', 'gpt54mini', 'gpt54-nano-direct', 'gpt54nano-direct', 'gpt-5.4-nano-direct', 'gpt-5.4-nano', 'gpt54nano'],
  },
  {
    id: 'gpt56-sol-direct',
    label: 'GPT-5.6 Sol Direct (raw/no OpenClaw)',
    model: 'openai/gpt-5.6-sol',
    aliases: ['gpt56-sol-direct', 'gpt56soldirect', 'gpt-5.6-sol-direct', 'gpt-5.6-sol', 'gpt56sol'],
  },
  {
    id: 'gpt56-terra-direct',
    label: 'GPT-5.6 Terra Direct (raw/no OpenClaw)',
    model: 'openai/gpt-5.6-terra',
    aliases: ['gpt56-terra-direct', 'gpt56terradirect', 'gpt-5.6-terra-direct', 'gpt-5.6-terra', 'gpt56terra'],
  },
  {
    id: 'gpt56-luna-direct',
    label: 'GPT-5.6 Luna Direct (raw/no OpenClaw)',
    model: 'openai/gpt-5.6-luna',
    aliases: ['gpt56-luna-direct', 'gpt56lunadirect', 'gpt-5.6-luna-direct', 'gpt-5.6-luna', 'gpt56luna'],
  },
];
const THINKING_OPTIONS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const DEFAULT_SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_STATE_TTL_MS = (() => {
  const requested = Number(process.env.VOICECLAW_DIALOGUE_SESSION_TTL_MS || process.env.DIALOGUE_SESSION_TTL_MS || DEFAULT_SESSION_STATE_TTL_MS);
  return Number.isFinite(requested) && requested > 0 ? Math.max(1000, requested) : DEFAULT_SESSION_STATE_TTL_MS;
})();
const GATEWAY_ABORT_REQUEST_TIMEOUT_MS = 2000;
const GATEWAY_ABORT_RETRY_DELAYS_MS = [0, 50, 150, 300, 600];
const GATEWAY_ABORT_FALLBACK_DELAY_MS = 50;

function shortModelName(modelId = '') {
  if (!modelId) return 'default';
  const clean = String(modelId);
  return clean.includes('/') ? clean.split('/').slice(-1)[0] : clean;
}

function loadRuntimeMetadata() {
  try {
    return JSON.parse(readFileSync(OPENCLAW_CONFIG, 'utf8'));
  } catch {
    return null;
  }
}

function modelOptionId(modelId = '') {
  return shortModelName(modelId).replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

function isKnownUnavailableModel(modelId = '') {
  // This model may remain in older local config, but the live provider rejects it.
  // Hide it from the intercom selector so saved browser selections self-heal to the primary model.
  return /gpt-5\.3-codex-spark$/i.test(String(modelId || ''));
}

function buildProcessingRoutes() {
  const runtime = loadRuntimeMetadata();
  const defaultsModel = runtime?.agents?.defaults?.model || {};
  const defaultsPrimary = defaultsModel?.primary || '';
  const fallbackModels = Array.isArray(defaultsModel?.fallbacks) ? defaultsModel.fallbacks : [];
  const modelsMap = runtime?.agents?.defaults?.models || {};

  const orderedModelIds = [];
  const addModel = (modelId) => {
    const value = String(modelId || '').trim();
    if (!value || orderedModelIds.includes(value)) return;
    orderedModelIds.push(value);
  };

  // Put the bridge's preferred brain first without changing OpenClaw's global default.
  // The default must remain OpenClaw-aware: raw chat-latest is available as an
  // explicit instant option, but it has no tools/context and cannot answer
  // calendar, account, or personal-context questions correctly.
  addModel(BRIDGE_DEFAULT_MODEL);

  // Match the models surfaced by OpenClaw's /models view: configured model entries,
  // with the primary/fallback order preserved after the bridge-specific default.
  addModel(defaultsPrimary);
  fallbackModels.forEach(addModel);
  Object.keys(modelsMap).forEach(addModel);

  const routes = orderedModelIds.filter((fullModelId) => !isKnownUnavailableModel(fullModelId)).map((fullModelId) => {
    const isBridgeDefault = fullModelId === BRIDGE_DEFAULT_MODEL;
    const isInstantRaw = fullModelId === INSTANT_RAW_MODEL;
    const alias = isBridgeDefault || isInstantRaw ? modelOptionId(fullModelId) : (modelsMap[fullModelId]?.alias || modelOptionId(fullModelId));
    const short = shortModelName(fullModelId);
    const isPrimaryDefault = fullModelId === defaultsPrimary;
    return {
      id: alias,
      label: isInstantRaw ? 'GPT-5.5 Instant (chat-latest · raw/no tools)' : (isBridgeDefault ? BRIDGE_DEFAULT_LABEL : short),
      agent: DEFAULT_AGENT,
      model: fullModelId,
      // chat-latest is fast only through OpenClaw's raw model-run path. The
      // full tool-enabled OpenClaw agent path times out with this public API
      // alias, so keep it selectable but never make it masquerade as the
      // OpenClaw-aware default route.
      modelRun: isInstantRaw,
      promptMode: isInstantRaw ? 'none' : undefined,
      // Do not waste a CLI turn priming /model for the already-active default.
      // That keeps the selected model unchanged while removing a repeated latency tax.
      modelOverride: isPrimaryDefault ? null : fullModelId,
      fastHint: true,
      fastVerified: isBridgeDefault,
    };
  });

  routes.splice(Math.min(routes.length, 1), 0, ...DIRECT_OPENAI_MODEL_ROUTES.map((route) => ({
    id: route.id,
    label: route.label,
    agent: DEFAULT_AGENT,
    model: route.model,
    modelRun: true,
    promptMode: 'none',
    modelOverride: route.model,
    fastHint: true,
    fastVerified: false,
  })));

  // Hard fallback if runtime metadata is unavailable.
  if (!routes.length) {
    routes.push({
      id: 'default',
      label: 'default',
      agent: DEFAULT_AGENT,
      model: null,
      modelOverride: null,
      fastHint: true,
      fastVerified: false,
    });
  }

  // Deduplicate while preserving order.
  const seen = new Set();
  return routes.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
const PROCESSING_ROUTES = buildProcessingRoutes();
const FAST_MODE_OPTIONS = ['on'];
const _primedSessions = new Map();
const _hermesSessions = new Map();
const _hermesOperations = new Map();
let callGatewayLoader = null;
let execFileRunner = execFile;
const sessionStateCleanupTimer = setInterval(
  () => pruneSessionState(),
  Math.min(5 * 60 * 1000, Math.max(1000, Math.floor(SESSION_STATE_TTL_MS / 2))),
);
sessionStateCleanupTimer.unref?.();

function normalizeThinking(value) {
  return THINKING_OPTIONS.includes(value) ? value : DEFAULT_THINKING;
}

function normalizeFastMode(value) {
  return 'on';
}

function routeIdByAlias(raw) {
  const wanted = String(raw || '').trim();
  if (!wanted) return '';

  const primary = PROCESSING_ROUTES[0]?.id || 'default';
  if (wanted === 'main' || wanted === 'default' || wanted === 'default-fast' || wanted === 'intercom' || wanted === 'gpt54' || wanted === 'gpt54-fast') return primary;
  const directRoute = DIRECT_OPENAI_MODEL_ROUTES.find((route) => route.aliases.includes(wanted));
  if (directRoute) return directRoute.id;
  return wanted;
}

function defaultRouteId() {
  const preferred = String(DEFAULT_AGENT || '').trim();
  if (preferred && PROCESSING_ROUTES.some((o) => o.id === preferred)) return preferred;
  return PROCESSING_ROUTES[0].id;
}

function normalizeRoute(value) {
  const wanted = routeIdByAlias(value);
  if (!wanted) return defaultRouteId();
  return PROCESSING_ROUTES.some((o) => o.id === wanted) ? wanted : defaultRouteId();
}

function sanitizeSessionToken(value) {
  const cleaned = String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'base';
}

function safeSessionIdPart(value, fallback = 'default') {
  const cleaned = String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function shortHash(value) {
  return createHash('sha1').update(String(value || '')).digest('hex').slice(0, 10);
}

function compactSessionToken(value) {
  const token = sanitizeSessionToken(value);
  if (token.length <= 18) return token;
  return `${token.slice(0, 12).replace(/[-._]+$/g, '')}-${shortHash(token)}`;
}

function routeSessionId(routeId, sessionToken) {
  const suffix = safeSessionIdPart(routeId, 'default').slice(0, 32).replace(/[-._]+$/g, '') || 'default';
  const token = compactSessionToken(sessionToken);
  // OpenClaw 2026.4.26 validates explicit session ids with /^[a-z0-9][a-z0-9._-]{0,127}$/i,
  // and the OpenAI Responses backend currently rejects prompt_cache_key values >64 chars.
  // Keep voice sessions short, stable, and route-scoped so model-selector turns do not fail before generation.
  const id = ['voice', token, suffix].join('-').replace(/[-._]+$/g, '');
  if (id.length <= 64) return id;
  return ['voice', shortHash(`${token}:${suffix}`), suffix.slice(0, 44)].join('-').slice(0, 64).replace(/[-._]+$/g, '') || 'voice-default';
}

function normalizeSessionMode(input = {}) {
  const raw = String(input.sessionMode || input.sessionBehavior || (input.newSession ? 'new' : (input.resumeSessionId ? 'resume' : 'attach'))).trim().toLowerCase();
  if (raw === 'new' || raw === 'new-session' || raw === 'reset') return 'new';
  if (raw === 'resume') return 'resume';
  return 'attach';
}

function normalizeExplicitSessionId(value) {
  const normalized = safeSessionIdPart(value, '').slice(0, 64).replace(/[-._]+$/g, '');
  return normalized || '';
}

function newRouteSessionId(routeId, sessionToken) {
  const base = routeSessionId(routeId, sessionToken);
  const suffix = `new-${shortHash(randomUUID())}`;
  return `${base.slice(0, Math.max(1, 64 - suffix.length - 1)).replace(/[-._]+$/g, '')}-${suffix}`;
}

function resolveSessionTarget(route, input = {}) {
  const mode = normalizeSessionMode(input);
  const routeDerivedSessionId = routeSessionId(route.id, input.sessionToken);
  const explicitSessionId = normalizeExplicitSessionId(
    input.sessionId || input.openClawSessionId || (mode === 'new' ? input.newSessionId : input.resumeSessionId),
  );
  const sessionId = explicitSessionId || (mode === 'new' ? newRouteSessionId(route.id, input.sessionToken) : routeDerivedSessionId);
  const source = explicitSessionId
    ? (String(input.sessionSource || '').trim() || 'explicit')
    : (mode === 'new' ? 'generated' : 'route-derived');

  return {
    mode,
    source,
    sessionId,
    routeDerivedSessionId,
    continuity: mode === 'new' ? 'new' : `${mode}-or-create`,
  };
}


function sessionKeyForGateway(cfg) {
  if (cfg.sessionKey) return cfg.sessionKey;
  const suffix = safeSessionIdPart(cfg.sessionId, 'default');
  // Keep this legacy bridge key shape stable. Changing it would strand existing
  // VoiceClaw transcripts even though newer OpenClaw CLIs generate :explicit: keys.
  return `agent:${cfg.agent}:${suffix}`;
}

function getOpenClawSessionState(sessionId) {
  pruneSessionState();
  let state = _primedSessions.get(sessionId);
  if (!state) {
    state = { fastMode: null, activeRequests: 0, lastUsedAt: Date.now() };
    _primedSessions.set(sessionId, state);
  }
  state.lastUsedAt = Date.now();
  return state;
}

function getHermesOperationState(sessionId) {
  pruneSessionState();
  let state = _hermesOperations.get(sessionId);
  if (!state) {
    state = { activeRequests: 0, pendingRequests: 0, lastUsedAt: Date.now(), tail: Promise.resolve() };
    _hermesOperations.set(sessionId, state);
  }
  state.lastUsedAt = Date.now();
  return state;
}

function pruneSessionState(now = Date.now()) {
  for (const [sessionId, state] of _primedSessions.entries()) {
    if (state.activeRequests > 0) continue;
    if (now - state.lastUsedAt >= SESSION_STATE_TTL_MS) _primedSessions.delete(sessionId);
  }

  for (const [sessionId, mapping] of _hermesSessions.entries()) {
    const operation = _hermesOperations.get(sessionId);
    if ((operation?.activeRequests || 0) > 0 || (operation?.pendingRequests || 0) > 0) continue;
    if (now - mapping.lastUsedAt >= SESSION_STATE_TTL_MS) _hermesSessions.delete(sessionId);
  }

  for (const [sessionId, state] of _hermesOperations.entries()) {
    if (state.activeRequests > 0 || state.pendingRequests > 0) continue;
    if (now - state.lastUsedAt >= SESSION_STATE_TTL_MS) _hermesOperations.delete(sessionId);
  }
}

async function withOpenClawSessionActivity(sessionId, operation) {
  const state = getOpenClawSessionState(sessionId);
  state.activeRequests += 1;
  try {
    return await operation(state);
  } finally {
    state.activeRequests = Math.max(0, state.activeRequests - 1);
    state.lastUsedAt = Date.now();
  }
}

function gatewayRequestId(value = '') {
  const supplied = String(value || '').trim();
  return supplied ? supplied.slice(0, 256) : `voice-bridge-${Date.now()}-${randomUUID()}`;
}

function readAcceptedRunContext(payload) {
  if (!payload || typeof payload !== 'object' || payload.status !== 'accepted') return {};
  return {
    runId: typeof payload.runId === 'string' && payload.runId.trim() ? payload.runId.trim() : undefined,
    sessionKey: typeof payload.sessionKey === 'string' && payload.sessionKey.trim() ? payload.sessionKey.trim() : undefined,
  };
}

function isConfirmedGatewayAbort(response, runId) {
  if (!response || typeof response !== 'object' || response.aborted !== true) return false;
  return response.runIds === undefined || (Array.isArray(response.runIds) && response.runIds.includes(runId));
}

function cancellationError(details = {}) {
  const state = details.state || 'detached';
  const locallyCancelled = state === 'cancelled' || state === 'cancelled-before-dispatch';
  const upstreamCancelled = state === 'cancelled';
  const runtimeLabel = details.runtime === 'hermes' ? 'Hermes' : 'OpenClaw';
  const error = new Error(locallyCancelled ? 'aborted' : `${runtimeLabel} output detached; upstream cancellation was not confirmed.`);
  error.name = 'AbortError';
  error.code = upstreamCancelled ? 'UPSTREAM_CANCELLED' : (locallyCancelled ? 'CANCELLED_BEFORE_DISPATCH' : 'OUTPUT_DETACHED');
  error.cancelled = locallyCancelled;
  error.notCancelled = !locallyCancelled;
  error.detached = !locallyCancelled;
  error.upstreamCancelled = upstreamCancelled;
  error.cancellationState = state;
  error.requestId = details.requestId || '';
  error.runId = details.runId || '';
  error.sessionId = details.sessionId || '';
  error.sessionKey = details.sessionKey || '';
  error.cancellation = {
    state,
    cancelled: locallyCancelled,
    notCancelled: !locallyCancelled,
    detached: !locallyCancelled,
    upstreamCancelled,
    requestId: error.requestId,
    runId: error.runId,
    sessionId: error.sessionId,
    sessionKey: error.sessionKey,
    attempted: !!details.abortAttempted,
    accepted: !!details.accepted,
    reason: details.reason || '',
  };
  if (details.cause) error.cause = details.cause;
  return error;
}

function isDialogueAbortError(error) {
  return error?.name === 'AbortError' && typeof error?.cancellationState === 'string';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveCallGateway() {
  if (callGatewayLoader) return callGatewayLoader;

  callGatewayLoader = (async () => {
    const binRealPath = (() => {
      try { return realpathSync(OPENCLAW_BIN); } catch { return ''; }
    })();
    const candidates = [
      OPENCLAW_GATEWAY_MODULE,
      join(OPENCLAW_INSTALL_PATH, 'dist', 'call.runtime.js'),
      join(OPENCLAW_INSTALL_PATH, 'node_modules', 'openclaw', 'dist', 'call.runtime.js'),
      binRealPath ? join(dirname(binRealPath), '..', 'dist', 'call.runtime.js') : '',
      '/opt/homebrew/lib/node_modules/openclaw/dist/call.runtime.js',
      '/usr/local/lib/node_modules/openclaw/dist/call.runtime.js',
    ].filter(Boolean);

    const modulePath = candidates.find((candidate) => existsSync(candidate));
    if (!modulePath) {
      throw new Error('OpenClaw gateway module was not found. Set OPENCLAW_GATEWAY_MODULE or install the OpenClaw CLI package.');
    }

    const module = await import(pathToFileURL(modulePath).href);
    if (typeof module.callGateway !== 'function') {
      throw new Error(`OpenClaw gateway module has no callGateway export: ${modulePath}`);
    }
    return module.callGateway;
  })();

  return callGatewayLoader;
}

const MIN_OPENCLAW_REPLY_TIMEOUT_MS = 10 * 60 * 1000;

function openClawReplyTimeout(value = MIN_OPENCLAW_REPLY_TIMEOUT_MS) {
  const numeric = Number(value || MIN_OPENCLAW_REPLY_TIMEOUT_MS);
  return Math.max(MIN_OPENCLAW_REPLY_TIMEOUT_MS, Number.isFinite(numeric) ? numeric : MIN_OPENCLAW_REPLY_TIMEOUT_MS);
}

async function runGatewayAgentTurn(
  message,
  cfg,
  {
    signal,
    timeoutMs = MIN_OPENCLAW_REPLY_TIMEOUT_MS,
    requestId = '',
    onRunStarted = null,
  } = {},
) {
  timeoutMs = openClawReplyTimeout(timeoutMs);
  if (signal?.aborted) {
    throw cancellationError({ runtime: 'openclaw', state: 'cancelled-before-dispatch', requestId, sessionId: cfg.sessionId, sessionKey: sessionKeyForGateway(cfg) });
  }
  const callGateway = await resolveCallGateway();
  if (signal?.aborted) {
    throw cancellationError({ runtime: 'openclaw', state: 'cancelled-before-dispatch', requestId, sessionId: cfg.sessionId, sessionKey: sessionKeyForGateway(cfg) });
  }

  const idempotencyKey = gatewayRequestId(requestId || cfg.requestId);
  const cancellation = {
    runtime: 'openclaw',
    state: 'running',
    requestId: idempotencyKey,
    runId: idempotencyKey,
    sessionId: cfg.sessionId,
    sessionKey: sessionKeyForGateway(cfg),
    accepted: false,
    abortAttempted: false,
    reason: '',
  };

  let abortAttemptPromise = null;
  const attemptUpstreamAbort = (request) => {
    if (abortAttemptPromise) return abortAttemptPromise;
    cancellation.abortAttempted = true;
    abortAttemptPromise = (async () => {
      let lastError = null;
      let lastResponse = null;
      for (const delayMs of GATEWAY_ABORT_RETRY_DELAYS_MS) {
        if (delayMs) await wait(delayMs);
        try {
          lastResponse = await request('chat.abort', {
            sessionKey: cancellation.sessionKey,
            runId: cancellation.runId,
          }, { timeoutMs: GATEWAY_ABORT_REQUEST_TIMEOUT_MS });
          if (isConfirmedGatewayAbort(lastResponse, cancellation.runId)) {
            cancellation.state = 'cancelled';
            cancellation.reason = 'gateway-confirmed';
            return cancellation;
          }
        } catch (error) {
          lastError = error;
        }
      }

      if (lastResponse) {
        cancellation.state = 'not-cancelled';
        cancellation.reason = 'gateway-did-not-confirm';
      } else {
        cancellation.state = 'detached';
        cancellation.reason = lastError?.message || 'chat.abort unsupported or unavailable';
        cancellation.cause = lastError;
      }
      return cancellation;
    })();
    return abortAttemptPromise;
  };

  const requestViaNewGatewayCall = (method, params, options = {}) => callGateway({
    method,
    scopes: ['operator.admin'],
    params,
    expectFinal: false,
    timeoutMs: options.timeoutMs || GATEWAY_ABORT_REQUEST_TIMEOUT_MS,
  });

  const state = getOpenClawSessionState(cfg.sessionId);
  state.activeRequests += 1;
  let gatewayRequest = null;
  let releaseWhenGatewaySettles = false;
  let abortFallbackTimer = null;
  let abortListener = null;
  let acceptedCallback = Promise.resolve();
  try {
    gatewayRequest = callGateway({
      method: 'agent',
      scopes: ['operator.admin'],
      params: {
        message,
        agentId: cfg.agent,
        sessionId: cfg.sessionId,
        sessionKey: cancellation.sessionKey,
        thinking: cfg.thinking,
        ...(cfg.modelOverride || cfg.model ? { model: cfg.modelOverride || cfg.model } : {}),
        ...(cfg.modelRun ? { modelRun: true } : {}),
        ...(cfg.promptMode ? { promptMode: cfg.promptMode } : {}),
        timeout: Math.ceil(timeoutMs / 1000),
        idempotencyKey,
      },
      expectFinal: true,
      timeoutMs: timeoutMs + 30000,
      onAccepted: (payload) => {
        if (payload?.status !== 'accepted') return;
        const accepted = readAcceptedRunContext(payload);
        cancellation.accepted = true;
        cancellation.runId = accepted.runId || cancellation.runId;
        cancellation.sessionKey = accepted.sessionKey || cancellation.sessionKey;
        if (typeof onRunStarted === 'function') {
          acceptedCallback = acceptedCallback.then(() => onRunStarted({
            runID: accepted.runId,
            sessionKey: accepted.sessionKey,
          }));
          acceptedCallback.catch(() => {});
        }
      },
      ...(signal ? {
        signal,
        onSignalAbort: async (request) => {
          if (signal.reason?.runtimeStopConfirmed === true) {
            cancellation.state = 'cancelled';
            cancellation.reason = 'runtime-stop-already-confirmed';
            return;
          }
          await attemptUpstreamAbort(request);
        },
      } : {}),
    });

    if (!signal) {
      const response = await gatewayRequest;
      await acceptedCallback;
      return { response, requestId: idempotencyKey, runId: cancellation.runId, sessionKey: cancellation.sessionKey };
    }

    const abortFallback = new Promise((_, reject) => {
      abortListener = () => {
        abortFallbackTimer = setTimeout(async () => {
          if (signal.reason?.runtimeStopConfirmed === true) {
            cancellation.state = 'cancelled';
            cancellation.reason = 'runtime-stop-already-confirmed';
          } else {
            await attemptUpstreamAbort(requestViaNewGatewayCall);
          }
          reject(cancellationError(cancellation));
        }, GATEWAY_ABORT_FALLBACK_DELAY_MS);
      };
      signal.addEventListener('abort', abortListener, { once: true });
    });

    try {
      const response = await Promise.race([gatewayRequest, abortFallback]);
      await acceptedCallback;
      if (signal.aborted) {
        if (signal.reason?.runtimeStopConfirmed !== true) {
          await attemptUpstreamAbort(requestViaNewGatewayCall);
        }
        throw cancellationError(cancellation);
      }
      return { response, requestId: idempotencyKey, runId: cancellation.runId, sessionKey: cancellation.sessionKey };
    } catch (error) {
      if (!signal.aborted) throw error;
      if (signal.reason?.runtimeStopConfirmed !== true) {
        await attemptUpstreamAbort(requestViaNewGatewayCall);
      }
      throw cancellationError(cancellation);
    }
  } catch (error) {
    if (error?.detached && gatewayRequest) {
      releaseWhenGatewaySettles = true;
      Promise.resolve(gatewayRequest).catch(() => null).finally(() => {
        state.activeRequests = Math.max(0, state.activeRequests - 1);
        state.lastUsedAt = Date.now();
      });
    }
    throw error;
  } finally {
    if (abortFallbackTimer) clearTimeout(abortFallbackTimer);
    if (abortListener) signal?.removeEventListener('abort', abortListener);
    if (!releaseWhenGatewaySettles) {
      state.activeRequests = Math.max(0, state.activeRequests - 1);
      state.lastUsedAt = Date.now();
    }
  }
}

function userFacingOpenClawGatewayError(error) {
  const message = String(error?.message || error || '');
  if (/gateway module was not found|callGateway export|module not found|cannot find module/i.test(message)) {
    return 'OpenClaw is not available to the Companion on this Mac. Open or reinstall OpenClaw, then retry from VoiceClaw.';
  }
  if (/ECONNREFUSED|connection refused|failed to connect|could not connect|not running|socket hang up|EHOSTUNREACH|ENETUNREACH/i.test(message)) {
    return 'OpenClaw is not running on this Mac, or the Companion cannot reach it. Open OpenClaw, wait until it is ready, then retry from VoiceClaw.';
  }
  if (/unauthorized|forbidden|login|oauth|auth/i.test(message)) {
    return 'OpenClaw could not authenticate this request. Open OpenClaw on the Mac, confirm your ChatGPT login, then retry from VoiceClaw.';
  }
  return null;
}

function runOpenclawTurn(args, { signal, timeoutMs = 60000, enforceMinimumTimeout = false } = {}) {
  timeoutMs = enforceMinimumTimeout ? openClawReplyTimeout(timeoutMs) : timeoutMs;
  return new Promise((resolve, reject) => {
    let settled = false;
    let killTimer = null;
    let onAbort = () => {};
    const finish = () => {
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const child = execFileRunner(OPENCLAW_BIN, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      finish();
      if (signal?.aborted) {
        return reject(cancellationError({
          runtime: 'openclaw',
          state: 'detached',
          reason: 'cli-process-terminated-without-gateway-confirmation',
        }));
      }
      if (err) return resolve({ ok: false, err, stdout, stderr });
      resolve({ ok: true, stdout, stderr });
    });

    onAbort = () => {
      child.kill?.('SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled) child.kill?.('SIGKILL');
      }, 1000);
      killTimer.unref?.();
    };
    if (signal && !settled) signal.addEventListener('abort', onAbort, { once: true });
    if (!settled && signal?.aborted) onAbort();
  });
}

function parseHermesChatOutput(stdout = '', stderr = '') {
  const lines = String(stdout || '').split(/\r?\n/);
  let sessionId = '';
  const body = [];
  for (const line of lines) {
    const match = line.match(/^\s*session_id:\s*(\S+)\s*$/i);
    if (match) {
      sessionId = match[1];
      continue;
    }
    body.push(line);
  }
  for (const line of String(stderr || '').split(/\r?\n/)) {
    const match = line.match(/^\s*session_id:\s*(\S+)\s*$/i);
    if (match) sessionId = match[1];
  }
  return {
    sessionId,
    reply: body.join('\n').trim(),
  };
}

function isStaleHermesResumeError(error) {
  const combined = `${String(error?.message || error || '')}\n${String(error?.stdout || '')}\n${String(error?.stderr || '')}`;
  return /No session found matching/i.test(combined);
}

function rememberHermesSession(bridgeSessionId, hermesSessionId) {
  if (!hermesSessionId) return;
  _hermesSessions.set(bridgeSessionId, { sessionId: hermesSessionId, lastUsedAt: Date.now() });
}

function runHermesChatProcess(message, cfg, { signal, timeoutMs, resumeSessionId = '' } = {}) {
  timeoutMs = openClawReplyTimeout(timeoutMs);
  return new Promise((resolve, reject) => {
    const args = [
      'chat',
      '-q', message,
      '--quiet',
      '--source', 'tool',
      '--yolo',
      '--accept-hooks',
    ];
    if (resumeSessionId) args.push('--resume', resumeSessionId);

    let settled = false;
    let killTimer = null;
    let onAbort = () => {};
    const finish = () => {
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const child = execFileRunner(HERMES_BIN, args, {
      timeout: timeoutMs + 30000,
      env: {
        ...process.env,
        HERMES_HOME,
        HERMES_ACCEPT_HOOKS: '1',
      },
    }, (err, stdout, stderr) => {
      finish();
      if (signal?.aborted) {
        return reject(cancellationError({
          runtime: 'hermes',
          state: 'cancelled',
          sessionId: cfg.sessionId,
          reason: 'cli-process-terminated',
        }));
      }
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      const parsed = parseHermesChatOutput(stdout, stderr);
      resolve({ ...parsed, stderr, resumedSessionId: resumeSessionId });
    });

    onAbort = () => {
      child.kill?.('SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled) child.kill?.('SIGKILL');
      }, 1000);
      killTimer.unref?.();
    };
    if (signal && !settled) signal.addEventListener('abort', onAbort, { once: true });
    if (!settled && signal?.aborted) onAbort();
  });
}

function serializeHermesOperation(sessionId, signal, operation) {
  const state = getHermesOperationState(sessionId);
  state.pendingRequests += 1;
  const scheduled = state.tail.catch(() => null).then(async () => {
    state.pendingRequests = Math.max(0, state.pendingRequests - 1);
    state.lastUsedAt = Date.now();
    if (signal?.aborted) {
      throw cancellationError({ runtime: 'hermes', state: 'cancelled-before-dispatch', sessionId });
    }
    state.activeRequests += 1;
    try {
      return await operation();
    } finally {
      state.activeRequests = Math.max(0, state.activeRequests - 1);
      state.lastUsedAt = Date.now();
    }
  });
  state.tail = scheduled.catch(() => null);
  return scheduled;
}

function runHermesChat(message, cfg, { signal, timeoutMs = MIN_OPENCLAW_REPLY_TIMEOUT_MS } = {}) {
  timeoutMs = openClawReplyTimeout(timeoutMs);
  return serializeHermesOperation(cfg.sessionId, signal, async () => {
    const mapping = _hermesSessions.get(cfg.sessionId);
    const resumeSessionId = String(cfg.runtimeSessionID || mapping?.sessionId || '').trim();
    if (mapping) mapping.lastUsedAt = Date.now();

    try {
      const result = await runHermesChatProcess(message, cfg, { signal, timeoutMs, resumeSessionId });
      if (result.sessionId) rememberHermesSession(cfg.sessionId, result.sessionId);
      return {
        ...result,
        sessionBehavior: resumeSessionId ? 'resumed' : 'new',
        staleResumeRetried: false,
      };
    } catch (error) {
      if (!resumeSessionId || !isStaleHermesResumeError(error)) throw error;

      const current = _hermesSessions.get(cfg.sessionId);
      if (current?.sessionId === resumeSessionId) _hermesSessions.delete(cfg.sessionId);
      console.warn(`[dialogue] stale Hermes resume mapping removed bridgeSession=${cfg.sessionId} hermesSession=${resumeSessionId}; retrying once with a new session`);

      const result = await runHermesChatProcess(message, cfg, { signal, timeoutMs, resumeSessionId: '' });
      if (result.sessionId) rememberHermesSession(cfg.sessionId, result.sessionId);
      return {
        ...result,
        sessionBehavior: 'new-after-stale-resume',
        staleResumeRetried: true,
        staleResumeSessionId: resumeSessionId,
      };
    }
  });
}

function hermesPythonContext() {
  const configured = String(process.env.HERMES_PYTHON || '').trim();
  const fallbackProjectRoot = join(HERMES_HOME, 'hermes-agent');
  const fallbackPython = join(fallbackProjectRoot, 'venv', 'bin', 'python3');
  if (configured) {
    return {
      python: configured,
      projectRoot: String(process.env.HERMES_PROJECT_ROOT || fallbackProjectRoot).trim()
        || fallbackProjectRoot,
    };
  }

  try {
    const firstLine = readFileSync(HERMES_BIN, 'utf8').split(/\r?\n/, 1)[0] || '';
    if (firstLine.startsWith('#!')) {
      const python = firstLine.slice(2).trim().split(/\s+/, 1)[0];
      if (python && existsSync(python)) {
        const projectRoot = dirname(dirname(dirname(python)));
        return { python, projectRoot };
      }
    }
  } catch {
    // Fall through to the standard Hermes installation layout.
  }

  return { python: fallbackPython, projectRoot: fallbackProjectRoot };
}

function runHermesSessionStoreOperation(action, sessionID = '', options = {}) {
  const normalizedAction = String(action || '').trim();
  const normalizedSessionID = String(sessionID || '').trim();
  if (!['create', 'attach', 'end', 'discover'].includes(normalizedAction)
      || (normalizedAction !== 'discover' && !normalizedSessionID)) {
    throw new Error('Hermes session-store operation is invalid.');
  }
  const { python, projectRoot } = hermesPythonContext();
  if (!existsSync(python) || !existsSync(projectRoot)) {
    throw new Error('Hermes Agent runtime was not found for remote-session binding.');
  }
  const script = String.raw`
import json
import os
import sys

project_root, hermes_home, action, session_id, raw_options = sys.argv[1:6]
options = json.loads(raw_options)
os.environ["HERMES_HOME"] = hermes_home
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from hermes_state import SessionDB

db = SessionDB()
try:
    if action == "discover":
        active_since = float(options.get("active_since") or 0)
        title = str(options.get("title") or "")
        source = str(options.get("source") or "voiceclaw")
        rows = db.list_sessions_rich(
            source=source,
            limit=max(1, min(int(options.get("limit") or 200), 1000)),
            order_by_last_active=True,
        )
        result = [
            {
                "id": row.get("id"),
                "source": row.get("source") or "",
                "title": row.get("title") or "",
                "started_at": row.get("started_at") or 0,
                "last_active": row.get("last_active") or row.get("started_at") or 0,
                "ended_at": row.get("ended_at"),
            }
            for row in rows
            if (not title or (row.get("title") or "") == title)
            and float(row.get("last_active") or row.get("started_at") or 0) >= active_since
            and not row.get("ended_at")
        ]
        print(json.dumps(result))
    else:
        existing = db.get_session(session_id)
    if action == "create":
        if existing:
            db.reopen_session(session_id)
        else:
            db.create_session(
                session_id,
                str(options.get("source") or "voiceclaw"),
                model_config={"_voiceclaw_remote_session": True},
                cwd=os.getcwd(),
            )
        title = str(options.get("title") or "").strip()
        if title:
            db.set_session_title(session_id, title)
    elif action == "attach":
        if not existing:
            raise RuntimeError(f"Hermes session not found: {session_id}")
        db.reopen_session(session_id)
    elif action == "end":
        if existing:
            db.end_session(session_id, "voiceclaw_end")
    if action != "discover":
        print(json.dumps({"session_id": session_id}))
finally:
    db.close()
`;

  return new Promise((resolve, reject) => {
    execFileRunner(
      python,
      [
        '-c',
        script,
        projectRoot,
        HERMES_HOME,
        normalizedAction,
        normalizedSessionID,
        JSON.stringify(options),
      ],
      {
        timeout: 15000,
        env: { ...process.env, HERMES_HOME },
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(String(stdout || '').trim()));
        } catch {
          reject(new Error('Hermes session store returned an invalid response.'));
        }
      },
    );
  });
}

const defaultHermesSessionStore = Object.freeze({
  async create(sessionID, options = {}) {
    const result = await runHermesSessionStoreOperation('create', sessionID, options);
    return result.session_id;
  },
  async attach(sessionID) {
    const result = await runHermesSessionStoreOperation('attach', sessionID);
    return result.session_id;
  },
  async end(sessionID) {
    const result = await runHermesSessionStoreOperation('end', sessionID);
    return result.session_id;
  },
  discover({ activeSince = 0, title = '', source = 'voiceclaw', limit = 200 } = {}) {
    return runHermesSessionStoreOperation('discover', '', {
      active_since: Number(activeSince) / 1000,
      title,
      source,
      limit,
    });
  },
});

class HermesTUIGatewayClient {
  constructor() {
    this.child = null;
    this.pending = new Map();
    this.listeners = new Map();
    this.startPromise = null;
    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.sequence = 0;
  }

  async request(method, params = {}, { id = '', timeoutMs = 120000 } = {}) {
    await this._start();
    const requestID = String(id || `voiceclaw-hermes-rpc-${++this.sequence}-${randomUUID()}`);
    if (this.pending.has(requestID)) {
      throw new Error(`Hermes gateway request ID is already active: ${requestID}`);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestID);
        reject(new Error(`Hermes gateway request timed out: ${method}`));
      }, Math.max(1000, Number(timeoutMs) || 120000));
      timeout.unref?.();
      this.pending.set(requestID, {
        resolve,
        reject,
        timeout,
        method,
      });
      try {
        this.child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: requestID,
          method,
          params,
        })}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestID);
        reject(error);
      }
    });
  }

  subscribe(sessionID, listener) {
    const key = String(sessionID || '');
    let listeners = this.listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
    };
  }

  async _start() {
    if (this.child?.exitCode === null && !this.child.killed) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      const { python, projectRoot } = hermesPythonContext();
      if (!existsSync(python) || !existsSync(projectRoot)) {
        reject(new Error('Hermes Agent runtime was not found for remote-session binding.'));
        return;
      }
      const child = spawn(python, ['-u', '-m', 'tui_gateway.entry'], {
        cwd: projectRoot,
        env: {
          ...process.env,
          HERMES_HOME,
          PYTHONUNBUFFERED: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      this.stdoutBuffer = '';
      this.stderrTail = '';
      let settled = false;
      const startupTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        reject(new Error('Hermes TUI gateway did not become ready.'));
      }, 30000);
      startupTimeout.unref?.();

      child.stdout.on('data', (chunk) => {
        this.stdoutBuffer += chunk.toString('utf8');
        for (;;) {
          const newline = this.stdoutBuffer.indexOf('\n');
          if (newline < 0) break;
          const line = this.stdoutBuffer.slice(0, newline).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
          if (!line) continue;
          let frame;
          try {
            frame = JSON.parse(line);
          } catch {
            continue;
          }
          if (frame?.method === 'event' && frame.params?.type === 'gateway.ready') {
            if (!settled) {
              settled = true;
              clearTimeout(startupTimeout);
              resolve();
            }
          }
          this._handleFrame(frame);
        }
      });
      child.stderr.on('data', (chunk) => {
        this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-8192);
      });
      child.once('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(startupTimeout);
          reject(error);
        }
        this._handleExit(error);
      });
      child.once('exit', (code, childSignal) => {
        const suffix = this.stderrTail.trim();
        const error = new Error(
          `Hermes TUI gateway exited (code=${code ?? 'none'}, signal=${childSignal || 'none'})${suffix ? `: ${suffix.slice(-1024)}` : ''}`,
        );
        if (!settled) {
          settled = true;
          clearTimeout(startupTimeout);
          reject(error);
        }
        this._handleExit(error);
      });
    }).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  _handleFrame(frame) {
    if (frame?.method === 'event') {
      const sessionID = String(frame.params?.session_id || '');
      for (const listener of this.listeners.get(sessionID) || []) {
        try { listener(frame.params); } catch {}
      }
      return;
    }
    if (frame?.id === undefined || frame?.id === null) return;
    const requestID = String(frame.id);
    const pending = this.pending.get(requestID);
    if (!pending) return;
    this.pending.delete(requestID);
    clearTimeout(pending.timeout);
    if (frame.error) {
      const error = new Error(frame.error.message || `Hermes gateway request failed: ${pending.method}`);
      error.code = frame.error.code;
      pending.reject(error);
      return;
    }
    pending.resolve(frame.result);
  }

  _handleExit(error) {
    if (this.child) this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

let defaultHermesGatewayClient = null;

function getDefaultHermesGatewayClient() {
  defaultHermesGatewayClient ||= new HermesTUIGatewayClient();
  return defaultHermesGatewayClient;
}

function userFacingHermesError(error) {
  const message = String(error?.message || error || '');
  const stderr = String(error?.stderr || '');
  const combined = `${message}\n${stderr}`;
  if (/No session found matching/i.test(combined)) {
    return 'Hermes could not resume that prior VoiceClaw session. Try the request again to start a fresh Hermes session.';
  }
  if (/ENOENT|no such file|not found/i.test(combined)) {
    return 'Hermes Agent is not available to the Companion on this Mac. Install Hermes Agent or set HERMES_BIN, then retry from VoiceClaw.';
  }
  if (/unauthorized|forbidden|login|oauth|auth/i.test(combined)) {
    return 'Hermes could not authenticate this request. Open Hermes on the Mac, confirm its provider login, then retry from VoiceClaw.';
  }
  if (/timed out|timeout/i.test(combined)) {
    return 'Hermes took too long to finish that. Try again or make it a smaller request.';
  }
  return 'Hermes Agent failed. Try that again.';
}

async function applyFastModeIfNeeded(cfg, signal) {
  if (!cfg.fastModeBestEffort) return;
  const desired = normalizeFastMode(cfg.fastMode);
  await withOpenClawSessionActivity(cfg.sessionId, async (state) => {
    if (state.fastMode === desired) return;

    console.log(`[dialogue] priming session ${cfg.sessionId} with /fast ${desired}`);
    await runOpenclawTurn([
      'agent',
      '--agent', cfg.agent,
      '--session-id', cfg.sessionId,
      '--message', desired === 'on' ? '/fast on' : '/fast off',
      '--json',
    ], { signal, timeoutMs: 12000 });

    state.fastMode = desired;
    state.lastUsedAt = Date.now();
    console.log(`[dialogue] session ${cfg.sessionId} primed with fastMode=${desired}`);
  });
}

export function getProcessingOptions() {
  pruneSessionState();
  return {
    defaultAgent: defaultRouteId(),
    defaultThinking: normalizeThinking(DEFAULT_THINKING),
    defaultFastMode: 'on',
    agents: PROCESSING_ROUTES.map((route) => ({
      id: route.id,
      label: route.label,
      model: route.model,
      agent: route.agent,
      modelRun: !!route.modelRun,
      promptMode: route.promptMode,
      fastHint: route.fastHint,
      fastVerified: route.fastVerified,
    })),
    thinking: THINKING_OPTIONS,
    fastMode: FAST_MODE_OPTIONS,
    fastModeBehavior: 'always-on best-effort session priming via /fast on',
    sessionModes: ['attach', 'resume', 'new'],
    sessionStateTTLms: SESSION_STATE_TTL_MS,
  };
}

export function resolveProcessingConfig(input = {}) {
  pruneSessionState();
  const routeId = normalizeRoute(input.agent);
  const thinking = normalizeThinking(input.thinking);
  const fastMode = normalizeFastMode(input.fastMode);
  const route = PROCESSING_ROUTES.find((o) => o.id === routeId) || PROCESSING_ROUTES[0];
  const sessionTarget = resolveSessionTarget(route, input);
  const runtimeAgentID = String(input.runtimeAgentID || input.agentID || '').trim();
  const agent = runtimeAgentID || route.agent;
  const explicitSessionKey = String(input.sessionKey || '').trim();
  const sessionKey = explicitSessionKey
    || `agent:${agent}:${safeSessionIdPart(sessionTarget.sessionId, 'default')}`;
  const runtimeSessionID = String(
    input.runtimeSessionID || input.hermesSessionID || input.hermesSessionId || '',
  ).trim();

  return {
    route: route.id,
    agent,
    model: route.model,
    modelOverride: route.modelOverride || null,
    modelRun: !!route.modelRun,
    promptMode: route.promptMode,
    thinking,
    fastHint: !!route.fastHint,
    fastVerified: !!route.fastVerified,
    fastMode,
    fastModeBestEffort: true,
    sessionToken: sanitizeSessionToken(input.sessionToken),
    sessionId: sessionTarget.sessionId,
    sessionKey,
    runtimeSessionID,
    sessionMode: sessionTarget.mode,
    sessionSource: sessionTarget.source,
    sessionContinuity: sessionTarget.continuity,
    routeDerivedSessionId: sessionTarget.routeDerivedSessionId,
    session: {
      id: sessionTarget.sessionId,
      key: sessionKey,
      mode: sessionTarget.mode,
      source: sessionTarget.source,
      continuity: sessionTarget.continuity,
      routeDerivedId: sessionTarget.routeDerivedSessionId,
    },
    requestId: String(input.requestId || '').trim(),
    runtime: String(input.runtime || input.agentRuntime || '').trim().toLowerCase() === 'hermes' ? 'hermes' : 'openclaw',
    label: `${route.label} · thinking ${thinking} · fast on`,
  };
}

function buildIntercomPrompt(userText) {
  return `User said: ${userText}

Realtime/OpenClaw fallback instruction:
- Fulfill the user's request using normal OpenClaw judgment and tools.
- Return a concise spoken/text response back to Realtime that primarily answers the user's original request.
- Do not perform side effects outside the current OpenClaw request unless the user explicitly asks for them.`;
}

function buildHermesPrompt(userText) {
  return `VoiceClaw Realtime routed this spoken request to Hermes Agent.

User request:
${userText}

Hermes response instructions:
- Fulfill the user's request using normal Hermes Agent judgment, memory, tools, and local context.
- Return a concise response suitable for VoiceClaw to speak aloud.
- Preserve concrete results, warnings, file paths, commands, and next steps when they matter.
- Do not mention this routing wrapper unless the user asks how VoiceClaw is connected to Hermes.`;
}

export function clearHistory() {
  // History managed by persistent OpenClaw sessions (route-scoped session ids).
  pruneSessionState();
}

export async function prewarmProcessing(processing = {}, { signal } = {}) {
  const cfg = resolveProcessingConfig(processing || {});
  if (cfg.runtime === 'hermes') {
    return {
      ok: true,
      processing: {
        route: 'hermes',
        runtime: 'hermes',
        sessionId: cfg.sessionId,
        sessionMode: cfg.sessionMode,
        sessionSource: cfg.sessionSource,
        sessionContinuity: cfg.sessionContinuity,
        label: 'Hermes Agent',
      },
    };
  }
  await applyFastModeIfNeeded(cfg, signal);
  return {
    ok: true,
    processing: {
      route: cfg.route,
      agent: cfg.agent,
      model: cfg.model,
      modelRun: cfg.modelRun,
      promptMode: cfg.promptMode,
      thinking: cfg.thinking,
      fastMode: cfg.fastMode,
      sessionId: cfg.sessionId,
      sessionKey: cfg.sessionKey,
      sessionMode: cfg.sessionMode,
      sessionSource: cfg.sessionSource,
      sessionContinuity: cfg.sessionContinuity,
      label: cfg.label,
    },
  };
}

export async function steerActiveReply(steerText, { processing, timeoutMs = MIN_OPENCLAW_REPLY_TIMEOUT_MS, signal, requestId = '' } = {}) {
  timeoutMs = openClawReplyTimeout(timeoutMs);
  const trimmed = String(steerText || '').trim();
  if (!trimmed) return { ok: false, error: 'empty steer text' };
  const cfg = resolveProcessingConfig(processing || {});
  if (cfg.runtime === 'hermes') {
    const message = `VoiceClaw Realtime steering update for the active Hermes request:\n${trimmed}`;
    try {
      const result = await runHermesChat(message, cfg, { signal, timeoutMs });
      return {
        ok: true,
        sessionKey: `hermes:${cfg.sessionId}`,
        sessionId: cfg.sessionId,
        sessionMode: cfg.sessionMode,
        result,
        reply: result.reply || 'Added that to Hermes.',
      };
    } catch (e) {
      if (isDialogueAbortError(e)) throw e;
      return { ok: false, sessionKey: `hermes:${cfg.sessionId}`, sessionId: cfg.sessionId, error: userFacingHermesError(e) };
    }
  }
  const message = `Realtime user steering update while the previous OpenClaw turn is still active:
${trimmed}`;
  try {
    if (signal?.aborted) {
      throw cancellationError({
        runtime: 'openclaw',
        state: 'cancelled-before-dispatch',
        requestId: requestId || cfg.requestId,
        sessionId: cfg.sessionId,
        sessionKey: sessionKeyForGateway(cfg),
      });
    }
    const callGateway = await resolveCallGateway();
    const idempotencyKey = gatewayRequestId(requestId || cfg.requestId || `voice-bridge-steer-${Date.now()}-${randomUUID()}`);
    const result = await withOpenClawSessionActivity(cfg.sessionId, () => callGateway({
      method: 'chat.send',
      scopes: ['operator.admin'],
      params: {
        sessionKey: sessionKeyForGateway(cfg),
        message,
        deliver: false,
        idempotencyKey,
      },
      expectFinal: false,
      timeoutMs,
    }));
    return {
      ok: true,
      sessionKey: sessionKeyForGateway(cfg),
      sessionId: cfg.sessionId,
      sessionMode: cfg.sessionMode,
      requestId: idempotencyKey,
      result,
    };
  } catch (e) {
    if (isDialogueAbortError(e)) throw e;
    return {
      ok: false,
      sessionKey: sessionKeyForGateway(cfg),
      sessionId: cfg.sessionId,
      sessionMode: cfg.sessionMode,
      error: e.message || String(e),
    };
  }
}

async function generateReplyResult(
  userText,
  {
    signal,
    processing,
    timeoutMs = MIN_OPENCLAW_REPLY_TIMEOUT_MS,
    requestId = '',
    onRunStarted = null,
  } = {},
  { surfaceRuntimeErrors = true } = {},
) {
  timeoutMs = openClawReplyTimeout(timeoutMs);
  const trimmed = String(userText || '').trim();
  if (!trimmed || trimmed === '[BLANK_AUDIO]') return null;

  const cfg = resolveProcessingConfig(processing || {});
  const t0 = Date.now();
  if (cfg.runtime === 'hermes') {
    try {
      const result = await runHermesChat(buildHermesPrompt(trimmed), cfg, { signal, timeoutMs });
      const elapsed = Date.now() - t0;
      const mappedSessionId = _hermesSessions.get(cfg.sessionId)?.sessionId || '';
      console.log(`[dialogue] runtime=hermes session=${cfg.sessionId} hermesSession=${result.sessionId || mappedSessionId} behavior=${result.sessionBehavior} replied in ${elapsed}ms: "${(result.reply || '').slice(0, 80)}"`);
      const runtimeSessionID = result.sessionId || mappedSessionId || cfg.runtimeSessionID || '';
      return {
        reply: result.reply || "I didn't catch that. Say it again.",
        runtime: 'hermes',
        sessionKey: cfg.sessionKey || `hermes:${runtimeSessionID || cfg.sessionId}`,
        runtimeSessionID,
        sessionId: cfg.sessionId,
        result,
      };
    } catch (e) {
      if (isDialogueAbortError(e) || e.message === 'aborted') throw e;
      console.error('[dialogue] Hermes agent error:', e.message);
      if (!surfaceRuntimeErrors) throw e;
      return {
        reply: userFacingHermesError(e),
        runtime: 'hermes',
        sessionKey: cfg.sessionKey || `hermes:${cfg.runtimeSessionID || cfg.sessionId}`,
        runtimeSessionID: cfg.runtimeSessionID || '',
        sessionId: cfg.sessionId,
        failed: true,
      };
    }
  }
  const message = cfg.modelRun ? trimmed : buildIntercomPrompt(trimmed);

  await applyFastModeIfNeeded(cfg, signal);

  try {
    const gatewayTurn = await runGatewayAgentTurn(message, cfg, {
      signal,
      timeoutMs,
      requestId: requestId || cfg.requestId,
      onRunStarted,
    });
    const obj = gatewayTurn.response;
    const payloads = obj?.result?.payloads || [];
    const model = obj?.result?.meta?.agentMeta?.model || 'unknown';
    const reply = payloads[0]?.text?.trim();
    const elapsed = Date.now() - t0;
    console.log(`[dialogue] route=${cfg.route} agent=${cfg.agent} requestId=${gatewayTurn.requestId} sessionMode=${cfg.sessionMode} thinking=${cfg.thinking} fastMode=${cfg.fastMode} fastHint=${cfg.fastHint} model=${model} replied in ${elapsed}ms: "${(reply || '').slice(0, 80)}"`);

    if (!reply || reply === 'NO_REPLY') {
      return {
        reply: "I didn't catch that. Say it again.",
        runtime: 'openclaw',
        sessionKey: gatewayTurn.sessionKey,
        runtimeSessionID: cfg.sessionId,
        sessionId: cfg.sessionId,
        requestId: gatewayTurn.requestId,
        runId: gatewayTurn.runId,
      };
    }
    return {
      reply,
      runtime: 'openclaw',
      sessionKey: gatewayTurn.sessionKey,
      runtimeSessionID: cfg.sessionId,
      sessionId: cfg.sessionId,
      requestId: gatewayTurn.requestId,
      runId: gatewayTurn.runId,
    };
  } catch (e) {
    if (isDialogueAbortError(e) || e.message === 'aborted') throw e;
    console.error('[dialogue] gateway agent error:', e.message);
    if (!surfaceRuntimeErrors) throw e;
    const specific = userFacingOpenClawGatewayError(e);
    const reply = specific || (/timed out|timeout/i.test(String(e.message || ''))
      ? 'OpenClaw took too long to finish that. Try again or make it a smaller request.'
      : 'OpenClaw fallback failed. Try that again.');
    return {
      reply,
      runtime: 'openclaw',
      sessionKey: sessionKeyForGateway(cfg),
      runtimeSessionID: cfg.sessionId,
      sessionId: cfg.sessionId,
      failed: true,
    };
  }
}

export async function generateReply(userText, options = {}) {
  const result = await generateReplyResult(userText, options, { surfaceRuntimeErrors: true });
  return result?.reply ?? null;
}

export function createVoiceRemoteSessionRuntimeAdapter({
  hermesSessionStore = defaultHermesSessionStore,
  hermesGateway = null,
} = {}) {
  const gatewayForHermes = () => hermesGateway || getDefaultHermesGatewayClient();
  const labelForRoute = (routeID) => `voiceclaw:${String(routeID || '').trim()}`;
  const openClawBinding = ({ routeID, agentID, sessionID, sessionKey }) => ({
    runtime: 'openclaw',
    routeID,
    agentID,
    canonicalSessionKey: sessionKey,
    dialogueSessionID: sessionID,
    runtimeSessionID: sessionID,
    label: labelForRoute(routeID),
  });
  const hermesBinding = ({ routeID, agentID, sessionID, liveSessionID = '' }) => ({
    runtime: 'hermes',
    routeID,
    agentID,
    canonicalSessionKey: `hermes:${sessionID}`,
    dialogueSessionID: liveSessionID || sessionID,
    runtimeSessionID: sessionID,
    ...(liveSessionID ? { liveSessionID } : {}),
    label: labelForRoute(routeID),
  });
  const callOpenClaw = async (
    method,
    params,
    { expectFinal = false, timeoutMs = 15000, onAccepted = null, signal = null } = {},
  ) => {
    const callGateway = await resolveCallGateway();
    return callGateway({
      method,
      scopes: ['operator.admin'],
      params,
      expectFinal,
      timeoutMs,
      ...(onAccepted ? { onAccepted } : {}),
      ...(signal ? { signal } : {}),
    });
  };
  const openClawDescriptor = (row, route) => {
    const sessionID = String(row?.sessionId || '').trim();
    const sessionKey = String(row?.key || '').trim();
    if (!sessionID || !sessionKey) throw new Error('OpenClaw returned an incomplete session identity.');
    const activeRunIDs = Array.isArray(row.activeRunIds)
      ? row.activeRunIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    return {
      sessionID,
      sessionKey,
      createdAt: Number(row.sessionStartedAt || row.createdAt || row.updatedAt || Date.now()),
      updatedAt: Number(row.lastInteractionAt || row.updatedAt || row.sessionStartedAt || Date.now()),
      state: row.archived ? 'ended' : 'detached',
      runID: activeRunIDs[0] || null,
      runState: row.hasActiveRun ? 'running' : 'idle',
      binding: openClawBinding({ ...route, sessionID, sessionKey }),
    };
  };
  const activeHermesSessions = async () => {
    const result = await gatewayForHermes().request('session.active_list', {});
    return Array.isArray(result?.sessions) ? result.sessions : [];
  };
  const ensureHermesLiveBinding = async (binding) => {
    const active = await activeHermesSessions();
    const current = active.find((row) => row.session_key === binding.runtimeSessionID
      || row.id === binding.liveSessionID);
    if (current?.id) {
      return hermesBinding({
        routeID: binding.routeID,
        agentID: binding.agentID,
        sessionID: binding.runtimeSessionID,
        liveSessionID: String(current.id),
      });
    }
    await hermesSessionStore.attach(binding.runtimeSessionID);
    const resumed = await gatewayForHermes().request('session.resume', {
      session_id: binding.runtimeSessionID,
      source: 'voiceclaw',
    });
    const liveSessionID = String(resumed?.session_id || '').trim();
    const storedSessionID = String(
      resumed?.session_key || resumed?.resumed || binding.runtimeSessionID,
    ).trim();
    if (!liveSessionID || storedSessionID !== binding.runtimeSessionID) {
      throw new Error('Hermes resumed a different runtime session identity.');
    }
    return hermesBinding({
      routeID: binding.routeID,
      agentID: binding.agentID,
      sessionID: binding.runtimeSessionID,
      liveSessionID,
    });
  };
  const hermesEvent = (params = {}) => {
    const payload = params.payload && typeof params.payload === 'object' ? params.payload : {};
    return {
      type: String(params.type || 'run.event'),
      data: {
        ...(payload.status ? { status: payload.status } : {}),
        ...(payload.name ? { name: payload.name } : {}),
        ...(payload.tool ? { tool: payload.tool } : {}),
        ...(payload.message ? { error: payload.message } : {}),
        ...(payload.text ? { preview: String(payload.text).slice(0, 1024) } : {}),
      },
    };
  };
  const openClawReply = (value) => {
    const payloads = value?.result?.payloads || value?.payloads || [];
    return String(payloads[0]?.text || value?.text || '').trim();
  };

  const adapter = {
    async discoverSessions({ routeID, runtime, agentID, activeSince, recentWindowMs }) {
      if (runtime === 'openclaw') {
        const result = await callOpenClaw('sessions.list', {
          limit: 200,
          activeMinutes: Math.max(1, Math.ceil(Number(recentWindowMs) / 60000)),
          agentId: agentID,
          label: labelForRoute(routeID),
          archived: false,
        });
        return (Array.isArray(result?.sessions) ? result.sessions : [])
          .filter((row) => row.label === labelForRoute(routeID))
          .map((row) => openClawDescriptor(row, { routeID, agentID }));
      }
      const [rows, active] = await Promise.all([
        hermesSessionStore.discover({
          activeSince,
          title: labelForRoute(routeID),
          source: 'voiceclaw',
        }),
        activeHermesSessions(),
      ]);
      return (Array.isArray(rows) ? rows : []).map((row) => {
        const sessionID = String(row.id || '').trim();
        const live = active.find((candidate) => candidate.session_key === sessionID);
        const running = live?.status === 'streaming' || live?.status === 'running';
        return {
          sessionID,
          sessionKey: `hermes:${sessionID}`,
          createdAt: Number(row.started_at || Date.now()) * 1000,
          updatedAt: Number(row.last_active || row.started_at || Date.now()) * 1000,
          state: 'detached',
          runID: null,
          runState: running ? 'running' : 'idle',
          binding: hermesBinding({
            routeID,
            agentID,
            sessionID,
            liveSessionID: String(live?.id || ''),
          }),
        };
      });
    },

    async startSession({ routeID, runtime, agentID }) {
      if (runtime === 'openclaw') {
        const created = await callOpenClaw('sessions.create', {
          agentId: agentID,
          label: labelForRoute(routeID),
        });
        return openClawDescriptor({
          key: created?.key,
          sessionId: created?.sessionId,
          sessionStartedAt: created?.entry?.sessionStartedAt || created?.entry?.updatedAt,
          updatedAt: created?.entry?.updatedAt,
          label: labelForRoute(routeID),
        }, { routeID, agentID });
      }
      if (runtime !== 'hermes') throw new Error(`Unsupported remote runtime: ${runtime}`);
      const created = await gatewayForHermes().request('session.create', {
        source: 'voiceclaw',
        title: labelForRoute(routeID),
        close_on_disconnect: false,
      });
      const sessionID = String(created?.stored_session_id || '').trim();
      const liveSessionID = String(created?.session_id || '').trim();
      if (!sessionID || !liveSessionID) throw new Error('Hermes returned an incomplete session identity.');
      await hermesSessionStore.create(sessionID, {
        source: 'voiceclaw',
        title: labelForRoute(routeID),
      });
      return {
        sessionID,
        sessionKey: `hermes:${sessionID}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        state: 'attached',
        runID: null,
        runState: 'idle',
        binding: hermesBinding({ routeID, agentID, sessionID, liveSessionID }),
      };
    },

    async attachSession({ session, binding }) {
      if (session.runtime === 'openclaw') {
        const resolved = await callOpenClaw('sessions.resolve', {
          key: binding.canonicalSessionKey,
          agentId: session.agent.id,
        });
        if (resolved?.ok !== true || resolved.key !== binding.canonicalSessionKey) {
          throw new Error('OpenClaw could not resolve the bound session key.');
        }
        return { binding };
      }
      return { binding: await ensureHermesLiveBinding(binding) };
    },

    async restartVoiceSession({ session, binding }) {
      const attached = await adapter.attachSession({ session, binding });
      return { ...attached, agentSessionRestarted: false };
    },

    async detachSession({ binding }) {
      return {
        sessionKey: binding.canonicalSessionKey,
        detached: true,
      };
    },

    async endSession({ session, binding }) {
      if (session.runtime === 'openclaw') {
        const result = await callOpenClaw('sessions.patch', {
          key: binding.canonicalSessionKey,
          agentId: session.agent.id,
          archived: true,
        });
        return { sessionKey: result?.key || binding.canonicalSessionKey, released: true };
      }
      if (binding.liveSessionID) {
        await gatewayForHermes().request('session.close', {
          session_id: binding.liveSessionID,
        }).catch(() => null);
      }
      await hermesSessionStore.end(binding.runtimeSessionID);
      return { sessionKey: binding.canonicalSessionKey, released: true };
    },

    async runTurn({
      session,
      binding,
      text,
      processing,
      signal,
      timeoutMs,
      requestID,
      onRunStarted,
      onEvent,
    }) {
      if (session.runtime === 'openclaw') {
        let runtimeRunID = '';
        const result = await generateReplyResult(text, {
          signal,
          timeoutMs,
          requestId: requestID,
          onRunStarted: async (identity) => {
            const runID = String(identity.runID || '').trim();
            const acceptedKey = String(identity.sessionKey || '').trim();
            if (!runID) throw new Error('OpenClaw did not return an accepted runtime run ID.');
            if (acceptedKey !== binding.canonicalSessionKey) {
              throw new Error(
                `OpenClaw accepted session key ${acceptedKey || '(empty)'} instead of the bound key ${binding.canonicalSessionKey}.`,
              );
            }
            runtimeRunID = runID;
            await onRunStarted({ runID, binding });
          },
          processing: {
            ...(processing || {}),
            runtime: 'openclaw',
            runtimeAgentID: session.agent.id,
            sessionId: binding.dialogueSessionID,
            sessionKey: binding.canonicalSessionKey,
            runtimeSessionID: binding.runtimeSessionID,
            sessionMode: 'resume',
            sessionSource: 'voice-remote-session',
            sessionToken: binding.canonicalSessionKey,
          },
        }, { surfaceRuntimeErrors: false });
        if (!result) throw new Error('OpenClaw returned no reply.');
        if (!runtimeRunID) throw new Error('OpenClaw completed without an accepted runtime run ID.');
        if (result.sessionKey !== binding.canonicalSessionKey) {
          throw new Error(
            `OpenClaw returned session key ${result.sessionKey || '(empty)'} instead of the bound key ${binding.canonicalSessionKey}.`,
          );
        }
        return {
          ...result,
          runID: runtimeRunID,
          sessionID: binding.runtimeSessionID,
          binding,
        };
      }

      const liveBinding = await ensureHermesLiveBinding(binding);
      const gateway = gatewayForHermes();
      const liveSessionID = liveBinding.liveSessionID;
      let started = false;
      let settled = false;
      let eventTail = Promise.resolve();
      const buffered = [];
      let resolveCompletion;
      let rejectCompletion;
      const completion = new Promise((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      const dispatchEvent = (params) => {
        eventTail = eventTail.then(() => onEvent(hermesEvent(params)));
        if (params.type === 'message.complete' && !settled) {
          settled = true;
          resolveCompletion(params.payload || {});
        } else if (params.type === 'error' && !settled) {
          settled = true;
          rejectCompletion(new Error(params.payload?.message || 'Hermes run failed.'));
        }
      };
      const unsubscribe = gateway.subscribe(liveSessionID, (params) => {
        if (!started) buffered.push(params);
        else dispatchEvent(params);
      });
      const completionTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectCompletion(new Error('Hermes run timed out.'));
      }, Math.max(1000, Number(timeoutMs) || MIN_OPENCLAW_REPLY_TIMEOUT_MS));
      completionTimeout.unref?.();
      const onAbort = () => {
        if (settled) return;
        settled = true;
        const error = signal.reason instanceof Error ? signal.reason : new Error('aborted');
        error.name = 'AbortError';
        error.cancelled = true;
        if (signal.reason?.runtimeStopConfirmed !== true) {
          gateway.request('session.interrupt', { session_id: liveSessionID }, {
            id: `${requestID}:interrupt`,
            timeoutMs: 5000,
          }).catch(() => null);
        }
        rejectCompletion(error);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const accepted = await gateway.request('prompt.submit', {
          session_id: liveSessionID,
          text: buildHermesPrompt(text),
        }, {
          id: requestID,
          timeoutMs: 15000,
        });
        if (accepted?.status !== 'streaming') {
          throw new Error('Hermes did not acknowledge a streaming run.');
        }
        await onRunStarted({ runID: requestID, binding: liveBinding });
        started = true;
        for (const params of buffered.splice(0)) dispatchEvent(params);
        const payload = await completion;
        await eventTail;
        return {
          reply: String(payload.text || '').trim() || "I didn't catch that. Say it again.",
          runtime: 'hermes',
          runID: requestID,
          sessionID: liveBinding.runtimeSessionID,
          sessionKey: liveBinding.canonicalSessionKey,
          runtimeSessionID: liveBinding.runtimeSessionID,
          binding: liveBinding,
        };
      } finally {
        clearTimeout(completionTimeout);
        signal?.removeEventListener('abort', onAbort);
        unsubscribe();
      }
    },

    async steerRun({ session, binding, runID, text, requestID }) {
      if (session.runtime === 'hermes') {
        const liveBinding = await ensureHermesLiveBinding(binding);
        const result = await gatewayForHermes().request('session.steer', {
          session_id: liveBinding.liveSessionID,
          text,
        }, {
          id: requestID,
          timeoutMs: 15000,
        });
        return {
          accepted: result?.status === 'queued',
          runID,
          binding: liveBinding,
        };
      }

      let resolveAccepted;
      let rejectAccepted;
      let acceptedSettled = false;
      const accepted = new Promise((resolve, reject) => {
        resolveAccepted = resolve;
        rejectAccepted = reject;
      });
      const acceptedTimeout = setTimeout(() => {
        if (!acceptedSettled) rejectAccepted(new Error('OpenClaw did not acknowledge the steering run.'));
      }, 10000);
      acceptedTimeout.unref?.();
      const completionCall = callOpenClaw('sessions.steer', {
        key: binding.canonicalSessionKey,
        agentId: session.agent.id,
        message: text,
        idempotencyKey: requestID,
        timeoutMs: MIN_OPENCLAW_REPLY_TIMEOUT_MS,
      }, {
        expectFinal: true,
        timeoutMs: MIN_OPENCLAW_REPLY_TIMEOUT_MS,
        onAccepted: (payload) => {
          const acceptedRunID = String(payload?.runId || '').trim();
          if (!acceptedRunID) return;
          acceptedSettled = true;
          resolveAccepted({ runID: acceptedRunID });
        },
      });
      completionCall.then((result) => {
        if (acceptedSettled) return;
        const acceptedRunID = String(result?.runId || '').trim();
        if (acceptedRunID) {
          acceptedSettled = true;
          resolveAccepted({ runID: acceptedRunID });
        } else {
          rejectAccepted(new Error('OpenClaw steering completed without a runtime run ID.'));
        }
      }, rejectAccepted);
      const acceptedIdentity = await accepted.finally(() => clearTimeout(acceptedTimeout));
      return {
        accepted: true,
        runID: acceptedIdentity.runID,
        completion: completionCall.then((result) => ({
          runID: acceptedIdentity.runID,
          reply: openClawReply(result),
          binding,
        })),
      };
    },

    async stopRun({ session, binding, runID, requestID }) {
      if (session.runtime === 'hermes') {
        const liveBinding = await ensureHermesLiveBinding(binding);
        const result = await gatewayForHermes().request('session.interrupt', {
          session_id: liveBinding.liveSessionID,
        }, {
          id: requestID,
          timeoutMs: 15000,
        });
        return {
          stopped: result?.status === 'interrupted',
          reason: result?.status || 'interrupt',
          binding: liveBinding,
        };
      }
      const result = await callOpenClaw('sessions.abort', {
        key: binding.canonicalSessionKey,
        agentId: session.agent.id,
        ...(runID ? { runId: runID } : {}),
      });
      return {
        stopped: result?.status === 'aborted' || result?.status === 'no-active-run',
        reason: result?.status || 'abort',
        runID: result?.abortedRunId || runID,
      };
    },

    async observeSession({ session, binding, runID }) {
      if (session.runtime === 'hermes') {
        const active = await activeHermesSessions();
        const row = active.find((candidate) => candidate.session_key === binding.runtimeSessionID
          || candidate.id === binding.liveSessionID);
        const running = row?.status === 'streaming' || row?.status === 'running';
        return {
          runID,
          runState: running
            ? 'running'
            : (session.runState === 'starting' || session.runState === 'running'
                ? 'unknown'
                : session.runState),
          binding: row?.id
            ? hermesBinding({
                routeID: binding.routeID,
                agentID: binding.agentID,
                sessionID: binding.runtimeSessionID,
                liveSessionID: String(row.id),
              })
            : binding,
        };
      }
      const result = await callOpenClaw('sessions.list', {
        limit: 200,
        agentId: session.agent.id,
        label: binding.label || labelForRoute(session.routeID),
        archived: false,
      });
      const row = (Array.isArray(result?.sessions) ? result.sessions : [])
        .find((candidate) => candidate.key === binding.canonicalSessionKey);
      const activeRunIDs = Array.isArray(row?.activeRunIds) ? row.activeRunIds : [];
      return {
        runID: activeRunIDs[0] || runID,
        runState: row?.hasActiveRun
          ? 'running'
          : (session.runState === 'starting' || session.runState === 'running'
              ? (row ? (row.abortedLastRun ? 'cancelled' : 'completed') : 'unknown')
              : session.runState),
        binding,
      };
    },
  };

  return Object.freeze(adapter);
}

export const __dialogueTestHooks = Object.freeze({
  parseHermesChatOutput,
  isStaleHermesResumeError,
  isConfirmedGatewayAbort,
  routeSessionId,
  pruneSessionState,
  sessionStateTTLms: SESSION_STATE_TTL_MS,
  sessionStateSnapshot() {
    return {
      openclaw: [..._primedSessions.entries()].map(([sessionId, state]) => ({
        sessionId,
        fastMode: state.fastMode,
        activeRequests: state.activeRequests,
        lastUsedAt: state.lastUsedAt,
      })),
      hermesMappings: [..._hermesSessions.entries()].map(([sessionId, mapping]) => ({
        sessionId,
        hermesSessionId: mapping.sessionId,
        lastUsedAt: mapping.lastUsedAt,
      })),
      hermesOperations: [..._hermesOperations.entries()].map(([sessionId, state]) => ({
        sessionId,
        activeRequests: state.activeRequests,
        pendingRequests: state.pendingRequests,
        lastUsedAt: state.lastUsedAt,
      })),
    };
  },
  setCallGatewayForTest(callGateway) {
    callGatewayLoader = Promise.resolve(callGateway);
  },
  resetCallGatewayForTest() {
    callGatewayLoader = null;
  },
  setExecFileForTest(runner) {
    execFileRunner = runner;
  },
  resetExecFileForTest() {
    execFileRunner = execFile;
  },
  resetSessionStateForTest() {
    _primedSessions.clear();
    _hermesSessions.clear();
    _hermesOperations.clear();
  },
});
