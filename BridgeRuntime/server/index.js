// Voice Bridge — Transport Server
// HTTP server + WebSocket for voice session management
// Serves client assets, handles audio upload/streaming, ASR, TTS, interrupts

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, stat, mkdir, appendFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { transcribe } from './asr.js';
import { synthesize, getVoiceOptions, resolveVoiceConfig, getTtsSpeedOptions, getTtsStatus } from './tts.js';
import { generateReply, clearHistory, getProcessingOptions, resolveProcessingConfig, prewarmProcessing, steerActiveReply } from './dialogue.js';
import {
  REALTIME_AUTH_MODE_OPENCLAW_OAUTH,
  buildRealtimeAuthStatus,
  realtimeAuthPreferences,
  resolveRealtimeBearer,
} from './realtime-auth.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLIENT_DIR = join(__dirname, '..', 'client');
const PORT = parseInt(process.env.VB_PORT || '3100', 10);
const BIND_HOST = (process.env.VB_BIND_HOST || process.env.HOST || '127.0.0.1').trim() || '127.0.0.1';
const RAW_BASE_PATH = (process.env.VB_BASE_PATH || '').trim();
const BASE_PATH = RAW_BASE_PATH
  ? '/' + RAW_BASE_PATH.replace(/^\/+|\/+$/g, '')
  : '';
const WAKE_PHRASE = (process.env.INTERCOM_WAKE_PHRASE || 'Hey').trim() || 'Hey';

// MIME types for static serving
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.wav':  'audio/wav',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const REALTIME_MODEL = process.env.REALTIME_MODEL || 'gpt-realtime-2';
const REALTIME_TRANSCRIPTION_MODEL = process.env.REALTIME_TRANSCRIPTION_MODEL || 'gpt-realtime-whisper';
const REALTIME_REASONING_EFFORT = process.env.REALTIME_REASONING_EFFORT || 'high';
const REALTIME_TRANSCRIPTION_DEFAULT = !['0', 'false', 'off', 'no'].includes(String(process.env.REALTIME_TRANSCRIPTION_DEFAULT || '0').toLowerCase());
const REALTIME_TRANSCRIPTION_DELAY = process.env.REALTIME_TRANSCRIPTION_DELAY || 'low';
const REALTIME_TRANSCRIPTION_LANGUAGE = process.env.REALTIME_TRANSCRIPTION_LANGUAGE || '';
const REALTIME_TURN_DETECTION_MODE = process.env.REALTIME_TURN_DETECTION_MODE || 'semantic_vad';
const REALTIME_SEMANTIC_VAD_EAGERNESS = process.env.REALTIME_SEMANTIC_VAD_EAGERNESS || 'auto';
const REALTIME_VOICE = process.env.REALTIME_VOICE || 'marin';
const REALTIME_LOG_DIR = process.env.REALTIME_LOG_DIR || join(__dirname, '..', 'ops-node', 'logs');
const REALTIME_TRANSCRIPT_LOG = join(REALTIME_LOG_DIR, 'realtime-transcripts.jsonl');
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || join(homedir(), '.openclaw', 'openclaw.json');
const REALTIME_VAD_THRESHOLD = Number(process.env.REALTIME_VAD_THRESHOLD || 0.68);
const REALTIME_VAD_PREFIX_PADDING_MS = Number(process.env.REALTIME_VAD_PREFIX_PADDING_MS || 240);
const REALTIME_VAD_SILENCE_DURATION_MS = Number(process.env.REALTIME_VAD_SILENCE_DURATION_MS || 330);
const VOICECLAW_BRIDGE_TOKEN = (process.env.VOICECLAW_BRIDGE_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || '').trim();
const VOICECLAW_BRIDGE_PASSWORD = (process.env.VOICECLAW_BRIDGE_PASSWORD || process.env.OPENCLAW_GATEWAY_PASSWORD || '').trim();

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function bridgeAuthEnabled() {
  return !!(VOICECLAW_BRIDGE_TOKEN || VOICECLAW_BRIDGE_PASSWORD);
}

function bridgeAuthSummary() {
  return {
    required: bridgeAuthEnabled(),
    bearerToken: !!VOICECLAW_BRIDGE_TOKEN,
    gatewayPassword: !!VOICECLAW_BRIDGE_PASSWORD,
  };
}

function bearerTokenFromRequest(req) {
  const header = String(req.headers.authorization || '').trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function hasBridgeAuth(req) {
  if (!bridgeAuthEnabled()) return true;

  const bearerToken = bearerTokenFromRequest(req);
  if (VOICECLAW_BRIDGE_TOKEN && timingSafeStringEqual(bearerToken, VOICECLAW_BRIDGE_TOKEN)) {
    return true;
  }

  const gatewayPassword = String(req.headers['x-openclaw-gateway-password'] || '').trim();
  if (VOICECLAW_BRIDGE_PASSWORD && timingSafeStringEqual(gatewayPassword, VOICECLAW_BRIDGE_PASSWORD)) {
    return true;
  }

  return false;
}

function logicalPathForAuth(urlPath) {
  if (BASE_PATH && urlPath.startsWith(`${BASE_PATH}/`)) {
    return urlPath.slice(BASE_PATH.length) || '/';
  }
  return urlPath;
}

function isProtectedBridgePath(urlPath) {
  const logicalPath = logicalPathForAuth(urlPath);
  return logicalPath === '/config'
    || logicalPath.startsWith('/realtime/')
    || logicalPath === '/ws';
}

function requireBridgeAuth(req, res) {
  if (hasBridgeAuth(req)) return true;

  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer realm="VoiceClaw Bridge"',
  });
  res.end(JSON.stringify({ ok: false, error: 'VoiceClaw Bridge authorization required' }));
  return false;
}

function loadOpenAIKeyFromConfig() {
  try {
    const cfg = JSON.parse(readFileSync(OPENCLAW_CONFIG, 'utf8'));
    return cfg?.messages?.tts?.providers?.openai?.apiKey || '';
  } catch {
    return '';
  }
}

function getOpenAIApiKey() {
  return process.env.OPENAI_API_KEY || loadOpenAIKeyFromConfig();
}

function openAIKeyForRealtimeRequest(req) {
  const forwarded = String(req.headers['x-openai-api-key'] || req.headers['x-voiceclaw-openai-key'] || '').trim();
  return forwarded || getOpenAIApiKey();
}

const REALTIME_INSTRUCTIONS = process.env.REALTIME_INSTRUCTIONS || `
# Role
- You are VoiceClaw, OpenClaw's high-capability realtime voice layer running on GPT-Realtime-2.
- You are the first responder for natural speech, timing, interruption, audio understanding, quick reasoning, conversation, and immediate spoken flow. OpenClaw core is the heavy tool body for the user's Mac and private/local work.
- Use OpenClaw as the public product name. Do not mention internal agent names in user-facing speech.

# Default behavior
- Answer directly whenever the request can be handled from conversation context, common knowledge, simple reasoning, language understanding, or the current date/time context provided in this session.
- Keep spoken answers concise and natural. Ask a short clarifying question when needed.

# When to call OpenClaw
- Call openclaw_turn only when the user explicitly asks for OpenClaw or when the request truly requires the user's Mac, files, browser, messages, calendar, memory, dashboards, shell, crons, long-running work, or other local/private computer state.
- Preserve the user's request faithfully and completely in the tool text.
- Before calling openclaw_turn, say at most one brief bridge phrase, for example: "On it.", "Checking.", or "One sec." Do not explain routing, tools, architecture, or plans unless the user asks.
- Do not invent tool results. Never claim you checked tools, files, memory, calendar, messages, or system state unless openclaw_turn returned that result.

# Tool-call speech discipline
- When doing something, do it. Do not narrate mechanics.
- After a successful tool action, give a brief useful completion note. Do not overexplain implementation details unless asked.
- Explain if the user asked for an explanation, the tool failed, or there is a real blocker/choice.

# Unclear or low-confidence audio
- If audio is missing, blank, likely environmental noise, or you are unsure what the user said, do not guess. Ask briefly: "Say that again?" or "I didn’t catch that."
- Do not route unclear fragments like "you", "thank you", footsteps, keyboard noise, or background machine noise to OpenClaw.
- Preserve explicit short commands when clear: stop, cancel, wait, yes, no, help, hey/OpenClaw wake phrases.

# Language
- Match the user’s language when clear. If the user speaks Hebrew, answer in Hebrew. If mixed, follow the user’s dominant language.

# Interruptions, stop/cancel, and bridge status
- If interrupted, stop speaking immediately. The bridge will preserve OpenClaw work where possible.
- If the user gives additional instructions, corrections, scope changes, follow-up questions, or asks to add something while an OpenClaw request is already active, you CAN and MUST call steer_openclaw with the new text. Do not say you cannot send another request. Do not wait for the previous response. Steering is allowed while work is active and is the correct behavior.
- If the user explicitly says stop, cancel, abort, never mind, or asks what the bridge is doing, call stop_openclaw or bridge_status instead of openclaw_turn.
`;

const REALTIME_DIRECT_INSTRUCTIONS = process.env.REALTIME_DIRECT_INSTRUCTIONS || `
# Role
- You are GPT-Realtime-2 in direct realtime intercom mode for User.
- Use your native realtime audio, reasoning, and conversation capabilities fully.
- Do not claim access to OpenClaw bridge tools, local files, memory, browser, calendars, messages, system state, or live dashboards unless those tools are explicitly supplied in the current session.
- If the user asks for OpenClaw-backed work/current system facts, say briefly that Direct mode needs the OpenClaw Bridge mode for that and continue helpfully with what you can answer directly.
- Keep spoken replies concise, natural, and high-agency. Do not narrate process; give a brief useful completion note when an action finishes.
`;

const REALTIME_TOOLS = [
  {
    type: 'function',
    name: 'openclaw_turn',
    description: "Escalate a request to the local OpenClaw agent runtime when the user's Mac, files, browser, memory, calendar, messages, shell, crons, dashboards, coding, research, or other local/private computer capabilities are needed, or when the user explicitly asks for OpenClaw. Returns the final answer to speak.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'The exact user request to route through OpenClaw.' },
        urgency: { type: 'string', enum: ['low', 'normal', 'high'], description: 'How urgent the request seems.' }
      },
      required: ['text']
    }
  },
  {
    type: 'function',
    name: 'steer_openclaw',
    description: 'Send follow-up messages, steering instructions, corrections, questions, or scope changes into the currently active OpenClaw request without cancelling it. Use this while OpenClaw is already working; do not claim that another request cannot be sent.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'The new steering instruction to inject into the active OpenClaw run.' },
        urgency: { type: 'string', enum: ['low', 'normal', 'high'], description: 'How urgent this steering update is.' }
      },
      required: ['text']
    }
  },
  {
    type: 'function',
    name: 'stop_openclaw',
    description: 'Stop the active OpenClaw request and clear queued OpenClaw requests when the user explicitly asks to stop, cancel, or abort the work.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] }
  },
  {
    type: 'function',
    name: 'bridge_status',
    description: 'Report local Realtime bridge state such as selected OpenClaw model, active work, queue, mic mute state, and recent latency.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] }
  }
];

