import { spawn, execFile as execFileCb } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { access, appendFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { executablePath, normalizeProcessPath } from './bin-paths.js';

const execFile = promisify(execFileCb);
normalizeProcessPath();

const HF_ROOT = process.env.VOICECLAW_HF_ROOT || join(os.homedir(), '.voiceclaw', 'hf-runtime');
const HF_VENV = process.env.VOICECLAW_HF_VENV || HF_ROOT;
const HF_PYTHON = process.env.VOICECLAW_HF_PYTHON || join(HF_VENV, 'bin', 'python');
const HF_CLI = process.env.VOICECLAW_HF_CLI || join(HF_VENV, 'bin', 'speech-to-speech');
const HF_LOG_DIR = process.env.VOICECLAW_HF_LOG_DIR || join(os.homedir(), 'Library', 'Application Support', 'VoiceClaw Companion', 'logs');
const HF_STDOUT_LOG = join(HF_LOG_DIR, 'hf-speech-to-speech.out.log');
const HF_STDERR_LOG = join(HF_LOG_DIR, 'hf-speech-to-speech.err.log');
const HF_HOST = process.env.VOICECLAW_HF_HOST || '127.0.0.1';
const HF_PORT = Number.parseInt(process.env.VOICECLAW_HF_PORT || '18765', 10);
const HF_WS_URL = `ws://${HF_HOST}:${HF_PORT}/v1/realtime`;
const HF_HTTP_BASE = `http://${HF_HOST}:${HF_PORT}`;
const HF_PACKAGE_SPEC = process.env.VOICECLAW_HF_PACKAGE_SPEC || 'speech-to-speech';
const HF_INSTALL_TIMEOUT_MS = Number.parseInt(process.env.VOICECLAW_HF_INSTALL_TIMEOUT_MS || String(90 * 60 * 1000), 10);
const HF_START_TIMEOUT_MS = Number.parseInt(process.env.VOICECLAW_HF_START_TIMEOUT_MS || String(15 * 60 * 1000), 10);
const HF_DEFAULT_LOCAL_MODEL = process.env.VOICECLAW_HF_LOCAL_MODEL || 'mlx-community/Qwen3.5-2B-4bit';
const HF_DEFAULT_CEREBRAS_MODEL = process.env.VOICECLAW_HF_CEREBRAS_MODEL || 'gemma-4-31b';
const HF_DEFAULT_TTS = process.env.VOICECLAW_HF_TTS || 'qwen3';
const HF_DEFAULT_STT_PROFILE = process.env.VOICECLAW_HF_STT_PROFILE || 'parakeet-live';
const HF_DEFAULT_STT = process.env.VOICECLAW_HF_STT || '';
const HF_DEFAULT_STT_MODEL = process.env.VOICECLAW_HF_STT_MODEL || 'mlx-community/parakeet-tdt-0.6b-v3';
const HF_FASTER_WHISPER_MODEL = process.env.VOICECLAW_HF_FASTER_WHISPER_MODEL || 'base.en';
const HF_MLX_AUDIO_WHISPER_MODEL = process.env.VOICECLAW_HF_MLX_AUDIO_WHISPER_MODEL || 'mlx-community/whisper-base';
const HF_WHISPER_MLX_MODEL = process.env.VOICECLAW_HF_WHISPER_MLX_MODEL || 'base.en';
const HF_DEFAULT_TTS_MODEL = process.env.VOICECLAW_HF_TTS_MODEL || 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit';
const CEREBRAS_BASE_URL = (process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1').replace(/\/+$/g, '');
const CEREBRAS_RESPONSES_ADAPTER_HOST = process.env.VOICECLAW_CEREBRAS_RESPONSES_ADAPTER_HOST || '127.0.0.1';
const CEREBRAS_RESPONSES_ADAPTER_PORT = Number.parseInt(process.env.VOICECLAW_CEREBRAS_RESPONSES_ADAPTER_PORT || '18764', 10);
const VOICECLAW_CONFIG = process.env.VOICECLAW_CONFIG_PATH
  || process.env.VOICECLAW_CONFIG
  || join(os.homedir(), '.voiceclaw', 'bridge.json');
// The HF OpenAI-compatible realtime schema currently accepts PCM only at 24 kHz.
const DEFAULT_HF_SAMPLE_RATE = 24_000;
const RESPONSE_CREATE_FALLBACK_MS = Number.parseInt(process.env.VOICECLAW_HF_RESPONSE_CREATE_FALLBACK_MS || '3500', 10);

const HF_STT_PROFILE_OPTIONS = [
  {
    id: 'parakeet-live',
    label: 'Parakeet Live',
    detail: 'Recommended. Uses HF speech-to-speech Parakeet TDT with live partial transcription and stronger realtime turn text.',
  },
  {
    id: 'mlx-whisper-accurate',
    label: 'Whisper MLX Accurate',
    detail: 'Uses MLX Audio Whisper large-v3-turbo on Apple Silicon for higher accuracy, with more latency.',
  },
  {
    id: 'faster-whisper-balanced',
    label: 'Faster Whisper Balanced',
    detail: 'Uses faster-whisper small.en with a modest beam for better accuracy than the fast profile.',
  },
  {
    id: 'faster-whisper-fast',
    label: 'Faster Whisper Fast',
    detail: 'Uses faster-whisper base.en/int8/beam 1 for lower latency and lower accuracy.',
  },
];

let sidecar = null;
let sidecarKey = '';
let sidecarStarting = null;
let installInFlight = null;
let cerebrasResponsesAdapter = null;
let cerebrasResponsesAdapterKey = '';
let cerebrasResponsesAdapterBaseURL = '';

async function fileExecutable(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command, args, { timeoutMs = 10 * 60 * 1000, env = {} } = {}) {
  return await new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    proc.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000) || stdout.slice(-2000)}`));
    });
  });
}

async function pythonCanImport(moduleName) {
  if (!existsSync(HF_PYTHON)) return false;
  try {
    await execFile(HF_PYTHON, ['-c', `import ${moduleName}`], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

async function pythonPackageVersion(moduleName) {
  if (!existsSync(HF_PYTHON)) return '';
  try {
    const { stdout } = await execFile(HF_PYTHON, ['-c', [
      'import importlib.metadata as md, sys',
      'names = sys.argv[1:]',
      'for n in names:',
      '    try:',
      '        print(md.version(n)); break',
      '    except md.PackageNotFoundError:',
      '        pass',
    ].join('\n'), moduleName], { timeout: 30_000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

function hfRuntimeEnv(extra = {}) {
  const env = {
    ...process.env,
    ...extra,
    PYTHONUNBUFFERED: '1',
    HF_XET_HIGH_PERFORMANCE: process.env.HF_XET_HIGH_PERFORMANCE || '1',
  };
  const disableXet = process.env.VOICECLAW_HF_DISABLE_XET || process.env.HF_HUB_DISABLE_XET;
  if (disableXet !== undefined && disableXet !== null && String(disableXet) !== '') {
    env.HF_HUB_DISABLE_XET = String(disableXet);
  }
  return env;
}

function hfRuntimeLaunchEnv(extra = {}) {
  const env = hfRuntimeEnv(extra);
  if (!/^(1|true|yes)$/i.test(String(process.env.VOICECLAW_HF_RUNTIME_ONLINE || ''))) {
    env.HF_HUB_OFFLINE = env.HF_HUB_OFFLINE || '1';
  }
  return env;
}

async function hfModelCached(modelID, allowPatterns = null) {
  if (!existsSync(HF_PYTHON)) return false;
  try {
    await runCommand(HF_PYTHON, ['-c', [
      'from huggingface_hub import snapshot_download',
      'import json, sys',
      'patterns = json.loads(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else None',
      'snapshot_download(sys.argv[1], local_files_only=True, allow_patterns=patterns)',
    ].join('; '), modelID, allowPatterns ? JSON.stringify(allowPatterns) : ''], {
      timeoutMs: 30_000,
      env: hfRuntimeEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

function requiredSTTPythonModules(sttProfile = '') {
  const { backend } = sttProfileConfig(sttProfile);
  switch (backend) {
    case 'faster-whisper':
      return [{ module: 'faster_whisper', package: 'faster-whisper', label: 'Faster Whisper speech-to-text runtime' }];
    case 'whisper-mlx':
      return [{ module: 'lightning_whisper_mlx', package: 'lightning-whisper-mlx', label: 'Lightning Whisper MLX speech-to-text runtime' }];
    case 'whisper':
      return [{ module: 'whisper', package: 'openai-whisper', label: 'Whisper speech-to-text runtime' }];
    case 'mlx-audio-whisper':
      return [{ module: 'mlx_audio', package: 'mlx-audio', label: 'MLX Audio Whisper speech-to-text runtime' }];
    case 'parakeet-tdt':
    default:
      return [];
  }
}

function requiredSTTModels(sttProfile = '') {
  const settings = sttProfileConfig(sttProfile);
  switch (settings.backend) {
    case 'faster-whisper':
      return [{
        id: 'stt-faster-whisper',
        label: `Faster Whisper ${settings.model}`,
        model: `Systran/faster-whisper-${settings.model}`,
        allowPatterns: ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt', 'preprocessor_config.json'],
      }];
    case 'mlx-audio-whisper':
      return [{ id: 'stt-mlx-audio-whisper', label: `MLX Audio Whisper ${settings.model}`, model: settings.model }];
    case 'parakeet-tdt':
      return [{ id: 'stt-parakeet-tdt', label: 'Parakeet TDT live speech-to-text', model: settings.model }];
    default:
      return [];
  }
}

function normalizeBrainMode(value = '') {
  const clean = String(value || '').trim();
  if (!clean || clean === 'local' || clean === 'qwen' || clean === 'qwen35' || clean === 'qwen3.5') return 'qwen3.5-2b';
  if (clean === 'cerebras') return `cerebras:${HF_DEFAULT_CEREBRAS_MODEL}`;
  return clean;
}

function localMiddleBrainRequired(brainMode = '') {
  const normalized = normalizeBrainMode(brainMode);
  return normalized === 'qwen3.5-2b';
}

function cerebrasMiddleBrainRequired(brainMode = '') {
  return normalizeBrainMode(brainMode).startsWith('cerebras:');
}

function normalizeSTTProfile(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'fast' || raw === 'faster-whisper' || raw === 'faster-whisper-fast' || raw === 'base' || raw === 'base.en') {
    return 'faster-whisper-fast';
  }
  if (raw === 'balanced' || raw === 'faster-whisper-balanced' || raw === 'small' || raw === 'small.en') {
    return 'faster-whisper-balanced';
  }
  if (raw === 'accurate' || raw === 'whisper-mlx' || raw === 'mlx-whisper' || raw === 'mlx-audio-whisper' || raw === 'mlx-whisper-accurate') {
    return 'mlx-whisper-accurate';
  }
  if (raw === 'parakeet' || raw === 'parakeet-tdt' || raw === 'parakeet-live' || raw === 'live') {
    return 'parakeet-live';
  }
  if (HF_DEFAULT_STT === 'faster-whisper') return 'faster-whisper-fast';
  if (HF_DEFAULT_STT === 'mlx-audio-whisper' || HF_DEFAULT_STT === 'whisper-mlx') return 'mlx-whisper-accurate';
  if (HF_DEFAULT_STT === 'parakeet-tdt') return 'parakeet-live';
  if (raw && raw !== String(HF_DEFAULT_STT_PROFILE || '').trim().toLowerCase()) {
    return normalizeSTTProfile(HF_DEFAULT_STT_PROFILE || 'parakeet-live');
  }
  return 'parakeet-live';
}

function sttProfileConfig(value = '') {
  const profile = normalizeSTTProfile(value);
  if (profile === 'faster-whisper-fast') {
    return {
      id: profile,
      backend: 'faster-whisper',
      model: HF_FASTER_WHISPER_MODEL || 'base.en',
      computeType: process.env.VOICECLAW_HF_FASTER_WHISPER_COMPUTE_TYPE || 'int8',
      beamSize: process.env.VOICECLAW_HF_FASTER_WHISPER_BEAM_SIZE || '1',
      liveTranscription: false,
    };
  }
  if (profile === 'faster-whisper-balanced') {
    return {
      id: profile,
      backend: 'faster-whisper',
      model: process.env.VOICECLAW_HF_FASTER_WHISPER_BALANCED_MODEL || 'small.en',
      computeType: process.env.VOICECLAW_HF_FASTER_WHISPER_BALANCED_COMPUTE_TYPE || 'int8',
      beamSize: process.env.VOICECLAW_HF_FASTER_WHISPER_BALANCED_BEAM_SIZE || '3',
      liveTranscription: false,
    };
  }
  if (profile === 'mlx-whisper-accurate') {
    return {
      id: profile,
      backend: 'mlx-audio-whisper',
      model: process.env.VOICECLAW_HF_MLX_AUDIO_WHISPER_ACCURATE_MODEL || 'mlx-community/whisper-large-v3-turbo',
      liveTranscription: false,
    };
  }
  return {
    id: 'parakeet-live',
    backend: 'parakeet-tdt',
    model: HF_DEFAULT_STT_MODEL,
    device: process.env.VOICECLAW_HF_PARAKEET_DEVICE || 'mps',
    computeType: process.env.VOICECLAW_HF_PARAKEET_COMPUTE_TYPE || 'float16',
    liveTranscription: true,
  };
}

async function prefetchHFModel(modelID, allowPatterns = null) {
  await runCommand(HF_PYTHON, ['-c', [
    'from huggingface_hub import snapshot_download',
    'import json, sys',
    'patterns = json.loads(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else None',
    'path = snapshot_download(sys.argv[1], resume_download=True, allow_patterns=patterns)',
    'print(path)',
  ].join('; '), modelID, allowPatterns ? JSON.stringify(allowPatterns) : ''], {
    timeoutMs: HF_INSTALL_TIMEOUT_MS,
    env: hfRuntimeEnv(),
  });
}

async function fetchJSON(url, { timeoutMs = 2500 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function hfPoolHealth() {
  try {
    const pool = await fetchJSON(`${HF_HTTP_BASE}/v1/pool`, { timeoutMs: 2500 });
    return { reachable: true, pool };
  } catch (error) {
    return { reachable: false, error: error?.message || String(error) };
  }
}

export async function getHFRealtimeStatus(options = {}) {
  const brainMode = normalizeBrainMode(options.brainMode || process.env.VOICECLAW_HF_BRAIN_MODE || 'qwen3.5-2b');
  const sttProfile = normalizeSTTProfile(options.sttProfile || process.env.VOICECLAW_HF_STT_PROFILE || '');
  const sttConfig = sttProfileConfig(sttProfile);
  const requireLocalMiddleBrain = localMiddleBrainRequired(brainMode);
  const requireCerebrasKey = cerebrasMiddleBrainRequired(brainMode);
  const pythonReady = await fileExecutable(HF_PYTHON);
  const cliReady = await fileExecutable(HF_CLI);
  const packageReady = await pythonCanImport('speech_to_speech');
  const mlxReady = await pythonCanImport('mlx');
  const mlxAudioReady = await pythonCanImport('mlx_audio');
  const sttModuleStatuses = [];
  for (const item of requiredSTTPythonModules(sttProfile)) {
    sttModuleStatuses.push({
      ...item,
      ready: await pythonCanImport(item.module),
      version: await pythonPackageVersion(item.package),
      required: true,
    });
  }
  const sttRequiredModels = [];
  for (const model of requiredSTTModels(sttProfile)) {
    sttRequiredModels.push({
      ...model,
      cached: pythonReady ? await hfModelCached(model.model, model.allowPatterns || null) : false,
      required: true,
    });
  }
  const ttsModelCached = pythonReady ? await hfModelCached(HF_DEFAULT_TTS_MODEL) : false;
  const localModelCached = pythonReady ? await hfModelCached(HF_DEFAULT_LOCAL_MODEL) : false;
  const health = await hfPoolHealth();
  const runtimeReady = pythonReady && cliReady && packageReady;
  const requiredModels = [
    ...sttRequiredModels,
    { id: 'tts-qwen3', label: 'Qwen3 local text-to-speech', model: HF_DEFAULT_TTS_MODEL, cached: ttsModelCached, required: HF_DEFAULT_TTS === 'qwen3' },
    { id: 'middle-qwen35-2b-local', label: 'Qwen 3.5 2B local Companion Realtime Voice LLM', model: HF_DEFAULT_LOCAL_MODEL, cached: localModelCached, required: requireLocalMiddleBrain },
  ];
  const cerebrasKeyReady = !requireCerebrasKey || !!cerebrasKeyFromPayload(options);
  const missingSTTModules = sttModuleStatuses.filter((item) => item.required && !item.ready);
  const missingRequiredModels = requiredModels.filter((model) => model.required && !model.cached);
  const ready = runtimeReady && missingSTTModules.length === 0 && missingRequiredModels.length === 0 && cerebrasKeyReady;
  const installItems = ready ? [] : [
    ...(!runtimeReady ? [{
      id: 'hf-speech-to-speech-runtime',
      label: 'HF speech-to-speech runtime',
      detail: 'Installs the OpenAI Realtime-compatible Hugging Face VAD -> STT -> LLM -> TTS pipeline into a user-local Python environment.',
      installable: true,
      command: `python3 -m venv ${HF_ROOT} && ${HF_PYTHON} -m pip install ${HF_PACKAGE_SPEC}`,
    }] : []),
    ...missingSTTModules.map((item) => ({
      id: item.module,
      label: item.label,
      detail: `Installs ${item.package}, required by the selected ${sttProfile} STT profile.`,
      installable: true,
      command: `${HF_PYTHON} -m pip install ${item.package}`,
    })),
    ...missingRequiredModels.map((model) => ({
      id: model.id,
      label: model.label,
      detail: `Downloads ${model.model} into the local Hugging Face cache so first voice use does not stall.`,
      installable: true,
      command: `${HF_PYTHON} -c "from huggingface_hub import snapshot_download; snapshot_download('${model.model}')"`,
    })),
    ...(!cerebrasKeyReady ? [{
      id: 'cerebras-api-key',
      label: 'Cerebras API key',
      detail: 'Add a Cerebras API key in VoiceClaw Companion or sync it from VoiceClaw Realtime before using the Cerebras Companion Realtime Voice LLM.',
      installable: false,
      command: 'manual setup required',
    }] : []),
  ];
  return {
    state: ready ? 'ready' : 'needs_setup',
    summary: ready
      ? `HF speech-to-speech runtime is ready for ${HF_STT_PROFILE_OPTIONS.find((item) => item.id === sttProfile)?.label || sttProfile} at ${HF_ROOT}.`
      : `HF speech-to-speech runtime or selected STT profile needs setup for ${HF_STT_PROFILE_OPTIONS.find((item) => item.id === sttProfile)?.label || sttProfile} at ${HF_ROOT}.`,
    root: HF_ROOT,
    python: pythonReady ? HF_PYTHON : '',
    cli: cliReady ? HF_CLI : '',
    packageReady,
    mlxReady,
    mlxAudioReady,
    runtimeReady,
    brainMode,
    requireLocalMiddleBrain,
    requireCerebrasKey,
    cerebrasKeyReady,
    sttProfile,
    sttProfileLabel: HF_STT_PROFILE_OPTIONS.find((item) => item.id === sttProfile)?.label || sttProfile,
    sttProfiles: HF_STT_PROFILE_OPTIONS,
    sttBackend: sttConfig.backend,
    liveTranscriptionEnabled: !!sttConfig.liveTranscription,
    sttModules: sttModuleStatuses,
    requiredModels,
    missingSTTModules,
    missingRequiredModels,
    host: HF_HOST,
    port: HF_PORT,
    wsURL: HF_WS_URL,
    sidecarRunning: !!sidecar && !sidecar.killed,
    sidecarKey,
    health,
    installPlan: {
      needed: !ready,
      installable: true,
      summary: ready
        ? 'No HF speech-to-speech runtime install is needed.'
        : `Install Python venv, ${HF_PACKAGE_SPEC}, selected STT dependencies, and required local STT/TTS model weights.`,
      installableCount: installItems.filter((item) => item.installable).length,
      items: installItems,
    },
  };
}

export async function installHFRealtimeRuntime(options = {}) {
  if (installInFlight) return await installInFlight;
  installInFlight = (async () => {
    await mkdir(HF_ROOT, { recursive: true });
    const python3 = executablePath(process.env.PYTHON_BIN || 'python3');
    if (!existsSync(HF_PYTHON)) {
      await mkdir(HF_VENV, { recursive: true });
      await runCommand(python3, ['-m', 'venv', HF_VENV], { timeoutMs: 10 * 60 * 1000 });
    }
    await runCommand(HF_PYTHON, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'], {
      timeoutMs: 15 * 60 * 1000,
    });
    await runCommand(HF_PYTHON, ['-m', 'pip', 'install', '--upgrade', HF_PACKAGE_SPEC], {
      timeoutMs: HF_INSTALL_TIMEOUT_MS,
    });
    const sttProfile = normalizeSTTProfile(options.sttProfile || process.env.VOICECLAW_HF_STT_PROFILE || '');
    for (const item of requiredSTTPythonModules(sttProfile)) {
      await runCommand(HF_PYTHON, ['-m', 'pip', 'install', '--upgrade', item.package], {
        timeoutMs: HF_INSTALL_TIMEOUT_MS,
      });
    }
    for (const model of requiredSTTModels(sttProfile)) {
      await prefetchHFModel(model.model, model.allowPatterns || null);
    }
    if (HF_DEFAULT_TTS === 'qwen3') await prefetchHFModel(HF_DEFAULT_TTS_MODEL);
    if (localMiddleBrainRequired(options.brainMode || process.env.VOICECLAW_HF_BRAIN_MODE || 'qwen3.5-2b')) {
      await prefetchHFModel(HF_DEFAULT_LOCAL_MODEL);
    }
    return await getHFRealtimeStatus(options);
  })();
  try {
    return await installInFlight;
  } finally {
    installInFlight = null;
  }
}

function cerebrasKeyFromPayload(payload = {}) {
  const forwarded = String(payload.cerebrasAPIKey || payload.cerebrasApiKey || '').trim();
  if (forwarded) return forwarded;
  try {
    const configured = String(JSON.parse(readFileSync(VOICECLAW_CONFIG, 'utf8')).cerebrasAPIKey || '').trim();
    if (configured) return configured;
  } catch {}
  return String(process.env.CEREBRAS_API_KEY || '').trim();
}

function normalizeCerebrasModel(model = '') {
  const clean = String(model || '').trim();
  if (!clean) return HF_DEFAULT_CEREBRAS_MODEL;
  if (clean === 'gemma-4-31B-it' || clean === 'google/gemma-4-31B-it:cerebras') return 'gemma-4-31b';
  return clean;
}

async function readJSONBody(req, limitBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const next = Buffer.from(chunk);
    total += next.length;
    if (total > limitBytes) throw new Error(`Request body exceeds ${limitBytes} bytes`);
    chunks.push(next);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function responseContentToText(content = '') {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (part.type === 'input_image' && typeof part.image_url === 'string') return `[image: ${part.image_url}]`;
    if (part.type === 'image_url' && part.image_url?.url) return `[image: ${part.image_url.url}]`;
    return '';
  }).filter(Boolean).join('\n');
}

function responsesInputToChatMessages(input = []) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [{ role: 'user', content: String(input || '') }];
  const messages = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id || item.id || `call_${messages.length}`,
          type: 'function',
          function: {
            name: item.name || 'unknown_tool',
            arguments: item.arguments || '{}',
          },
        }],
      });
      continue;
    }
    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id || '',
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output || {}),
      });
      continue;
    }
    const role = ['system', 'developer', 'user', 'assistant', 'tool'].includes(item.role) ? item.role : 'user';
    const content = responseContentToText(item.content);
    if (!content && role !== 'assistant') continue;
    messages.push({
      role: role === 'developer' ? 'system' : role,
      content: role === 'assistant' && !content ? null : content,
    });
  }
  return messages.length ? messages : [{ role: 'user', content: '' }];
}

function responsesToolsToChatTools(tools = []) {
  if (!Array.isArray(tools)) return undefined;
  const converted = tools
    .filter((tool) => tool && typeof tool === 'object' && (tool.type === 'function' || tool.function))
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name || tool.function?.name || 'unknown_tool',
        description: tool.description || tool.function?.description || '',
        parameters: tool.parameters || tool.function?.parameters || { type: 'object', properties: {} },
      },
    }))
    .filter((tool) => tool.function.name);
  return converted.length ? converted : undefined;
}

function responsesToolChoiceToChatToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (['auto', 'none', 'required'].includes(toolChoice)) return toolChoice;
  if (toolChoice.type === 'function' && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  if (toolChoice.function?.name) {
    return { type: 'function', function: { name: toolChoice.function.name } };
  }
  return undefined;
}

function responsesUsageFromChat(usage = {}) {
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const total = Number(usage.total_tokens ?? input + output) || input + output;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: total,
  };
}

function responseOutputTextItem(responseID, text) {
  return {
    id: `msg_${responseID}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{
      type: 'output_text',
      text: text || '',
      annotations: [],
      logprobs: null,
    }],
  };
}

