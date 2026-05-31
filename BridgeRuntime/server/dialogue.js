// Dialogue module — OpenClaw intercom agent bridge.
// Processing is selectable per turn via route presets that map to real
// backend behavior the current CLI path can actually invoke.

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw';
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
const THINKING_OPTIONS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

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

  routes.splice(Math.min(routes.length, 1), 0, {
    id: DIRECT_GPT55_ROUTE_ID,
    label: 'GPT-5.5 Direct (raw/no OpenClaw)',
    agent: DEFAULT_AGENT,
    model: DIRECT_GPT55_MODEL,
    modelRun: true,
    promptMode: 'none',
    modelOverride: DIRECT_GPT55_MODEL,
    fastHint: true,
    fastVerified: false,
  });

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
let callGatewayLoader = null;

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
  if (['gpt55-direct', 'gpt55direct', 'gpt-5.5-direct', 'gpt-5.5-without-openclaw', 'without-openclaw'].includes(wanted)) return DIRECT_GPT55_ROUTE_ID;
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


function sessionKeyForGateway(cfg) {
  const suffix = safeSessionIdPart(cfg.sessionId, 'default');
  return `agent:${cfg.agent}:${suffix}`;
}

function abortPromise(signal) {
  if (!signal) return null;
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
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

async function runGatewayAgentTurn(message, cfg, { signal, timeoutMs = MIN_OPENCLAW_REPLY_TIMEOUT_MS } = {}) {
  timeoutMs = openClawReplyTimeout(timeoutMs);
  const callGateway = await resolveCallGateway();
  const request = callGateway({
    method: 'agent',
    scopes: ['operator.admin'],
    params: {
      message,
      agentId: cfg.agent,
      sessionId: cfg.sessionId,
      sessionKey: sessionKeyForGateway(cfg),
      thinking: cfg.thinking,
      ...(cfg.modelOverride || cfg.model ? { model: cfg.modelOverride || cfg.model } : {}),
      ...(cfg.modelRun ? { modelRun: true } : {}),
      ...(cfg.promptMode ? { promptMode: cfg.promptMode } : {}),
      timeout: Math.ceil(timeoutMs / 1000),
      idempotencyKey: `voice-bridge-${Date.now()}-${randomUUID()}`,
    },
    expectFinal: true,
    timeoutMs: timeoutMs + 30000,
  });
  const aborter = abortPromise(signal);
  return aborter ? await Promise.race([request, aborter]) : await request;
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
    const child = execFile(OPENCLAW_BIN, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (signal?.aborted) return reject(new Error('aborted'));
      if (err) return resolve({ ok: false, err, stdout, stderr });
      resolve({ ok: true, stdout, stderr });
    });

    if (signal) {
      signal.addEventListener('abort', () => { child.kill(); }, { once: true });
    }
  });
}

async function applyFastModeIfNeeded(cfg, signal) {
  if (!cfg.fastModeBestEffort) return;
  const desired = normalizeFastMode(cfg.fastMode);
  const alreadyPrimed = _primedSessions.get(cfg.sessionId)?.fastMode;
  if (alreadyPrimed === desired) return;

  console.log(`[dialogue] priming session ${cfg.sessionId} with /fast ${desired}`);
  await runOpenclawTurn([
    'agent',
    '--agent', cfg.agent,
    '--session-id', cfg.sessionId,
    '--message', desired === 'on' ? '/fast on' : '/fast off',
    '--json',
  ], { signal, timeoutMs: 12000 });

  _primedSessions.set(cfg.sessionId, { ...(_primedSessions.get(cfg.sessionId) || {}), fastMode: desired });
  console.log(`[dialogue] session ${cfg.sessionId} primed with fastMode=${desired}`);
}

export function getProcessingOptions() {
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
  };
}

export function resolveProcessingConfig(input = {}) {
  const routeId = normalizeRoute(input.agent);
  const thinking = normalizeThinking(input.thinking);
  const fastMode = normalizeFastMode(input.fastMode);
  const route = PROCESSING_ROUTES.find((o) => o.id === routeId) || PROCESSING_ROUTES[0];

  return {
    route: route.id,
    agent: route.agent,
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
    sessionId: routeSessionId(route.id, input.sessionToken),
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

export function clearHistory() {
  // History managed by persistent OpenClaw sessions (route-scoped session ids).
}

export async function prewarmProcessing(processing = {}, { signal } = {}) {
  const cfg = resolveProcessingConfig(processing || {});
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
      label: cfg.label,
    },
  };
}

export async function steerActiveReply(steerText, { processing, timeoutMs = MIN_OPENCLAW_REPLY_TIMEOUT_MS } = {}) {
  timeoutMs = openClawReplyTimeout(timeoutMs);
  const trimmed = String(steerText || '').trim();
  if (!trimmed) return { ok: false, error: 'empty steer text' };
  const cfg = resolveProcessingConfig(processing || {});
  const message = `Realtime user steering update while the previous OpenClaw turn is still active:
${trimmed}`;
  try {
    const callGateway = await resolveCallGateway();
    const result = await callGateway({
      method: 'chat.send',
      scopes: ['operator.admin'],
      params: {
        sessionKey: sessionKeyForGateway(cfg),
        message,
        deliver: false,
        idempotencyKey: `voice-bridge-steer-${Date.now()}-${randomUUID()}`,
      },
      expectFinal: false,
      timeoutMs,
    });
    return { ok: true, sessionKey: sessionKeyForGateway(cfg), sessionId: cfg.sessionId, result };
  } catch (e) {
    return { ok: false, sessionKey: sessionKeyForGateway(cfg), sessionId: cfg.sessionId, error: e.message || String(e) };
  }
}

export async function generateReply(userText, { signal, processing, timeoutMs = MIN_OPENCLAW_REPLY_TIMEOUT_MS } = {}) {
  timeoutMs = openClawReplyTimeout(timeoutMs);
  const trimmed = userText.trim();
  if (!trimmed || trimmed === '[BLANK_AUDIO]') return null;

  const cfg = resolveProcessingConfig(processing || {});
  const t0 = Date.now();
  const message = cfg.modelRun ? trimmed : buildIntercomPrompt(trimmed);

  await applyFastModeIfNeeded(cfg, signal);

  try {
    const obj = await runGatewayAgentTurn(message, cfg, { signal, timeoutMs });
    const payloads = obj?.result?.payloads || [];
    const model = obj?.result?.meta?.agentMeta?.model || 'unknown';
    const reply = payloads[0]?.text?.trim();
    const elapsed = Date.now() - t0;
    console.log(`[dialogue] route=${cfg.route} agent=${cfg.agent} thinking=${cfg.thinking} fastMode=${cfg.fastMode} fastHint=${cfg.fastHint} model=${model} replied in ${elapsed}ms: "${(reply || '').slice(0, 80)}"`);

    if (!reply || reply === 'NO_REPLY') {
      return "I didn't catch that. Say it again.";
    }
    return reply;
  } catch (e) {
    if (e.message === 'aborted') throw e;
    console.error('[dialogue] gateway agent error:', e.message);
    const specific = userFacingOpenClawGatewayError(e);
    if (specific) return specific;
    if (/timed out|timeout/i.test(String(e.message || ''))) {
      return 'OpenClaw took too long to finish that. Try again or make it a smaller request.';
    }
    return 'OpenClaw fallback failed. Try that again.';
  }
}