const realtimeTurns = new Map();

const MAX_CLASSIC_PENDING_TURNS = Number(process.env.VB_MAX_PENDING_TURNS || 3);
const MAX_REALTIME_PENDING_TURNS = Number(process.env.VB_REALTIME_MAX_PENDING_TURNS || 3);
const MIN_PROBE_RMS = Number(process.env.VB_PROBE_MIN_RMS || 140);
const MIN_TURN_RMS = Number(process.env.VB_TURN_MIN_RMS || 90);
const MIN_AUDIO_BYTES = Number(process.env.VB_MIN_AUDIO_BYTES || 1200);
const REALTIME_SIDEBAND_ENABLED = !['0', 'false', 'off'].includes(String(process.env.REALTIME_SIDEBAND_ENABLED || '1').toLowerCase());
const REALTIME_SIDEBAND_OPEN_TIMEOUT_MS = Number(process.env.REALTIME_SIDEBAND_OPEN_TIMEOUT_MS || 2500);
const realtimeSidebands = new Map();
const realtimeSidebandStates = new Map();
const realtimePendingCounts = new Map();
const realtimeCancelTombstones = new Map();
const realtimeSessionConfigs = new Map();
const realtimeCompletedResults = new Map();
const REALTIME_RESULT_TTL_MS = Number(process.env.REALTIME_RESULT_TTL_MS || 10 * 60 * 1000);


function parseRealtimeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseJsonHeader(value) {
  if (!value) return {};
  try { return JSON.parse(decodeURIComponent(String(value))); } catch {}
  try { return JSON.parse(String(value)); } catch {}
  return {};
}

function normalizeRealtimeReasoning(value = '') {
  const clean = String(value || '').toLowerCase();
  return ['none', 'low', 'medium', 'high'].includes(clean) ? clean : REALTIME_REASONING_EFFORT;
}

function normalizeTranscriptionDelay(value = '') {
  const clean = String(value || '').toLowerCase();
  return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(clean) ? clean : REALTIME_TRANSCRIPTION_DELAY;
}

function normalizeTurnDetectionMode(value = '') {
  const clean = String(value || '').toLowerCase().replace('-', '_');
  if (['semantic', 'semantic_vad'].includes(clean)) return 'semantic_vad';
  if (['server', 'server_vad'].includes(clean)) return 'server_vad';
  if (['none', 'manual', 'off', 'disabled', 'null'].includes(clean)) return 'none';
  return REALTIME_TURN_DETECTION_MODE;
}

function buildRealtimeTurnDetection(mode) {
  const normalized = normalizeTurnDetectionMode(mode);
  if (normalized === 'none') return null;
  if (normalized === 'semantic_vad') {
    return { type: 'semantic_vad', eagerness: REALTIME_SEMANTIC_VAD_EAGERNESS, create_response: true, interrupt_response: true };
  }
  return { type: 'server_vad', threshold: REALTIME_VAD_THRESHOLD, prefix_padding_ms: REALTIME_VAD_PREFIX_PADDING_MS, silence_duration_ms: REALTIME_VAD_SILENCE_DURATION_MS, create_response: true, interrupt_response: true };
}

function realtimeRequestOptions(req, routeMode, sessionToken) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const processing = parseJsonHeader(req.headers['x-openclaw-processing']);
  const model = String(req.headers['x-realtime-model'] || url.searchParams.get('model') || REALTIME_MODEL).trim() || REALTIME_MODEL;
  const voice = String(req.headers['x-realtime-voice'] || url.searchParams.get('voice') || REALTIME_VOICE).trim() || REALTIME_VOICE;
  const noiseReduction = normalizeRealtimeNoiseReduction(req.headers['x-realtime-noise-reduction'] || url.searchParams.get('noiseReduction'));
  const captions = parseRealtimeBoolean(req.headers['x-realtime-captions'] ?? url.searchParams.get('captions'), REALTIME_TRANSCRIPTION_DEFAULT);
  const turnDetection = normalizeTurnDetectionMode(req.headers['x-realtime-turn-detection'] || url.searchParams.get('vad'));
  const realtimeReasoning = normalizeRealtimeReasoning(req.headers['x-realtime-reasoning'] || url.searchParams.get('reasoning'));
  const transcriptionDelay = normalizeTranscriptionDelay(req.headers['x-realtime-transcription-delay'] || url.searchParams.get('transcriptionDelay'));
  const transcriptionLanguage = String(req.headers['x-realtime-transcription-language'] || url.searchParams.get('language') || REALTIME_TRANSCRIPTION_LANGUAGE || '').trim();
  return {
    sessionToken: sanitizeRealtimeSessionToken(sessionToken),
    routeMode,
    processing,
    model,
    voice,
    noiseReduction,
    captions,
    turnDetection,
    realtimeReasoning,
    transcriptionDelay,
    transcriptionLanguage,
    createdAt: Date.now(),
  };
}

function normalizeRealtimeNoiseReduction(value = '') {
  const clean = String(value || '').toLowerCase().replace('-', '_');
  if (['near', 'near_field'].includes(clean)) return 'near_field';
  if (['far', 'far_field'].includes(clean)) return 'far_field';
  if (['off', 'none', 'disabled', 'null'].includes(clean)) return 'off';
  return 'near_field';
}

function buildRealtimeAudioConfig(options = {}) {
  const input = {};
  if (options.noiseReduction && options.noiseReduction !== 'off') input.noise_reduction = { type: options.noiseReduction };
  if (options.captions) {
    input.transcription = { model: REALTIME_TRANSCRIPTION_MODEL, delay: options.transcriptionDelay || REALTIME_TRANSCRIPTION_DELAY };
    if (options.transcriptionLanguage) input.transcription.language = options.transcriptionLanguage;
  }
  const turnDetection = buildRealtimeTurnDetection(options.turnDetection);
  input.turn_detection = turnDetection;
  return { input, output: { voice: options.voice || REALTIME_VOICE } };
}

function normalizeActionText(text = '') {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function actionability(text = '', { allowWake = false, allowShortCommand = true, context = 'turn' } = {}) {
  const clean = normalizeActionText(text);
  const normalized = clean.toLowerCase().replace(/[“”]/g, '"').replace(/[^a-z0-9א-ת\s?!.-]/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized === '[blank_audio]') return { actionable: false, reason: 'blank', text: clean };
  const noiseOnly = new Set(['you','thank you','thanks','thank','thank you thank you','okay thank you','uh','um','umm','hmm','mm','ah','oh','yeah yeah','no no','keyboard','typing','keyboard clacking','keyboard clicking','typing sounds','footsteps','step','steps','walking','machine noise','machine whirring','background noise','silence','inaudible','unintelligible','blank audio','music','beep']);
  if (noiseOnly.has(normalized)) return { actionable: false, reason: 'noise-only', text: clean };
  if (/^(?:\[?inaudible\]?|\[?unintelligible\]?|\(?no speech detected\)?|\[?blank audio\]?)$/i.test(clean)) return { actionable: false, reason: 'asr-placeholder', text: clean };
  const shortCommands = new Set(['stop','cancel','abort','wait','pause','hold on','yes','no','help','status','weather','calendar','time','timer','reminder','lights','email','mail','messages','dashboard','plate','mic','microphone','voice','realtime','what are you doing','never mind','nevermind']);
  if (allowShortCommand && shortCommands.has(normalized)) return { actionable: true, reason: 'short-command', text: clean };
  if (allowWake && /^(?:hey|hay|heyy|openclaw|open claw|open cloud|open claude)(?:\s|$)/.test(normalized)) return { actionable: true, reason: 'wake', text: clean };
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return { actionable: true, reason: 'word-count', text: clean };
  if (/[?!]$/.test(clean) && clean.length >= 3) return { actionable: true, reason: 'punctuated-short', text: clean };
  if (/^[א-ת]{2,}$/.test(normalized)) return { actionable: true, reason: 'hebrew-short', text: clean };
  return { actionable: false, reason: `too-short-${context}`, text: clean };
}

function isKnownAudioContainer(raw) {
  if (!raw || raw.length < 12) return false;
  if (raw.slice(0, 4).toString('ascii') === 'RIFF') return false;
  if (raw.slice(0, 4).toString('ascii') === 'OggS') return true;
  if (raw[0] === 0x1A && raw[1] === 0x45 && raw[2] === 0xDF && raw[3] === 0xA3) return true;
  if (raw[4] === 0x66 && raw[5] === 0x74 && raw[6] === 0x79 && raw[7] === 0x70) return true;
  if (raw.slice(0, 4).toString('ascii') === 'fLaC') return true;
  return false;
}

function audioEnergy(buffer) {
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (raw.length < MIN_AUDIO_BYTES) return { rms: 0, peak: 0, samples: 0, tooSmall: true, container: false };
  if (isKnownAudioContainer(raw)) return { rms: null, peak: null, samples: 0, tooSmall: false, container: true };
  let offset = raw.length > 44 && raw.slice(0, 4).toString('ascii') === 'RIFF' ? 44 : 0;
  let sumSq = 0, peak = 0, samples = 0;
  for (let i = offset; i + 1 < raw.length; i += 2) {
    const v = raw.readInt16LE(i); const a = Math.abs(v);
    peak = Math.max(peak, a); sumSq += v * v; samples += 1;
  }
  const rms = samples ? Math.sqrt(sumSq / samples) : 0;
  return { rms, peak, samples, tooSmall: false, container: false };
}

function shouldSkipAudio(buffer, threshold = MIN_TURN_RMS) {
  const e = audioEnergy(buffer);
  return { skip: !e.container && (e.tooSmall || e.rms < threshold), ...e, threshold };
}

function rememberRealtimeCancel(sessionToken, turnId = '') {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  if (!turnId) return;
  const tombstones = realtimeCancelTombstones.get(key) || [];
  tombstones.push({ turnId: String(turnId), at: Date.now() });
  realtimeCancelTombstones.set(key, tombstones.slice(-20));
}

function isRealtimeCancelled(sessionToken, turnId = '') {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const wanted = String(turnId || '');
  if (!wanted) return false;
  const recent = (realtimeCancelTombstones.get(key) || []).filter((item) => Date.now() - item.at < 120000);
  realtimeCancelTombstones.set(key, recent);
  return recent.some((item) => item.turnId === wanted);
}

function realtimeQueueCount(sessionToken) { return realtimePendingCounts.get(sanitizeRealtimeSessionToken(sessionToken)) || 0; }
function incrementRealtimeQueue(sessionToken) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const count = realtimeQueueCount(key);
  if (count >= MAX_REALTIME_PENDING_TURNS) return false;
  realtimePendingCounts.set(key, count + 1);
  return true;
}
function decrementRealtimeQueue(sessionToken) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const count = Math.max(0, realtimeQueueCount(key) - 1);
  if (count) realtimePendingCounts.set(key, count); else realtimePendingCounts.delete(key);
}