function responseEnvelope({ responseID, model, output = [], usage = {}, tools = [], toolChoice = 'auto' }) {
  const now = Date.now() / 1000;
  return {
    id: responseID,
    object: 'response',
    created_at: now,
    completed_at: now,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model,
    output,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: toolChoice || 'auto',
    tools: Array.isArray(tools) ? tools : [],
    top_p: null,
    usage: responsesUsageFromChat(usage),
  };
}

function writeSSE(res, event) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function chatCompletionPayloadFromResponses(body = {}, { stream = false } = {}) {
  const tools = responsesToolsToChatTools(body.tools);
  const toolChoice = responsesToolChoiceToChatToolChoice(body.tool_choice);
  const payload = {
    model: body.model || HF_DEFAULT_CEREBRAS_MODEL,
    messages: responsesInputToChatMessages(body.input),
    stream,
  };
  if (tools) payload.tools = tools;
  if (toolChoice) payload.tool_choice = toolChoice;
  if (Number.isFinite(Number(body.temperature))) payload.temperature = Number(body.temperature);
  if (Number.isFinite(Number(body.top_p))) payload.top_p = Number(body.top_p);
  const maxTokens = Number(body.max_output_tokens ?? body.max_tokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) payload.max_tokens = Math.round(maxTokens);
  return payload;
}

async function cerebrasChatCompletion({ body = {}, apiKey = '', stream = false } = {}) {
  const response = await fetch(`${CEREBRAS_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': stream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify(chatCompletionPayloadFromResponses(body, { stream })),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Cerebras Chat Completions returned HTTP ${response.status}: ${errorText.slice(0, 1000)}`);
  }
  return response;
}

async function handleCerebrasResponsesRequest(req, res) {
  try {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/responses')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not found' } }));
      return;
    }
    if (!cerebrasResponsesAdapterKey) throw new Error('Cerebras adapter has no API key configured.');
    const body = await readJSONBody(req);
    const model = body.model || HF_DEFAULT_CEREBRAS_MODEL;
    const responseID = `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const stream = body.stream !== false;

    if (!stream) {
      const upstream = await cerebrasChatCompletion({ body, apiKey: cerebrasResponsesAdapterKey, stream: false });
      const json = await upstream.json();
      const choice = json.choices?.[0] || {};
      const message = choice.message || {};
      const text = message.content || '';
      const output = [];
      if (text) output.push(responseOutputTextItem(responseID, text));
      for (const call of message.tool_calls || []) {
        output.push({
          id: `fc_${call.id || Math.random().toString(36).slice(2, 8)}`,
          type: 'function_call',
          call_id: call.id || `call_${output.length}`,
          name: call.function?.name || '',
          arguments: call.function?.arguments || '{}',
          status: 'completed',
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseEnvelope({
        responseID,
        model,
        output,
        usage: json.usage || {},
        tools: body.tools || [],
        toolChoice: body.tool_choice || 'auto',
      })));
      return;
    }

    const upstream = await cerebrasChatCompletion({ body, apiKey: cerebrasResponsesAdapterKey, stream: true });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const decoder = new TextDecoder();
    const reader = upstream.body?.getReader();
    if (!reader) throw new Error('Cerebras stream response had no readable body.');

    let buffer = '';
    let text = '';
    let sequence = 1;
    const toolCalls = new Map();
    const messageID = `msg_${responseID}`;
    let usage = {};

    const emitTextDelta = (delta) => {
      if (!delta) return;
      text += delta;
      writeSSE(res, {
        type: 'response.output_text.delta',
        sequence_number: sequence++,
        item_id: messageID,
        output_index: 0,
        content_index: 0,
        delta,
        logprobs: [],
      });
    };

    const accumulateToolDelta = (toolCall) => {
      const index = Number(toolCall.index ?? 0);
      const existing = toolCalls.get(index) || {
        id: toolCall.id || `call_${responseID}_${index}`,
        name: '',
        arguments: '',
      };
      if (toolCall.id) existing.id = toolCall.id;
      if (toolCall.function?.name) existing.name += toolCall.function.name;
      if (toolCall.function?.arguments) existing.arguments += toolCall.function.arguments;
      toolCalls.set(index, existing);
    };

    const processSSEData = (data) => {
      const clean = data.trim();
      if (!clean || clean === '[DONE]') return;
      let event;
      try { event = JSON.parse(clean); } catch { return; }
      if (event.usage) usage = event.usage;
      const choice = event.choices?.[0];
      if (!choice) return;
      if (choice.delta?.content) emitTextDelta(choice.delta.content);
      for (const toolCall of choice.delta?.tool_calls || []) accumulateToolDelta(toolCall);
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const rawEvent of events) {
        const lines = rawEvent.split('\n');
        for (const line of lines) {
          if (line.startsWith('data:')) processSSEData(line.slice(5));
        }
      }
    }
    if (buffer) {
      for (const line of buffer.split('\n')) {
        if (line.startsWith('data:')) processSSEData(line.slice(5));
      }
    }

    if (text.trim()) {
      writeSSE(res, {
        type: 'response.output_item.done',
        sequence_number: sequence++,
        output_index: 0,
        item: responseOutputTextItem(responseID, text),
      });
    }
    let outputIndex = text.trim() ? 1 : 0;
    for (const call of [...toolCalls.values()]) {
      writeSSE(res, {
        type: 'response.output_item.done',
        sequence_number: sequence++,
        output_index: outputIndex++,
        item: {
          id: `fc_${call.id}`,
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments || '{}',
          status: 'completed',
        },
      });
    }
    const output = [];
    if (text.trim()) output.push(responseOutputTextItem(responseID, text));
    for (const call of [...toolCalls.values()]) {
      output.push({
        id: `fc_${call.id}`,
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: call.arguments || '{}',
        status: 'completed',
      });
    }
    writeSSE(res, {
      type: 'response.completed',
      sequence_number: sequence++,
      response: responseEnvelope({
        responseID,
        model,
        output,
        usage,
        tools: body.tools || [],
        toolChoice: body.tool_choice || 'auto',
      }),
    });
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error?.message || String(error) } }));
    } else {
      writeSSE(res, {
        type: 'error',
        sequence_number: 999999,
        error: { message: error?.message || String(error) },
      });
      res.end();
    }
  }
}

async function ensureCerebrasResponsesAdapter(apiKey) {
  if (cerebrasResponsesAdapter) {
    cerebrasResponsesAdapterKey = apiKey;
    return cerebrasResponsesAdapterBaseURL;
  }
  for (let offset = 0; offset < 20; offset += 1) {
    const port = CEREBRAS_RESPONSES_ADAPTER_PORT + offset;
    const server = createServer((req, res) => {
      handleCerebrasResponsesRequest(req, res);
    });
    const baseURL = `http://${CEREBRAS_RESPONSES_ADAPTER_HOST}:${port}/v1`;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, CEREBRAS_RESPONSES_ADAPTER_HOST, resolve);
      });
      cerebrasResponsesAdapter = server;
      cerebrasResponsesAdapterKey = apiKey;
      cerebrasResponsesAdapterBaseURL = baseURL;
      return baseURL;
    } catch (error) {
      try { server.close(); } catch {}
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`Could not bind Cerebras Responses adapter starting at ${CEREBRAS_RESPONSES_ADAPTER_HOST}:${CEREBRAS_RESPONSES_ADAPTER_PORT}.`);
}