function pruneRealtimeResults() {
  const now = Date.now();
  for (const [key, result] of realtimeCompletedResults.entries()) {
    if (now - result.completedAt > REALTIME_RESULT_TTL_MS) realtimeCompletedResults.delete(key);
  }
}

function rememberRealtimeResult(sessionToken, result = {}) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  realtimeCompletedResults.set(key, {
    ok: !!result.ok,
    reply: result.reply || '',
    error: result.error || '',
    turnId: result.turnId || '',
    timings: result.timings || null,
    completedAt: Date.now(),
  });
  pruneRealtimeResults();
}

function latestRealtimeResult(sessionToken) {
  pruneRealtimeResults();
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const result = realtimeCompletedResults.get(key);
  if (!result) return null;
  return {
    ...result,
    completedAgoMs: Date.now() - result.completedAt,
  };
}

function realtimeSidebandStateFor(sessionToken) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  let state = realtimeSidebandStates.get(key);
  if (!state) {
    state = {
      activeResponseId: null,
      pendingResponseCreates: [],
      lastResponseCreate: null,
      handledCallIds: new Set(),
      lastToolCallId: '',
      lastError: '',
      lastCloseCode: null,
      lastCloseReason: '',
      connectedAt: null,
    };
    realtimeSidebandStates.set(key, state);
  }
  return state;
}

function resetRealtimeSidebandState(sessionToken) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  realtimeSidebandStates.delete(key);
}

function closeRealtimeSideband(sessionToken, reason = 'client disconnect', { clearSession = true, clearQueue = true } = {}) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const ws = realtimeSidebands.get(key);
  if (ws) {
    try { ws.close(1000, reason); } catch {}
    realtimeSidebands.delete(key);
  }
  if (clearSession) realtimeSessionConfigs.delete(key);
  if (clearQueue) realtimePendingCounts.delete(key);
  if (clearSession) resetRealtimeSidebandState(key);
  return !!ws;
}

function bridgeStatusSnapshot(sessionToken = '') {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const current = realtimeTurns.get(key);
  const sideband = realtimeSidebands.get(key);
  const sidebandState = sideband ? ['connecting', 'open', 'closing', 'closed'][sideband.readyState] || String(sideband.readyState) : 'none';
  const sidebandDiagnostics = realtimeSidebandStates.get(key) || null;
  const sessionConfig = realtimeSessionConfigs.get(key) || null;
  return {
    active: !!current,
    turnId: current?.turnId || null,
    activeForMs: current ? Date.now() - current.startedAt : 0,
    realtimePending: realtimeQueueCount(key),
    maxRealtimePending: MAX_REALTIME_PENDING_TURNS,
    sideband: sidebandState,
    sidebandEnabled: REALTIME_SIDEBAND_ENABLED,
    sidebandDiagnostics: sidebandDiagnostics ? {
      activeResponseId: sidebandDiagnostics.activeResponseId,
      pendingResponseCreates: sidebandDiagnostics.pendingResponseCreates.length,
      handledToolCalls: sidebandDiagnostics.handledCallIds.size,
      lastToolCallId: sidebandDiagnostics.lastToolCallId,
      lastError: sidebandDiagnostics.lastError,
      lastCloseCode: sidebandDiagnostics.lastCloseCode,
      lastCloseReason: sidebandDiagnostics.lastCloseReason,
      connectedAt: sidebandDiagnostics.connectedAt,
    } : null,
    sessionConfig,
    lastResult: latestRealtimeResult(key),
    tts: getTtsStatus(),
  };
}

function sendSidebandEvent(ws, event) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(event));
  return true;
}

function queueSidebandResponseCreate(ws, sessionToken, event, reason = 'queued') {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const state = realtimeSidebandStateFor(key);
  const eventId = String(event?.event_id || '');
  const alreadyQueued = eventId && state.pendingResponseCreates.some((queued) => queued.event_id === eventId);
  if (!alreadyQueued) state.pendingResponseCreates.push(event);
  appendRealtimeLog({ kind: 'sideband_response_create_queued', sessionToken: key, reason, pending: state.pendingResponseCreates.length, activeResponseId: state.activeResponseId });
  flushSidebandResponseCreates(ws, key);
}

function requestSidebandResponseCreate(ws, sessionToken, response = {}, reason = 'tool-output') {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const state = realtimeSidebandStateFor(key);
  const event = {
    type: 'response.create',
    event_id: `vc-sideband-${reason}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
  if (response && Object.keys(response).length) event.response = response;

  if (state.activeResponseId) {
    queueSidebandResponseCreate(ws, key, event, reason);
    return false;
  }

  state.lastResponseCreate = event;
  state.activeResponseId = 'requested';
  const sent = sendSidebandEvent(ws, event);
  appendRealtimeLog({ kind: sent ? 'sideband_response_create_sent' : 'sideband_response_create_send_failed', sessionToken: key, reason, pending: state.pendingResponseCreates.length });
  if (!sent) {
    state.activeResponseId = null;
    queueSidebandResponseCreate(ws, key, event, 'send-failed');
  }
  return sent;
}

function flushSidebandResponseCreates(ws, sessionToken) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const state = realtimeSidebandStateFor(key);
  if (state.activeResponseId || ws?.readyState !== WebSocket.OPEN || !state.pendingResponseCreates.length) return false;
  const event = state.pendingResponseCreates.shift();
  state.lastResponseCreate = event;
  state.activeResponseId = 'requested';
  const sent = sendSidebandEvent(ws, event);
  appendRealtimeLog({ kind: sent ? 'sideband_response_create_flushed' : 'sideband_response_create_flush_failed', sessionToken: key, pending: state.pendingResponseCreates.length });
  if (!sent) {
    state.activeResponseId = null;
    state.pendingResponseCreates.unshift(event);
  }
  return sent;
}

function toolResultSpeechSeed(result) {
  const r = result?.result || result || {};
  if (typeof r.spoken === 'string' && r.spoken.trim()) return r.spoken.trim();
  if (typeof r.summary === 'string' && r.summary.trim()) return r.summary.trim();
  if (typeof result?.summary === 'string' && result.summary.trim()) return result.summary.trim();
  if (typeof result?.error === 'string' && result.error.trim()) return result.error.trim();
  return 'The tool returned a result.';
}

function toolResultAnswerInstructions(result, fallback = '') {
  const seed = toolResultSpeechSeed(result) || fallback || 'The tool returned a result.';
  return `Answer the user conversationally using the function output. Be concise but substantive. Do not say only "done", "completed", "finished", or "successful". State the useful result itself. Start from this result summary, expanding only if the function output contains useful detail:
${seed}`;
}

async function handleRealtimeSidebandToolCall(ws, event, sessionToken) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const state = realtimeSidebandStateFor(key);
  const name = event.name || event.tool_name || event.function?.name;
  const callId = event.call_id || event.callId || event.item_id || event.id;
  if (!callId) return;
  if (state.handledCallIds.has(callId)) {
    await appendRealtimeLog({ kind: 'sideband_function_duplicate_ignored', sessionToken: key, name, callId });
    return;
  }
  state.handledCallIds.add(callId);
  state.lastToolCallId = callId;
  let args = {};
  try { args = JSON.parse(event.arguments || event.output || '{}'); } catch {}
  await appendRealtimeLog({ kind: 'sideband_function_requested', sessionToken: key, name, callId, args });
  const exact = (text) => `Say exactly this text and nothing else:\n${String(text || '').trim()}`;
  const outputAndSpeak = (output, { speak = true } = {}) => {
    sendSidebandEvent(ws, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } });
    appendRealtimeLog({ kind: 'sideband_function_output_sent', sessionToken: key, name, callId, outputPreview: String(output || '').slice(0, 500) });
    if (speak) {
      requestSidebandResponseCreate(ws, key, { instructions: exact(output) }, name || 'tool-output');
    }
  };
  const outputJsonAndSpeakSummary = (result, { speak = true } = {}) => {
    const output = JSON.stringify(result);
    const spoken = toolResultSpeechSeed(result);
    sendSidebandEvent(ws, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } });
    appendRealtimeLog({ kind: 'sideband_function_output_sent', sessionToken: key, name, callId, ok: result?.ok, outputPreview: output.slice(0, 500) });
    if (speak) {
      requestSidebandResponseCreate(ws, key, { instructions: toolResultAnswerInstructions(result, spoken) }, name || 'tool-summary');
    }
  };
  if (name === 'wait_for_user') { outputAndSpeak('Waiting silently for the user.', { speak: false }); return; }
  if (name === 'realtime_status') { outputAndSpeak(JSON.stringify(bridgeStatusSnapshot(sessionToken))); return; }
  if (name === 'stop_openclaw') { cancelRealtimeTurn(sessionToken, 'sideband stop', '', { force: true }); outputAndSpeak('Stopped.'); return; }
  if (name === 'steer_openclaw') {
    const steerText = String(args.text || '').trim();
    if (!steerText) { outputJsonAndSpeakSummary({ ok: false, error: 'No steering text supplied.' }); return; }
    const result = await steerRealtimeOpenClawTurn({ text: steerText, sessionToken, urgency: args.urgency || 'normal', processing: args.processing || {} });
    outputJsonAndSpeakSummary({ ...result, summary: result.ok ? 'Added that to the active OpenClaw request.' : `OpenClaw steering failed: ${result.error || 'unknown error'}` });
    return;
  }
  if (name === 'bridge_status') { outputAndSpeak(JSON.stringify(bridgeStatusSnapshot(sessionToken))); return; }
  if (name && name !== 'openclaw_turn') return;
  const gate = actionability(args.text || '', { allowWake: false, allowShortCommand: true, context: 'realtime-sideband' });
  if (!gate.actionable) { outputAndSpeak("I didn't catch that. Say it again?"); return; }
  if (!incrementRealtimeQueue(sessionToken)) { outputAndSpeak(`The OpenClaw queue is full (${MAX_REALTIME_PENDING_TURNS} waiting). Say stop or wait a moment.`); return; }
  const turnId = `rt-sideband-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const sessionConfig = realtimeSessionConfigs.get(sanitizeRealtimeSessionToken(sessionToken)) || {};
    const result = await runRealtimeOpenClawTurn({ text: gate.text, sessionToken, turnId, urgency: args.urgency || 'normal', processing: { ...(sessionConfig.processing || {}), ...(args.processing || {}) } });
    if (isRealtimeCancelled(sessionToken, turnId)) { outputAndSpeak('Stopped.'); return; }
    outputAndSpeak(result.ok ? result.reply : (result.cancelled ? 'Stopped.' : `OpenClaw bridge error: ${result.error || 'unknown error'}`));
  } finally { decrementRealtimeQueue(sessionToken); }
}