function sttArgsForHF(payload = {}) {
  const settings = sttProfileConfig(payload.sttProfile || payload.sttQualityProfile || '');
  if (settings.backend === 'faster-whisper') {
    return [
      '--stt', 'faster-whisper',
      '--faster_whisper_stt_model_name', settings.model,
      '--faster_whisper_stt_device', process.env.VOICECLAW_HF_FASTER_WHISPER_DEVICE || 'auto',
      '--faster_whisper_stt_compute_type', settings.computeType,
      '--faster_whisper_stt_gen_beam_size', settings.beamSize,
      '--faster_whisper_stt_gen_language', process.env.VOICECLAW_HF_STT_LANGUAGE || 'en',
      '--faster_whisper_stt_gen_task', 'transcribe',
    ];
  }
  if (settings.backend === 'mlx-audio-whisper') {
    return [
      '--stt', 'mlx-audio-whisper',
      '--mlx_audio_whisper_model_name', settings.model,
    ];
  }
  if (settings.backend === 'whisper-mlx') {
    return [
      '--stt', 'whisper-mlx',
      '--stt_model_name', HF_WHISPER_MLX_MODEL,
      '--stt_device', 'mps',
      '--language', process.env.VOICECLAW_HF_STT_LANGUAGE || 'en',
    ];
  }
  if (settings.backend === 'whisper') {
    return [
      '--stt', 'whisper',
      '--stt_model_name', process.env.VOICECLAW_HF_WHISPER_MODEL || 'openai/whisper-base.en',
      '--stt_device', process.env.VOICECLAW_HF_WHISPER_DEVICE || 'mps',
      '--stt_torch_dtype', process.env.VOICECLAW_HF_WHISPER_DTYPE || 'float16',
      '--language', process.env.VOICECLAW_HF_STT_LANGUAGE || 'en',
    ];
  }
  return [
    '--stt', 'parakeet-tdt',
    '--parakeet_tdt_model_name', settings.model,
    '--parakeet_tdt_device', settings.device || 'mps',
    '--parakeet_tdt_compute_type', settings.computeType || 'float16',
    '--parakeet_tdt_language', process.env.VOICECLAW_HF_STT_LANGUAGE || 'en',
  ];
}