function normalizeSidebandToolCallEvent(event = {}) {
  if (event.type === 'response.function_call_arguments.done') return event;
  if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
    return {
      ...event,
      name: event.item.name,
      call_id: event.item.call_id || event.item.id,
      arguments: event.item.arguments || event.arguments || '{}',
    };
  }
  return null;
}

function activeResponseCollisionMessage(event = {}) {
  const message = event?.error?.message || event?.message || '';
  return String(message || '').toLowerCase().includes('already has an active response') ? message : '';
}

async function handleRealtimeSidebandEvent(ws, event, sessionToken) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const state = realtimeSidebandStateFor(key);
  const type = event?.type || '';

  if (type === 'response.created') {
    state.activeResponseId = event.response?.id || event.response_id || event.id || 'active';
    await appendRealtimeLog({ kind: 'sideband_response_active', sessionToken: key, responseId: state.activeResponseId });
    return;
  }

  if (type === 'response.done' || type === 'response.cancelled' || type === 'response.failed') {
    const responseId = state.activeResponseId;
    state.activeResponseId = null;
    await appendRealtimeLog({ kind: 'sideband_response_done', sessionToken: key, responseId, pending: state.pendingResponseCreates.length, type });
    flushSidebandResponseCreates(ws, key);
    return;
  }

  if (type.includes('error')) {
    const collision = activeResponseCollisionMessage(event);
    state.lastError = event?.error?.message || event?.message || JSON.stringify(event).slice(0, 500);
    if (collision) {
      if (state.lastResponseCreate) queueSidebandResponseCreate(ws, key, state.lastResponseCreate, 'active-response-retry');
      state.activeResponseId = state.activeResponseId || 'active';
      await appendRealtimeLog({ kind: 'sideband_active_response_collision', sessionToken: key, pending: state.pendingResponseCreates.length });
      return;
    }
    await appendRealtimeLog({ kind: 'sideband_error_event', sessionToken: key, error: state.lastError });
    return;
  }

  const toolEvent = normalizeSidebandToolCallEvent(event);
  if (toolEvent) {
    state.activeResponseId = state.activeResponseId || event.response_id || event.response?.id || 'active';
    await handleRealtimeSidebandToolCall(ws, toolEvent, key);
  }
}

function realtimeCallIdFromLocation(location = '') {
  const clean = String(location || '').trim();
  if (!clean) return '';
  try {
    const parsed = new URL(clean, 'https://api.openai.com');
    return parsed.pathname.split('/').filter(Boolean).pop() || '';
  } catch {
    return clean.split('?')[0].split('/').filter(Boolean).pop() || '';
  }
}

async function startRealtimeSideband(location, sessionToken, apiKey = getOpenAIApiKey()) {
  if (!REALTIME_SIDEBAND_ENABLED || !location || !apiKey) return false;
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const callId = realtimeCallIdFromLocation(location);
  const wsUrl = callId ? `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}` : '';
  if (!wsUrl) return false;
  try {
    const existing = realtimeSidebands.get(key);
    if (existing?.readyState === WebSocket.OPEN || existing?.readyState === WebSocket.CONNECTING) existing.close();
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    realtimeSidebands.set(key, ws);
    let opened = false;
    const openPromise = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), REALTIME_SIDEBAND_OPEN_TIMEOUT_MS);
      ws.once('open', () => { opened = true; clearTimeout(timer); resolve(true); });
      ws.once('error', () => { clearTimeout(timer); resolve(false); });
      ws.once('close', () => { clearTimeout(timer); resolve(false); });
    });
    ws.on('open', () => {
      const state = realtimeSidebandStateFor(key);
      state.connectedAt = new Date().toISOString();
      state.lastError = '';
      appendRealtimeLog({ kind: 'sideband_open', sessionToken: key, callIdPrefix: callId.slice(0, 8) });
    });
    ws.on('message', (data) => {
      let event;
      try { event = JSON.parse(data.toString()); } catch { return; }
      handleRealtimeSidebandEvent(ws, event, key).catch((err) => appendRealtimeLog({ kind: 'sideband_event_error', sessionToken: key, error: err.message }));
    });
    ws.on('close', (code, reason) => {
      if (realtimeSidebands.get(key) === ws) realtimeSidebands.delete(key);
      const state = realtimeSidebandStateFor(key);
      state.lastCloseCode = code;
      state.lastCloseReason = String(reason || '');
      appendRealtimeLog({ kind: 'sideband_close', sessionToken: key, code, reason: String(reason || '') });
    });
    ws.on('error', (err) => {
      if (!opened && realtimeSidebands.get(key) === ws) realtimeSidebands.delete(key);
      const state = realtimeSidebandStateFor(key);
      state.lastError = err.message;
      appendRealtimeLog({ kind: 'sideband_error', sessionToken: key, error: err.message });
    });
    const ready = await openPromise;
    if (!ready || ws.readyState !== WebSocket.OPEN) {
      if (realtimeSidebands.get(key) === ws) realtimeSidebands.delete(key);
      try { ws.close(); } catch {}
      await appendRealtimeLog({ kind: 'sideband_not_ready', sessionToken: key, timeoutMs: REALTIME_SIDEBAND_OPEN_TIMEOUT_MS, callIdPrefix: callId.slice(0, 8) });
      return false;
    }
    return true;
  } catch (err) { appendRealtimeLog({ kind: 'sideband_start_failed', sessionToken: key, error: err.message }); return false; }
}

function sanitizeRealtimeSessionToken(value = '') {
  const cleaned = String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || `browser-${Date.now().toString(36)}`;
}

function realtimeOpenClawSessionToken(browserSessionId = '') {
  return `voice-realtime-${sanitizeRealtimeSessionToken(browserSessionId)}-julian`;
}

function realtimeRoutingMode(req) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const value = String(url.searchParams.get('route') || req.headers['x-openclaw-route'] || '').toLowerCase();
  return value === 'direct' || value === 'pure' || value === 'realtime-only' ? 'direct' : 'openclaw';
}

function isOpenClawRealtimeRoute(routeMode = '') {
  return routeMode === 'openclaw';
}

function hasServerOwnedRealtimeTools(routeMode = '') {
  return isOpenClawRealtimeRoute(routeMode);
}

function realtimeCurrentContext() {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  const formatted = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(now);
  return `\n# Current context\n- Current local date and time on this Mac: ${formatted} (${timezone}).\n`;
}

function realtimeInstructionsForRoute(routeMode = '') {
  const base = isOpenClawRealtimeRoute(routeMode) ? REALTIME_INSTRUCTIONS : REALTIME_DIRECT_INSTRUCTIONS;
  return `${base.trim()}\n${realtimeCurrentContext()}`.trim();
}

function realtimeToolsForRoute(routeMode = '') {
  return isOpenClawRealtimeRoute(routeMode) ? REALTIME_TOOLS : [];
}

async function appendRealtimeLog(event) {
  try {
    await mkdir(REALTIME_LOG_DIR, { recursive: true });
    await appendFile(REALTIME_TRANSCRIPT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  } catch (err) {
    console.error('[realtime-log]', err.message);
  }
}

function cancelRealtimeTurn(sessionToken, reason = 'cancelled', turnId = '', { force = false } = {}) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const current = realtimeTurns.get(key);
  if (!current) return false;
  const wantedTurnId = String(turnId || '');
  if (!force && wantedTurnId && current.turnId !== wantedTurnId) {
    appendRealtimeLog({ kind: 'cancel_ignored', sessionToken: key, turnId: current.turnId, requestedTurnId: wantedTurnId, reason });
    return false;
  }
  current.controller.abort();
  realtimeTurns.delete(key);
  appendRealtimeLog({ kind: 'cancel', sessionToken: key, turnId: current.turnId, reason });
  return true;
}

function realtimeVoiceTimeoutMs(_urgency = 'normal', _processing = {}) {
  // OpenClaw fallback can legitimately use browser, files, messages, subagents,
  // and other slower local tools. Realtime can still interrupt/cancel/steer turns,
  // so keep the bridge patient enough for real agent work.
  return Number(process.env.REALTIME_OPENCLAW_TIMEOUT_MS || 1200000);
}


async function steerRealtimeOpenClawTurn({ text, sessionToken, urgency, processing }) {
  const cleanedText = String(text || '').trim();
  if (!cleanedText) return { ok: false, error: 'empty steer text' };
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const current = realtimeTurns.get(key);
  if (!current) return { ok: false, error: 'no active OpenClaw turn to steer' };
  const startedAt = Date.now();
  const result = await steerActiveReply(cleanedText, { processing: { ...(processing || {}), sessionToken: realtimeOpenClawSessionToken(key), fastMode: 'on' }, timeoutMs: 15000 });
  await appendRealtimeLog({ kind: 'steer', sessionToken: key, turnId: current.turnId, urgency: urgency || 'normal', ok: !!result.ok, elapsedMs: Date.now() - startedAt, text: cleanedText, error: result.error || '' });
  return { ok: !!result.ok, steered: !!result.ok, reply: result.ok ? 'Added that to the active OpenClaw request.' : undefined, sessionToken: key, turnId: current.turnId, activeSinceMs: Date.now() - current.startedAt, summary: result.ok ? 'Added that to the active OpenClaw request.' : `OpenClaw steering failed: ${result.error || 'unknown error'}`, error: result.error || undefined };
}

async function runRealtimeOpenClawTurn({ text, sessionToken, turnId, urgency, processing }) {
  const cleanedText = String(text || '').trim();
  if (!cleanedText) return { ok: false, error: 'empty text' };

  const key = sanitizeRealtimeSessionToken(sessionToken);
  if (realtimeTurns.has(key)) return await steerRealtimeOpenClawTurn({ text: cleanedText, sessionToken: key, urgency, processing });
  realtimeCompletedResults.delete(key);
  const controller = new AbortController();
  const openclawToken = realtimeOpenClawSessionToken(key);
  const effectiveTurnId = String(turnId || `rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  realtimeTurns.set(key, { controller, turnId: effectiveTurnId, startedAt: Date.now() });

  await appendRealtimeLog({ kind: 'user', sessionToken: key, openclawSessionToken: openclawToken, turnId: effectiveTurnId, urgency: urgency || 'normal', text: cleanedText });

  try {
    const gatewayStartedAt = Date.now();
    const reply = await generateReply(cleanedText, {
      signal: controller.signal,
      processing: { ...(processing || {}), sessionToken: openclawToken, fastMode: 'on' },
      timeoutMs: realtimeVoiceTimeoutMs(urgency, processing || {}),
    });
    const timings = { gatewayMs: Date.now() - gatewayStartedAt, totalMs: Date.now() - realtimeTurns.get(key)?.startedAt };
    if (controller.signal.aborted || realtimeTurns.get(key)?.turnId !== effectiveTurnId) {
      await appendRealtimeLog({ kind: 'stale_reply_suppressed', sessionToken: key, turnId: effectiveTurnId });
      return { ok: false, cancelled: true, error: 'turn cancelled' };
    }
    if (realtimeTurns.get(key)?.turnId === effectiveTurnId) realtimeTurns.delete(key);
    const answer = reply || "I didn't catch that. Say it again.";
    await appendRealtimeLog({ kind: 'assistant', sessionToken: key, openclawSessionToken: openclawToken, turnId: effectiveTurnId, timings, text: answer });
    rememberRealtimeResult(key, { ok: true, reply: answer, turnId: effectiveTurnId, timings });
    return { ok: true, reply: answer, sessionToken: key, openclawSessionToken: openclawToken, turnId: effectiveTurnId, timings };
  } catch (err) {
    if (realtimeTurns.get(key)?.turnId === effectiveTurnId) realtimeTurns.delete(key);
    if (err.message === 'aborted') {
      await appendRealtimeLog({ kind: 'cancelled', sessionToken: key, turnId: effectiveTurnId });
      return { ok: false, cancelled: true, error: 'turn cancelled' };
    }
    console.error('[realtime-openclaw]', err.message);
    await appendRealtimeLog({ kind: 'error', sessionToken: key, turnId: effectiveTurnId, error: err.message });
    rememberRealtimeResult(key, { ok: false, error: 'OpenClaw turn failed', turnId: effectiveTurnId });
    return { ok: false, error: 'OpenClaw turn failed' };
  }
}

async function readRequestBody(req, limitBytes = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ── HTTP server (static files) ──────────────────────────────────────

const httpServer = createServer(async (req, res) => {
  try {
    let urlPath = new URL(req.url, `http://localhost:${PORT}`).pathname;

    if (urlPath === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, port: PORT, bindHost: BIND_HOST, basePath: BASE_PATH || '/', wakePhrase: WAKE_PHRASE, realtimeBridge: true, auth: bridgeAuthSummary(), tts: getTtsStatus() }));
      return;
    }

    if (isProtectedBridgePath(urlPath) && !requireBridgeAuth(req, res)) {
      return;
    }

    if (urlPath === '/config') {
      const tts = await getVoiceOptions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        product: 'VoiceClaw Bridge',
        auth: bridgeAuthSummary(),
        wsPath: `${BASE_PATH}/ws` || '/ws',
        realtimePath: `${BASE_PATH}/realtime/session` || '/realtime/session',
        processing: getProcessingOptions(),
        wakePhrase: WAKE_PHRASE,
        realtime: { model: REALTIME_MODEL, transcriptionModel: REALTIME_TRANSCRIPTION_MODEL, transcriptionDefault: REALTIME_TRANSCRIPTION_DEFAULT, transcriptionDelay: REALTIME_TRANSCRIPTION_DELAY, reasoningEffort: REALTIME_REASONING_EFFORT, reasoningOptions: ['low', 'medium', 'high'], voice: REALTIME_VOICE, bridge: true, sidebandEnabled: REALTIME_SIDEBAND_ENABLED, transcriptLog: REALTIME_TRANSCRIPT_LOG, turnDetectionDefault: REALTIME_TURN_DETECTION_MODE, turnDetectionOptions: ['semantic_vad', 'server_vad'], cloudAudioDefault: true, localPrivatePath: `${BASE_PATH}/index.html` || '/index.html', transcriptionOptions: ['off', REALTIME_TRANSCRIPTION_MODEL], conversationOptions: ['openclaw-gpt55', REALTIME_MODEL], routeModes: ['direct', 'openclaw'], auth: realtimeAuthPreferences(req), openclawTools: REALTIME_TOOLS.map(({ name, description }) => ({ name, description })) },
        tts,
      }));
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/prewarm`) {
      const body = await readRequestBody(req, 100_000).catch(() => '{}');
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      try {
        const key = sanitizeRealtimeSessionToken(payload.sessionToken);
        const openclawToken = realtimeOpenClawSessionToken(key);
        const result = await prewarmProcessing({ ...(payload.processing || {}), sessionToken: openclawToken, fastMode: 'on' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessionToken: key, openclawSessionToken: openclawToken, ...result }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }


    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/steer`) {
      const body = await readRequestBody(req, 200_000).catch(() => '{}');
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      const gate = actionability(payload.text || '', { allowWake: false, allowShortCommand: true, context: 'realtime-steer' });
      if (!gate.actionable) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, filtered: true, reason: gate.reason, error: 'unclear or non-actionable steering text' }));
        return;
      }
      const result = await steerRealtimeOpenClawTurn({ ...payload, text: gate.text });
      res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/openclaw-turn`) {
      const body = await readRequestBody(req, 200_000);
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      const gate = actionability(payload.text || '', { allowWake: false, allowShortCommand: true, context: 'realtime-http' });
      if (!gate.actionable) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, filtered: true, reason: gate.reason, error: 'unclear or non-actionable audio' }));
        return;
      }
      if (!incrementRealtimeQueue(payload.sessionToken)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, queued: realtimeQueueCount(payload.sessionToken), maxQueued: MAX_REALTIME_PENDING_TURNS, error: 'realtime OpenClaw queue is full' }));
        return;
      }
      let result;
      try {
        result = await runRealtimeOpenClawTurn({ ...payload, text: gate.text });
      } finally {
        decrementRealtimeQueue(payload.sessionToken);
      }
      res.writeHead(result.ok ? 200 : (result.cancelled ? 409 : 400), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...result, queue: { pending: realtimeQueueCount(payload.sessionToken), max: MAX_REALTIME_PENDING_TURNS } }));
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/cancel`) {
      const body = await readRequestBody(req, 50_000).catch(() => '{}');
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      rememberRealtimeCancel(payload.sessionToken, payload.turnId || '');
      if (payload.clearQueue) realtimePendingCounts.delete(sanitizeRealtimeSessionToken(payload.sessionToken));
      const cancelled = cancelRealtimeTurn(payload.sessionToken, payload.reason || 'client cancel', payload.turnId || '', { force: !!payload.force });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, cancelled }));
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/disconnect`) {
      const body = await readRequestBody(req, 50_000).catch(() => '{}');
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      const key = sanitizeRealtimeSessionToken(payload.sessionToken || '');
      const reason = payload.reason || 'client disconnect';
      const cancelActive = payload.cancelActive !== false;
      const closeSideband = payload.closeSideband !== false;
      const clearQueue = payload.clearQueue !== false;
      const cancelled = cancelActive ? cancelRealtimeTurn(key, reason, '', { force: true }) : false;
      if (cancelActive && clearQueue) realtimePendingCounts.delete(key);
      const sidebandClosed = closeSideband ? closeRealtimeSideband(key, reason, { clearSession: cancelActive, clearQueue: cancelActive && clearQueue }) : false;
      await appendRealtimeLog({ kind: 'realtime_session_disconnected', sessionToken: key, reason, cancelActive, closeSideband, clearQueue, cancelled, sidebandClosed, activePreserved: !cancelActive, transportState: payload.transportState || '', clientState: payload.clientState || '' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, cancelled, sidebandClosed, activePreserved: !cancelActive }));
      return;
    }


    if (req.method === 'GET' && urlPath === `${BASE_PATH}/realtime/status`) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const sessionToken = url.searchParams.get('sessionToken') || req.headers['x-voice-session-token'] || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...bridgeStatusSnapshot(sessionToken) }));
      return;
    }

    if (req.method === 'GET' && urlPath === `${BASE_PATH}/realtime/auth/status`) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const probe = ['1', 'true', 'yes'].includes(String(url.searchParams.get('probe') || '').toLowerCase());
      const model = String(url.searchParams.get('model') || REALTIME_MODEL).trim() || REALTIME_MODEL;
      const voice = String(url.searchParams.get('voice') || REALTIME_VOICE).trim() || REALTIME_VOICE;
      const status = await buildRealtimeAuthStatus({
        req,
        apiKey: openAIKeyForRealtimeRequest(req),
        probe,
        model,
        voice,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/session`) {
      const routeMode = realtimeRoutingMode(req);
      const apiKey = openAIKeyForRealtimeRequest(req);

      const sessionToken = req.headers['x-voice-session-token'] || `browser-${Date.now().toString(36)}`;
      const options = realtimeRequestOptions(req, routeMode, sessionToken);
      realtimeSessionConfigs.set(options.sessionToken, options);
      const sdpOffer = await readRequestBody(req);
      const fd = new FormData();
      fd.set('sdp', sdpOffer);
      const realtimeSession = {
        type: 'realtime',
        model: options.model,
        reasoning: { effort: options.realtimeReasoning },
        instructions: realtimeInstructionsForRoute(routeMode),
        audio: buildRealtimeAudioConfig(options),
      };
      if (routeMode !== 'direct') {
        realtimeSession.tools = realtimeToolsForRoute(routeMode);
        realtimeSession.tool_choice = 'auto';
      } else {
        realtimeSession.tool_choice = 'none';
      }
      fd.set('session', JSON.stringify(realtimeSession));

      let realtimeBearer;
      try {
        realtimeBearer = await resolveRealtimeBearer({
          req,
          session: realtimeSession,
          apiKey,
        });
      } catch (error) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error?.message || String(error), auth: realtimeAuthPreferences(req) }));
        return;
      }

      const usesClientSecretSignaling = realtimeBearer.source === REALTIME_AUTH_MODE_OPENCLAW_OAUTH;
      const upstream = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${realtimeBearer.bearer}`,
          ...(usesClientSecretSignaling ? { 'Content-Type': 'application/sdp' } : {}),
        },
        body: usesClientSecretSignaling ? sdpOffer : fd,
      });
      const body = await upstream.text();
      const location = upstream.headers.get('location') || upstream.headers.get('Location') || '';
      const sidebandStarted = hasServerOwnedRealtimeTools(routeMode) && upstream.ok && location ? await startRealtimeSideband(location, sessionToken, realtimeBearer.sidebandBearer || realtimeBearer.bearer) : false;
      if (upstream.ok) await appendRealtimeLog({ kind: 'realtime_session_created', sessionToken: sanitizeRealtimeSessionToken(sessionToken), routeMode, sidebandLocationHeader: !!location, sidebandStarted, authSource: realtimeBearer.source, authPreferenceSource: realtimeBearer.preferences.source, fallbackToAPIKey: realtimeBearer.preferences.fallbackToAPIKey, oauthFallbackError: realtimeBearer.oauthError || '', options: { model: options.model, voice: options.voice, noiseReduction: options.noiseReduction, captions: options.captions, turnDetection: options.turnDetection, realtimeReasoning: options.realtimeReasoning, transcriptionDelay: options.transcriptionDelay } });
      const headers = { 'Content-Type': upstream.ok ? 'application/sdp' : 'text/plain' };
      if (location) headers['X-OpenAI-Realtime-Location'] = 'present';
      headers['X-OpenClaw-Route'] = routeMode;
      if (sidebandStarted) headers['X-OpenClaw-Sideband'] = 'started';
      headers['X-VoiceClaw-Realtime-Auth'] = realtimeBearer.source;
      headers['X-VoiceClaw-Realtime-Auth-Preference'] = realtimeBearer.preferences.mode;
      headers['X-VoiceClaw-Realtime-Auth-Fallback'] = realtimeBearer.oauthError ? 'used' : (realtimeBearer.preferences.fallbackToAPIKey ? 'enabled' : 'disabled');
      headers['X-Realtime-Captions'] = options.captions ? 'on' : 'off';
      headers['X-Realtime-Turn-Detection'] = options.turnDetection;
      headers['X-Realtime-Reasoning'] = options.realtimeReasoning;
      res.writeHead(upstream.status, headers);
      res.end(body);
      return;
    }

    if (urlPath === `${BASE_PATH}/realtime` || urlPath === `${BASE_PATH}/realtime/`) {
      res.writeHead(302, { Location: `${BASE_PATH}/realtime.html` || '/realtime.html' });
      res.end();
      return;
    }

    if (BASE_PATH) {
      if (urlPath === '/') {
        res.writeHead(302, { Location: `${BASE_PATH}/` });
        res.end();
        return;
      }
      if (!(urlPath === BASE_PATH || urlPath.startsWith(`${BASE_PATH}/`))) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      urlPath = urlPath.slice(BASE_PATH.length) || '/';
    }

    if (urlPath === '/' || urlPath === '/index') urlPath = '/index.html';

    const filePath = join(CLIENT_DIR, urlPath);
    // Basic path traversal guard
    if (!filePath.startsWith(CLIENT_DIR)) {
      res.writeHead(403); res.end(); return;
    }

    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const ext = extname(filePath);
    const contentType = MIME[ext] || 'application/octet-stream';
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(body);
  } catch (err) {
    console.error('[http]', err.message);
    res.writeHead(500); res.end();
  }
});

// ── WebSocket server ────────────────────────────────────────────────

const WS_PATH = `${BASE_PATH}/ws` || '/ws';
const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });

wss.on('connection', (ws) => {
  console.log('[ws] client connected');

  // Per-session state
  const sessionId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session = {
    id: sessionId,
    audioChunks: [],          // collected binary audio buffers for real turns
    wakeProbeChunks: [],      // short hands-free wake probe buffers
    bargeProbeChunks: [],     // short probes while response generation/playback is active
    bargeMode: 'generation',
    collectingWakeProbe: false,
    collectingBargeProbe: false,
    wakeProbeMode: 'wake',
    wakeProbeProcessing: false,
    continuousTextBuffer: '',
    continuousLastSpeechAt: 0,
    ttsAbort: null,           // AbortController for current TTS job
    asrAbort: null,           // AbortController for current ASR job
    dialogueAbort: null,      // AbortController for current dialogue/LLM call
    processing: false,        // true while ASR+TTS pipeline is running
    turnSeq: 0,
    activeTurnId: 0,
    cancelledThroughTurnId: 0,
    processingConfig: resolveProcessingConfig({ sessionToken: `ws-${sessionId}` }),
    voiceConfig: null,
    pendingTextTurns: [],      // queued user turns captured while a prior turn is still running
    busyQueueSeq: 0,
    busyQueueEpoch: 0,
    busyAsrControllers: new Set(),
  };

  function send(obj) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  // Cancel any in-flight TTS, dialogue, and optionally ASR
  function cancelPipeline() {
    session.cancelledThroughTurnId = Math.max(session.cancelledThroughTurnId, session.activeTurnId || session.turnSeq || 0);
    if (session.ttsAbort) {
      session.ttsAbort.abort();
      session.ttsAbort = null;
    }
    if (session.dialogueAbort) {
      session.dialogueAbort.abort();
      session.dialogueAbort = null;
    }
    if (session.asrAbort) {
      session.asrAbort.abort();
      session.asrAbort = null;
    }
    if (session.busyAsrControllers?.size) {
      for (const controller of session.busyAsrControllers) controller.abort();
      session.busyAsrControllers.clear();
    }
    session.busyQueueEpoch = (session.busyQueueEpoch || 0) + 1;
    session.processing = false;
    session.pendingTextTurns = [];
  }

  ws.on('message', async (data, isBinary) => {
    // Binary frames = audio data from client mic. A preceding control message
    // decides whether this frame belongs to a real utterance or a wake probe.
    if (isBinary) {
      if (session.collectingBargeProbe) {
        session.bargeProbeChunks.push(Buffer.from(data));
      } else if (session.collectingWakeProbe) {
        session.wakeProbeChunks.push(Buffer.from(data));
      } else {
        session.audioChunks.push(Buffer.from(data));
      }
      return;
    }

    // Text frames = JSON control messages
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.type) {
      case 'start_session': {
        cancelPipeline();
        session.audioChunks = [];
        session.wakeProbeChunks = [];
        session.bargeProbeChunks = [];
        session.collectingWakeProbe = false;
        session.collectingBargeProbe = false;
        session.continuousTextBuffer = '';
        session.continuousLastSpeechAt = 0;
        session.turnSeq = 0;
        session.activeTurnId = 0;
        session.cancelledThroughTurnId = 0;
        session.busyQueueSeq = 0;
        session.pendingTextTurns = [];
        session.processingConfig = resolveProcessingConfig({ ...(msg.processing || {}), sessionToken: msg.sessionToken || session.processingConfig?.sessionToken || `ws-${session.id}` });
        session.voiceConfig = await resolveVoiceConfig(msg.voice);
        session.ttsSpeed = getTtsSpeedOptions().defaultSpeed;
        if (msg.ttsSpeed) session.ttsSpeed = msg.ttsSpeed;
        send({ type: 'processing', processing: session.processingConfig });
        send({
          type: 'voice',
          voice: {
            id: session.voiceConfig.id,
            label: session.voiceConfig.label,
            engine: session.voiceConfig.engine,
            fallbackUsed: session.voiceConfig.fallbackUsed,
            requested: session.voiceConfig.requested,
          }
        });
        send({ type: 'status', status: 'ready' });
        break;
      }

      case 'config_update': {
        session.processingConfig = resolveProcessingConfig({ ...(msg.processing || {}), sessionToken: msg.sessionToken || session.processingConfig?.sessionToken || `ws-${session.id}` });
        session.voiceConfig = await resolveVoiceConfig(msg.voice || session.voiceConfig?.id);
        if (msg.ttsSpeed) session.ttsSpeed = msg.ttsSpeed;
        send({ type: 'processing', processing: session.processingConfig });
        send({
          type: 'voice',
          voice: {
            id: session.voiceConfig.id,
            label: session.voiceConfig.label,
            engine: session.voiceConfig.engine,
            fallbackUsed: session.voiceConfig.fallbackUsed,
            requested: session.voiceConfig.requested,
          }
        });
        break;
      }

      case 'wake_probe_start':
        if (session.processing || session.wakeProbeProcessing) break;
        session.wakeProbeChunks = [];
        session.wakeProbeMode = msg.mode === 'continuous' ? 'continuous' : 'wake';
        session.collectingWakeProbe = true;
        break;

      case 'wake_probe_end':
        session.collectingWakeProbe = false;
        if (msg.mode === 'continuous') session.wakeProbeMode = 'continuous';
        if (session.wakeProbeChunks.length === 0 || session.processing || session.wakeProbeProcessing) break;
        processWakeProbe(session, ws, send).catch((err) => {
          console.error('[wake] probe failed:', err.message);
        });
        break;

      case 'barge_probe_start':
        session.bargeProbeChunks = [];
        session.bargeMode = msg.mode === 'playback' ? 'playback' : 'generation';
        session.collectingBargeProbe = true;
        break;

      case 'barge_probe_end':
        session.collectingBargeProbe = false;
        if (msg.mode === 'playback') session.bargeMode = 'playback';
        if (session.bargeProbeChunks.length === 0) break;
        processBargeProbe(session, ws, send, cancelPipeline).catch((err) => {
          console.error('[barge] probe failed:', err.message);
        });
        break;

      case 'audio_end':
        // Client finished recording an utterance — process it
        session.collectingWakeProbe = false;
        if (session.audioChunks.length === 0) {
          send({ type: 'error', message: 'No audio received' });
          break;
        }
        await processUtterance(session, ws, send);
        break;

      case 'client_event':
        console.log(`[client] event=${msg.event || 'unknown'} level=${msg.level ?? ''}`);
        break;

      case 'interrupt':
        // Barge-in: kill current TTS immediately
        console.log('[ws] interrupt received');
        cancelPipeline();
        send({ type: 'interrupted' });
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    console.log('[ws] client disconnected');
    cancelPipeline();
    clearHistory(sessionId);
  });

  ws.on('error', (err) => {
    console.error('[ws] error:', err.message);
    cancelPipeline();
  });
});

// ── Pipeline: audio → ASR → dialogue → TTS → stream back ───────────

function stripWakePrefixFromTurn(text = '') {
  const original = String(text || '').trim();
  if (!original) return original;

  // SpeechRecognition/Whisper often includes the wake word at the front of the
  // actual turn (for example: “Hey, what time is it?”). The wake word is UI
  // control, not useful user content, so strip only a leading wake prefix and
  // leave the rest of the utterance intact.
  return stripWakePrefixText(original) || original;
}

function stripWakePrefixText(text = '') {
  const original = String(text || '').trim();
  if (!original) return '';
  return original
    .replace(/^(?:hey|hay|heyy)(?:\s+(?:open\s*claw|open\s*cloud|opencloud|openclaw|open\s*claws|open\s*clause|open\s*claude))?[\s,;:\-–—.!?]*/i, '')
    .replace(/^(?:open\s*claw|open\s*cloud|opencloud|openclaw|open\s*claws|open\s*clause|open\s*claude)[\s,;:\-–—.!?]+/i, '')
    .trim();
}

function isWakeRemainderTurn(text = '') {
  const normalized = String(text || '').trim().toLowerCase().replace(/[^a-z0-9\s?!.]/g, ' ').replace(/\s+/g, ' ');
  if (!normalized || normalized === '[blank_audio]') return false;
  if (['hey', 'hay', 'heyy', 'openclaw', 'open claw', 'open cloud', 'open claude'].includes(normalized)) return false;
  return normalized.length >= 2;
}

function parseWakeTurn(text = '') {
  const original = String(text || '').trim();
  const matched = detectWakePhrase(original);
  if (!matched) return { matched: false, turnText: '', stripped: '' };
  const stripped = stripWakePrefixText(original);
  return { matched: true, turnText: isWakeRemainderTurn(stripped) ? stripped : '', stripped };
}

function beginTurn(session) {
  const turnId = ++session.turnSeq;
  session.activeTurnId = turnId;
  return turnId;
}

function isTurnStale(session, turnId) {
  return turnId <= (session.cancelledThroughTurnId || 0) || turnId !== session.activeTurnId;
}

async function processTranscribedUtterance(session, ws, send, text, turnStart = Date.now(), turnId = beginTurn(session), options = {}) {
  const cleanedText = stripWakePrefixFromTurn(text);
  if (!cleanedText || cleanedText.trim() === '' || cleanedText.trim() === '[BLANK_AUDIO]') {
    send({ type: 'transcript', text: '(no speech detected)', final: true });
    return;
  }
  const gate = actionability(cleanedText, { allowWake: false, allowShortCommand: true, context: options.queued ? 'queued' : 'turn' });
  if (!gate.actionable) {
    console.log(`[turn] filtered_non_actionable reason=${gate.reason} text=${JSON.stringify(cleanedText.slice(0, 80))}`);
    send({ type: 'transcript', text: gate.reason === 'noise-only' ? '(background noise ignored)' : '(unclear audio ignored)', rawText: text, final: true, filtered: true, reason: gate.reason, turnId });
    send({ type: 'status', status: 'ready' });
    return;
  }

  if (isTurnStale(session, turnId)) {
    console.log(`[turn] stale_before_transcript turn=${turnId} active=${session.activeTurnId} cancelledThrough=${session.cancelledThroughTurnId}`);
    return;
  }
  const routedText = gate.text || cleanedText;
  if (!options.suppressTranscript) send({ type: 'transcript', text: routedText, rawText: text, final: true, turnId, queued: !!options.queued });

  const dialogueController = new AbortController();
  session.dialogueAbort = dialogueController;

  send({ type: 'status', status: 'thinking' });
  const dialogueStart = Date.now();
  const reply = await generateReply(routedText, {
    sessionId: session.id,
    signal: dialogueController.signal,
    processing: session.processingConfig,
  });
  console.log(`[turn] dialogue_ms=${Date.now() - dialogueStart} turn=${turnId}`);
  session.dialogueAbort = null;

  if (isTurnStale(session, turnId)) {
    console.log(`[turn] stale_after_dialogue turn=${turnId} active=${session.activeTurnId} cancelledThrough=${session.cancelledThroughTurnId}`);
    return;
  }
  if (!reply) return;
  send({ type: 'reply', text: reply, turnId });

  const ttsController = new AbortController();
  session.ttsAbort = ttsController;

  if (isTurnStale(session, turnId)) {
    console.log(`[turn] stale_before_tts turn=${turnId} active=${session.activeTurnId} cancelledThrough=${session.cancelledThroughTurnId}`);
    return;
  }
  send({ type: 'tts_start', turnId });
  const ttsStart = Date.now();
  const wavBuf = await synthesize(reply, {
    signal: ttsController.signal,
    voice: session.voiceConfig?.id,
    speed: session.ttsSpeed,
  });
  console.log(`[turn] tts_ms=${Date.now() - ttsStart} audio_bytes=${wavBuf.length} turn=${turnId}`);
  session.ttsAbort = null;

  if (isTurnStale(session, turnId)) {
    console.log(`[turn] stale_after_tts turn=${turnId} active=${session.activeTurnId} cancelledThrough=${session.cancelledThroughTurnId}`);
    return;
  }
  if (ws.readyState === ws.OPEN) {
    ws.send(wavBuf);
  }
  send({ type: 'tts_end', turnId });
  console.log(`[turn] total_ms=${Date.now() - turnStart} turn=${turnId}`);
}

function pendingReadyCount(session) {
  return session.pendingTextTurns.filter((turn) => turn.ready && !turn.dropped).length;
}

async function queueBusyUtterance(session, ws, send, rawAudio) {
  if (!rawAudio?.length) return;
  const queuedAt = Date.now();
  const epoch = session.busyQueueEpoch || 0;
  const controller = new AbortController();
  const slot = {
    seq: ++session.busyQueueSeq,
    queuedAt,
    ready: false,
    dropped: false,
    text: '',
    rawText: '',
    epoch,
    controller,
  };
  if (session.pendingTextTurns.length >= MAX_CLASSIC_PENDING_TURNS) {
    send({ type: 'busy', message: `OpenClaw queue is full (${MAX_CLASSIC_PENDING_TURNS} waiting). Say stop or wait a moment.` });
    return;
  }
  session.pendingTextTurns.push(slot);
  session.busyAsrControllers.add(controller);

  try {
    send({ type: 'status', status: 'transcribing' });
    const { text } = await transcribe(rawAudio, { signal: controller.signal });
    session.busyAsrControllers.delete(controller);

    if (slot.epoch !== session.busyQueueEpoch || !session.pendingTextTurns.includes(slot)) return;

    const cleanedText = stripWakePrefixFromTurn(text);
    const gate = actionability(cleanedText, { allowWake: false, allowShortCommand: true, context: 'busy-queue' });
    if (!cleanedText || cleanedText.trim() === '' || cleanedText.trim() === '[BLANK_AUDIO]' || !gate.actionable) {
      slot.dropped = true;
      console.log(`[turn] dropped queued non-actionable reason=${gate.reason || 'blank'} text=${JSON.stringify((cleanedText || '').slice(0, 80))}`);
      setTimeout(() => drainPendingTextTurns(session, ws, send).catch((err) => console.error('[queue-drain]', err.message)), 0);
      return;
    }

    slot.text = gate.text || cleanedText;
    slot.rawText = text;
    slot.ready = true;
    send({ type: 'transcript', text: cleanedText, rawText: text, final: true, queued: true });
    send({ type: 'busy', message: `Queued while OpenClaw finishes the current turn (${pendingReadyCount(session)} waiting).` });
    send({ type: 'status', status: 'thinking' });
    console.log(`[turn] queued busy utterance seq=${slot.seq} ready=${pendingReadyCount(session)} text=${JSON.stringify(cleanedText.slice(0, 80))}`);
    if (!session.processing) {
      drainPendingTextTurns(session, ws, send).catch((err) => console.error('[queue-drain]', err.message));
    }
  } catch (err) {
    session.busyAsrControllers.delete(controller);
    if (slot.epoch === session.busyQueueEpoch && session.pendingTextTurns.includes(slot)) {
      slot.dropped = true;
      setTimeout(() => drainPendingTextTurns(session, ws, send).catch((drainErr) => console.error('[queue-drain]', drainErr.message)), 0);
    }
    if (err.message !== 'aborted') console.error('[queue-busy]', err.message);
  }
}

async function drainPendingTextTurns(session, ws, send) {
  while (session.pendingTextTurns[0]?.dropped) session.pendingTextTurns.shift();
  if (session.processing || !session.pendingTextTurns.length) return;
  const next = session.pendingTextTurns[0];
  if (!next.ready) return;
  session.pendingTextTurns.shift();
  const turnId = beginTurn(session);
  session.processing = true;
  try {
    send({ type: 'queued_turn_started', text: next.text, turnId, remaining: pendingReadyCount(session) });
    await processTranscribedUtterance(session, ws, send, next.text, next.queuedAt || Date.now(), turnId, { queued: true, suppressTranscript: true });
  } catch (err) {
    if (err.message !== 'aborted') console.error('[queue-drain]', err.message);
  } finally {
    if (session.activeTurnId === turnId) session.processing = false;
    session.dialogueAbort = null;
    session.ttsAbort = null;
    session.asrAbort = null;
  }
  while (session.pendingTextTurns[0]?.dropped) session.pendingTextTurns.shift();
  if (session.pendingTextTurns.length && !session.processing && session.pendingTextTurns[0].ready) {
    setTimeout(() => drainPendingTextTurns(session, ws, send).catch((err) => console.error('[queue-drain]', err.message)), 20);
  }
}

async function processUtterance(session, ws, send) {
  if (session.processing) {
    const busyAudio = Buffer.concat(session.audioChunks);
    session.audioChunks = [];
    queueBusyUtterance(session, ws, send, busyAudio).catch((err) => console.error('[queue-busy]', err.message));
    return;
  }
  session.processing = true;
  const turnId = beginTurn(session);
  const turnStart = Date.now();

  // Combine all audio chunks into a single WAV buffer
  const rawAudio = Buffer.concat(session.audioChunks);
  const energy = shouldSkipAudio(rawAudio, MIN_TURN_RMS);
  console.log(`[turn] start session=${session.id} turn=${turnId} bytes=${rawAudio.length} rms=${Math.round(energy.rms)} peak=${energy.peak}`);
  session.audioChunks = [];
  if (energy.skip) {
    console.log(`[turn] skipped low-energy audio turn=${turnId} rms=${Math.round(energy.rms)} threshold=${energy.threshold}`);
    send({ type: 'transcript', text: '(blank audio ignored)', final: true, filtered: true, reason: 'low-energy', turnId });
    send({ type: 'status', status: 'ready' });
    session.processing = false;
    return;
  }

  const asrController = new AbortController();
  session.asrAbort = asrController;

  try {
    // 1. ASR
    send({ type: 'status', status: 'transcribing' });
    const asrStart = Date.now();
    const { text } = await transcribe(rawAudio, { signal: asrController.signal });
    console.log(`[turn] asr_ms=${Date.now() - asrStart} turn=${turnId} text=${JSON.stringify((text || '').slice(0, 80))}`);
    session.asrAbort = null;

    if (isTurnStale(session, turnId)) {
      console.log(`[turn] stale_after_asr turn=${turnId} active=${session.activeTurnId} cancelledThrough=${session.cancelledThroughTurnId}`);
      return;
    }
    await processTranscribedUtterance(session, ws, send, text, turnStart, turnId);

  } catch (err) {
    if (err.message === 'aborted') {
      // Expected from interrupt — already handled
    } else {
      console.error('[pipeline]', err.message);
      send({ type: 'error', message: 'Processing failed' });
    }
  } finally {
    if (session.activeTurnId === turnId) session.processing = false;
    session.asrAbort = null;
    session.dialogueAbort = null;
    session.ttsAbort = null;
    if (!session.processing) {
      drainPendingTextTurns(session, ws, send).catch((err) => console.error('[queue-drain]', err.message));
    }
  }
}


function detectWakePhrase(text = '') {
  const normalized = text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const wakeWords = ['hey', 'hay', 'heyy'];
  const hasHey = wakeWords.some((word) => normalized === word
    || normalized.startsWith(`${word} `)
    || normalized.includes(` ${word} `));
  const openClawVariants = [
    'openclaw',
    'open claw',
    'open cloud',
    'open clouds',
    'open club',
    'open cloth',
    'open claud',
    'open claude',
    'open clause',
    'open the claw',
    'open the cloud',
    'open the ball',
    'open to all',
    'welcome claw',
    'welcome cloud',
  ];

  if (openClawVariants.some((phrase) => normalized.includes(phrase))) return true;
  return hasHey;
}


function isContinuousSpeechTurn(text = '') {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s?!.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized === '[blank_audio]') return false;
  const noiseOnly = new Set([
    'you', 'thank you', 'thanks', 'uh', 'um', 'hmm', 'keyboard', 'typing',
    'keyboard clacking', 'keyboard clicking', 'typing sounds'
  ]);
  if (noiseOnly.has(normalized)) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length >= 3) return true;
  if (words.length >= 2 && /[?!.]$/.test(text.trim())) return true;
  return false;
}


function absorbContinuousSpeech(session, text = '') {
  const trimmed = String(text || '').trim();
  const normalized = trimmed.toLowerCase().replace(/[^a-z0-9\s?!.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized === '[blank_audio]') return { matched: false, text: '', buffered: session.continuousTextBuffer || '' };
  const noiseOnly = new Set([
    'you', 'thank you', 'thanks', 'uh', 'um', 'hmm', 'keyboard', 'typing',
    'keyboard clacking', 'keyboard clicking', 'typing sounds'
  ]);
  if (noiseOnly.has(normalized)) return { matched: false, text: '', buffered: session.continuousTextBuffer || '' };

  const now = Date.now();
  const previous = (now - (session.continuousLastSpeechAt || 0)) < 2500 ? session.continuousTextBuffer : '';
  const combined = `${previous} ${trimmed}`.trim();
  session.continuousTextBuffer = combined;
  session.continuousLastSpeechAt = now;

  if (isContinuousSpeechTurn(combined)) {
    session.continuousTextBuffer = '';
    session.continuousLastSpeechAt = 0;
    return { matched: true, text: combined, buffered: combined };
  }
  return { matched: false, text: '', buffered: combined };
}


function parseBargeIn(text = '', mode = 'generation') {
  const original = String(text || '').trim();
  const normalized = original.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return { matched: false, remainder: '' };

  // During playback the speaker audio can leak back into the mic, so only
  // explicit human barge-in phrases are allowed. Broader phrases like “sorry”
  // or “stop” are reserved for generation, where there is no TTS echo.
  const playbackPhrases = [
    'hold on a second',
    'hold on a sec',
    'hold on',
    'hey wait',
    'wait'
  ];
  const generationPhrases = [
    ...playbackPhrases,
    'one second',
    'one sec',
    'sorry',
    'stop',
    'pause'
  ];
  const phrases = mode === 'playback' ? playbackPhrases : generationPhrases;

  for (const phrase of phrases) {
    const idx = normalized.indexOf(phrase);
    if (idx === -1) continue;
    const after = normalized.slice(idx + phrase.length).trim();
    return { matched: true, phrase, remainder: after };
  }
  return { matched: false, remainder: '' };
}

async function processBargeProbe(session, ws, send, cancelPipeline) {
  const rawAudio = Buffer.concat(session.bargeProbeChunks);
  session.bargeProbeChunks = [];
  if (!rawAudio.length) return;
  const energy = shouldSkipAudio(rawAudio, MIN_PROBE_RMS);
  if (energy.skip) {
    console.log(`[barge] skipped low-energy probe rms=${Math.round(energy.rms)} threshold=${energy.threshold}`);
    send({ type: 'barge_probe_result', matched: false, text: '', reason: 'low-energy' });
    return;
  }

  const controller = new AbortController();
  const started = Date.now();
  try {
    const { text } = await transcribe(rawAudio, { signal: controller.signal });
    const trimmed = String(text || '').trim();
    const parsed = parseBargeIn(trimmed, session.bargeMode);
    console.log(`[barge] mode=${session.bargeMode} probe_ms=${Date.now() - started} matched=${parsed.matched} phrase=${JSON.stringify(parsed.phrase || '')} remainder=${JSON.stringify(parsed.remainder || '')} text=${JSON.stringify(trimmed.slice(0, 120))}`);
    send({ type: 'barge_probe_result', matched: parsed.matched, text: trimmed, remainder: parsed.remainder || '' });
    if (parsed.matched) {
      cancelPipeline();
      send({ type: 'interrupted', reason: 'voice-barge-in', text: trimmed, remainder: parsed.remainder || '' });
      if (parsed.remainder) {
        setTimeout(async () => {
          if (session.processing) return;
          session.processing = true;
          try {
            const remainderTurnId = beginTurn(session);
            send({ type: 'barge_remainder_started', text: parsed.remainder, turnId: remainderTurnId });
            await processTranscribedUtterance(session, ws, send, parsed.remainder, started, remainderTurnId);
          } catch (err) {
            if (err.message !== 'aborted') console.error('[barge-remainder]', err.message);
          } finally {
            if (!session.activeTurnId || session.activeTurnId <= session.cancelledThroughTurnId) session.processing = false;
            session.dialogueAbort = null;
            session.ttsAbort = null;
            session.asrAbort = null;
          }
        }, 150);
      }
    }
  } catch (err) {
    if (err.message !== 'aborted') console.error('[barge]', err.message);
  }
}

async function processWakeProbe(session, ws, send) {
  if (session.wakeProbeProcessing) return;
  session.wakeProbeProcessing = true;
  const rawAudio = Buffer.concat(session.wakeProbeChunks);
  session.wakeProbeChunks = [];
  if (!rawAudio.length) {
    session.wakeProbeProcessing = false;
    return;
  }
  const energy = shouldSkipAudio(rawAudio, MIN_PROBE_RMS);
  if (energy.skip) {
    console.log(`[wake] skipped low-energy probe rms=${Math.round(energy.rms)} threshold=${energy.threshold}`);
    send({ type: 'wake_probe_result', matched: false, text: '', rawText: '', reason: 'low-energy', mode: session.wakeProbeMode });
    session.wakeProbeProcessing = false;
    return;
  }

  const controller = new AbortController();
  const started = Date.now();
  try {
    const { text } = await transcribe(rawAudio, { signal: controller.signal });
    const trimmed = String(text || '').trim();
    let matched;
    let turnText = trimmed;
    let buffered = '';
    let wakeRemainder = '';
    if (session.wakeProbeMode === 'continuous') {
      const absorbed = absorbContinuousSpeech(session, trimmed);
      matched = absorbed.matched;
      turnText = absorbed.text || trimmed;
      buffered = absorbed.buffered || '';
    } else {
      const parsedWake = parseWakeTurn(trimmed);
      matched = parsedWake.matched;
      wakeRemainder = parsedWake.turnText || '';
      turnText = wakeRemainder || trimmed;
    }
    console.log(`[wake] mode=${session.wakeProbeMode} probe_ms=${Date.now() - started} matched=${matched} text=${JSON.stringify(trimmed.slice(0, 80))} remainder=${JSON.stringify(wakeRemainder.slice(0, 120))} buffered=${JSON.stringify(buffered.slice(0, 120))}`);
    send({ type: 'wake_probe_result', matched, text: turnText, rawText: trimmed, remainder: wakeRemainder, buffered, mode: session.wakeProbeMode });
    if (matched && session.wakeProbeMode === 'wake' && wakeRemainder) {
      if (session.processing) {
        if (session.pendingTextTurns.length >= MAX_CLASSIC_PENDING_TURNS) {
          send({ type: 'busy', message: `OpenClaw queue is full (${MAX_CLASSIC_PENDING_TURNS} waiting). Say stop or wait a moment.` });
          return;
        }
        session.pendingTextTurns.push({ text: wakeRemainder, queuedAt: started, ready: true, dropped: false });
        send({ type: 'busy', message: `Queued wake turn while OpenClaw finishes the current turn (${pendingReadyCount(session)} waiting).` });
        return;
      }
      session.processing = true;
      const turnId = beginTurn(session);
      try {
        send({ type: 'wake_turn_started', text: wakeRemainder, rawText: trimmed, turnId });
        await processTranscribedUtterance(session, ws, send, wakeRemainder, started, turnId);
      } finally {
        if (session.activeTurnId === turnId) session.processing = false;
        session.dialogueAbort = null;
        session.ttsAbort = null;
        session.asrAbort = null;
        if (!session.processing) {
          drainPendingTextTurns(session, ws, send).catch((err) => console.error('[queue-drain]', err.message));
        }
      }
      return;
    }
    if (matched && session.wakeProbeMode === 'continuous') {
      if (session.processing) {
        if (session.pendingTextTurns.length >= MAX_CLASSIC_PENDING_TURNS) {
          send({ type: 'busy', message: `OpenClaw queue is full (${MAX_CLASSIC_PENDING_TURNS} waiting). Say stop or wait a moment.` });
          return;
        }
        session.pendingTextTurns.push({ text: turnText, queuedAt: started, ready: true, dropped: false });
        send({ type: 'busy', message: `Queued while OpenClaw finishes the current turn (${pendingReadyCount(session)} waiting).` });
        return;
      }
      session.processing = true;
      const turnId = beginTurn(session);
      try {
        send({ type: 'continuous_turn_started', text: turnText, turnId });
        await processTranscribedUtterance(session, ws, send, turnText, started, turnId);
      } finally {
        if (session.activeTurnId === turnId) session.processing = false;
        session.dialogueAbort = null;
        session.ttsAbort = null;
        session.asrAbort = null;
        if (!session.processing) {
          drainPendingTextTurns(session, ws, send).catch((err) => console.error('[queue-drain]', err.message));
        }
      }
      return;
    }
    if (matched) send({ type: 'wake_detected', text: trimmed, mode: session.wakeProbeMode });
  } catch (err) {
    if (err.message !== 'aborted') console.error('[wake]', err.message);
  } finally {
    session.wakeProbeProcessing = false;
  }
}

// ── Start ───────────────────────────────────────────────────────────

httpServer.listen(PORT, BIND_HOST, () => {
  console.log(`[voice-bridge] listening on http://${BIND_HOST}:${PORT}${BASE_PATH || '/'}`);
  console.log(`[voice-bridge] client dir: ${CLIENT_DIR}`);
  console.log(`[voice-bridge] WebSocket endpoint: ws://localhost:${PORT}${WS_PATH}`);
  console.log(`[voice-bridge] health endpoint: http://localhost:${PORT}/healthz`);
  console.log(`[voice-bridge] wake phrase: ${JSON.stringify(WAKE_PHRASE)}`);
});