function ttsArgsForHF() {
  const tts = String(HF_DEFAULT_TTS || 'qwen3').trim();
  if (tts === 'pocket') {
    return [
      '--tts', 'pocket',
      '--pocket_tts_device', process.env.VOICECLAW_HF_POCKET_DEVICE || 'cpu',
      '--pocket_tts_voice', process.env.VOICECLAW_HF_POCKET_VOICE || 'jean',
      '--pocket_tts_sample_rate', process.env.VOICECLAW_HF_POCKET_SAMPLE_RATE || '16000',
      '--pocket_tts_blocksize', process.env.VOICECLAW_HF_POCKET_BLOCKSIZE || '512',
      '--pocket_tts_max_tokens', process.env.VOICECLAW_HF_POCKET_MAX_TOKENS || '50',
    ];
  }
  if (tts === 'kokoro') {
    return [
      '--tts', 'kokoro',
      '--kokoro_device', process.env.VOICECLAW_HF_KOKORO_DEVICE || 'mps',
      '--kokoro_voice', process.env.VOICECLAW_HF_KOKORO_VOICE || 'af_heart',
      '--kokoro_lang_code', process.env.VOICECLAW_HF_KOKORO_LANG || 'a',
      '--kokoro_speed', process.env.VOICECLAW_HF_KOKORO_SPEED || '1.0',
      '--kokoro_blocksize', process.env.VOICECLAW_HF_KOKORO_BLOCKSIZE || '512',
    ];
  }
  return [
    '--tts', 'qwen3',
    '--qwen3_tts_model_name', HF_DEFAULT_TTS_MODEL,
    '--qwen3_tts_mlx_quantization', '6bit',
    '--qwen3_tts_language', 'auto',
    '--qwen3_tts_streaming_chunk_size', '4',
    '--qwen3_tts_blocksize', '512',
  ];
}

async function sidecarConfigFromPayload(payload = {}) {
  const sttArgs = sttArgsForHF(payload);
  const ttsArgs = ttsArgsForHF();
  const sttConfig = sttProfileConfig(payload.sttProfile || payload.sttQualityProfile || '');
  const liveTranscriptionArgs = sttConfig.liveTranscription
    ? ['--enable_live_transcription', '--live_transcription_min_silence_ms', process.env.VOICECLAW_HF_LIVE_TRANSCRIPTION_MIN_SILENCE_MS || '180']
    : ['--enable_live_transcription'];
  const brainMode = String(payload.brainMode || '').trim();
  if (brainMode.startsWith('cerebras:')) {
    const model = normalizeCerebrasModel(String(payload.cerebrasModel || brainMode.slice('cerebras:'.length) || HF_DEFAULT_CEREBRAS_MODEL));
    const key = cerebrasKeyFromPayload(payload);
    const adapterBaseURL = await ensureCerebrasResponsesAdapter(key);
    return {
      key: `cerebras:${model}:stt:${sttConfig.id}`,
      env: {
        OPENAI_API_KEY: 'voiceclaw-local-cerebras-responses-adapter',
      },
      args: [
        '--mode', 'realtime',
        '--ws_host', HF_HOST,
        '--ws_port', String(HF_PORT),
        '--sample_rate', String(DEFAULT_HF_SAMPLE_RATE),
        ...sttArgs,
        '--llm_backend', 'responses-api',
        '--model_name', model,
        '--responses_api_base_url', adapterBaseURL,
        '--responses_api_stream',
        '--responses_api_disable_thinking',
        '--stream_batch_sentences', '1',
        '--chat_size', '12',
        '--no_compact_history',
        ...ttsArgs,
        ...liveTranscriptionArgs,
        '--thresh', '0.5',
        '--min_silence_ms', '360',
        '--min_speech_ms', '384',
        '--speech_pad_ms', '240',
        '--num_pipelines', '1',
        '--log_level', process.env.VOICECLAW_HF_LOG_LEVEL || 'info',
      ],
    };
  }

  return {
    key: `local:${HF_DEFAULT_LOCAL_MODEL}:stt:${sttConfig.id}`,
    env: {},
    args: [
      '--mode', 'realtime',
      '--ws_host', HF_HOST,
      '--ws_port', String(HF_PORT),
      '--sample_rate', String(DEFAULT_HF_SAMPLE_RATE),
      '--device', 'mps',
      ...sttArgs,
      '--llm_backend', 'mlx-lm',
      '--model_name', HF_DEFAULT_LOCAL_MODEL,
      '--stream_batch_sentences', '1',
      '--chat_size', '12',
      '--no_compact_history',
      ...ttsArgs,
      ...liveTranscriptionArgs,
      '--llm_gen_max_new_tokens', '192',
      '--thresh', '0.5',
      '--min_silence_ms', '360',
      '--min_speech_ms', '384',
      '--speech_pad_ms', '240',
      '--num_pipelines', '1',
      '--log_level', process.env.VOICECLAW_HF_LOG_LEVEL || 'info',
    ],
  };
}

async function appendLog(path, chunk) {
  try {
    await mkdir(HF_LOG_DIR, { recursive: true });
    await appendFile(path, chunk);
  } catch {}
}

export async function ensureHFRealtimeSidecar(payload = {}) {
  const status = await getHFRealtimeStatus({ brainMode: payload.brainMode, ...payload });
  if (status.requireCerebrasKey && !status.cerebrasKeyReady) {
    throw new Error('Cerebras API key is required for the HF/Cerebras Companion Realtime Voice LLM.');
  }
  if (status.state !== 'ready') {
    throw new Error('HF speech-to-speech runtime is not installed. Use Companion setup to install the HF runtime first.');
  }

  if (sidecarStarting) await sidecarStarting;
  const config = await sidecarConfigFromPayload(payload);
  if (config.key.startsWith('cerebras:') && !cerebrasKeyFromPayload(payload)) {
    throw new Error('Cerebras API key is required for the HF/Cerebras Companion Realtime Voice LLM.');
  }

  sidecarStarting = (async () => {
    const health = await hfPoolHealth();
    if (sidecar && !sidecar.killed && sidecarKey === config.key && health.reachable) {
      return { wsURL: HF_WS_URL, key: sidecarKey, health };
    }

    if (sidecar && !sidecar.killed) {
      sidecar.kill('SIGTERM');
      sidecar = null;
    }

    await mkdir(HF_LOG_DIR, { recursive: true });
    sidecarKey = config.key;
    const proc = spawn(HF_CLI, config.args, {
      env: hfRuntimeLaunchEnv(config.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    sidecar = proc;
    let earlyExit = null;

    proc.stdout.on('data', (chunk) => appendLog(HF_STDOUT_LOG, chunk));
    proc.stderr.on('data', (chunk) => appendLog(HF_STDERR_LOG, chunk));
    proc.on('exit', (code, signal) => {
      earlyExit = { code, signal };
      appendLog(HF_STDERR_LOG, `\n[hf-sidecar] exited code=${code} signal=${signal}\n`);
      if (sidecarKey === config.key) {
        sidecar = null;
        sidecarKey = '';
      }
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < HF_START_TIMEOUT_MS) {
      const nextHealth = await hfPoolHealth();
      if (nextHealth.reachable) return { wsURL: HF_WS_URL, key: config.key, health: nextHealth };
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (earlyExit) {
        throw new Error(`HF speech-to-speech sidecar exited early with code ${earlyExit.code ?? 'unknown'} signal ${earlyExit.signal ?? 'none'}. Check ${HF_STDERR_LOG}.`);
      }
    }
    if (sidecar && !sidecar.killed) {
      sidecar.kill('SIGTERM');
    }
    sidecar = null;
    sidecarKey = '';
    throw new Error(`HF speech-to-speech sidecar did not become ready within ${Math.round(HF_START_TIMEOUT_MS / 1000)} seconds. Check ${HF_STDERR_LOG}.`);
  })();
  try {
    return await sidecarStarting;
  } finally {
    sidecarStarting = null;
  }
}

function safeJSONParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function collectTextFields(value, out = []) {
  if (!value) return out;
  if (typeof value === 'string') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectTextFields(item, out);
    return out;
  }
  if (typeof value !== 'object') return out;
  for (const key of ['transcript', 'text']) {
    const text = typeof value[key] === 'string' ? value[key].trim() : '';
    if (text) out.push(text);
  }
  for (const key of ['output', 'content', 'parts', 'item', 'message', 'response']) {
    collectTextFields(value[key], out);
  }
  return out;
}

function extractHFResponseText(response = {}) {
  return collectTextFields(response)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function encodePCMChunk(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function decodeAudioDelta(delta = '') {
  try { return Buffer.from(String(delta || ''), 'base64'); } catch { return Buffer.alloc(0); }
}

function voiceForHF(localVoice = '', realtimeVoice = '') {
  const candidate = String(localVoice || realtimeVoice || '').trim();
  const lower = candidate.toLowerCase();
  if (HF_DEFAULT_TTS === 'kokoro') {
    if (!candidate) return process.env.VOICECLAW_HF_KOKORO_VOICE || 'af_heart';
    if (lower.startsWith('kokoro-')) return candidate.slice('kokoro-'.length).replace(/-/g, '_') || 'af_heart';
    if (lower.includes('heart')) return 'af_heart';
    return candidate.replace(/^openai-/i, '').replace(/^piper-/i, '').replace(/-/g, '_') || 'af_heart';
  }
  if (HF_DEFAULT_TTS === 'qwen3') {
    const supported = new Set(['aiden', 'dylan', 'eric', 'ono_anna', 'ryan', 'serena', 'sohee', 'uncle_fu', 'vivian']);
    const clean = candidate.replace(/^openai-/i, '').replace(/^piper-/i, '').replace(/^qwen3-/i, '').replace(/-/g, '_').toLowerCase();
    if (supported.has(clean)) return clean;
    if (lower.includes('ryan')) return 'ryan';
    if (lower.includes('serena')) return 'serena';
    if (lower.includes('cedar') || lower.includes('aiden') || !candidate) return 'aiden';
    return 'aiden';
  }
  if (!candidate) return 'Aiden';
  return candidate.replace(/^openai-/i, '').replace(/^piper-/i, '') || 'Aiden';
}

function turnDetectionForHF(payload = {}) {
  const vad = payload.serverVad && typeof payload.serverVad === 'object' ? payload.serverVad : {};
  const sensitivity = Number(vad.sensitivity ?? payload.vadSensitivity ?? 0.72);
  const thresholdFallback = Number.isFinite(sensitivity) ? 0.62 - (Math.min(1, Math.max(0, sensitivity)) * 0.28) : 0.5;
  const threshold = Number(vad.threshold ?? payload.vadThreshold ?? thresholdFallback);
  const silenceDurationMs = Number(vad.silenceDurationMs ?? vad.silenceMs ?? payload.vadSilenceDurationMs ?? payload.vadSilenceMs ?? 360);
  const prefixPaddingMs = Number(vad.prefixPaddingMs ?? vad.prefix_padding_ms ?? payload.vadPrefixPaddingMs ?? 240);
  return {
    type: 'server_vad',
    interrupt_response: true,
    threshold: Number.isFinite(threshold) ? Math.min(0.95, Math.max(0.05, threshold)) : 0.5,
    silence_duration_ms: Number.isFinite(silenceDurationMs) ? Math.max(120, silenceDurationMs) : 360,
    prefix_padding_ms: Number.isFinite(prefixPaddingMs) ? Math.max(0, prefixPaddingMs) : 240,
  };
}

export class HFRealtimeBridge {
  constructor({
    clientWs,
    send,
    payload = {},
    tools = [],
    instructions = '',
    toolHandler = null,
  }) {
    this.clientWs = clientWs;
    this.send = send;
    this.payload = payload || {};
    this.tools = Array.isArray(tools) ? tools : [];
    this.instructions = instructions || 'You are VoiceClaw Realtime, a fast conversational voice assistant.';
    this.toolHandler = typeof toolHandler === 'function' ? toolHandler : null;
    this.hfWs = null;
    this.connected = false;
    this.configured = false;
    this.closed = false;
    this.audioStarted = false;
    this.audioBytes = 0;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.pendingCommit = false;
    this.lastSilenceFlushAt = 0;
    this.responseTextById = new Map();
    this.finalReplySentById = new Set();
    this.inputTranscriptByItem = new Map();
    this.lastFinalTranscript = '';
    this.lastAssistantText = '';
    this.configureTimer = null;
    this.awaitingResponseAfterTranscript = false;
    this.responseCreateTimer = null;
    this.responseInProgress = false;
    this.pendingToolFollowupResponse = false;
    this.pendingCompanionResultAfterAudio = false;
    this.awaitingToolFollowup = false;
    this.companionResultSent = false;
  }

  async start() {
    const sidecarInfo = await ensureHFRealtimeSidecar(this.payload);
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(sidecarInfo.wsURL);
      this.hfWs = ws;
      const timeout = setTimeout(() => reject(new Error('HF realtime websocket did not open')), 45_000);
      ws.on('open', () => {
        this.connected = true;
        clearTimeout(timeout);
        resolve();
      });
      ws.on('message', (data) => this.handleHFMessage(data));
      ws.on('close', () => {
        this.closed = true;
        if (!this.configured) return;
        this.send({ type: 'error', message: 'HF realtime websocket closed unexpectedly' });
        this.send({ type: 'status', status: 'closed' });
      });
      ws.on('error', (error) => {
        if (!this.configured) reject(error);
        else this.send({ type: 'error', message: `HF realtime websocket error: ${error.message}` });
      });
    });
  }

  sendAudio(buffer) {
    if (!this.connected || !this.configured || this.hfWs?.readyState !== WebSocket.OPEN) {
      const chunk = Buffer.from(buffer);
      this.pendingAudio.push(chunk);
      this.pendingAudioBytes += chunk.length;
      const maxPendingBytes = DEFAULT_HF_SAMPLE_RATE * 2 * 8;
      while (this.pendingAudioBytes > maxPendingBytes && this.pendingAudio.length) {
        const removed = this.pendingAudio.shift();
        this.pendingAudioBytes -= removed?.length || 0;
      }
      return;
    }
    if (this.hfWs.bufferedAmount > DEFAULT_HF_SAMPLE_RATE * 2 * 6) {
      this.send({ type: 'warning', message: 'HF realtime socket is backlogged; dropping one microphone frame to keep latency bounded.' });
      return;
    }
    this.hfWs.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: encodePCMChunk(buffer),
    }));
  }

  flushPendingAudio() {
    if (!this.connected || !this.configured || this.hfWs?.readyState !== WebSocket.OPEN) return;
    const chunks = this.pendingAudio.splice(0);
    this.pendingAudioBytes = 0;
    for (const chunk of chunks) {
      this.hfWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: encodePCMChunk(chunk),
      }));
    }
    if (this.pendingCommit) {
      this.pendingCommit = false;
      this.sendEndOfSpeechPadding();
    }
  }

  commit() {
    if (!this.connected || !this.configured || this.hfWs?.readyState !== WebSocket.OPEN) {
      this.pendingCommit = true;
      return;
    }
    this.sendEndOfSpeechPadding();
  }

  sendEndOfSpeechPadding() {
    if (this.hfWs?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - this.lastSilenceFlushAt < 300) return;
    this.lastSilenceFlushAt = now;
    const vad = turnDetectionForHF(this.payload);
    const paddingMs = Math.max(650, Math.min(1600, Number(vad.silence_duration_ms || 420) + 320));
    const silence = Buffer.alloc(Math.round((DEFAULT_HF_SAMPLE_RATE * 2 * paddingMs) / 1000));
    this.hfWs.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: encodePCMChunk(silence),
    }));
    this.awaitingResponseAfterTranscript = true;
  }

  interrupt(reason = 'client-barge-in') {
    if (this.hfWs?.readyState === WebSocket.OPEN) {
      this.hfWs.send(JSON.stringify({ type: 'response.cancel' }));
    }
    this.responseInProgress = false;
    this.pendingToolFollowupResponse = false;
    this.pendingCompanionResultAfterAudio = false;
    this.awaitingToolFollowup = false;
    this.finishAudioIfNeeded();
    this.send({ type: 'interrupted', reason });
  }

  flushPendingToolFollowupResponse() {
    if (!this.pendingToolFollowupResponse || this.responseInProgress || this.hfWs?.readyState !== WebSocket.OPEN) return false;
    this.pendingToolFollowupResponse = false;
    this.awaitingToolFollowup = true;
    this.hfWs.send(JSON.stringify({ type: 'response.create' }));
    return true;
  }

  sendToolResult({ callID = '', output = '', continueResponse = true } = {}) {
    if (!callID || this.hfWs?.readyState !== WebSocket.OPEN) return;
    this.hfWs.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callID,
        output: String(output || ''),
      },
    }));
    if (!continueResponse) return;
    this.pendingToolFollowupResponse = true;
    this.awaitingToolFollowup = true;
    this.flushPendingToolFollowupResponse();
  }

  sendCompanionDoneResult() {
    if (this.companionResultSent) return;
    this.companionResultSent = true;
    this.awaitingToolFollowup = false;
    this.send({
      type: 'companion_voice_result',
      ok: true,
      done: true,
      hf: true,
      routeMode: this.payload.routeMode || this.payload.route || '',
      brainMode: this.payload.brainMode || '',
      sttProfile: normalizeSTTProfile(this.payload.sttProfile || this.payload.sttQualityProfile || ''),
      planner: 'hf-speech-to-speech',
      transcript: this.lastFinalTranscript,
      rawText: this.lastFinalTranscript,
      reply: this.lastAssistantText,
      elapsedMs: 0,
      audioStreamed: true,
    });
    this.send({ type: 'status', status: 'ready' });
  }

  close() {
    this.closed = true;
    if (this.configureTimer) clearTimeout(this.configureTimer);
    if (this.responseCreateTimer) clearTimeout(this.responseCreateTimer);
    try { this.hfWs?.close(); } catch {}
  }

  scheduleResponseCreateFallback() {
    if (!this.awaitingResponseAfterTranscript || this.hfWs?.readyState !== WebSocket.OPEN) return;
    if (this.responseCreateTimer) clearTimeout(this.responseCreateTimer);
    this.responseCreateTimer = setTimeout(() => {
      this.responseCreateTimer = null;
      if (!this.awaitingResponseAfterTranscript || this.hfWs?.readyState !== WebSocket.OPEN) return;
      this.awaitingResponseAfterTranscript = false;
      this.hfWs.send(JSON.stringify({ type: 'response.create' }));
    }, Math.max(1000, RESPONSE_CREATE_FALLBACK_MS));
  }

  clearResponseCreateFallback() {
    this.awaitingResponseAfterTranscript = false;
    if (this.responseCreateTimer) {
      clearTimeout(this.responseCreateTimer);
      this.responseCreateTimer = null;
    }
  }

  markConfigured(source = 'session.update') {
    if (this.closed || this.configured) return;
    this.configured = true;
    this.flushPendingAudio();
    this.send({
      type: 'status',
      status: 'ready',
      hf: true,
      source,
      capabilities: {
        partialTranscripts: true,
        streamingTTS: true,
        serverEndpointing: true,
        toolCalls: this.tools.length > 0,
      },
    });
  }

  sendSessionUpdate() {
    if (this.hfWs?.readyState !== WebSocket.OPEN) return;
    const voice = voiceForHF(this.payload.localVoice, this.payload.voice);
    const session = {
      type: 'realtime',
      instructions: this.instructions,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: DEFAULT_HF_SAMPLE_RATE },
          turn_detection: turnDetectionForHF(this.payload),
        },
        output: {
          format: { type: 'audio/pcm', rate: DEFAULT_HF_SAMPLE_RATE },
          voice,
        },
      },
    };
    if (this.tools.length) {
      session.tools = this.tools;
      session.tool_choice = 'auto';
    }
    this.hfWs.send(JSON.stringify({ type: 'session.update', session }));
    if (this.configureTimer) clearTimeout(this.configureTimer);
    this.configureTimer = setTimeout(() => this.markConfigured('session.update-accepted'), 900);
  }

  handleHFMessage(raw) {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
    const event = safeJSONParse(text);
    if (!event || typeof event.type !== 'string') return;

    switch (event.type) {
      case 'session.created':
        this.sendSessionUpdate();
        break;
      case 'session.updated':
        if (this.configureTimer) clearTimeout(this.configureTimer);
        this.markConfigured('session.updated');
        break;
      case 'input_audio_buffer.speech_started':
        this.send({ type: 'status', status: 'user-speaking' });
        this.send({ type: 'interrupted', reason: 'turn_detected' });
        break;
      case 'input_audio_buffer.speech_stopped':
        this.send({ type: 'status', status: 'transcribing' });
        break;
      case 'conversation.item.input_audio_transcription.delta':
        if (event.delta) {
          const itemID = event.item_id || '';
          this.inputTranscriptByItem.set(itemID, event.delta);
          this.send({
            type: 'transcript',
            text: event.delta,
            rawText: event.delta,
            final: false,
            hf: true,
            itemID,
          });
        }
        break;
      case 'conversation.item.input_audio_transcription.completed':
        {
        const itemID = event.item_id || '';
        const transcript = event.transcript || this.inputTranscriptByItem.get(itemID) || '';
        if (transcript) {
          this.lastFinalTranscript = transcript;
          this.inputTranscriptByItem.set(itemID, transcript);
        }
        this.send({
          type: 'transcript',
          text: transcript,
          rawText: transcript,
          final: true,
          hf: true,
          itemID,
        });
        this.scheduleResponseCreateFallback();
        break;
        }
      case 'response.created':
        this.responseInProgress = true;
        this.clearResponseCreateFallback();
        this.send({ type: 'status', status: 'thinking' });
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
      case 'response.output_text.delta':
        this.clearResponseCreateFallback();
        this.responseInProgress = true;
        if (event.delta) {
          const responseID = event.response_id || '';
          const next = `${this.responseTextById.get(responseID) || ''}${event.delta}`;
          this.responseTextById.set(responseID, next);
          this.lastAssistantText = next;
          this.send({ type: 'reply_delta', text: next, delta: event.delta, responseID, final: false });
        }
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
      case 'response.output_text.done':
        {
          this.clearResponseCreateFallback();
          this.responseInProgress = true;
          const responseID = event.response_id || '';
          const textValue = event.transcript || event.text || this.responseTextById.get(responseID) || '';
          if (textValue) {
            this.responseTextById.set(responseID, textValue);
            this.lastAssistantText = textValue;
            this.finalReplySentById.add(responseID);
            this.send({ type: 'reply', text: textValue, responseID, final: true });
          }
        }
        break;
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        this.clearResponseCreateFallback();
        this.responseInProgress = true;
        this.forwardAudioDelta(event.delta);
        break;
      case 'response.output_audio.done':
      case 'response.audio.done':
        this.finishAudioIfNeeded();
        if (this.pendingToolFollowupResponse && !this.responseInProgress && this.flushPendingToolFollowupResponse()) {
          this.send({ type: 'status', status: 'thinking', reason: 'tool-result' });
          break;
        }
        if (this.pendingCompanionResultAfterAudio) {
          this.pendingCompanionResultAfterAudio = false;
          this.sendCompanionDoneResult();
        }
        break;
      case 'response.function_call_arguments.done':
        this.clearResponseCreateFallback();
        this.responseInProgress = true;
        this.handleToolCall(event);
        break;
      case 'response.done':
        this.responseInProgress = false;
        {
          const responseID = event.response_id || event.response?.id || '';
          const responseText = extractHFResponseText(event.response) || this.responseTextById.get(responseID) || '';
          if (responseText && !this.finalReplySentById.has(responseID)) {
            this.lastAssistantText = responseText;
            this.responseTextById.set(responseID, responseText);
            this.finalReplySentById.add(responseID);
            this.send({ type: 'reply', text: responseText, responseID, final: true });
          }
        }
        if (this.pendingToolFollowupResponse && this.audioStarted) {
          break;
        }
        if (this.flushPendingToolFollowupResponse()) {
          this.send({ type: 'status', status: 'thinking', reason: 'tool-result' });
          break;
        }
        if (this.audioStarted) {
          this.pendingCompanionResultAfterAudio = true;
          break;
        }
        this.finishAudioIfNeeded();
        this.sendCompanionDoneResult();
        break;
      case 'error':
        if (this.configureTimer) {
          clearTimeout(this.configureTimer);
          this.configureTimer = null;
        }
        this.send({ type: 'error', message: event.error?.message || event.message || 'HF realtime error' });
        break;
      default:
        break;
    }
  }

  handleToolCall(event = {}) {
    const name = String(event.name || '').trim();
    const callID = String(event.call_id || '').trim();
    if (!callID) return;
    if (name === 'wait_for_user') {
      this.sendToolResult({ callID, output: 'Waiting silently for the user.' });
      return;
    }
    if (name.startsWith('iphone_') || name.startsWith('android_')) {
      this.send({
        type: 'iphone_tool',
        iphoneToolName: name,
        iphoneToolArguments: event.arguments || '{}',
        callID,
        hf: true,
      });
      return;
    }
    if (this.toolHandler) {
      this.toolHandler({
        name,
        callID,
        argumentsJSON: event.arguments || '{}',
        event,
        bridge: this,
      }).catch((error) => {
        this.sendToolResult({
          callID,
          output: JSON.stringify({ ok: false, error: error?.message || String(error) }),
        });
      });
      return;
    }
    this.sendToolResult({
      callID,
      output: JSON.stringify({ ok: false, error: `Unsupported VoiceClaw Companion tool: ${name}` }),
    });
  }

  forwardAudioDelta(delta) {
    const audio = decodeAudioDelta(delta);
    if (!audio.length || this.clientWs?.readyState !== WebSocket.OPEN) return;
    if (!this.audioStarted) {
      this.audioStarted = true;
      this.audioBytes = 0;
      this.send({
        type: 'tts_audio_start',
        sampleRate: DEFAULT_HF_SAMPLE_RATE,
        channels: 1,
        encoding: 'pcm_s16le',
        engine: 'hf-speech-to-speech',
      });
    }
    this.audioBytes += audio.length;
    this.clientWs.send(audio, { binary: true });
  }

  finishAudioIfNeeded() {
    if (!this.audioStarted) return;
    const audioBytes = this.audioBytes;
    this.audioStarted = false;
    this.audioBytes = 0;
    this.send({ type: 'tts_audio_end', audioBytes });
  }
}
