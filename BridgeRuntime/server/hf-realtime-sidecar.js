import { spawn, execFile as execFileCb } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { access, appendFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { executablePath, normalizeProcessPath } from './bin-paths.js';
import { parseRealtimeBoolean, readBridgeConfig, resolveOpenAIChatGPTOAuthBearer } from './realtime-auth.js';
import { PLATFORM_PATHS } from './platform-paths.js';

const execFile = promisify(execFileCb);
normalizeProcessPath();

const HF_ROOT = process.env.VOICECLAW_HF_ROOT || join(os.homedir(), '.voiceclaw', 'hf-runtime');
const HF_HOME = process.env.HF_HOME || process.env.HUGGINGFACE_HUB_CACHE?.replace(/\/hub$/g, '') || join(os.homedir(), '.cache', 'huggingface');
const HF_VENV = process.env.VOICECLAW_HF_VENV || HF_ROOT;
const HF_PYTHON = process.env.VOICECLAW_HF_PYTHON || join(HF_VENV, 'bin', 'python');
const HF_CLI = process.env.VOICECLAW_HF_CLI || join(HF_VENV, 'bin', 'speech-to-speech');
const HF_LOG_DIR = process.env.VOICECLAW_HF_LOG_DIR || PLATFORM_PATHS.logsDir;
const HF_STDOUT_LOG = join(HF_LOG_DIR, 'hf-speech-to-speech.out.log');
const HF_STDERR_LOG = join(HF_LOG_DIR, 'hf-speech-to-speech.err.log');
const PRIORITY_HELPER_PLIST = '/Library/LaunchDaemons/ai.voiceclaw.priority-helper.plist';
const HF_HOST = process.env.VOICECLAW_HF_HOST || '127.0.0.1';
const HF_PORT = Number.parseInt(process.env.VOICECLAW_HF_PORT || '18765', 10);
const VOICECLAW_LOGICAL_CORES = Math.max(1, os.cpus().length || 1);
const requestedHFPoolSize = Number.parseInt(process.env.VOICECLAW_HF_POOL_SIZE || '2', 10);
const HF_POOL_SIZE = Math.max(1, Math.min(2, Number.isFinite(requestedHFPoolSize) ? requestedHFPoolSize : 2));
const requestedAggressiveThreads = Number.parseInt(process.env.VOICECLAW_AGGRESSIVE_THREADS || String(VOICECLAW_LOGICAL_CORES), 10);
const VOICECLAW_AGGRESSIVE_THREADS = Math.max(2, Math.min(16, Number.isFinite(requestedAggressiveThreads) ? requestedAggressiveThreads : VOICECLAW_LOGICAL_CORES));
// HF speech-to-speech currently disables live transcription on Apple Silicon
// when --num_pipelines > 1 because progressive STT contends on the global MLX
// lock. VoiceClaw gets parallelism from multiple hot sidecars instead.
const requestedHFNumPipelines = Number.parseInt(process.env.VOICECLAW_HF_NUM_PIPELINES || '1', 10);
const VOICECLAW_HF_NUM_PIPELINES = Math.max(1, Math.min(2, Number.isFinite(requestedHFNumPipelines) ? requestedHFNumPipelines : 1));
const VOICECLAW_HF_LATENCY_TIER = process.env.VOICECLAW_HF_LATENCY_TIER || '0';
const VOICECLAW_HF_THROUGHPUT_TIER = process.env.VOICECLAW_HF_THROUGHPUT_TIER || '0';
const HF_PACKAGE_SPEC = process.env.VOICECLAW_HF_PACKAGE_SPEC || 'speech-to-speech';
const HF_INSTALL_TIMEOUT_MS = Number.parseInt(process.env.VOICECLAW_HF_INSTALL_TIMEOUT_MS || String(90 * 60 * 1000), 10);
const HF_START_TIMEOUT_MS = Number.parseInt(process.env.VOICECLAW_HF_START_TIMEOUT_MS || String(15 * 60 * 1000), 10);
const HF_START_ATTEMPTS = Math.max(1, Number.parseInt(process.env.VOICECLAW_HF_START_ATTEMPTS || '3', 10));
const HF_CACHE_CHECK_TIMEOUT_MS = Math.max(1000, Number.parseInt(process.env.VOICECLAW_HF_CACHE_CHECK_TIMEOUT_MS || '2000', 10));
const HF_CACHE_CHECK_TTL_MS = Math.max(1000, Number.parseInt(process.env.VOICECLAW_HF_CACHE_CHECK_TTL_MS || '60000', 10));
const HF_IMPORT_CHECK_TIMEOUT_MS = Math.max(1000, Number.parseInt(process.env.VOICECLAW_HF_IMPORT_CHECK_TIMEOUT_MS || '30000', 10));
const HF_DEFAULT_LOCAL_MODEL = process.env.VOICECLAW_HF_LOCAL_MODEL || 'mlx-community/Qwen3.5-0.8B-4bit';
const HF_DEFAULT_CEREBRAS_MODEL = process.env.VOICECLAW_HF_CEREBRAS_MODEL || 'gemma-4-31b';
const HF_DEFAULT_TTS = process.env.VOICECLAW_HF_TTS || 'auto';
const HF_DEFAULT_STT_PROFILE = process.env.VOICECLAW_HF_STT_PROFILE || 'parakeet-live';
const HF_DEFAULT_STT = process.env.VOICECLAW_HF_STT || '';
const HF_DEFAULT_STT_MODEL = process.env.VOICECLAW_HF_STT_MODEL || 'mlx-community/parakeet-tdt-0.6b-v3';
const HF_FASTER_WHISPER_MODEL = process.env.VOICECLAW_HF_FASTER_WHISPER_MODEL || 'base.en';
const HF_MLX_AUDIO_WHISPER_MODEL = process.env.VOICECLAW_HF_MLX_AUDIO_WHISPER_MODEL || 'mlx-community/whisper-base';
const HF_WHISPER_MLX_MODEL = process.env.VOICECLAW_HF_WHISPER_MLX_MODEL || 'base.en';
const HF_DEFAULT_KOKORO_MODEL = process.env.VOICECLAW_HF_KOKORO_MODEL || 'mlx-community/Kokoro-82M-bf16';
const HF_NATIVE_KOKORO_MODEL = process.env.VOICECLAW_HF_NATIVE_KOKORO_MODEL || 'hexgrad/Kokoro-82M';
const HF_KOKORO_VOICE_MODEL = process.env.VOICECLAW_HF_KOKORO_VOICE_MODEL || 'prince-canuma/Kokoro-82M';
const HF_DEFAULT_TTS_MODEL = process.env.VOICECLAW_HF_TTS_MODEL || 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit';
const HF_OPENAI_BRAIN_MODELS = {
  'gpt55-fast-low': { model: process.env.VOICECLAW_HF_OPENAI_MODEL || 'gpt-5.5', label: 'GPT-5.5' },
  'gpt-5.4': { model: 'gpt-5.4', label: 'GPT-5.4' },
  'gpt-5.4-mini': { model: 'gpt-5.4-mini', label: 'GPT-5.4-mini' },
};
const CEREBRAS_BASE_URL = (process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1').replace(/\/+$/g, '');
const CEREBRAS_RESPONSES_ADAPTER_HOST = process.env.VOICECLAW_CEREBRAS_RESPONSES_ADAPTER_HOST || '127.0.0.1';
const CEREBRAS_RESPONSES_ADAPTER_PORT = Number.parseInt(process.env.VOICECLAW_CEREBRAS_RESPONSES_ADAPTER_PORT || '18764', 10);
const VOICECLAW_CONFIG = process.env.VOICECLAW_CONFIG_PATH
  || process.env.VOICECLAW_CONFIG
  || join(os.homedir(), '.voiceclaw', 'bridge.json');
// HF/Silero realtime VAD accepts 8 kHz or 16 kHz. VoiceClaw standardizes the
// Companion Realtime Voice mic, VAD, STT, and local TTS transport on 16 kHz.
const DEFAULT_HF_SAMPLE_RATE = 16_000;
const TURN_WATCHDOG_MS = Number.parseInt(process.env.VOICECLAW_HF_TURN_WATCHDOG_MS || '45000', 10);
const HF_MAX_PENDING_AUDIO_BYTES = boundedInteger(process.env.VOICECLAW_HF_MAX_PENDING_AUDIO_BYTES, DEFAULT_HF_SAMPLE_RATE * 2 * 8, DEFAULT_HF_SAMPLE_RATE * 2, 16_000_000);
const HF_MAX_PENDING_AUDIO_FRAMES = boundedInteger(process.env.VOICECLAW_HF_MAX_PENDING_AUDIO_FRAMES, 512, 8, 4_096);
const HF_MAX_CLIENT_AUDIO_BUFFERED_BYTES = boundedInteger(process.env.VOICECLAW_HF_MAX_CLIENT_AUDIO_BUFFERED_BYTES, DEFAULT_HF_SAMPLE_RATE * 2 * 6, DEFAULT_HF_SAMPLE_RATE * 2, 16_000_000);
const HF_MAX_PENDING_RESPONSES = boundedInteger(process.env.VOICECLAW_HF_MAX_PENDING_RESPONSES, 8, 1, 64);
const HF_MAX_PENDING_CONTROLS = boundedInteger(process.env.VOICECLAW_HF_MAX_PENDING_CONTROLS, 128, 8, 1_024);
const HF_MAX_ADMISSION_WAITERS = boundedInteger(process.env.VOICECLAW_HF_MAX_ADMISSION_WAITERS, 64, 4, 512);
const HF_ADMISSION_TIMEOUT_MS = boundedInteger(process.env.VOICECLAW_HF_ADMISSION_TIMEOUT_MS, 120_000, 1_000, 3_600_000);
const HF_TOOL_RESULT_TIMEOUT_MS = boundedInteger(
  process.env.COMPANION_VOICE_IPHONE_TOOL_RESULT_TIMEOUT_MS || process.env.VOICECLAW_HF_TOOL_RESULT_TIMEOUT_MS,
  120_000,
  1_000,
  3_600_000,
);
const HF_PROVIDER_REQUEST_TIMEOUT_MS = boundedInteger(process.env.VOICECLAW_HF_PROVIDER_REQUEST_TIMEOUT_MS, 120_000, 5_000, 3_600_000);
const HF_TOMBSTONE_TTL_MS = boundedInteger(process.env.VOICECLAW_HF_TOMBSTONE_TTL_MS, 300_000, 10_000, 86_400_000);
const HF_MAX_TOMBSTONES = boundedInteger(process.env.VOICECLAW_HF_MAX_TOMBSTONES, 1_024, 64, 16_384);

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
let sidecarPort = HF_PORT;
let sidecarStarting = null;
const sidecarPool = new Map();
const sidecarStartingByKey = new Map();
const reservedHFPorts = new Set();
let portAllocationLock = Promise.resolve();
let admissionLock = Promise.resolve();
const hfProcessAdmissionReservations = new Set();
const hfAdmissionWaiters = new Set();
let installInFlight = null;
let cerebrasResponsesAdapter = null;
let cerebrasResponsesAdapterStarting = null;
let cerebrasResponsesAdapterBaseURL = '';
const cerebrasAdapterCredentials = new Map();
const cerebrasAdapterTokensByDigest = new Map();
let shutdownCleanupInstalled = false;
let shutdownCleanupStarted = false;
const hfModelCache = new Map();
const pythonImportCache = new Map();
const pythonPackageVersionCache = new Map();
const pythonImportInFlight = new Map();
const pythonPackageVersionInFlight = new Map();
const hfModelCacheInFlight = new Map();

function boundedInteger(value, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const finite = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(minimum, Math.min(maximum, finite));
}

async function fileExecutable(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command, args, {
  timeoutMs = 10 * 60 * 1000,
  env = {},
  signal = null,
  deadlineAt = 0,
} = {}) {
  return await new Promise((resolve, reject) => {
    throwIfOperationCancelled({ signal, deadlineAt });
    let settled = false;
    let timeout = null;
    const proc = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    const effectiveTimeoutMs = deadlineAt
      ? Math.max(1, Math.min(timeoutMs, deadlineAt - Date.now()))
      : timeoutMs;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => {
      try { proc.kill('SIGTERM'); } catch {}
      finish(reject, makeAbortError(signal?.reason));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      const error = new Error(`${command} timed out after ${effectiveTimeoutMs} ms`);
      error.name = 'TimeoutError';
      error.code = 'DEADLINE_EXCEEDED';
      finish(reject, error);
    }, effectiveTimeoutMs);
    timeout.unref?.();
    proc.on('error', (error) => {
      finish(reject, error);
    });
    proc.on('close', (code) => {
      if (code === 0) finish(resolve, { stdout, stderr });
      else finish(reject, new Error(`${command} exited ${code}: ${stderr.slice(-2000) || stdout.slice(-2000)}`));
    });
  });
}

async function pythonCanImport(moduleName) {
  if (!existsSync(HF_PYTHON)) return false;
  const cached = pythonImportCache.get(moduleName);
  if (cached && Date.now() - cached.at < HF_CACHE_CHECK_TTL_MS) return cached.value;
  if (pythonImportInFlight.has(moduleName)) return await pythonImportInFlight.get(moduleName);
  const promise = (async () => {
    try {
      await execFile(HF_PYTHON, ['-c', `import ${moduleName}`], { timeout: HF_IMPORT_CHECK_TIMEOUT_MS });
      pythonImportCache.set(moduleName, { at: Date.now(), value: true });
      return true;
    } catch {
      pythonImportCache.set(moduleName, { at: Date.now(), value: false });
      return false;
    } finally {
      pythonImportInFlight.delete(moduleName);
    }
  })();
  pythonImportInFlight.set(moduleName, promise);
  return await promise;
}

async function pythonPackageVersion(moduleName) {
  if (!existsSync(HF_PYTHON)) return '';
  const cached = pythonPackageVersionCache.get(moduleName);
  if (cached && Date.now() - cached.at < HF_CACHE_CHECK_TTL_MS) return cached.value;
  if (pythonPackageVersionInFlight.has(moduleName)) return await pythonPackageVersionInFlight.get(moduleName);
  const promise = (async () => {
    try {
      const { stdout } = await execFile(HF_PYTHON, ['-c', [
        'import importlib.metadata as md, sys',
        'names = sys.argv[1:]',
        'for n in names:',
        '    try:',
        '        print(md.version(n)); break',
        '    except md.PackageNotFoundError:',
        '        pass',
      ].join('\n'), moduleName], { timeout: HF_IMPORT_CHECK_TIMEOUT_MS });
      const version = stdout.trim();
      pythonPackageVersionCache.set(moduleName, { at: Date.now(), value: version });
      return version;
    } catch {
      pythonPackageVersionCache.set(moduleName, { at: Date.now(), value: '' });
      return '';
    } finally {
      pythonPackageVersionInFlight.delete(moduleName);
    }
  })();
  pythonPackageVersionInFlight.set(moduleName, promise);
  return await promise;
}

function hfRuntimeEnv(extra = {}) {
  const env = {
    ...process.env,
    ...extra,
    PYTHONUNBUFFERED: '1',
    HF_XET_HIGH_PERFORMANCE: process.env.HF_XET_HIGH_PERFORMANCE || '1',
    HF_HUB_ENABLE_HF_TRANSFER: process.env.HF_HUB_ENABLE_HF_TRANSFER || '1',
    TOKENIZERS_PARALLELISM: process.env.TOKENIZERS_PARALLELISM || 'true',
    OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || String(VOICECLAW_AGGRESSIVE_THREADS),
    OPENBLAS_NUM_THREADS: process.env.OPENBLAS_NUM_THREADS || String(VOICECLAW_AGGRESSIVE_THREADS),
    VECLIB_MAXIMUM_THREADS: process.env.VECLIB_MAXIMUM_THREADS || String(VOICECLAW_AGGRESSIVE_THREADS),
    NUMEXPR_NUM_THREADS: process.env.NUMEXPR_NUM_THREADS || String(VOICECLAW_AGGRESSIVE_THREADS),
    MKL_NUM_THREADS: process.env.MKL_NUM_THREADS || String(VOICECLAW_AGGRESSIVE_THREADS),
    PYTORCH_ENABLE_MPS_FALLBACK: process.env.PYTORCH_ENABLE_MPS_FALLBACK || '1',
    PYTORCH_MPS_HIGH_WATERMARK_RATIO: process.env.PYTORCH_MPS_HIGH_WATERMARK_RATIO || '0.0',
    PYTHONMALLOC: process.env.PYTHONMALLOC || 'malloc',
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeAbortError(reason = 'Operation aborted') {
  const source = reason instanceof Error ? reason : new Error(String(reason || 'Operation aborted'));
  if (!source.name || source.name === 'Error') source.name = 'AbortError';
  if (!source.code) source.code = 'ABORT_ERR';
  return source;
}

function operationDeadlineAt(options = {}, defaultTimeoutMs = 0) {
  const explicit = Number(options.deadlineAt ?? options.deadline_at ?? 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const deadlineMs = Number(options.deadlineMs ?? options.timeoutMs ?? defaultTimeoutMs);
  return Number.isFinite(deadlineMs) && deadlineMs > 0 ? Date.now() + deadlineMs : 0;
}

function throwIfOperationCancelled({ signal = null, deadlineAt = 0 } = {}) {
  if (signal?.aborted) throw makeAbortError(signal.reason);
  if (deadlineAt && Date.now() >= deadlineAt) {
    const error = new Error('Operation deadline exceeded');
    error.name = 'TimeoutError';
    error.code = 'DEADLINE_EXCEEDED';
    throw error;
  }
}

function waitForOperation(promise, { signal = null, deadlineAt = 0 } = {}) {
  throwIfOperationCancelled({ signal, deadlineAt });
  if (!signal && !deadlineAt) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => finish(reject, makeAbortError(signal?.reason));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (deadlineAt) {
      const remaining = Math.max(0, deadlineAt - Date.now());
      timer = setTimeout(() => {
        const error = new Error('Operation deadline exceeded');
        error.name = 'TimeoutError';
        error.code = 'DEADLINE_EXCEEDED';
        finish(reject, error);
      }, remaining);
      timer.unref?.();
    }
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function abortableSleep(ms, operation = {}) {
  if (!operation.signal && !operation.deadlineAt) return sleep(ms);
  throwIfOperationCancelled(operation);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      clearTimeout(timer);
      operation.signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => finish(reject, makeAbortError(operation.signal?.reason));
    const waitMs = operation.deadlineAt
      ? Math.max(0, Math.min(ms, operation.deadlineAt - Date.now()))
      : ms;
    timer = setTimeout(() => {
      if (operation.deadlineAt && Date.now() >= operation.deadlineAt && waitMs < ms) {
        const error = new Error('Operation deadline exceeded');
        error.name = 'TimeoutError';
        error.code = 'DEADLINE_EXCEEDED';
        finish(reject, error);
      } else {
        finish(resolve);
      }
    }, waitMs);
    timer.unref?.();
    operation.signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function linkedAbortController(signals = [], deadlineAt = 0) {
  const controller = new AbortController();
  const cleanups = [];
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const signal of signals.filter(Boolean)) {
    if (signal.aborted) {
      abort(signal.reason);
      break;
    }
    const listener = () => abort(signal.reason);
    signal.addEventListener('abort', listener, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', listener));
  }
  let timer = null;
  if (!controller.signal.aborted && deadlineAt) {
    timer = setTimeout(() => {
      const error = new Error('Operation deadline exceeded');
      error.name = 'TimeoutError';
      error.code = 'DEADLINE_EXCEEDED';
      abort(error);
    }, Math.max(0, deadlineAt - Date.now()));
    timer.unref?.();
  }
  return {
    controller,
    signal: controller.signal,
    cleanup() {
      if (timer) clearTimeout(timer);
      for (const cleanup of cleanups) cleanup();
    },
  };
}

function credentialDigest(value = '') {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function credentialFingerprint(value = '') {
  const text = String(value || '');
  return text ? credentialDigest(text).slice(0, 24) : 'none';
}

class BoundedTombstones {
  constructor({ max = HF_MAX_TOMBSTONES, ttlMs = HF_TOMBSTONE_TTL_MS } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  add(id, details = {}) {
    const key = String(id || '');
    if (!key) return;
    this.prune();
    this.entries.delete(key);
    this.entries.set(key, { at: Date.now(), ...details });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value);
  }

  get(id) {
    const key = String(id || '');
    if (!key) return null;
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  has(id) {
    return !!this.get(id);
  }

  prune() {
    const oldest = Date.now() - this.ttlMs;
    for (const [id, entry] of this.entries) {
      if (entry.at >= oldest) break;
      this.entries.delete(id);
    }
  }

  clear() {
    this.entries.clear();
  }
}

function hfWsURL(port = HF_PORT) {
  return `ws://${HF_HOST}:${port}/v1/realtime`;
}

function hfHttpBase(port = HF_PORT) {
  return `http://${HF_HOST}:${port}`;
}

async function execFileText(command, args = [], options = {}) {
  try {
    const { stdout } = await execFile(command, args, { timeout: 5000, ...options });
    return String(stdout || '');
  } catch {
    return '';
  }
}

async function commandExists(command) {
  const output = await execFileText('/usr/bin/which', [command], { timeout: 2000 });
  return output.trim();
}

async function applyRealtimeProcessPolicy(pid, label = 'hf-sidecar') {
  if (!Number.isFinite(pid) || pid <= 1) return;
  if (/^(1|true|yes)$/i.test(String(process.env.VOICECLAW_DISABLE_PROCESS_PRIORITY || ''))) return;
  let taskpolicy = '';
  let renice = '';
  try {
    taskpolicy = await commandExists('taskpolicy');
    if (taskpolicy) {
      await execFile(taskpolicy, ['-B', '-t', VOICECLAW_HF_THROUGHPUT_TIER, '-l', VOICECLAW_HF_LATENCY_TIER, '-p', String(pid)], { timeout: 3000 });
    }
  } catch (error) {
    console.warn(`[hf-sidecar] taskpolicy priority assertion failed for ${label} pid=${pid}: ${error?.message || String(error)}`);
  }
  try {
    renice = await commandExists('renice');
    if (renice) {
      await execFile(renice, ['-n', process.env.VOICECLAW_HF_NICE || '-5', '-p', String(pid)], { timeout: 3000 });
    }
  } catch (error) {
    if (existsSync(PRIORITY_HELPER_PLIST)) {
      console.log(`[hf-sidecar] root priority helper is installed; sidecar ${label} pid=${pid} will be boosted asynchronously.`);
      return;
    }
    if (!/^(0|false|no)$/i.test(String(process.env.VOICECLAW_ENABLE_SUDO_PRIORITY || '1')) && renice) {
      const sudo = await commandExists('sudo');
      if (sudo) {
        try {
          await execFile(sudo, ['-n', renice, '-n', process.env.VOICECLAW_HF_NICE || '-5', '-p', String(pid)], { timeout: 3000 });
          console.log(`[hf-sidecar] elevated process priority with sudo renice for ${label} pid=${pid}`);
          return;
        } catch (sudoError) {
          console.warn(`[hf-sidecar] renice priority assertion failed for ${label} pid=${pid}; sudo priority is not currently authorized: ${sudoError?.message || String(sudoError)}`);
          return;
        }
      }
    }
    console.warn(`[hf-sidecar] renice priority assertion failed for ${label} pid=${pid}: ${error?.message || String(error)}`);
  }
}

async function spawnHFRuntimeProcess(config) {
  const env = hfRuntimeLaunchEnv(config.env);
  if (!/^(1|true|yes)$/i.test(String(process.env.VOICECLAW_DISABLE_TASKPOLICY_LAUNCH || ''))) {
    const taskpolicy = await commandExists('taskpolicy');
    if (taskpolicy) {
      return spawn(taskpolicy, ['-t', VOICECLAW_HF_THROUGHPUT_TIER, '-l', VOICECLAW_HF_LATENCY_TIER, HF_CLI, ...config.args], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
  }
  return spawn(HF_CLI, config.args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function hfPortListenerPids(port = HF_PORT) {
  const output = await execFileText('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
  return Array.from(new Set(output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^p\d+$/.test(line))
    .map((line) => Number.parseInt(line.slice(1), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0)));
}

function portFromHFCommand(command = '') {
  const match = String(command || '').match(/--ws_port\s+(\d+)/);
  const parsed = Number.parseInt(match?.[1] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function processCommand(pid) {
  return (await execFileText('ps', ['-p', String(pid), '-o', 'command='])).trim();
}

async function parentPid(pid) {
  const output = (await execFileText('ps', ['-p', String(pid), '-o', 'ppid='])).trim();
  const parsed = Number.parseInt(output, 10);
  return Number.isFinite(parsed) && parsed > 1 ? parsed : 0;
}

async function childPids(pid) {
  const output = await execFileText('pgrep', ['-P', String(pid)]);
  return output
    .split(/\s+/)
    .map((part) => Number.parseInt(part, 10))
    .filter((child) => Number.isFinite(child) && child > 0);
}

async function processTreePids(rootPid, maxDepth = 4) {
  const seen = new Set([rootPid]);
  let frontier = [rootPid];
  for (let depth = 0; depth < maxDepth && frontier.length; depth += 1) {
    const next = [];
    for (const pid of frontier) {
      for (const child of await childPids(pid)) {
        if (seen.has(child)) continue;
        seen.add(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return seen;
}

async function processAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 1) return false;
  const output = await execFileText('ps', ['-p', String(pid), '-o', 'pid=']);
  return !!output.trim();
}

function looksLikeVoiceClawHFCommand(command = '') {
  const text = String(command || '');
  if (!text) return false;
  if (!text.includes('speech-to-speech')) return false;
  if (text.includes(String(HF_ROOT))) return true;
  if (text.includes(String(HF_CLI))) return true;
  if (text.includes('--ws_port') && text.includes(String(HF_PORT))) return true;
  return false;
}

async function addRuntimeTreeToSet(set, pid) {
  if (!Number.isFinite(pid) || pid <= 1) return;
  set.add(pid);
  for (const child of await processTreePids(pid, 6)) set.add(child);
  const parent = await parentPid(pid);
  const parentCommand = parent ? await processCommand(parent) : '';
  if (parent && looksLikeVoiceClawHFCommand(parentCommand)) {
    set.add(parent);
    for (const child of await processTreePids(parent, 6)) set.add(child);
  }
}

async function voiceClawHFProcessEntries() {
  const output = await execFileText('ps', ['-axo', 'pid=,ppid=,command=']);
  return output
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number.parseInt(match[1], 10),
        ppid: Number.parseInt(match[2], 10),
        command: match[3],
      };
    })
    .filter((entry) => entry && Number.isFinite(entry.pid) && entry.pid > 1 && looksLikeVoiceClawHFCommand(entry.command));
}

async function hfRuntimeProcessSnapshot() {
  const entries = await voiceClawHFProcessEntries();
  const ports = Array.from(new Set([
    HF_PORT,
    ...entries.map((entry) => portFromHFCommand(entry.command)).filter(Boolean),
    ...Array.from(sidecarPool.values()).map((record) => record.port).filter(Boolean),
  ])).sort((a, b) => a - b);
  const listenerDetails = [];
  for (const port of ports) {
    for (const pid of await hfPortListenerPids(port)) {
      listenerDetails.push({
        pid,
        port,
        command: await processCommand(pid),
      });
    }
  }
  const listeners = Array.from(new Set(listenerDetails.map((listener) => listener.pid)));
  const listenerSet = new Set(listeners);
  const trackedPid = sidecar && !sidecar.killed && sidecar.pid ? sidecar.pid : 0;
  const pool = Array.from(sidecarPool.values()).map((record) => ({
    key: record.key,
    port: record.port,
    pid: record.proc?.pid || 0,
    activeLeases: Number(record.activeLeases || 0),
    pipelineCapacity: Number(record.pipelineCapacity || VOICECLAW_HF_NUM_PIPELINES),
  }));
  return {
    processCount: entries.length,
    listenerCount: listeners.length,
    listeners,
    listenerDetails,
    trackedPid,
    trackedPort: sidecarPort,
    trackedAlive: trackedPid ? await processAlive(trackedPid) : false,
    pool,
    entries: entries.map((entry) => ({
      pid: entry.pid,
      ppid: entry.ppid,
      port: portFromHFCommand(entry.command),
      listener: listenerSet.has(entry.pid),
      tracked: trackedPid === entry.pid || pool.some((record) => record.pid === entry.pid),
      command: entry.command,
    })),
  };
}

async function waitForPidExit(pid, timeoutMs = 4000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const output = await execFileText('ps', ['-p', String(pid), '-o', 'pid=']);
    if (!output.trim()) return true;
    await sleep(200);
  }
  return false;
}

async function terminateHFProcessMap(killPids, reason = 'restart') {
  const ordered = Array.from(killPids.entries())
    .filter(([pid]) => Number.isFinite(pid) && pid > 1)
    .sort(([a], [b]) => b - a);
  if (!ordered.length) return;
  for (const [pid, command] of ordered) {
    console.warn(`[hf-sidecar] terminating stale HF runtime pid=${pid} reason=${reason} command=${command || 'unknown command'}`);
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  for (const [pid, command] of ordered) {
    if (!await waitForPidExit(pid)) {
      console.warn(`[hf-sidecar] stale HF runtime pid=${pid} did not exit after SIGTERM; sending SIGKILL command=${command || 'unknown command'}`);
      try { process.kill(pid, 'SIGKILL'); } catch {}
      await waitForPidExit(pid, 2500);
    }
  }
}

function poolKeepPids(extra = []) {
  const pids = [];
  for (const record of sidecarPool.values()) {
    if (record?.proc?.pid) pids.push(record.proc.pid);
  }
  if (sidecar && !sidecar.killed && sidecar.pid) pids.push(sidecar.pid);
  for (const pid of extra) pids.push(pid);
  return Array.from(new Set(pids.filter((pid) => Number.isFinite(pid) && pid > 1)));
}

async function dropDeadPoolRecords() {
  for (const [key, record] of sidecarPool.entries()) {
    if (!record?.proc?.pid || record.proc.killed || !await processAlive(record.proc.pid)) {
      sidecarPool.delete(key);
      releaseCerebrasAdapterCredential(record?.credentialToken, record);
      notifyHFAdmissionWaiters();
    }
  }
}

async function stopSidecarRecord(record, reason = 'restart') {
  if (!record) return;
  if (!record.proc || record.proc.killed) {
    if (record.port) reservedHFPorts.delete(record.port);
    releaseCerebrasAdapterCredential(record.credentialToken, record);
    notifyHFAdmissionWaiters();
    return;
  }
  const pid = record.proc.pid;
  console.warn(`[hf-sidecar] stopping pooled sidecar key=${record.key} pid=${pid} port=${record.port} reason=${reason}`);
  const killPids = new Map();
  if (pid) {
    killPids.set(pid, await processCommand(pid));
    for (const child of await processTreePids(pid, 6)) {
      killPids.set(child, await processCommand(child));
    }
  }
  const listenerPids = record.port ? await hfPortListenerPids(record.port) : [];
  for (const listenerPid of listenerPids) {
    const command = await processCommand(listenerPid);
    if (looksLikeVoiceClawHFCommand(command)) {
      killPids.set(listenerPid, command);
      for (const child of await processTreePids(listenerPid, 6)) {
        killPids.set(child, await processCommand(child));
      }
    }
  }
  await terminateHFProcessMap(killPids, reason);
  if (record.port) reservedHFPorts.delete(record.port);
  releaseCerebrasAdapterCredential(record.credentialToken, record);
  notifyHFAdmissionWaiters();
}

async function terminateHFPortListeners(reason = 'restart', port = HF_PORT) {
  const pids = await hfPortListenerPids(port);
  const killPids = new Map();
  for (const pid of pids) {
    const command = await processCommand(pid);
    if (!looksLikeVoiceClawHFCommand(command)) {
      throw new Error(`HF speech-to-speech port ${port} is already owned by non-VoiceClaw process ${pid}: ${command || 'unknown command'}`);
    }
    killPids.set(pid, command);
    for (const child of await processTreePids(pid, 6)) {
      killPids.set(child, await processCommand(child));
    }
    const parent = await parentPid(pid);
    const parentCommand = parent ? await processCommand(parent) : '';
    if (parent && looksLikeVoiceClawHFCommand(parentCommand)) {
      killPids.set(parent, parentCommand);
      for (const child of await processTreePids(parent, 6)) {
        killPids.set(child, await processCommand(child));
      }
    }
  }

  await terminateHFProcessMap(killPids, reason);
  const remaining = await hfPortListenerPids(port);
  if (remaining.length) {
    const details = [];
    for (const pid of remaining) details.push(`${pid}:${await processCommand(pid)}`);
    throw new Error(`Could not clear HF speech-to-speech port ${port}; still owned by ${details.join('; ')}`);
  }
}

async function cleanupStaleHFProcesses(reason = 'cleanup', { keepPids = [] } = {}) {
  const keep = new Set();
  for (const pid of keepPids) {
    if (!Number.isFinite(pid) || pid <= 1) continue;
    await addRuntimeTreeToSet(keep, pid);
  }
  const killPids = new Map();
  for (const entry of await voiceClawHFProcessEntries()) {
    if (keep.has(entry.pid)) continue;
    killPids.set(entry.pid, entry.command);
    for (const child of await processTreePids(entry.pid, 6)) {
      if (!keep.has(child)) killPids.set(child, await processCommand(child));
    }
  }
  await terminateHFProcessMap(killPids, reason);
}

async function selfHealHFRuntimeProcesses(reason = 'status-self-heal') {
  await dropDeadPoolRecords();
  const before = await hfRuntimeProcessSnapshot();
  if (/^(1|true|yes)$/i.test(String(process.env.VOICECLAW_HF_DISABLE_PROCESS_SELF_HEAL || ''))) {
    return { before, after: before, changed: false, disabled: true };
  }
  const keepPids = poolKeepPids();
  if (!keepPids.length) {
    if (before.trackedPid && before.trackedAlive) {
      keepPids.push(before.trackedPid);
    } else if (before.listenerCount === 1) {
      keepPids.push(before.listeners[0]);
    } else if (before.listenerCount > 1) {
      for (const listener of before.listenerDetails || []) {
        await terminateHFPortListeners(`${reason}-multiple-listeners`, listener.port || HF_PORT);
      }
    }
  }

  await cleanupStaleHFProcesses(reason, { keepPids });
  const after = await hfRuntimeProcessSnapshot();
  return {
    before,
    after,
    changed: before.processCount !== after.processCount
      || before.listenerCount !== after.listenerCount
      || before.entries.map((entry) => entry.pid).join(',') !== after.entries.map((entry) => entry.pid).join(','),
  };
}

async function stopCurrentSidecar(reason = 'restart') {
  if (!sidecar || sidecar.killed) {
    sidecar = null;
    sidecarKey = '';
    return;
  }
  const record = Array.from(sidecarPool.values()).find((item) => item.proc === sidecar) || {
    key: sidecarKey || 'current-sidecar',
    port: sidecarPort,
    proc: sidecar,
  };
  await stopSidecarRecord(record, reason);
  sidecar = null;
  sidecarKey = '';
}

export async function stopAllHFRealtimeSidecars(reason = 'shutdown') {
  const records = Array.from(sidecarPool.values());
  for (const record of records) {
    await stopSidecarRecord(record, reason).catch((error) => {
      console.warn(`[hf-sidecar] failed to stop pooled sidecar key=${record?.key || 'unknown'} reason=${reason}: ${error?.message || String(error)}`);
    });
    if (record?.key) sidecarPool.delete(record.key);
  }
  if (sidecar && !sidecar.killed) {
    await stopCurrentSidecar(reason).catch((error) => {
      console.warn(`[hf-sidecar] failed to stop current sidecar reason=${reason}: ${error?.message || String(error)}`);
    });
  }
  sidecar = null;
  sidecarKey = '';
  sidecarStarting = null;
  sidecarStartingByKey.clear();
  hfProcessAdmissionReservations.clear();
  reservedHFPorts.clear();
  notifyHFAdmissionWaiters();
  if (cerebrasResponsesAdapter) {
    await new Promise((resolve) => cerebrasResponsesAdapter.close(resolve)).catch(() => {});
    cerebrasResponsesAdapter = null;
    cerebrasResponsesAdapterBaseURL = '';
  }
  cerebrasAdapterCredentials.clear();
  cerebrasAdapterTokensByDigest.clear();
}

function installShutdownCleanup() {
  if (shutdownCleanupInstalled) return;
  shutdownCleanupInstalled = true;
  const cleanupAndExit = async (signal) => {
    if (shutdownCleanupStarted) {
      process.exit(signal === 'SIGINT' ? 130 : 143);
      return;
    }
    shutdownCleanupStarted = true;
    try {
      await stopAllHFRealtimeSidecars(`process-${signal}`);
    } finally {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      cleanupAndExit(signal).catch(() => {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
    });
  }
  process.once('exit', () => {
    for (const record of sidecarPool.values()) {
      try { record.proc?.kill?.('SIGTERM'); } catch {}
    }
    try { sidecar?.kill?.('SIGTERM'); } catch {}
  });
}

installShutdownCleanup();

async function verifyHFPortOwner(expectedRootPid, port = HF_PORT) {
  const owners = await hfPortListenerPids(port);
  if (!owners.length) {
    return { ok: false, owners: [], reason: 'no-listener' };
  }
  const tree = await processTreePids(expectedRootPid);
  const matching = owners.filter((pid) => tree.has(pid));
  if (matching.length) {
    return { ok: true, owners, matching };
  }
  const details = [];
  for (const pid of owners) details.push(`${pid}:${await processCommand(pid)}`);
  return { ok: false, owners, reason: `owned-by-other-process:${details.join('; ')}` };
}

async function withPortAllocationLock(fn) {
  const previous = portAllocationLock;
  let release = () => {};
  portAllocationLock = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function withAdmissionLock(fn) {
  const previous = admissionLock;
  let release = () => {};
  admissionLock = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function notifyHFAdmissionWaiters() {
  const waiters = Array.from(hfAdmissionWaiters);
  hfAdmissionWaiters.clear();
  for (const waiter of waiters) waiter.resolve();
}

async function waitForHFAdmissionChange({
  signal = null,
  deadlineAt = 0,
  admissionDeadlineAt = 0,
  onQueued = null,
  key = '',
  reason = 'capacity',
} = {}) {
  const configuredAdmissionDeadline = admissionDeadlineAt || (Date.now() + HF_ADMISSION_TIMEOUT_MS);
  const queueDeadlineAt = deadlineAt
    ? Math.min(deadlineAt, configuredAdmissionDeadline)
    : configuredAdmissionDeadline;
  throwIfOperationCancelled({ signal, deadlineAt: queueDeadlineAt });
  if (hfAdmissionWaiters.size >= HF_MAX_ADMISSION_WAITERS) {
    const error = new Error(`HF runtime admission queue is full (${HF_MAX_ADMISSION_WAITERS} waiters).`);
    error.code = 'HF_ADMISSION_QUEUE_FULL';
    throw error;
  }
  const queuedAt = Date.now();
  const position = hfAdmissionWaiters.size + 1;
  try {
    onQueued?.({
      key,
      reason,
      position,
      poolSize: HF_POOL_SIZE,
      activeProcesses: new Set([...sidecarPool.keys(), ...hfProcessAdmissionReservations]).size,
      pipelineCapacity: VOICECLAW_HF_NUM_PIPELINES,
      deadlineAt: queueDeadlineAt,
    });
  } catch {}
  await new Promise((resolve, reject) => {
    let settled = false;
    let deadlineTimer = null;
    let pollTimer = null;
    const waiter = {
      resolve: () => finish(resolve),
    };
    const cleanup = () => {
      hfAdmissionWaiters.delete(waiter);
      signal?.removeEventListener?.('abort', onAbort);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (pollTimer) clearTimeout(pollTimer);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => finish(reject, makeAbortError(signal?.reason));
    hfAdmissionWaiters.add(waiter);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    pollTimer = setTimeout(() => finish(resolve), 250);
    pollTimer.unref?.();
    if (queueDeadlineAt) {
      deadlineTimer = setTimeout(() => {
        const error = new Error(`HF runtime admission timed out after ${Date.now() - queuedAt} ms.`);
        error.name = 'TimeoutError';
        error.code = 'HF_ADMISSION_TIMEOUT';
        finish(reject, error);
      }, Math.max(0, queueDeadlineAt - Date.now()));
      deadlineTimer.unref?.();
    }
  });
}

async function reserveHFProcessAdmission(key, operation = {}) {
  let queued = false;
  while (true) {
    throwIfOperationCancelled(operation);
    await dropDeadPoolRecords();
    const decision = await withAdmissionLock(async () => {
      if (sidecarStartingByKey.has(key) || hfProcessAdmissionReservations.has(key)) return { kind: 'starting' };
      if (sidecarPool.has(key)) return { kind: 'existing' };
      const occupied = new Set([...sidecarPool.keys(), ...hfProcessAdmissionReservations]).size;
      if (occupied < HF_POOL_SIZE) {
        hfProcessAdmissionReservations.add(key);
        return { kind: 'launch', evict: null };
      }
      const evict = Array.from(sidecarPool.values())
        .filter((record) => !record.evicting && Number(record.activeLeases || 0) === 0)
        .sort((a, b) => Number(a.lastUsedAt || a.startedAt || 0) - Number(b.lastUsedAt || b.startedAt || 0))[0];
      if (!evict) return null;
      evict.evicting = true;
      sidecarPool.delete(evict.key);
      hfProcessAdmissionReservations.add(key);
      return { kind: 'launch', evict };
    });
    if (decision?.kind === 'launch') {
      if (decision.evict) await stopSidecarRecord(decision.evict, 'bounded-pool-admission');
      return decision;
    }
    if (decision?.kind === 'existing') return decision;
    await waitForHFAdmissionChange({
      ...operation,
      key,
      reason: decision?.kind === 'starting' ? 'matching-runtime-starting' : 'process-capacity',
      onQueued: queued ? null : operation.onQueued,
    });
    queued = true;
  }
}

async function acquireHFSessionLease(key, record, operation = {}) {
  let queued = false;
  while (true) {
    throwIfOperationCancelled(operation);
    const health = record?.port
      ? await hfPoolHealth({ port: record.port, timeoutMs: 700, ...operation })
      : { reachable: false };
    throwIfOperationCancelled(operation);
    const reportedSize = Number(health.pool?.size);
    const reportedInUse = Number(health.pool?.in_use);
    const upstreamAtCapacity = health.reachable
      && Number.isFinite(reportedSize)
      && reportedSize > 0
      && Number.isFinite(reportedInUse)
      && reportedInUse >= reportedSize;
    const lease = await withAdmissionLock(async () => {
      const current = sidecarPool.get(key);
      if (current !== record || !record?.proc || record.proc.killed || record.evicting) return { stale: true };
      const active = Number(record.activeLeases || 0);
      if (active >= Number(record.pipelineCapacity || VOICECLAW_HF_NUM_PIPELINES) || upstreamAtCapacity) return null;
      record.activeLeases = active + 1;
      record.lastUsedAt = Date.now();
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          withAdmissionLock(async () => {
            record.activeLeases = Math.max(0, Number(record.activeLeases || 0) - 1);
            record.lastUsedAt = Date.now();
          }).finally(notifyHFAdmissionWaiters);
        },
      };
    });
    if (lease?.stale) {
      const error = new Error('HF runtime changed while waiting for a pipeline slot.');
      error.code = 'HF_ADMISSION_RUNTIME_CHANGED';
      throw error;
    }
    if (lease) return lease;
    await waitForHFAdmissionChange({
      ...operation,
      key,
      reason: upstreamAtCapacity ? 'pipeline-draining' : 'pipeline-capacity',
      onQueued: queued ? null : operation.onQueued,
    });
    queued = true;
  }
}

async function allocateHFPoolPort(preferredPort = HF_PORT) {
  return await withPortAllocationLock(async () => {
  await dropDeadPoolRecords();
  const used = new Set([
    ...Array.from(sidecarPool.values()).map((record) => record.port).filter(Boolean),
    ...Array.from(reservedHFPorts),
  ]);
  const candidates = [
    preferredPort,
    ...Array.from({ length: HF_POOL_SIZE }, (_, index) => HF_PORT + index),
  ];
  for (const port of Array.from(new Set(candidates))) {
    if (used.has(port)) continue;
    const listeners = await hfPortListenerPids(port);
    if (!listeners.length) {
      reservedHFPorts.add(port);
      return port;
    }
    let voiceClawOwned = true;
    for (const pid of listeners) {
      const command = await processCommand(pid);
      if (!looksLikeVoiceClawHFCommand(command)) voiceClawOwned = false;
    }
    if (voiceClawOwned) {
      await terminateHFPortListeners('pool-port-reclaim', port);
      reservedHFPorts.add(port);
      return port;
    }
  }
  const error = new Error(`All ${HF_POOL_SIZE} configured HF sidecar ports are occupied.`);
  error.code = 'HF_PROCESS_CAPACITY_EXHAUSTED';
  throw error;
  });
}

function preferredHFPoolPortForKey(key = '') {
  const text = String(key || '');
  if (!text || HF_POOL_SIZE <= 1) return HF_PORT;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return HF_PORT + (hash % HF_POOL_SIZE);
}

function safeReadDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeIsFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function safeIsNonEmptyDir(path) {
  try {
    const entries = readdirSync(path, { withFileTypes: true });
    return entries.some((entry) => {
      const child = join(path, entry.name);
      return entry.isFile() || (entry.isDirectory() && safeIsNonEmptyDir(child));
    });
  } catch {
    return false;
  }
}

function hubCacheRepoPath(modelID = '') {
  const clean = String(modelID || '').trim();
  if (!clean) return '';
  const parts = clean.split('/').filter(Boolean);
  if (parts.length === 1) return join(HF_HOME, 'hub', `models--${parts[0]}`);
  return join(HF_HOME, 'hub', `models--${parts.join('--')}`);
}

function snapshotPatternPresent(snapshotPath, pattern = '') {
  const clean = String(pattern || '').trim();
  if (!clean) return safeIsNonEmptyDir(snapshotPath);
  if (!clean.includes('*')) return safeIsFile(join(snapshotPath, clean));
  const slashIndex = clean.lastIndexOf('/');
  const dir = slashIndex >= 0 ? clean.slice(0, slashIndex) : '';
  const filePattern = slashIndex >= 0 ? clean.slice(slashIndex + 1) : clean;
  const escaped = filePattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*');
  const re = new RegExp(`^${escaped}$`);
  return safeReadDir(join(snapshotPath, dir)).some((entry) => entry.isFile() && re.test(entry.name));
}

function hfModelSnapshotLooksCached(modelID, allowPatterns = null) {
  const repoPath = hubCacheRepoPath(modelID);
  if (!repoPath || !existsSync(repoPath)) return false;
  const snapshotsPath = join(repoPath, 'snapshots');
  const snapshots = safeReadDir(snapshotsPath).filter((entry) => entry.isDirectory());
  if (!snapshots.length) return false;
  for (const snapshot of snapshots) {
    const snapshotPath = join(snapshotsPath, snapshot.name);
    if (Array.isArray(allowPatterns) && allowPatterns.length) {
      if (allowPatterns.every((pattern) => snapshotPatternPresent(snapshotPath, pattern))) return true;
    } else if (safeIsNonEmptyDir(snapshotPath)) {
      return true;
    }
  }
  return false;
}

async function hfModelCached(modelID, allowPatterns = null) {
  if (!existsSync(HF_PYTHON)) return false;
  const key = `${modelID}\n${JSON.stringify(allowPatterns || [])}`;
  const cached = hfModelCache.get(key);
  if (cached && Date.now() - cached.at < HF_CACHE_CHECK_TTL_MS) return cached.value;
  if (hfModelSnapshotLooksCached(modelID, allowPatterns)) {
    hfModelCache.set(key, { at: Date.now(), value: true });
    return true;
  }
  if (hfModelCacheInFlight.has(key)) return await hfModelCacheInFlight.get(key);
  const promise = (async () => {
    try {
      await runCommand(HF_PYTHON, ['-c', [
        'from huggingface_hub import snapshot_download',
        'import json, sys',
        'patterns = json.loads(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else None',
        'snapshot_download(sys.argv[1], local_files_only=True, allow_patterns=patterns)',
      ].join('; '), modelID, allowPatterns ? JSON.stringify(allowPatterns) : ''], {
        timeoutMs: HF_CACHE_CHECK_TIMEOUT_MS,
        env: hfRuntimeEnv(),
      });
      hfModelCache.set(key, { at: Date.now(), value: true });
      return true;
    } catch {
      hfModelCache.set(key, { at: Date.now(), value: false });
      return false;
    } finally {
      hfModelCacheInFlight.delete(key);
    }
  })();
  hfModelCacheInFlight.set(key, promise);
  return await promise;
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
      return [
        { id: 'stt-mlx-audio-whisper', label: `MLX Audio Whisper ${settings.model}`, model: settings.model },
        {
          id: 'stt-mlx-audio-whisper-processor',
          label: 'Whisper large-v3 processor files for MLX Audio',
          model: 'openai/whisper-large-v3',
          allowPatterns: [
            'config.json',
            'generation_config.json',
            'preprocessor_config.json',
            'tokenizer.json',
            'tokenizer_config.json',
            'special_tokens_map.json',
            'vocab.json',
            'merges.txt',
            'normalizer.json',
          ],
        },
      ];
    case 'parakeet-tdt':
      return [{ id: 'stt-parakeet-tdt', label: 'Parakeet TDT live speech-to-text', model: settings.model }];
    default:
      return [];
  }
}

function requiredTTSPythonModules(ttsConfig = {}) {
  if (ttsConfig.engine === 'kokoro' && ttsConfig.device === 'cpu') {
    return [
      { module: 'kokoro', package: 'kokoro>=0.9.2', versionPackage: 'kokoro', label: 'Native Kokoro CPU text-to-speech runtime' },
      { module: 'soundfile', package: 'soundfile', label: 'SoundFile audio writer for native Kokoro' },
    ];
  }
  if (ttsConfig.engine === 'kokoro' && ttsConfig.device === 'mps') {
    return [
      { module: 'mlx_audio', package: 'mlx-audio', label: 'MLX Audio Kokoro text-to-speech runtime' },
      { module: 'misaki', package: 'misaki', label: 'Kokoro phonemizer runtime' },
    ];
  }
  return [];
}

function requiredTTSModels(ttsConfig = {}) {
  if (ttsConfig.engine === 'qwen3') {
    return [{
      id: 'tts-qwen3',
      label: 'Qwen3 local text-to-speech',
      model: HF_DEFAULT_TTS_MODEL,
    }];
  }
  if (ttsConfig.engine === 'kokoro') {
    if (ttsConfig.device === 'cpu') {
      return [
        {
          id: 'tts-kokoro-native',
          label: 'Native Kokoro local text-to-speech',
          model: ttsConfig.model || HF_NATIVE_KOKORO_MODEL,
          allowPatterns: ['config.json', 'kokoro-v1_0.pth'],
        },
        {
          id: 'tts-kokoro-native-voices',
          label: 'Native Kokoro voice tensors',
          model: ttsConfig.model || HF_NATIVE_KOKORO_MODEL,
          allowPatterns: ['voices/*.pt'],
        },
      ];
    }
    return [
      {
        id: 'tts-kokoro',
        label: 'Kokoro local text-to-speech',
        model: ttsConfig.model || HF_DEFAULT_KOKORO_MODEL,
      },
      {
        id: 'tts-kokoro-voices',
        label: 'Kokoro voice tensors',
        model: HF_KOKORO_VOICE_MODEL,
        allowPatterns: ['voices/*.safetensors'],
      },
    ];
  }
  return [];
}

function normalizeBrainMode(value = '') {
  const clean = String(value || '').trim();
  if (clean.toLowerCase() === 'qwen3.5-2b') return 'qwen3.5-0.8b';
  if (!clean || clean === 'local' || clean === 'qwen' || clean === 'qwen35' || clean === 'qwen3.5') return 'qwen3.5-0.8b';
  if (clean === 'cerebras') return `cerebras:${HF_DEFAULT_CEREBRAS_MODEL}`;
  if (['gpt-5.4', 'gpt54', 'gpt-54', 'gpt-5-4', 'openai/gpt-5.4'].includes(clean.toLowerCase())) return 'gpt-5.4';
  if (['gpt-5.4-mini', 'gpt54-mini', 'gpt54mini', 'gpt-54-mini', 'openai/gpt-5.4-mini'].includes(clean.toLowerCase())) return 'gpt-5.4-mini';
  if (['gpt-5.4-nano', 'gpt54-nano', 'gpt54nano', 'gpt-54-nano', 'openai/gpt-5.4-nano'].includes(clean.toLowerCase())) return 'gpt-5.4-mini';
  return clean;
}

function openAIBrainModelForMode(brainMode = '') {
  return HF_OPENAI_BRAIN_MODELS[normalizeBrainMode(brainMode)] || null;
}

function localMiddleBrainRequired(brainMode = '') {
  const normalized = normalizeBrainMode(brainMode);
  return normalized === 'qwen3.5-0.8b';
}

function openAIMiddleBrainRequired(brainMode = '') {
  return !!openAIBrainModelForMode(brainMode);
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

async function warmNativeKokoroRuntime(ttsConfig = {}) {
  if (ttsConfig.engine !== 'kokoro' || ttsConfig.device !== 'cpu') return;
  const langCode = process.env.VOICECLAW_HF_KOKORO_LANG || 'a';
  await runCommand(HF_PYTHON, ['-c', [
    'from kokoro import KPipeline',
    'import sys',
    'KPipeline(lang_code=sys.argv[1])',
  ].join('; '), langCode], {
    timeoutMs: HF_INSTALL_TIMEOUT_MS,
    env: hfRuntimeEnv(),
  });
}

function hfRealtimePrepareProfiles(set = 'selected') {
  const normalized = String(set || '').trim().toLowerCase();
  if (!normalized || normalized === 'selected' || normalized === 'none') return [];
  const profiles = [
    {
      id: 'local-qwen-parakeet-kokoro',
      label: 'Local Qwen 3.5 0.8B + Parakeet Live STT + Kokoro TTS',
      required: true,
      options: { brainMode: 'qwen3.5-0.8b', sttProfile: 'parakeet-live', localVoice: 'kokoro-af-heart' },
    },
    {
      id: 'local-qwen-fast-whisper-kokoro',
      label: 'Local Qwen 3.5 0.8B + Faster Whisper Fast STT + Kokoro TTS',
      required: false,
      options: { brainMode: 'qwen3.5-0.8b', sttProfile: 'faster-whisper-fast', localVoice: 'kokoro-af-heart' },
    },
    {
      id: 'local-qwen-balanced-whisper-kokoro',
      label: 'Local Qwen 3.5 0.8B + Faster Whisper Balanced STT + Kokoro TTS',
      required: false,
      options: { brainMode: 'qwen3.5-0.8b', sttProfile: 'faster-whisper-balanced', localVoice: 'kokoro-af-heart' },
    },
  ];
  if (normalized === 'full') {
    profiles.push({
      id: 'local-qwen-mlx-whisper-kokoro',
      label: 'Local Qwen 3.5 0.8B + Whisper MLX Accurate STT + Kokoro TTS',
      required: false,
      options: { brainMode: 'qwen3.5-0.8b', sttProfile: 'mlx-whisper-accurate', localVoice: 'kokoro-af-heart' },
    });
  }
  return profiles;
}

function dedupeInstallItems(items = []) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = `${item.id || ''}\n${item.command || ''}\n${item.label || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function defaultHFRealtimePrewarmPayload(options = {}) {
  const profile = hfRealtimePrepareProfiles(options.prepareSet || 'recommended')[0];
  return {
    ...(profile?.options || { brainMode: 'qwen3.5-0.8b', sttProfile: 'parakeet-live', localVoice: 'kokoro-af-heart' }),
    ...(options || {}),
    prepareSet: '',
  };
}

function hfRealtimeProfileKey(options = {}) {
  return JSON.stringify({
    brainMode: normalizeBrainMode(options.brainMode || 'qwen3.5-0.8b'),
    sttProfile: normalizeSTTProfile(options.sttProfile || ''),
    localVoice: String(options.localVoice || options.voice || 'kokoro-af-heart').trim().toLowerCase(),
  });
}

function hfSidecarIdentityKey(options = {}, identity = {}) {
  const brainMode = normalizeBrainMode(options.brainMode || 'qwen3.5-0.8b');
  const sttConfig = sttProfileConfig(options.sttProfile || options.sttQualityProfile || '');
  const ttsConfig = ttsConfigForHF(options);
  const prefix = brainMode.startsWith('cerebras:')
    ? `cerebras:${normalizeCerebrasModel(String(options.cerebrasModel || brainMode.slice('cerebras:'.length) || HF_DEFAULT_CEREBRAS_MODEL))}:auth:${identity.providerCredentialFingerprint || credentialFingerprint(cerebrasKeyFromPayload(options))}`
    : openAIBrainModelForMode(brainMode)
      ? `openai:${openAIBrainModelForMode(brainMode).model}:auth:${identity.authSource || 'session'}:${identity.providerCredentialFingerprint || credentialFingerprint(openAIKeyFromPayload(options))}`
    : `local:${HF_DEFAULT_LOCAL_MODEL}`;
  return `${prefix}:stt:${sttConfig.id}:tts:${ttsConfig.engine}:${ttsConfig.device || 'default'}:${ttsConfig.voice}`;
}

function primaryHFRealtimeProfileOptions(options = {}) {
  return {
    brainMode: normalizeBrainMode(options.brainMode || 'qwen3.5-0.8b'),
    sttProfile: normalizeSTTProfile(options.sttProfile || ''),
    localVoice: String(options.localVoice || options.voice || 'kokoro-af-heart').trim() || 'kokoro-af-heart',
  };
}

function hfRealtimeProfilesForPrepareSet(options = {}) {
  const primaryOptions = primaryHFRealtimeProfileOptions(options);
  const primaryKey = hfRealtimeProfileKey(primaryOptions);
  const profiles = hfRealtimePrepareProfiles(options.prepareSet || 'recommended').map((profile) => ({
    ...profile,
    required: profile.required || hfRealtimeProfileKey(profile.options) === primaryKey,
  }));
  if (!profiles.some((profile) => hfRealtimeProfileKey(profile.options) === primaryKey)) {
    profiles.unshift({
      id: 'primary',
      label: 'Primary Companion Realtime Voice configuration',
      required: true,
      options: primaryOptions,
    });
  }
  return profiles;
}

async function getHFRealtimeProfileSetStatus(options = {}) {
  const primaryOptions = primaryHFRealtimeProfileOptions(options);
  const primaryIdentityKey = hfSidecarIdentityKey(primaryOptions);
  const processHeal = options.allowProcessSelfHeal === true
    ? await selfHealHFRuntimeProcesses('explicit-profile-set-status-check').catch((error) => ({
      before: null,
      after: null,
      changed: false,
      error: error?.message || String(error),
    }))
    : { before: null, after: await hfRuntimeProcessSnapshot(), changed: false, skipped: true };
  const primaryRecord = sidecarPool.get(primaryIdentityKey);
  const healthPort = primaryRecord?.proc && !primaryRecord.proc.killed
    ? primaryRecord.port
    : sidecarKey === primaryIdentityKey && sidecar && !sidecar.killed
      ? sidecarPort
      : preferredHFPoolPortForKey(primaryIdentityKey);
  const health = await hfPoolHealth({ port: healthPort });
  const primaryKey = hfRealtimeProfileKey(primaryOptions);
  const profiles = hfRealtimeProfilesForPrepareSet(options);
  const preparedProfiles = [];
  for (const profile of profiles) {
    const status = await getHFRealtimeSingleStatus({ ...profile.options, prepareSet: '', skipProcessSelfHeal: true, skipHealth: true });
    preparedProfiles.push({
      id: profile.id,
      label: profile.label,
      required: profile.required,
      state: status.state,
      summary: status.summary,
      brainMode: status.brainMode,
      sttProfile: status.sttProfile,
      sttProfileLabel: status.sttProfileLabel,
      ttsEngine: status.ttsEngine,
      ttsDevice: status.ttsDevice,
      ttsVoice: status.ttsVoice,
      missingRequiredModels: status.missingRequiredModels || [],
      missingSTTModules: status.missingSTTModules || [],
      missingTTSModules: status.missingTTSModules || [],
      installPlan: status.installPlan || null,
    });
  }

  const primaryProfileIndex = Math.max(0, profiles.findIndex((profile) => hfRealtimeProfileKey(profile.options) === primaryKey));
  const primaryProfile = profiles[primaryProfileIndex] || profiles[0];
  const primary = primaryProfile
    ? await getHFRealtimeSingleStatus({ ...primaryProfile.options, prepareSet: '', skipProcessSelfHeal: true, skipHealth: true })
    : await getHFRealtimeSingleStatus({ ...options, skipProcessSelfHeal: true, skipHealth: true });
  const requiredMissing = preparedProfiles.filter((profile) => profile.required && profile.state !== 'ready');
  const allItems = dedupeInstallItems(preparedProfiles.flatMap((profile) => {
    const items = Array.isArray(profile.installPlan?.items) ? profile.installPlan.items : [];
    return items.map((item) => ({
      ...item,
      profileID: profile.id,
      profileLabel: profile.label,
    }));
  }));
  const installableCount = allItems.filter((item) => item.installable).length;
  const state = requiredMissing.length ? 'needs_setup' : 'ready';
  const summary = requiredMissing.length
    ? `Companion Realtime Voice needs setup before the primary/default realtime stack can run: ${requiredMissing.map((profile) => profile.label).join(', ')}.`
    : allItems.length
      ? `Companion Realtime Voice primary/default local stack is ready. ${allItems.length} additional recommended voice runtime item${allItems.length === 1 ? '' : 's'} can be installed now so alternate STT profiles are ready before the phone needs them.`
      : 'Companion Realtime Voice workstation is prepared: primary/default local realtime stack and recommended alternate STT profiles are installed.';

  return {
    ...primary,
    state,
    summary,
    prepareSet: options.prepareSet || 'recommended',
    preparedProfiles,
    processSelfHeal: {
      changed: !!processHeal.changed,
      error: processHeal.error || '',
      beforeProcessCount: processHeal.before?.processCount ?? null,
      afterProcessCount: processHeal.after?.processCount ?? null,
    },
    processes: processHeal.after || primary.processes || null,
    health,
    installPlan: {
      needed: allItems.length > 0,
      installable: true,
      summary: allItems.length
        ? `${allItems.length} Companion Realtime Voice preparation item${allItems.length === 1 ? '' : 's'} need attention; ${installableCount} can be installed automatically.`
        : 'No Companion Realtime Voice preparation items need installation.',
      installableCount,
      items: allItems,
    },
  };
}

async function fetchJSON(url, { timeoutMs = 2500, signal = null, deadlineAt = 0 } = {}) {
  const effectiveDeadline = deadlineAt
    ? Math.min(deadlineAt, Date.now() + timeoutMs)
    : Date.now() + timeoutMs;
  const linked = linkedAbortController([signal], effectiveDeadline);
  try {
    const response = await fetch(url, { signal: linked.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    linked.cleanup();
  }
}

async function hfPoolHealth({ timeoutMs = 700, port = HF_PORT, signal = null, deadlineAt = 0 } = {}) {
  try {
    const pool = await fetchJSON(`${hfHttpBase(port)}/v1/pool`, { timeoutMs, signal, deadlineAt });
    return { reachable: true, pool };
  } catch (error) {
    if (signal?.aborted) throw makeAbortError(signal.reason);
    if (deadlineAt && Date.now() >= deadlineAt) {
      const deadlineError = new Error('HF pool health deadline exceeded');
      deadlineError.name = 'TimeoutError';
      deadlineError.code = 'DEADLINE_EXCEEDED';
      throw deadlineError;
    }
    return { reachable: false, error: error?.message || String(error) };
  }
}

export async function getHFRealtimeStatus(options = {}) {
  if (options.prepareSet) return await getHFRealtimeProfileSetStatus(options);
  return await getHFRealtimeSingleStatus(options);
}

async function getHFRealtimeSingleStatus(options = {}) {
  const brainMode = normalizeBrainMode(options.brainMode || process.env.VOICECLAW_HF_BRAIN_MODE || 'qwen3.5-0.8b');
  const sttProfile = normalizeSTTProfile(options.sttProfile || process.env.VOICECLAW_HF_STT_PROFILE || '');
  const sttConfig = sttProfileConfig(sttProfile);
  const ttsConfig = ttsConfigForHF(options);
  const shouldSelfHeal = options.allowProcessSelfHeal === true && options.skipProcessSelfHeal !== true;
  const processHeal = shouldSelfHeal
    ? await selfHealHFRuntimeProcesses('explicit-single-status-check').catch((error) => ({
      before: null,
      after: null,
      changed: false,
      error: error?.message || String(error),
    }))
    : { before: null, after: await hfRuntimeProcessSnapshot(), changed: false, skipped: true };
  const requireLocalMiddleBrain = localMiddleBrainRequired(brainMode);
  const requireOpenAIBearer = openAIMiddleBrainRequired(brainMode);
  const requireCerebrasKey = cerebrasMiddleBrainRequired(brainMode);
  const pythonReady = await fileExecutable(HF_PYTHON);
  const cliReady = await fileExecutable(HF_CLI);
  const packageReady = await pythonCanImport('speech_to_speech');
  const mlxReady = await pythonCanImport('mlx');
  const mlxAudioReady = await pythonCanImport('mlx_audio');
  const sttModuleStatuses = [];
  for (const item of requiredSTTPythonModules(sttProfile)) {
    const version = await pythonPackageVersion(item.versionPackage || item.package);
    const importReady = version ? true : await pythonCanImport(item.module);
    sttModuleStatuses.push({
      ...item,
      ready: importReady || !!version,
      importReady,
      version,
      required: true,
    });
  }
  const ttsModuleStatuses = [];
  for (const item of requiredTTSPythonModules(ttsConfig)) {
    const version = await pythonPackageVersion(item.versionPackage || item.package);
    const importReady = version ? true : await pythonCanImport(item.module);
    ttsModuleStatuses.push({
      ...item,
      ready: importReady || !!version,
      importReady,
      version,
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
  const ttsRequiredModels = [];
  for (const model of requiredTTSModels(ttsConfig)) {
    ttsRequiredModels.push({
      ...model,
      cached: pythonReady ? await hfModelCached(model.model, model.allowPatterns || null) : false,
      required: true,
    });
  }
  const localModelCached = pythonReady ? await hfModelCached(HF_DEFAULT_LOCAL_MODEL) : false;
  const openAIBearerStatus = requireOpenAIBearer
    ? await openAIResponsesBearerReadyForHF(options)
    : { ready: true, source: 'not-required', fingerprint: 'none', error: '' };
  const requestedKey = hfSidecarIdentityKey({
    ...options,
    brainMode,
    sttProfile,
    localVoice: options.localVoice || options.voice || ttsConfig.voice,
  }, {
    authSource: openAIBearerStatus.source,
    providerCredentialFingerprint: requireOpenAIBearer
      ? openAIBearerStatus.fingerprint
      : requireCerebrasKey
        ? credentialFingerprint(cerebrasKeyFromPayload(options))
        : 'none',
  });
  const requestedRecord = sidecarPool.get(requestedKey);
  const requestedSidecarRunning = !!requestedRecord?.proc && !requestedRecord.proc.killed;
  const healthPort = requestedSidecarRunning
    ? requestedRecord.port
    : sidecarKey === requestedKey && sidecar && !sidecar.killed
      ? sidecarPort
      : preferredHFPoolPortForKey(requestedKey);
  const health = options.skipHealth ? null : await hfPoolHealth({ port: healthPort });
  const runtimeReady = pythonReady && cliReady && packageReady;
  const requiredModels = [
    ...sttRequiredModels,
    ...ttsRequiredModels,
    { id: 'middle-qwen35-800m-local', label: 'Qwen 3.5 0.8B local Companion Realtime Voice LLM', model: HF_DEFAULT_LOCAL_MODEL, cached: localModelCached, required: requireLocalMiddleBrain },
  ];
  const openAIBearerReady = !requireOpenAIBearer || openAIBearerStatus.ready;
  const cerebrasKeyReady = !requireCerebrasKey || !!cerebrasKeyFromPayload(options);
  const missingSTTModules = sttModuleStatuses.filter((item) => item.required && !item.ready);
  const missingTTSModules = ttsModuleStatuses.filter((item) => item.required && !item.ready);
  const missingRequiredModels = requiredModels.filter((model) => model.required && !model.cached);
  const dependenciesReady = runtimeReady && missingSTTModules.length === 0 && missingTTSModules.length === 0 && missingRequiredModels.length === 0 && openAIBearerReady && cerebrasKeyReady;
  const streamingReady = !!(dependenciesReady && (requestedSidecarRunning || (sidecarKey === requestedKey && !!sidecar && !sidecar.killed)) && health?.reachable);
  const ready = dependenciesReady;
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
    ...missingTTSModules.map((item) => ({
      id: item.module,
      label: item.label,
      detail: `Installs ${item.package}, required by the selected ${ttsConfig.engine} TTS runtime.`,
      installable: true,
      command: `${HF_PYTHON} -m pip install ${item.package}`,
    })),
    ...missingRequiredModels.map((model) => ({
      id: model.id,
      label: model.label,
      detail: `Downloads ${model.model} into the local Hugging Face cache so first voice use does not stall.`,
      installable: true,
      command: model.allowPatterns
        ? `${HF_PYTHON} -c "from huggingface_hub import snapshot_download; snapshot_download('${model.model}', allow_patterns=${JSON.stringify(model.allowPatterns)})"`
        : `${HF_PYTHON} -c "from huggingface_hub import snapshot_download; snapshot_download('${model.model}')"`,
    })),
    ...(!cerebrasKeyReady ? [{
      id: 'cerebras-api-key',
      label: 'Cerebras API key',
      detail: 'Add a Cerebras API key in VoiceClaw Realtime Companion or sync it from VoiceClaw Realtime before using the Cerebras Companion Realtime Voice LLM.',
      installable: false,
      command: 'manual setup required',
    }] : []),
    ...(!openAIBearerReady ? [{
      id: 'openai-responses-bearer',
      label: 'OpenAI Responses authentication',
      detail: openAIBearerStatus.error || 'Sync Companion ChatGPT OAuth or enable API-key fallback before using an OpenAI model as the Companion Realtime Voice LLM.',
      installable: false,
      command: 'manual setup required',
    }] : []),
  ];
  return {
    state: ready ? 'ready' : 'needs_setup',
    summary: ready
      ? `HF speech-to-speech runtime is ready for ${HF_STT_PROFILE_OPTIONS.find((item) => item.id === sttProfile)?.label || sttProfile} at ${HF_ROOT}.`
      : `HF speech-to-speech runtime or selected STT profile needs setup for ${HF_STT_PROFILE_OPTIONS.find((item) => item.id === sttProfile)?.label || sttProfile} at ${HF_ROOT}.`,
    dependencyState: dependenciesReady ? 'ready' : 'needs_setup',
    dependenciesReady,
    streamingReady,
    streamingSummary: streamingReady
      ? `HF streaming sidecar is listening on ${hfWsURL(healthPort)}.`
      : dependenciesReady
        ? 'HF runtime dependencies are ready, but the streaming sidecar is not currently listening. It will be started when Companion Realtime Voice opens.'
        : 'HF streaming sidecar is waiting for required runtime dependencies.',
    root: HF_ROOT,
    python: pythonReady ? HF_PYTHON : '',
    cli: cliReady ? HF_CLI : '',
    packageReady,
    mlxReady,
    mlxAudioReady,
    runtimeReady,
    brainMode,
    requireLocalMiddleBrain,
    requireOpenAIKey: requireOpenAIBearer,
    openAIKeyReady: openAIBearerReady,
    requireOpenAIBearer,
    openAIBearerReady,
    openAIBearerSource: openAIBearerStatus.source,
    openAIBearerError: openAIBearerStatus.error,
    requireCerebrasKey,
    cerebrasKeyReady,
    sttProfile,
    sttProfileLabel: HF_STT_PROFILE_OPTIONS.find((item) => item.id === sttProfile)?.label || sttProfile,
    sttProfiles: HF_STT_PROFILE_OPTIONS,
    sttBackend: sttConfig.backend,
    liveTranscriptionEnabled: !!sttConfig.liveTranscription,
    ttsEngine: ttsConfig.engine,
    ttsVoice: ttsConfig.voice,
    ttsDevice: ttsConfig.device || '',
    ttsModel: ttsConfig.model || '',
    sttModules: sttModuleStatuses,
    ttsModules: ttsModuleStatuses,
    requiredModels,
    missingSTTModules,
    missingTTSModules,
    missingRequiredModels,
    host: HF_HOST,
    port: healthPort,
    wsURL: hfWsURL(healthPort),
    numPipelines: VOICECLAW_HF_NUM_PIPELINES,
    aggressiveThreads: VOICECLAW_AGGRESSIVE_THREADS,
    sidecarRunning: requestedSidecarRunning || (sidecarKey === requestedKey && !!sidecar && !sidecar.killed),
    sidecarKey: requestedSidecarRunning ? requestedKey : sidecarKey === requestedKey ? sidecarKey : '',
    sidecarPort: requestedSidecarRunning ? requestedRecord.port : sidecarKey === requestedKey ? sidecarPort : 0,
    sidecarPool: Array.from(sidecarPool.values()).map((record) => ({
      key: record.key,
      port: record.port,
      wsURL: record.wsURL,
      pid: record.proc?.pid || 0,
      startedAt: record.startedAt,
      activeLeases: Number(record.activeLeases || 0),
      pipelineCapacity: Number(record.pipelineCapacity || VOICECLAW_HF_NUM_PIPELINES),
    })),
    health,
    processSelfHeal: {
      changed: !!processHeal.changed,
      skipped: !!processHeal.skipped,
      error: processHeal.error || '',
      beforeProcessCount: processHeal.before?.processCount ?? null,
      afterProcessCount: processHeal.after?.processCount ?? null,
    },
    processes: processHeal.after,
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
    const profiles = options.prepareSet ? hfRealtimeProfilesForPrepareSet(options) : [];
    if (profiles.length) {
      for (const profile of profiles) {
        await installHFRealtimeRuntimeForProfile(profile.options);
      }
      return await getHFRealtimeStatus(options);
    }
    await installHFRealtimeRuntimeForProfile(options);
    return await getHFRealtimeStatus(options);
  })();
  try {
    return await installInFlight;
  } finally {
    installInFlight = null;
  }
}

async function installHFRealtimeRuntimeForProfile(options = {}) {
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
  const ttsConfig = ttsConfigForHF(options);
  for (const item of requiredTTSPythonModules(ttsConfig)) {
    await runCommand(HF_PYTHON, ['-m', 'pip', 'install', '--upgrade', item.package], {
      timeoutMs: HF_INSTALL_TIMEOUT_MS,
    });
  }
  for (const model of requiredSTTModels(sttProfile)) {
    await prefetchHFModel(model.model, model.allowPatterns || null);
  }
  for (const model of requiredTTSModels(ttsConfig)) {
    await prefetchHFModel(model.model, model.allowPatterns || null);
  }
  await warmNativeKokoroRuntime(ttsConfig);
  if (localMiddleBrainRequired(options.brainMode || process.env.VOICECLAW_HF_BRAIN_MODE || 'qwen3.5-0.8b')) {
    await prefetchHFModel(HF_DEFAULT_LOCAL_MODEL);
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

function pruneCerebrasAdapterCredentials() {
  const inUse = new Set(Array.from(sidecarPool.values()).map((record) => record.credentialToken).filter(Boolean));
  const oldestAllowed = Date.now() - HF_TOMBSTONE_TTL_MS;
  for (const [token, entry] of cerebrasAdapterCredentials) {
    if (!inUse.has(token) && entry.lastUsedAt < oldestAllowed) releaseCerebrasAdapterCredential(token);
  }
  while (cerebrasAdapterCredentials.size >= HF_MAX_ADMISSION_WAITERS) {
    const removable = Array.from(cerebrasAdapterCredentials.entries())
      .filter(([token]) => !inUse.has(token))
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
    if (!removable) break;
    releaseCerebrasAdapterCredential(removable[0]);
  }
}

function registerCerebrasAdapterCredential(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('Cerebras API key is required for the local Responses adapter.');
  const digest = credentialDigest(key);
  const existingToken = cerebrasAdapterTokensByDigest.get(digest);
  if (existingToken) {
    const existing = cerebrasAdapterCredentials.get(existingToken);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return { token: existingToken, fingerprint: digest.slice(0, 24) };
    }
    cerebrasAdapterTokensByDigest.delete(digest);
  }
  pruneCerebrasAdapterCredentials();
  const token = `vc_cerebras_${randomUUID().replace(/-/g, '')}`;
  cerebrasAdapterCredentials.set(token, {
    apiKey: key,
    digest,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  });
  cerebrasAdapterTokensByDigest.set(digest, token);
  return { token, fingerprint: digest.slice(0, 24) };
}

function releaseCerebrasAdapterCredential(token, releasingRecord = null) {
  const clean = String(token || '');
  if (!clean) return;
  const usedByAnotherRecord = Array.from(sidecarPool.values()).some((record) => (
    record !== releasingRecord
    && record.credentialToken === clean
    && record.proc
    && !record.proc.killed
  ));
  if (usedByAnotherRecord) return;
  const entry = cerebrasAdapterCredentials.get(clean);
  cerebrasAdapterCredentials.delete(clean);
  if (entry && cerebrasAdapterTokensByDigest.get(entry.digest) === clean) {
    cerebrasAdapterTokensByDigest.delete(entry.digest);
  }
}

function cerebrasAdapterCredentialForRequest(req) {
  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = String(match?.[1] || req.headers['x-voiceclaw-provider-token'] || '').trim();
  const entry = cerebrasAdapterCredentials.get(token);
  if (!entry) return null;
  entry.lastUsedAt = Date.now();
  return { token, apiKey: entry.apiKey, fingerprint: entry.digest.slice(0, 24) };
}

function openAIKeyFromPayload(payload = {}) {
  const forwarded = String(payload.openAIAPIKey || payload.openAIApiKey || payload.openaiAPIKey || payload.openaiApiKey || payload.openaiKey || '').trim();
  if (forwarded) return forwarded;
  try {
    const parsed = JSON.parse(readFileSync(VOICECLAW_CONFIG, 'utf8'));
    const configured = String(parsed.openAIAPIKey || parsed.openAIApiKey || parsed.openaiAPIKey || parsed.openaiApiKey || parsed.apiKey || '').trim();
    if (configured) return configured;
  } catch {}
  return String(process.env.OPENAI_API_KEY || '').trim();
}

function openAIResponsesAPIKeyFallbackEnabled(payload = {}) {
  const cfg = readBridgeConfig();
  return parseRealtimeBoolean(
    payload.realtimeAuthFallbackToAPIKey
      ?? payload.openAIAPIKeyFallback
      ?? payload.apiKeyFallback
      ?? process.env.VOICECLAW_REALTIME_AUTH_FALLBACK_TO_API_KEY,
    parseRealtimeBoolean(cfg.realtimeAuthFallbackToAPIKey, false)
  );
}

async function resolveOpenAIResponsesBearerForHF(payload = {}) {
  let oauthError = null;
  try {
    const bearer = await resolveOpenAIChatGPTOAuthBearer(undefined, payload);
    if (bearer) {
      return { bearer, source: 'companion-oauth' };
    }
  } catch (error) {
    oauthError = error;
  }

  if (openAIResponsesAPIKeyFallbackEnabled(payload)) {
    const apiKey = openAIKeyFromPayload(payload);
    if (apiKey) {
      return { bearer: apiKey, source: 'api-key-fallback' };
    }
  }

  const apiNote = openAIResponsesAPIKeyFallbackEnabled(payload)
    ? 'API-key fallback is enabled, but no OpenAI API key was available.'
    : 'API-key fallback is off, so the HF OpenAI Responses branch will not use an API key.';
  throw new Error(`OpenAI-compatible Responses bearer is unavailable for the selected OpenAI Companion Realtime Voice LLM. ${oauthError?.message || oauthError || 'No Companion OAuth bearer found.'} ${apiNote}`);
}

async function openAIResponsesBearerReadyForHF(payload = {}) {
  try {
    const auth = await resolveOpenAIResponsesBearerForHF(payload);
    return { ready: !!auth.bearer, source: auth.source, fingerprint: credentialFingerprint(auth.bearer), error: '' };
  } catch (error) {
    return { ready: false, source: '', fingerprint: 'none', error: error?.message || String(error) };
  }
}

function normalizeCerebrasModel(model = '') {
  const clean = String(model || '').trim();
  if (!clean) return HF_DEFAULT_CEREBRAS_MODEL;
  if (clean === 'gemma-4-31B-it' || clean === 'google/gemma-4-31B-it:cerebras') return 'gemma-4-31b';
  return clean;
}

async function readJSONBody(req, limitBytes = 200 * 1024 * 1024, { signal = null } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    throwIfOperationCancelled({ signal });
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

async function cerebrasChatCompletion({ body = {}, apiKey = '', stream = false, signal = null } = {}) {
  const response = await fetch(`${CEREBRAS_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': stream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify(chatCompletionPayloadFromResponses(body, { stream })),
    signal,
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Cerebras Chat Completions returned HTTP ${response.status}: ${errorText.slice(0, 1000)}`);
  }
  return response;
}

async function handleCerebrasResponsesRequest(req, res) {
  const credential = cerebrasAdapterCredentialForRequest(req);
  const deadlineAt = Date.now() + HF_PROVIDER_REQUEST_TIMEOUT_MS;
  const requestAbort = linkedAbortController([], deadlineAt);
  const abortRequest = () => requestAbort.controller.abort(makeAbortError('Cerebras adapter client disconnected'));
  req.once('aborted', abortRequest);
  res.once('close', () => {
    if (!res.writableEnded) abortRequest();
  });
  try {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/responses')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not found' } }));
      return;
    }
    if (!credential) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unknown or expired VoiceClaw provider credential.' } }));
      return;
    }
    const body = await readJSONBody(req, 200 * 1024 * 1024, { signal: requestAbort.signal });
    const model = body.model || HF_DEFAULT_CEREBRAS_MODEL;
    const responseID = `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const stream = body.stream !== false;

    if (!stream) {
      const upstream = await cerebrasChatCompletion({ body, apiKey: credential.apiKey, stream: false, signal: requestAbort.signal });
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

    const upstream = await cerebrasChatCompletion({ body, apiKey: credential.apiKey, stream: true, signal: requestAbort.signal });
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
      throwIfOperationCancelled({ signal: requestAbort.signal, deadlineAt });
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
    if (requestAbort.signal.aborted && res.destroyed) return;
    if (!res.headersSent) {
      const status = error?.name === 'TimeoutError' || error?.code === 'DEADLINE_EXCEEDED' ? 504 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error?.message || String(error) } }));
    } else {
      writeSSE(res, {
        type: 'error',
        sequence_number: 999999,
        error: { message: error?.message || String(error) },
      });
      res.end();
    }
  } finally {
    requestAbort.cleanup();
  }
}

async function ensureCerebrasResponsesAdapter() {
  if (cerebrasResponsesAdapter) return cerebrasResponsesAdapterBaseURL;
  if (cerebrasResponsesAdapterStarting) return await cerebrasResponsesAdapterStarting;
  cerebrasResponsesAdapterStarting = (async () => {
    const port = CEREBRAS_RESPONSES_ADAPTER_PORT;
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
      cerebrasResponsesAdapterBaseURL = baseURL;
      return baseURL;
    } catch (error) {
      try { server.close(); } catch {}
      throw new Error(`Could not bind the Cerebras Responses adapter at ${CEREBRAS_RESPONSES_ADAPTER_HOST}:${port}: ${error?.message || String(error)}`);
    }
  })();
  try {
    return await cerebrasResponsesAdapterStarting;
  } finally {
    cerebrasResponsesAdapterStarting = null;
  }
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

function kokoroDeviceForHF(payload = {}) {
  const explicit = String(process.env.VOICECLAW_HF_KOKORO_DEVICE || '').trim().toLowerCase();
  if (['cpu', 'mps', 'cuda', 'auto'].includes(explicit)) return explicit;
  return 'cpu';
}

function ttsConfigForHF(payload = {}) {
  const localVoice = String(payload.localVoice || payload.voice || '').trim();
  const lower = localVoice.toLowerCase();
  let engine = String(HF_DEFAULT_TTS || 'auto').trim().toLowerCase();
  if (!engine || engine === 'auto') {
    if (lower.startsWith('qwen')) engine = 'qwen3';
    else if (lower.startsWith('pocket-')) engine = 'pocket';
    else engine = 'kokoro';
  }
  if (!['kokoro', 'pocket', 'qwen3'].includes(engine)) engine = 'kokoro';

  if (engine === 'pocket') {
    const voice = lower.startsWith('pocket-') ? localVoice.slice('pocket-'.length) : (process.env.VOICECLAW_HF_POCKET_VOICE || 'jean');
    return { engine, voice: voice || 'jean', model: '' };
  }
  if (engine === 'qwen3') {
    return { engine, voice: voiceForHF(localVoice, payload.voice, engine), model: HF_DEFAULT_TTS_MODEL };
  }
  const device = kokoroDeviceForHF(payload);
  return {
    engine: 'kokoro',
    voice: voiceForHF(localVoice, payload.voice, 'kokoro'),
    device,
    model: device === 'cpu' ? HF_NATIVE_KOKORO_MODEL : HF_DEFAULT_KOKORO_MODEL,
  };
}

function ttsArgsForHF(payload = {}, config = ttsConfigForHF(payload)) {
  const tts = config.engine;
  if (tts === 'pocket') {
    return [
      '--tts', 'pocket',
      '--pocket_tts_device', process.env.VOICECLAW_HF_POCKET_DEVICE || 'cpu',
      '--pocket_tts_voice', config.voice || process.env.VOICECLAW_HF_POCKET_VOICE || 'jean',
      '--pocket_tts_sample_rate', process.env.VOICECLAW_HF_POCKET_SAMPLE_RATE || '16000',
      '--pocket_tts_blocksize', process.env.VOICECLAW_HF_POCKET_BLOCKSIZE || '512',
      '--pocket_tts_max_tokens', process.env.VOICECLAW_HF_POCKET_MAX_TOKENS || '50',
    ];
  }
  if (tts === 'kokoro') {
    return [
      '--tts', 'kokoro',
      '--kokoro_device', config.device || process.env.VOICECLAW_HF_KOKORO_DEVICE || 'mps',
      '--kokoro_model_name', config.model || HF_DEFAULT_KOKORO_MODEL,
      '--kokoro_voice', config.voice || process.env.VOICECLAW_HF_KOKORO_VOICE || 'af_heart',
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

async function sidecarConfigFromPayload(payload = {}, { port = HF_PORT, signal = null, deadlineAt = 0 } = {}) {
  throwIfOperationCancelled({ signal, deadlineAt });
  const sttArgs = sttArgsForHF(payload);
  const ttsConfig = ttsConfigForHF(payload);
  const ttsArgs = ttsArgsForHF(payload, ttsConfig);
  const sttConfig = sttProfileConfig(payload.sttProfile || payload.sttQualityProfile || '');
  const liveTranscriptionArgs = sttConfig.liveTranscription
    ? ['--enable_live_transcription', '--live_transcription_min_silence_ms', process.env.VOICECLAW_HF_LIVE_TRANSCRIPTION_MIN_SILENCE_MS || '180']
    : [];
  const brainMode = normalizeBrainMode(payload.brainMode || '');
  if (brainMode.startsWith('cerebras:')) {
    const model = normalizeCerebrasModel(String(payload.cerebrasModel || brainMode.slice('cerebras:'.length) || HF_DEFAULT_CEREBRAS_MODEL));
    const key = cerebrasKeyFromPayload(payload);
    const credential = registerCerebrasAdapterCredential(key);
    const adapterBaseURL = await waitForOperation(ensureCerebrasResponsesAdapter(), { signal, deadlineAt });
    return {
      key: `cerebras:${model}:auth:${credential.fingerprint}:stt:${sttConfig.id}:tts:${ttsConfig.engine}:${ttsConfig.device || 'default'}:${ttsConfig.voice}`,
      credentialToken: credential.token,
      env: {
        OPENAI_API_KEY: credential.token,
      },
      args: [
        '--mode', 'realtime',
        '--ws_host', HF_HOST,
        '--ws_port', String(port),
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
        '--num_pipelines', String(VOICECLAW_HF_NUM_PIPELINES),
        '--log_level', process.env.VOICECLAW_HF_LOG_LEVEL || 'info',
      ],
      port,
      admission: {
        sampleRate: DEFAULT_HF_SAMPLE_RATE,
        channels: 1,
        encoding: 'pcm_s16le',
        bytesPerSample: 2,
        stt: { profile: sttConfig.id, backend: sttConfig.backend, model: sttConfig.model || '' },
        llm: { provider: 'cerebras', model, credentialFingerprint: credential.fingerprint },
        tts: { engine: ttsConfig.engine, model: ttsConfig.model || '', voice: ttsConfig.voice, device: ttsConfig.device || '' },
      },
    };
  }

  const openAIBrain = openAIBrainModelForMode(brainMode);
  if (openAIBrain) {
    const model = openAIBrain.model;
    const auth = await waitForOperation(resolveOpenAIResponsesBearerForHF(payload), { signal, deadlineAt });
    const authFingerprint = credentialFingerprint(auth.bearer);
    return {
      key: `openai:${model}:auth:${auth.source}:${authFingerprint}:stt:${sttConfig.id}:tts:${ttsConfig.engine}:${ttsConfig.device || 'default'}:${ttsConfig.voice}`,
      env: {
        OPENAI_API_KEY: auth.bearer,
      },
      args: [
        '--mode', 'realtime',
        '--ws_host', HF_HOST,
        '--ws_port', String(port),
        '--sample_rate', String(DEFAULT_HF_SAMPLE_RATE),
        ...sttArgs,
        '--llm_backend', 'responses-api',
        '--model_name', model,
        '--responses_api_base_url', process.env.VOICECLAW_HF_OPENAI_BASE_URL || 'https://api.openai.com/v1',
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
        '--num_pipelines', String(VOICECLAW_HF_NUM_PIPELINES),
        '--log_level', process.env.VOICECLAW_HF_LOG_LEVEL || 'info',
      ],
      port,
      admission: {
        sampleRate: DEFAULT_HF_SAMPLE_RATE,
        channels: 1,
        encoding: 'pcm_s16le',
        bytesPerSample: 2,
        stt: { profile: sttConfig.id, backend: sttConfig.backend, model: sttConfig.model || '' },
        llm: { provider: 'openai', model, authSource: auth.source, credentialFingerprint: authFingerprint },
        tts: { engine: ttsConfig.engine, model: ttsConfig.model || '', voice: ttsConfig.voice, device: ttsConfig.device || '' },
      },
    };
  }

  return {
    key: `local:${HF_DEFAULT_LOCAL_MODEL}:stt:${sttConfig.id}:tts:${ttsConfig.engine}:${ttsConfig.device || 'default'}:${ttsConfig.voice}`,
    env: {},
    args: [
      '--mode', 'realtime',
      '--ws_host', HF_HOST,
      '--ws_port', String(port),
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
      '--thresh', '0.5',
      '--min_silence_ms', '360',
      '--min_speech_ms', '384',
      '--speech_pad_ms', '240',
      '--num_pipelines', String(VOICECLAW_HF_NUM_PIPELINES),
      '--log_level', process.env.VOICECLAW_HF_LOG_LEVEL || 'info',
    ],
    port,
    admission: {
      sampleRate: DEFAULT_HF_SAMPLE_RATE,
      channels: 1,
      encoding: 'pcm_s16le',
      bytesPerSample: 2,
      stt: { profile: sttConfig.id, backend: sttConfig.backend, model: sttConfig.model || '' },
      llm: { provider: 'local', model: HF_DEFAULT_LOCAL_MODEL, device: 'mps' },
      tts: { engine: ttsConfig.engine, model: ttsConfig.model || '', voice: ttsConfig.voice, device: ttsConfig.device || '' },
    },
  };
}

async function appendLog(path, chunk) {
  try {
    await mkdir(HF_LOG_DIR, { recursive: true });
    await appendFile(path, chunk);
  } catch {}
}

async function launchHFRealtimeSidecarOnce(config, attempt, operation = {}) {
  throwIfOperationCancelled(operation);
  const port = config.port || HF_PORT;
  const existing = sidecarPool.get(config.key);
  if (existing) {
    const existingHealth = await hfPoolHealth({ port: existing.port, ...operation });
    if (existing.proc && !existing.proc.killed && existingHealth.reachable) {
      const owner = await verifyHFPortOwner(existing.proc.pid, existing.port);
      if (owner.ok) {
        sidecar = existing.proc;
        sidecarKey = existing.key;
        sidecarPort = existing.port;
        return {
          wsURL: existing.wsURL,
          key: existing.key,
          port: existing.port,
          health: existingHealth,
          admission: existing.admission,
          record: existing,
        };
      }
    }
    await stopSidecarRecord(existing, `tracked-sidecar-restart-attempt-${attempt}`);
    sidecarPool.delete(config.key);
  }
  await terminateHFPortListeners(`runtime-config-change-attempt-${attempt}`, port);

  await mkdir(HF_LOG_DIR, { recursive: true });
  sidecarKey = config.key;
  sidecarPort = port;
  console.log(`[hf-sidecar] launching key=${config.key} port=${port} attempt=${attempt}/${HF_START_ATTEMPTS} cli=${HF_CLI}`);
  const proc = await spawnHFRuntimeProcess(config);
  applyRealtimeProcessPolicy(proc.pid, config.key).catch(() => {});
  sidecar = proc;
  const record = {
    key: config.key,
    port,
    wsURL: hfWsURL(port),
    proc,
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
    activeLeases: 0,
    pipelineCapacity: VOICECLAW_HF_NUM_PIPELINES,
    admission: config.admission,
    credentialToken: config.credentialToken || '',
    evicting: false,
  };
  sidecarPool.set(config.key, record);
  notifyHFAdmissionWaiters();
  let earlyExit = null;
  const abortLaunch = () => {
    stopSidecarRecord(record, 'launch-aborted').catch(() => {});
  };
  operation.signal?.addEventListener?.('abort', abortLaunch, { once: true });

  proc.stdout.on('data', (chunk) => appendLog(HF_STDOUT_LOG, chunk));
  proc.stderr.on('data', (chunk) => appendLog(HF_STDERR_LOG, chunk));
  proc.on('exit', (code, exitSignal) => {
    earlyExit = { code, signal: exitSignal };
    reservedHFPorts.delete(port);
    appendLog(HF_STDERR_LOG, `\n[hf-sidecar] exited code=${code} signal=${exitSignal} attempt=${attempt}\n`);
    if (sidecar === proc || sidecarKey === config.key) {
      sidecar = null;
      sidecarKey = '';
    }
    if (sidecarPool.get(config.key)?.proc === proc) {
      sidecarPool.delete(config.key);
    }
    releaseCerebrasAdapterCredential(record.credentialToken, record);
    notifyHFAdmissionWaiters();
  });

  try {
    const startedAt = Date.now();
    while (Date.now() - startedAt < HF_START_TIMEOUT_MS) {
      throwIfOperationCancelled(operation);
      const nextHealth = await hfPoolHealth({ port, ...operation });
      if (nextHealth.reachable) {
        const owner = await verifyHFPortOwner(proc.pid, port);
        if (owner.ok) {
          console.log(`[hf-sidecar] ready key=${config.key} pid=${proc.pid} attempt=${attempt} port=${port} portOwners=${owner.owners.join(',')}`);
          for (const ownerPid of owner.owners || []) {
            applyRealtimeProcessPolicy(ownerPid, `${config.key}:listener`).catch(() => {});
          }
          await cleanupStaleHFProcesses(`post-launch-attempt-${attempt}`, { keepPids: poolKeepPids([proc.pid]) });
          return {
            wsURL: hfWsURL(port),
            key: config.key,
            port,
            health: nextHealth,
            admission: config.admission,
            record,
          };
        }
        throw new Error(`HF speech-to-speech sidecar became reachable on ${port}, but the listener is stale or wrong (${owner.reason}).`);
      }
      if (earlyExit) {
        throw new Error(`HF speech-to-speech sidecar exited early with code ${earlyExit.code ?? 'unknown'} signal ${earlyExit.signal ?? 'none'}. Check ${HF_STDERR_LOG}.`);
      }
      await abortableSleep(1000, operation);
    }
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError'
        || error?.code === 'ABORT_ERR' || error?.code === 'DEADLINE_EXCEEDED') {
      await stopSidecarRecord(record, 'startup-operation-cancelled');
      if (sidecarPool.get(config.key) === record) sidecarPool.delete(config.key);
    }
    throw error;
  } finally {
    operation.signal?.removeEventListener?.('abort', abortLaunch);
  }

  await stopSidecarRecord(record, `startup-timeout-attempt-${attempt}`);
  sidecarPool.delete(config.key);
  reservedHFPorts.delete(port);
  throw new Error(`HF speech-to-speech sidecar did not become ready on ${port} within ${Math.round(HF_START_TIMEOUT_MS / 1000)} seconds. Check ${HF_STDERR_LOG}.`);
}

export async function ensureHFRealtimeSidecar(payload = {}, options = {}) {
  const operation = {
    signal: options.signal || null,
    deadlineAt: operationDeadlineAt(options, 0),
    admissionDeadlineAt: operationDeadlineAt({ deadlineMs: options.admissionTimeoutMs || HF_ADMISSION_TIMEOUT_MS }, 0),
    onQueued: typeof options.onQueued === 'function' ? options.onQueued : null,
  };
  throwIfOperationCancelled(operation);
  const status = await waitForOperation(
    getHFRealtimeStatus({ brainMode: payload.brainMode, ...payload }),
    operation,
  );
  if (status.requireOpenAIBearer && !status.openAIBearerReady) {
    throw new Error(status.openAIBearerError || 'OpenAI Responses authentication is required for the selected OpenAI Companion Realtime Voice LLM.');
  }
  if (status.requireCerebrasKey && !status.cerebrasKeyReady) {
    throw new Error('Cerebras API key is required for the HF/Cerebras Companion Realtime Voice LLM.');
  }
  if (status.state !== 'ready') {
    throw new Error('HF speech-to-speech runtime is not installed. Use Companion setup to install the HF runtime first.');
  }

  await dropDeadPoolRecords();
  const identityConfig = await sidecarConfigFromPayload(payload, { port: HF_PORT, ...operation });
  const key = identityConfig.key;
  let sidecarInfo = null;
  while (!sidecarInfo) {
    throwIfOperationCancelled(operation);
    const admission = await reserveHFProcessAdmission(key, operation);
    if (admission.kind === 'existing') {
      const starting = sidecarStartingByKey.get(key);
      if (starting) {
        sidecarInfo = await waitForOperation(starting, operation);
        break;
      }
      const record = sidecarPool.get(key);
      const health = record ? await hfPoolHealth({ port: record.port, ...operation }) : { reachable: false };
      if (record?.proc && !record.proc.killed && health.reachable) {
        const owner = await verifyHFPortOwner(record.proc.pid, record.port);
        if (owner.ok) {
          sidecar = record.proc;
          sidecarKey = record.key;
          sidecarPort = record.port;
          record.lastUsedAt = Date.now();
          sidecarInfo = {
            wsURL: record.wsURL,
            key: record.key,
            port: record.port,
            health,
            admission: record.admission,
            record,
          };
          break;
        }
        console.warn(`[hf-sidecar] tracked sidecar is not the active HF listener; restarting (${owner.reason})`);
      }
      if (record) {
        record.evicting = true;
        sidecarPool.delete(key);
        await stopSidecarRecord(record, 'tracked-sidecar-invalid');
      }
      notifyHFAdmissionWaiters();
      continue;
    }

    const preferredPort = key === sidecarKey ? sidecarPort : preferredHFPoolPortForKey(key);
    let config = identityConfig;
    let startPromise = null;
    try {
      const port = await allocateHFPoolPort(preferredPort);
      config = await sidecarConfigFromPayload(payload, { port, ...operation });
      if (config.key !== key) throw new Error('HF sidecar identity changed while acquiring process admission.');
      if (config.key.startsWith('cerebras:') && !cerebrasKeyFromPayload(payload)) {
        throw new Error('Cerebras API key is required for the HF/Cerebras Companion Realtime Voice LLM.');
      }

      startPromise = (async () => {
        let lastError = null;
        for (let attempt = 1; attempt <= HF_START_ATTEMPTS; attempt += 1) {
          throwIfOperationCancelled(operation);
          try {
            return await launchHFRealtimeSidecarOnce(config, attempt, operation);
          } catch (error) {
            lastError = error;
            if (error?.name === 'AbortError' || error?.code === 'DEADLINE_EXCEEDED') throw error;
            console.warn(`[hf-sidecar] launch attempt ${attempt}/${HF_START_ATTEMPTS} failed: ${error?.message || String(error)}`);
            const failedRecord = sidecarPool.get(config.key);
            if (failedRecord) {
              await stopSidecarRecord(failedRecord, `failed-attempt-${attempt}`);
              sidecarPool.delete(config.key);
              reservedHFPorts.delete(failedRecord.port);
            } else if (sidecarKey === config.key) {
              await stopCurrentSidecar(`failed-attempt-${attempt}`);
            }
            try {
              await terminateHFPortListeners(`failed-attempt-${attempt}`, config.port || HF_PORT);
            } catch (cleanupError) {
              console.warn(`[hf-sidecar] cleanup after failed attempt ${attempt} failed: ${cleanupError?.message || String(cleanupError)}`);
              if (attempt === HF_START_ATTEMPTS) throw cleanupError;
            }
            if (attempt < HF_START_ATTEMPTS) await abortableSleep(Math.min(5000, 1000 * attempt), operation);
          }
        }

        if (sidecarPool.get(config.key)?.proc === sidecar) {
          sidecar = null;
          sidecarKey = '';
        }
        reservedHFPorts.delete(config.port || HF_PORT);
        throw new Error(`HF speech-to-speech sidecar failed after ${HF_START_ATTEMPTS} launch attempts: ${lastError?.message || String(lastError)}.`);
      })();
      sidecarStartingByKey.set(config.key, startPromise);
      sidecarStarting = startPromise;
      notifyHFAdmissionWaiters();
      sidecarInfo = await waitForOperation(startPromise, operation);
    } finally {
      const releaseReservation = () => {
        hfProcessAdmissionReservations.delete(key);
        if (startPromise && sidecarStarting === startPromise) sidecarStarting = null;
        if (startPromise && sidecarStartingByKey.get(key) === startPromise) sidecarStartingByKey.delete(key);
        notifyHFAdmissionWaiters();
      };
      if (startPromise) Promise.resolve(startPromise).finally(releaseReservation).catch(() => {});
      else releaseReservation();
    }
  }

  if (options.acquireLease) {
    const record = sidecarInfo.record || sidecarPool.get(sidecarInfo.key);
    const lease = await acquireHFSessionLease(sidecarInfo.key, record, operation);
    return { ...sidecarInfo, releaseLease: lease.release };
  }
  return sidecarInfo;
}

export async function prewarmHFRealtimeRuntime(options = {}) {
  const payload = defaultHFRealtimePrewarmPayload(options);
  const sidecarInfo = await ensureHFRealtimeSidecar(payload);
  const status = await getHFRealtimeStatus(payload);
  return {
    ...status,
    ok: true,
    state: 'ready',
    summary: `Companion Realtime Voice warm runtime is online for ${status.sttProfileLabel || status.sttProfile}, ${status.brainMode}, ${status.ttsEngine}${status.ttsDevice ? ` on ${status.ttsDevice}` : ''}.`,
    sidecarRunning: true,
    sidecarKey: sidecarInfo.key,
    sidecarPort: sidecarInfo.port,
    wsURL: sidecarInfo.wsURL,
    health: sidecarInfo.health || status.health || null,
    status,
  };
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

function voiceForHF(localVoice = '', realtimeVoice = '', engine = '') {
  const candidate = String(localVoice || realtimeVoice || '').trim();
  const lower = candidate.toLowerCase();
  const ttsEngine = String(engine || HF_DEFAULT_TTS || 'auto').toLowerCase();
  if (ttsEngine === 'kokoro' || ttsEngine === 'auto') {
    const supported = new Set([
      'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
      'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
      'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
      'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
    ]);
    if (!candidate) {
      const configured = String(process.env.VOICECLAW_HF_KOKORO_VOICE || 'af_heart').trim().replace(/-/g, '_').toLowerCase();
      return supported.has(configured) ? configured : 'af_heart';
    }
    if (lower.startsWith('kokoro-')) {
      const clean = candidate.slice('kokoro-'.length).replace(/-/g, '_').toLowerCase();
      return supported.has(clean) ? clean : 'af_heart';
    }
    if (lower.includes('heart')) return 'af_heart';
    if (lower.includes('fable')) return 'bm_fable';
    if (lower.includes('bella')) return 'af_bella';
    if (lower.includes('nicole')) return 'af_nicole';
    if (lower.includes('sarah')) return 'af_sarah';
    if (lower.includes('sky')) return 'af_sky';
    if (lower.includes('adam')) return 'am_adam';
    if (lower.includes('michael')) return 'am_michael';
    if (lower.includes('emma')) return 'bf_emma';
    if (lower.includes('isabella')) return 'bf_isabella';
    if (lower.includes('george')) return 'bm_george';
    const clean = candidate.replace(/^openai-/i, '').replace(/^piper-/i, '').replace(/^kokoro-/i, '').replace(/-/g, '_').toLowerCase();
    return supported.has(clean) ? clean : 'af_heart';
  }
  if (ttsEngine === 'qwen3') {
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

let hfBridgeGenerationSequence = 0;

export class HFRealtimeBridge {
  constructor({
    clientWs,
    send,
    payload = {},
    tools = [],
    instructions = '',
    toolHandler = null,
    signal = null,
    deadlineAt = 0,
    sidecarResolver = ensureHFRealtimeSidecar,
    runtimeIdentityResolver = sidecarConfigFromPayload,
    webSocketFactory = (url) => new WebSocket(url),
  }) {
    this.clientWs = clientWs;
    this.sendRaw = typeof send === 'function' ? send : () => false;
    this.payload = payload || {};
    this.tools = Array.isArray(tools) ? tools : [];
    this.instructions = instructions || 'You are VoiceClaw Realtime, a fast conversational voice assistant.';
    this.toolHandler = typeof toolHandler === 'function' ? toolHandler : null;
    this.sidecarResolver = sidecarResolver;
    this.runtimeIdentityResolver = runtimeIdentityResolver;
    this.webSocketFactory = webSocketFactory;

    this.hfSessionID = String(
      this.payload.hfSessionID
      || this.payload.hfSessionId
      || this.payload.sessionToken
      || `hf-session-${randomUUID()}`,
    ).slice(0, 256);
    this.hfGeneration = ++hfBridgeGenerationSequence;
    this.hfGenerationID = `hf-generation-${this.hfGeneration}-${randomUUID()}`;
    this.hfConfigRevision = 1;
    this.hfConfigID = `hf-config-${this.hfGeneration}-1-${randomUUID()}`;
    this.hfTurnSequence = 0;
    this.hfResponseSequence = 0;
    this.hfEventSequence = 0;

    this.hfWs = null;
    this.sidecarInfo = null;
    this.sidecarAdmission = null;
    this.releaseSidecarLease = null;
    this.pipelineSessionID = '';
    this.connected = false;
    this.upstreamAdmitted = false;
    this.configured = false;
    this.ready = false;
    this.started = false;
    this.closed = false;
    this.terminal = false;
    this.terminalReason = '';

    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.pendingCommit = null;
    this.inputGap = null;
    this.outputAudioGap = null;
    this.responseGap = null;
    this.gapSequence = 0;
    this.lastSilenceFlushAt = 0;

    this.activeTurn = null;
    this.activeResponse = null;
    this.responseContextsByProviderID = new Map();
    this.responseTextById = new Map();
    this.finalReplySentById = new Set();
    this.transcriptStates = new Map();
    this.inputItemContexts = new Map();
    this.inputTranscriptByItem = new Map();
    this.pendingResponseRequests = [];
    this.responseCreateOutstanding = false;
    this.awaitingProviderResponse = false;
    this.pendingToolCalls = new Map();
    this.lastFinalTranscript = '';
    this.lastAssistantText = '';
    this.companionResultSent = false;
    this.pendingCompanionResultAfterAudio = false;

    this.responseTombstones = new BoundedTombstones();
    this.turnTombstones = new BoundedTombstones();
    this.configTombstones = new BoundedTombstones();
    this.inputItemTombstones = new BoundedTombstones();
    this.toolCallTombstones = new BoundedTombstones();

    this.audioStarted = false;
    this.audioBytes = 0;
    this.audioResponseContext = null;
    this.responseInProgress = false;
    this.turnWatchdogTimer = null;
    this.hfHeartbeatTimer = null;
    this.hfLastPongAt = 0;

    this.controlQueue = Promise.resolve();
    this.pendingControlCount = 0;
    this.lifecycleAbortController = new AbortController();
    this.externalSignal = signal;
    this.startDeadlineAt = Number(deadlineAt) || 0;
    this.externalAbortListener = null;
    if (signal) {
      this.externalAbortListener = () => this.close('external-abort');
      if (signal.aborted) this.lifecycleAbortController.abort(signal.reason);
      else signal.addEventListener('abort', this.externalAbortListener, { once: true });
    }
  }

  identity(context = null) {
    const selected = context || this.activeResponse || this.activeTurn || {};
    const identity = {
      hfSessionID: this.hfSessionID,
      hfSessionId: this.hfSessionID,
      hfGeneration: this.hfGeneration,
      hfGenerationID: this.hfGenerationID,
      hfConfigRevision: this.hfConfigRevision,
      hfConfigID: this.hfConfigID,
    };
    const turnID = selected.turnID || selected.hfTurnID || '';
    const responseID = selected.id || selected.responseID || selected.hfResponseID || '';
    if (turnID) identity.hfTurnID = turnID;
    if (responseID) identity.hfResponseID = responseID;
    return identity;
  }

  emit(event, context = null) {
    const outgoing = { ...event, ...this.identity(context) };
    try {
      return this.sendRaw(outgoing);
    } catch {
      return false;
    }
  }

  rejectProtocol(code, message, event = {}, context = null) {
    return this.emit({
      type: 'protocol_rejection',
      code,
      message,
      rejectedType: String(event.type || ''),
      providerEventID: event.event_id || event.eventId || undefined,
      providerResponseID: this.providerResponseID(event) || undefined,
      callID: event.call_id || event.callID || undefined,
      recoverable: true,
    }, context);
  }

  enqueueControl(label, task, { allowTerminal = false } = {}) {
    if (this.terminal && !allowTerminal) {
      const error = new Error(`HF generation is closed; rejected ${label}.`);
      error.code = 'HF_GENERATION_CLOSED';
      const rejected = Promise.reject(error);
      rejected.catch(() => {});
      return rejected;
    }
    if (this.pendingControlCount >= HF_MAX_PENDING_CONTROLS) {
      const error = new Error(`HF per-session control queue is full (${HF_MAX_PENDING_CONTROLS}).`);
      error.code = 'HF_CONTROL_QUEUE_FULL';
      this.emit({ type: 'error', code: error.code, message: error.message, recoverable: false });
      this.emit({ type: 'status', status: 'control_backpressure', bridgeReady: false });
      const rejected = Promise.reject(error);
      rejected.catch(() => {});
      return rejected;
    }
    this.pendingControlCount += 1;
    const operation = this.controlQueue.then(async () => {
      if (this.terminal && !allowTerminal) throw makeAbortError(this.terminalReason || 'HF generation closed');
      return await task();
    });
    this.controlQueue = operation.catch((error) => {
      if (error?.name !== 'AbortError' && error?.code !== 'HF_GENERATION_CLOSED') {
        this.emit({ type: 'error', code: error?.code || 'HF_CONTROL_FAILED', message: error?.message || String(error), control: label });
      }
    }).finally(() => {
      this.pendingControlCount = Math.max(0, this.pendingControlCount - 1);
    });
    return operation;
  }

  async drainControls() {
    await this.controlQueue;
  }

  async start(options = {}) {
    if (this.terminal) {
      const error = new Error('This HF bridge generation is terminal; create a new HFRealtimeBridge generation.');
      error.code = 'HF_GENERATION_CLOSED';
      throw error;
    }
    if (this.started) {
      const error = new Error('This HF bridge generation has already been started.');
      error.code = 'HF_GENERATION_ALREADY_STARTED';
      throw error;
    }
    this.started = true;
    const deadlineAt = operationDeadlineAt(options, 0) || this.startDeadlineAt || (Date.now() + HF_START_TIMEOUT_MS);
    const linked = linkedAbortController([
      this.lifecycleAbortController.signal,
      options.signal,
      this.externalSignal,
    ], deadlineAt);
    try {
      const sidecarInfo = await this.sidecarResolver(this.payload, {
        acquireLease: true,
        signal: linked.signal,
        deadlineAt,
        onQueued: (details) => {
          this.emit({
            type: 'status',
            status: 'queued-hf-runtime',
            hf: true,
            bridgeReady: false,
            ...details,
          });
        },
      });
      throwIfOperationCancelled({ signal: linked.signal, deadlineAt });
      this.sidecarInfo = sidecarInfo;
      this.sidecarAdmission = sidecarInfo.admission || null;
      this.releaseSidecarLease = typeof sidecarInfo.releaseLease === 'function' ? sidecarInfo.releaseLease : null;
      await this.openHFWebSocket(sidecarInfo.wsURL, { signal: linked.signal, deadlineAt });
    } catch (error) {
      this.transitionTerminal('start-failed', { notify: false });
      try { this.hfWs?.terminate?.(); } catch {}
      try { this.hfWs?.close?.(); } catch {}
      throw error;
    } finally {
      linked.cleanup();
    }
  }

  async openHFWebSocket(url, operation = {}) {
    await new Promise((resolve, reject) => {
      throwIfOperationCancelled(operation);
      const ws = this.webSocketFactory(url);
      this.hfWs = ws;
      let settled = false;
      let timeout = null;
      const openDeadline = operation.deadlineAt
        ? Math.min(operation.deadlineAt, Date.now() + 45_000)
        : Date.now() + 45_000;
      const cleanupOpen = () => {
        clearTimeout(timeout);
        operation.signal?.removeEventListener?.('abort', onAbort);
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanupOpen();
        fn(value);
      };
      const onAbort = () => {
        try { ws.terminate?.(); } catch {}
        try { ws.close?.(); } catch {}
        finish(reject, makeAbortError(operation.signal?.reason));
      };
      timeout = setTimeout(() => {
        const error = new Error('HF realtime websocket did not open before its deadline.');
        error.name = 'TimeoutError';
        error.code = 'HF_WEBSOCKET_OPEN_TIMEOUT';
        try { ws.terminate?.(); } catch {}
        finish(reject, error);
      }, Math.max(0, openDeadline - Date.now()));
      timeout.unref?.();
      operation.signal?.addEventListener?.('abort', onAbort, { once: true });

      ws.on('open', () => {
        if (this.terminal) return;
        this.connected = true;
        this.startHFHeartbeat(ws);
        finish(resolve);
      });
      ws.on('pong', () => {
        this.hfLastPongAt = Date.now();
      });
      ws.on('message', (data) => this.handleHFMessage(data));
      ws.on('close', (code, reason) => {
        if (!settled) {
          const error = new Error(`HF realtime websocket closed before admission (code ${code || 0}).`);
          error.code = 'HF_WEBSOCKET_CLOSED_BEFORE_READY';
          finish(reject, error);
        }
        this.handleTransportClose(code, reason);
      });
      ws.on('error', (error) => {
        if (!settled) finish(reject, error);
        else if (!this.terminal) {
          this.emit({ type: 'error', code: 'HF_WEBSOCKET_ERROR', message: `HF realtime websocket error: ${error.message}` });
        }
      });
    });
  }

  startHFHeartbeat(ws) {
    this.stopHFHeartbeat();
    this.hfLastPongAt = Date.now();
    this.hfHeartbeatTimer = setInterval(() => {
      if (this.terminal || ws.readyState !== WebSocket.OPEN) return;
      const staleMs = Date.now() - this.hfLastPongAt;
      if (staleMs > 90_000) {
        console.warn(`[hf-bridge] realtime sidecar websocket missed heartbeat for ${staleMs} ms; terminating stale socket`);
        try { ws.terminate(); } catch {}
        return;
      }
      try { ws.ping(); } catch {}
    }, 15_000);
    this.hfHeartbeatTimer.unref?.();
  }

  stopHFHeartbeat() {
    if (this.hfHeartbeatTimer) clearInterval(this.hfHeartbeatTimer);
    this.hfHeartbeatTimer = null;
  }

  nextUpstreamEventID(kind = 'control') {
    return `vc_${kind}_${this.hfGeneration}_${++this.hfEventSequence}`;
  }

  sendUpstream(event) {
    if (this.terminal || this.hfWs?.readyState !== WebSocket.OPEN) {
      const error = new Error('HF realtime websocket is not open.');
      error.code = 'HF_WEBSOCKET_NOT_OPEN';
      return Promise.reject(error);
    }
    const outgoing = {
      ...event,
      event_id: event.event_id || this.nextUpstreamEventID(String(event.type || 'control').replace(/[^a-z0-9]+/gi, '_')),
    };
    return new Promise((resolve, reject) => {
      let callbackUsed = false;
      const callback = (error) => {
        callbackUsed = true;
        if (error) reject(error);
        else resolve(outgoing.event_id);
      };
      try {
        this.hfWs.send(JSON.stringify(outgoing), callback);
        if (this.hfWs.send.length < 2 && !callbackUsed) resolve(outgoing.event_id);
      } catch (error) {
        reject(error);
      }
    });
  }

  handleTransportClose(code = 0, reason = '') {
    if (this.terminal) return;
    const wasReady = this.ready;
    this.transitionTerminal('hf-sidecar-closed', { notify: false });
    if (wasReady) {
      this.emit({
        type: 'error',
        code: 'HF_WEBSOCKET_CLOSED',
        message: 'HF realtime websocket closed unexpectedly',
        closeCode: Number(code || 0),
        closeReason: Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason || ''),
        recoverable: true,
      });
    }
    this.emit({
      type: 'status',
      status: 'closed',
      hf: true,
      bridgeReady: false,
      terminal: true,
      requiresNewGeneration: true,
      reason: 'hf-sidecar-closed',
    });
  }

  transitionTerminal(reason = 'closed', { notify = false } = {}) {
    if (this.terminal) return;
    this.terminal = true;
    this.closed = true;
    this.connected = false;
    this.configured = false;
    this.ready = false;
    this.upstreamAdmitted = false;
    this.terminalReason = reason;
    this.stopHFHeartbeat();
    this.clearTurnWatchdog();
    this.configTombstones.add(this.hfConfigID, { reason });
    this.terminalizeTurn(reason);
    this.clearPendingAudio(reason, { reportGap: notify });
    this.pendingResponseRequests = [];
    this.responseCreateOutstanding = false;
    this.lifecycleAbortController.abort(makeAbortError(reason));
    this.externalSignal?.removeEventListener?.('abort', this.externalAbortListener);
    if (this.releaseSidecarLease) {
      const release = this.releaseSidecarLease;
      this.releaseSidecarLease = null;
      try { release(); } catch {}
    }
  }

  close(reason = 'client-close') {
    if (this.terminal) return;
    this.transitionTerminal(reason, { notify: false });
    try { this.hfWs?.close(); } catch {}
  }

  sessionUpdatePayload() {
    const voice = ttsConfigForHF(this.payload).voice;
    // This HF runtime defaults omitted format fields to its process-level
    // --sample_rate (16 kHz); its OpenAI schema otherwise only admits 24 kHz.
    const session = {
      type: 'realtime',
      instructions: this.instructions,
      audio: {
        input: {
          turn_detection: turnDetectionForHF(this.payload),
        },
        output: {
          voice,
        },
      },
    };
    if (this.tools.length) {
      session.tools = this.tools;
      session.tool_choice = 'auto';
    }
    return session;
  }

  sendSessionUpdate(source = 'session.created-admitted') {
    const configID = this.hfConfigID;
    const configRevision = this.hfConfigRevision;
    return this.enqueueControl('session.update', async () => {
      if (!this.upstreamAdmitted) {
        const error = new Error('HF pipeline has not admitted this websocket session.');
        error.code = 'HF_PIPELINE_NOT_ADMITTED';
        throw error;
      }
      await this.sendUpstream({ type: 'session.update', session: this.sessionUpdatePayload() });
      if (this.terminal || this.hfConfigID !== configID || this.hfConfigRevision !== configRevision) return;
      this.markConfigured(source);
    });
  }

  markConfigured(source = 'session.created-admitted') {
    if (this.terminal || this.configured || !this.upstreamAdmitted) return false;
    const admission = this.sidecarAdmission;
    const audioValid = admission?.sampleRate === DEFAULT_HF_SAMPLE_RATE
      && admission?.channels === 1
      && admission?.encoding === 'pcm_s16le'
      && admission?.bytesPerSample === 2;
    if (!admission?.stt || !admission?.llm || !admission?.tts || !audioValid) {
      this.emit({
        type: 'error',
        code: 'HF_PIPELINE_ADMISSION_INVALID',
        message: 'HF pipeline admission did not confirm the selected 16 kHz mono PCM STT, LLM, and TTS stack.',
        recoverable: false,
      });
      return false;
    }
    this.configured = true;
    this.ready = true;
    this.flushPendingAudio();
    this.emit({
      type: 'status',
      status: 'ready',
      hf: true,
      bridgeReady: true,
      source,
      pipelineSessionID: this.pipelineSessionID,
      admission,
      capabilities: {
        partialTranscripts: true,
        transcriptRevisions: true,
        streamingTTS: true,
        serverEndpointing: true,
        toolCalls: this.tools.length > 0,
        correlatedToolResults: true,
      },
    });
    return true;
  }

  updateSession({ payload = this.payload, tools = this.tools, instructions = this.instructions } = {}) {
    if (this.terminal) {
      this.rejectProtocol('HF_GENERATION_CLOSED', 'A terminal HF bridge cannot be reconfigured; create a new generation.', { type: 'session.update' });
      return Promise.resolve(false);
    }
    this.configTombstones.add(this.hfConfigID, { reason: 'config-update' });
    this.terminalizeTurn('config-update');
    this.payload = payload || {};
    this.tools = Array.isArray(tools) ? tools : [];
    this.instructions = instructions || 'You are VoiceClaw Realtime, a fast conversational voice assistant.';
    this.hfConfigRevision += 1;
    this.hfConfigID = `hf-config-${this.hfGeneration}-${this.hfConfigRevision}-${randomUUID()}`;
    this.configured = false;
    this.ready = false;
    this.emit({
      type: 'status',
      status: 'configuring-hf-session',
      hf: true,
      bridgeReady: false,
    });
    const configID = this.hfConfigID;
    const configRevision = this.hfConfigRevision;
    return this.enqueueControl('session.reconfigure', async () => {
      const requestedRuntime = await this.runtimeIdentityResolver(this.payload, {
        port: this.sidecarInfo?.port || HF_PORT,
        signal: this.lifecycleAbortController.signal,
      });
      if (this.terminal || this.hfConfigID !== configID || this.hfConfigRevision !== configRevision) return false;
      if (this.sidecarInfo?.key && requestedRuntime.key !== this.sidecarInfo.key) {
        this.emit({
          type: 'error',
          code: 'HF_RUNTIME_IDENTITY_CHANGED',
          message: 'The selected HF provider credential or STT/LLM/TTS runtime changed; a new bridge generation is required.',
          recoverable: true,
          expectedRuntimeKey: this.sidecarInfo.key,
          requestedRuntimeKey: requestedRuntime.key,
        });
        this.transitionTerminal('runtime-identity-changed', { notify: false });
        this.emit({
          type: 'status',
          status: 'closed',
          hf: true,
          bridgeReady: false,
          terminal: true,
          requiresNewGeneration: true,
          reason: 'runtime-identity-changed',
        });
        try { this.hfWs?.close(); } catch {}
        return false;
      }
      await this.sendUpstream({ type: 'session.update', session: this.sessionUpdatePayload() });
      if (this.terminal || this.hfConfigID !== configID || this.hfConfigRevision !== configRevision) return false;
      this.markConfigured('session.update-on-admitted-pipeline');
      return true;
    });
  }

  isContextCurrent(context = {}) {
    return !this.terminal
      && (!context.generationID || context.generationID === this.hfGenerationID)
      && (!context.configID || context.configID === this.hfConfigID)
      && (!context.turnID || context.turnID === this.activeTurn?.turnID);
  }

  createTurn(reason = 'user-turn') {
    if (this.activeTurn && this.isContextCurrent(this.activeTurn) && !this.activeTurn.completed) return this.activeTurn;
    if (this.activeTurn) this.terminalizeTurn('superseded-turn');
    this.lastFinalTranscript = '';
    this.lastAssistantText = '';
    this.companionResultSent = false;
    this.pendingCompanionResultAfterAudio = false;
    const turn = {
      turnID: `hf-turn-${this.hfGeneration}-${++this.hfTurnSequence}-${randomUUID()}`,
      generationID: this.hfGenerationID,
      configID: this.hfConfigID,
      configRevision: this.hfConfigRevision,
      createdAt: Date.now(),
      reason,
      completed: false,
      responseCreateIntentKeys: new Set(),
    };
    this.activeTurn = turn;
    return turn;
  }

  prepareForUserTurn(reason = 'user-turn', { force = false, emitStatus = true } = {}) {
    const priorResponse = this.activeResponse;
    const hadResponse = !!priorResponse || this.responseInProgress || this.audioStarted;
    if (hadResponse) this.finishAudioIfNeeded(priorResponse);
    if (force && this.activeTurn) this.terminalizeTurn(reason);
    const turn = this.createTurn(reason);
    if (hadResponse) {
      this.enqueueControl('response.cancel', () => this.sendUpstream({ type: 'response.cancel' })).catch(() => {});
    }
    if (emitStatus) this.emit({ type: 'status', status: 'user-turn-open', reason }, turn);
    return turn;
  }

  terminalizeResponse(reason = 'response-complete', response = this.activeResponse) {
    if (!response) return;
    response.completed = true;
    response.abortController?.abort(makeAbortError(reason));
    if (response.providerID) {
      this.responseTombstones.add(response.providerID, { reason, hfResponseID: response.id });
      this.responseContextsByProviderID.delete(response.providerID);
      this.responseTextById.delete(response.providerID);
      this.finalReplySentById.delete(response.providerID);
    }
    this.responseTombstones.add(response.id, { reason });
    for (const [callID, pending] of this.pendingToolCalls) {
      if (pending.responseID !== response.id) continue;
      this.clearPendingToolCall(pending, reason);
      this.toolCallTombstones.add(callID, { reason, responseID: response.id });
      this.pendingToolCalls.delete(callID);
    }
    if (this.activeResponse === response) this.activeResponse = null;
    this.responseInProgress = false;
    this.awaitingProviderResponse = false;
    this.responseCreateOutstanding = false;
  }

  terminalizeTurn(reason = 'turn-complete') {
    const turn = this.activeTurn;
    if (!turn) return;
    if (this.activeResponse) this.terminalizeResponse(reason, this.activeResponse);
    turn.completed = true;
    this.turnTombstones.add(turn.turnID, { reason, configID: turn.configID });
    for (const [itemID, context] of this.inputItemContexts) {
      if (context.turnID !== turn.turnID) continue;
      this.inputItemContexts.delete(itemID);
      this.inputTranscriptByItem.delete(itemID);
      this.transcriptStates.delete(itemID);
      this.inputItemTombstones.add(itemID, { reason, turnID: turn.turnID });
    }
    this.pendingResponseRequests = this.pendingResponseRequests.filter((entry) => entry.turnID !== turn.turnID);
    this.activeTurn = null;
    this.clearTurnWatchdog();
  }

  contextFromMetadata(metadata = {}) {
    return {
      generationID: metadata.hfGenerationID || this.hfGenerationID,
      configID: metadata.hfConfigID || this.hfConfigID,
      turnID: metadata.hfTurnID || this.activeTurn?.turnID || '',
    };
  }

  validateInputContext(context, type = 'input_audio_buffer.append') {
    if (context.generationID !== this.hfGenerationID) {
      this.rejectProtocol('STALE_HF_GENERATION', 'Rejected audio from a stale HF generation.', { type });
      return false;
    }
    if (context.configID !== this.hfConfigID || (context.turnID && context.turnID !== this.activeTurn?.turnID)) {
      this.rejectProtocol('STALE_HF_AUDIO', 'Rejected audio from a stale HF configuration or turn.', { type });
      return false;
    }
    return true;
  }

  sendAudio(buffer, metadata = {}) {
    if (this.terminal) return false;
    let chunk = Buffer.from(buffer || []);
    if (!chunk.length) return false;
    const turn = this.activeTurn || this.prepareForUserTurn('audio-input', { emitStatus: false });
    const context = this.contextFromMetadata({ ...metadata, hfTurnID: metadata.hfTurnID || turn.turnID });
    if (!this.validateInputContext(context)) {
      this.recordInputGap(chunk, 'stale-audio', context);
      return false;
    }
    if (chunk.length > HF_MAX_PENDING_AUDIO_BYTES) {
      this.recordInputGap(chunk, 'audio-frame-too-large', context);
      return false;
    }
    if (chunk.length % 2 !== 0) {
      this.recordInputGap(1, 'unaligned-pcm-s16le', context);
      chunk = chunk.subarray(0, chunk.length - 1);
      if (!chunk.length) return false;
    }
    if (!this.connected || !this.configured || !this.ready || this.hfWs?.readyState !== WebSocket.OPEN) {
      return this.enqueuePendingAudio(chunk, context, 'hf-not-ready');
    }
    return this.sendAudioFrame(chunk, context);
  }

  enqueuePendingAudio(chunk, context, reason) {
    if (chunk.length > HF_MAX_PENDING_AUDIO_BYTES) {
      this.recordInputGap(chunk, 'audio-frame-too-large', context);
      return false;
    }
    while ((this.pendingAudioBytes + chunk.length > HF_MAX_PENDING_AUDIO_BYTES
      || this.pendingAudio.length >= HF_MAX_PENDING_AUDIO_FRAMES) && this.pendingAudio.length) {
      const removed = this.pendingAudio.shift();
      this.pendingAudioBytes -= removed.chunk.length;
      this.recordInputGap(removed.chunk, 'pending-audio-overflow', removed.context);
    }
    if (this.pendingAudioBytes + chunk.length > HF_MAX_PENDING_AUDIO_BYTES
        || this.pendingAudio.length >= HF_MAX_PENDING_AUDIO_FRAMES) {
      this.recordInputGap(chunk, 'pending-audio-overflow', context);
      return false;
    }
    this.pendingAudio.push({ chunk, context });
    this.pendingAudioBytes += chunk.length;
    this.emit({
      type: 'status',
      status: 'input_backpressure',
      direction: 'input',
      reason,
      bufferedBytes: this.pendingAudioBytes,
      maxBufferedBytes: HF_MAX_PENDING_AUDIO_BYTES,
    }, context);
    return true;
  }

  sendAudioFrame(chunk, context) {
    if (!this.validateInputContext(context)) {
      this.recordInputGap(chunk, 'stale-audio', context);
      return false;
    }
    const highWater = DEFAULT_HF_SAMPLE_RATE * 2 * 6;
    if (Number(this.hfWs?.bufferedAmount || 0) + chunk.length > highWater) {
      this.recordInputGap(chunk, 'hf-upstream-backpressure', context);
      return false;
    }
    try {
      this.hfWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        event_id: this.nextUpstreamEventID('audio'),
        audio: encodePCMChunk(chunk),
      }));
      this.finishInputGap('input-flowing');
      return true;
    } catch {
      this.recordInputGap(chunk, 'hf-upstream-send-failed', context);
      return false;
    }
  }

  flushPendingAudio() {
    if (!this.connected || !this.configured || !this.ready || this.hfWs?.readyState !== WebSocket.OPEN) return;
    const pending = this.pendingAudio.splice(0);
    this.pendingAudioBytes = 0;
    for (const entry of pending) {
      if (!this.validateInputContext(entry.context)) {
        this.recordInputGap(entry.chunk, 'stale-buffered-audio', entry.context);
        continue;
      }
      this.sendAudioFrame(entry.chunk, entry.context);
    }
    if (this.pendingCommit) {
      const commit = this.pendingCommit;
      this.pendingCommit = null;
      if (this.validateInputContext(commit.context, 'input_audio_buffer.commit')) {
        this.sendEndOfSpeechPadding(commit.context);
      }
    }
    if (!this.pendingAudioBytes) {
      this.finishInputGap('input-drained');
      this.emit({ type: 'status', status: 'input_backpressure_recovered', direction: 'input', bufferedBytes: 0 });
    }
  }

  clearPendingAudio(reason, { reportGap = true } = {}) {
    if (reportGap && this.pendingAudioBytes) this.recordInputGap(this.pendingAudioBytes, reason);
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.pendingCommit = null;
    this.finishInputGap(reason);
  }

  recordInputGap(buffer, reason, context = this.activeTurn) {
    const bytes = Buffer.isBuffer(buffer) ? buffer.length : Math.max(0, Number(buffer || 0));
    if (!this.inputGap || this.inputGap.reason !== reason) {
      this.finishInputGap('gap-replaced');
      this.inputGap = {
        id: `hf-input-gap-${++this.gapSequence}`,
        reason,
        context,
        droppedFrames: 0,
        droppedBytes: 0,
      };
      this.emit({
        type: 'audio_gap',
        direction: 'input',
        phase: 'start',
        reason,
        gapId: this.inputGap.id,
        bufferedBytes: this.pendingAudioBytes,
      }, context);
    }
    this.inputGap.droppedFrames += 1;
    this.inputGap.droppedBytes += bytes;
    this.emit({
      type: 'status',
      status: 'input_backpressure',
      direction: 'input',
      reason,
      gapId: this.inputGap.id,
      droppedFrames: this.inputGap.droppedFrames,
      droppedBytes: this.inputGap.droppedBytes,
    }, context);
  }

  finishInputGap(reason = 'input-drained') {
    if (!this.inputGap) return;
    const gap = this.inputGap;
    this.inputGap = null;
    this.emit({
      type: 'audio_gap',
      direction: 'input',
      phase: 'end',
      reason,
      gapId: gap.id,
      droppedFrames: gap.droppedFrames,
      droppedBytes: gap.droppedBytes,
    }, gap.context);
  }

  commit(metadata = {}) {
    if (this.terminal) return Promise.resolve(false);
    const turn = this.activeTurn || this.prepareForUserTurn('audio-commit', { emitStatus: false });
    const context = this.contextFromMetadata({ ...metadata, hfTurnID: metadata.hfTurnID || turn.turnID });
    return this.enqueueControl('audio.commit', async () => {
      if (!this.connected || !this.configured || !this.ready || this.hfWs?.readyState !== WebSocket.OPEN) {
        this.pendingCommit = { context };
        return false;
      }
      if (!this.validateInputContext(context, 'input_audio_buffer.commit')) return false;
      this.sendEndOfSpeechPadding(context);
      return true;
    });
  }

  sendEndOfSpeechPadding(context = this.activeTurn) {
    if (this.hfWs?.readyState !== WebSocket.OPEN || !this.validateInputContext(context, 'input_audio_buffer.commit')) return;
    const now = Date.now();
    if (now - this.lastSilenceFlushAt < 300) return;
    this.lastSilenceFlushAt = now;
    const vad = turnDetectionForHF(this.payload);
    const paddingMs = Math.max(650, Math.min(1600, Number(vad.silence_duration_ms || 420) + 320));
    const silence = Buffer.alloc(Math.round((DEFAULT_HF_SAMPLE_RATE * 2 * paddingMs) / 1000));
    this.sendAudioFrame(silence, context);
    this.awaitingProviderResponse = true;
    this.scheduleTurnWatchdog('end-of-speech-padding', context);
  }

  interrupt(reason = 'client-barge-in') {
    if (this.terminal) return Promise.resolve(false);
    const context = this.activeResponse || this.activeTurn;
    const cancellation = this.enqueueControl('response.cancel', async () => {
      if (this.hfWs?.readyState === WebSocket.OPEN) await this.sendUpstream({ type: 'response.cancel' });
    }).catch(() => {});
    this.finishAudioIfNeeded(this.activeResponse);
    this.terminalizeTurn(reason);
    this.pendingResponseRequests = [];
    this.emit({ type: 'interrupted', reason }, context);
    return cancellation;
  }

  providerResponseID(event = {}) {
    return String(event.response_id || event.responseID || event.response?.id || '').trim();
  }

  createResponseContext(providerID = '') {
    const turn = this.activeTurn;
    if (!turn || !this.isContextCurrent(turn) || !this.configured) return null;
    const response = {
      id: `hf-response-${this.hfGeneration}-${++this.hfResponseSequence}-${randomUUID()}`,
      providerID: String(providerID || ''),
      turnID: turn.turnID,
      generationID: this.hfGenerationID,
      configID: this.hfConfigID,
      configRevision: this.hfConfigRevision,
      createdAt: Date.now(),
      text: '',
      finalReplySent: false,
      providerDone: false,
      audioDone: false,
      completed: false,
      abortController: new AbortController(),
    };
    if (response.providerID) this.responseContextsByProviderID.set(response.providerID, response);
    this.activeResponse = response;
    this.responseInProgress = true;
    this.awaitingProviderResponse = false;
    this.responseCreateOutstanding = false;
    return response;
  }

  resolveResponseContext(event = {}, { allowCreate = true } = {}) {
    const providerID = this.providerResponseID(event);
    if (providerID && this.responseTombstones.has(providerID)) {
      this.rejectProtocol('STALE_HF_RESPONSE_EVENT', 'Rejected a late event for a tombstoned HF response.', event);
      return null;
    }
    let response = providerID ? this.responseContextsByProviderID.get(providerID) : this.activeResponse;
    if (response && !this.isContextCurrent(response)) {
      this.rejectProtocol('STALE_HF_RESPONSE_EVENT', 'Rejected an HF response event from a stale generation, configuration, or turn.', event, response);
      return null;
    }
    if (!response && allowCreate && this.activeTurn && (this.awaitingProviderResponse || this.responseCreateOutstanding || event.type === 'response.created')) {
      response = this.createResponseContext(providerID);
    }
    if (!response) {
      this.rejectProtocol('UNOWNED_HF_RESPONSE_EVENT', 'Rejected an HF response event with no current turn ownership.', event);
      return null;
    }
    if (providerID && !response.providerID) {
      response.providerID = providerID;
      this.responseContextsByProviderID.set(providerID, response);
    } else if (providerID && response.providerID !== providerID) {
      this.rejectProtocol('MISMATCHED_HF_RESPONSE_EVENT', 'Rejected an event for a different provider response.', event, response);
      return null;
    }
    return response;
  }

  queueResponseCreate(reason = 'tool-result', context = this.activeTurn) {
    if (!context || !this.isContextCurrent(context) || this.terminal) return false;
    const toolFollowup = String(reason).includes('tool-result');
    const intentKey = toolFollowup
      ? `tool:${context.responseID || context.providerResponseID || context.turnID}`
      : `initial:${context.turnID}`;
    const intentKeys = this.activeTurn?.responseCreateIntentKeys;
    if (intentKeys?.has(intentKey)) return true;
    if (this.pendingResponseRequests.length >= HF_MAX_PENDING_RESPONSES) {
      if (!this.responseGap) {
        this.responseGap = { id: `hf-response-gap-${++this.gapSequence}`, dropped: 0, context };
        this.emit({
          type: 'response_gap',
          phase: 'start',
          reason: 'response-queue-overflow',
          gapId: this.responseGap.id,
          maxPendingResponses: HF_MAX_PENDING_RESPONSES,
        }, context);
      }
      this.responseGap.dropped += 1;
      this.emit({ type: 'status', status: 'response_backpressure', reason: 'response-queue-overflow', gapId: this.responseGap.id }, context);
      return false;
    }
    this.pendingResponseRequests.push({
      reason,
      intentKey,
      turnID: context.turnID,
      generationID: this.hfGenerationID,
      configID: this.hfConfigID,
      queuedAt: Date.now(),
    });
    intentKeys?.add(intentKey);
    this.flushResponseQueue();
    return true;
  }

  flushResponseQueue() {
    const unresolvedTools = this.activeResponse
      ? Array.from(this.pendingToolCalls.values()).some((pending) => pending.responseID === this.activeResponse.id)
      : false;
    if (this.terminal || !this.ready || this.responseInProgress || this.responseCreateOutstanding
        || unresolvedTools || this.hfWs?.readyState !== WebSocket.OPEN || !this.pendingResponseRequests.length) return false;
    const request = this.pendingResponseRequests.shift();
    if (!this.isContextCurrent(request)) {
      this.rejectProtocol('STALE_HF_RESPONSE_REQUEST', 'Dropped a queued response request from a stale turn.', { type: 'response.create' }, request);
      return this.flushResponseQueue();
    }
    this.responseCreateOutstanding = true;
    this.awaitingProviderResponse = true;
    this.enqueueControl('response.create', async () => {
      await this.sendUpstream(this.responseCreateEvent());
      this.emit({ type: 'status', status: 'thinking', reason: request.reason }, request);
    }).catch(() => {
      this.responseCreateOutstanding = false;
    });
    if (!this.pendingResponseRequests.length && this.responseGap) {
      const gap = this.responseGap;
      this.responseGap = null;
      this.emit({ type: 'response_gap', phase: 'end', reason: 'response-queue-drained', gapId: gap.id, droppedResponses: gap.dropped }, gap.context);
      this.emit({ type: 'status', status: 'response_backpressure_recovered', gapId: gap.id }, gap.context);
    }
    return true;
  }

  responseCreateEvent() {
    const voice = ttsConfigForHF(this.payload).voice;
    return {
      type: 'response.create',
      response: {
        output_modalities: ['text', 'audio'],
        audio: {
          output: {
            voice,
          },
        },
      },
    };
  }

  triggerResponseAfterFinalTranscript(reason = 'transcript-completed') {
    if (this.payload.hfExplicitResponseCreate !== true) return false;
    return this.queueResponseCreate(reason, this.activeTurn);
  }

  scheduleTurnWatchdog(reason = 'turn', context = this.activeTurn) {
    this.clearTurnWatchdog();
    if (!context) return;
    this.turnWatchdogTimer = setTimeout(() => {
      this.turnWatchdogTimer = null;
      if (this.terminal || this.companionResultSent || !this.isContextCurrent(context)) return;
      const audioStreamed = this.audioStarted || this.audioBytes > 0;
      this.finishAudioIfNeeded(this.activeResponse);
      this.emit({
        type: 'companion_voice_result',
        ok: true,
        done: true,
        filtered: true,
        filterReason: `hf-turn-watchdog-${reason}`,
        hf: true,
        routeMode: this.payload.routeMode || this.payload.route || '',
        brainMode: this.payload.brainMode || '',
        sttProfile: normalizeSTTProfile(this.payload.sttProfile || this.payload.sttQualityProfile || ''),
        transcript: this.lastFinalTranscript,
        rawText: this.lastFinalTranscript,
        reply: '',
        elapsedMs: Math.max(10_000, TURN_WATCHDOG_MS),
        audioStreamed,
      }, context);
      this.emit({ type: 'status', status: 'ready', hf: true, bridgeReady: this.ready, reason: `hf-turn-watchdog-${reason}` }, context);
      this.companionResultSent = true;
      this.terminalizeTurn(`hf-turn-watchdog-${reason}`);
    }, Math.max(10_000, TURN_WATCHDOG_MS));
    this.turnWatchdogTimer.unref?.();
  }

  clearTurnWatchdog() {
    if (this.turnWatchdogTimer) clearTimeout(this.turnWatchdogTimer);
    this.turnWatchdogTimer = null;
  }

  transcriptItemContext(event = {}) {
    const itemID = String(event.item_id || event.itemID || this.activeTurn?.turnID || '').trim();
    if (!itemID) return { itemID, context: null };
    if (this.inputItemTombstones.has(itemID)) {
      this.rejectProtocol('STALE_HF_TRANSCRIPT_EVENT', 'Rejected a late transcript event for a completed input item.', event);
      return { itemID, context: null };
    }
    if (!this.activeTurn) {
      this.rejectProtocol('UNOWNED_HF_TRANSCRIPT_EVENT', 'Rejected a transcript event with no current turn ownership.', event);
      return { itemID, context: null };
    }
    let context = this.inputItemContexts.get(itemID);
    if (!context) {
      context = { ...this.activeTurn };
      this.inputItemContexts.set(itemID, context);
      while (this.inputItemContexts.size > 64) {
        const oldest = this.inputItemContexts.keys().next().value;
        this.inputItemContexts.delete(oldest);
        this.transcriptStates.delete(oldest);
        this.inputTranscriptByItem.delete(oldest);
        this.inputItemTombstones.add(oldest, { reason: 'transcript-state-capacity' });
      }
    }
    if (!this.isContextCurrent(context)) {
      this.rejectProtocol('STALE_HF_TRANSCRIPT_EVENT', 'Rejected a transcript event from a stale turn.', event, context);
      return { itemID, context: null };
    }
    return { itemID, context };
  }

  transcriptDeltaSemantics(state, event) {
    const rawDelta = String(event.delta || '');
    const previous = state.text;
    const contentIndex = Number(event.content_index);
    const explicitAppend = event.append === true || event.delta_mode === 'append' || event.operation === 'append';
    const explicitRevision = event.is_revision === true || event.delta_mode === 'revision' || event.operation === 'revision';
    if (!previous) return { operation: 'partial', text: rawDelta, delta: rawDelta };
    if (explicitAppend) return { operation: 'append', text: previous + rawDelta, delta: rawDelta };
    if (explicitRevision) return { operation: 'revision', text: rawDelta, delta: rawDelta };
    if (rawDelta.startsWith(previous)) {
      return { operation: 'append', text: rawDelta, delta: rawDelta.slice(previous.length) };
    }
    let commonPrefix = 0;
    const limit = Math.min(previous.length, rawDelta.length);
    while (commonPrefix < limit && previous[commonPrefix] === rawDelta[commonPrefix]) commonPrefix += 1;
    if (previous.startsWith(rawDelta) || commonPrefix > 0
        || (Number.isFinite(contentIndex) && contentIndex > Number(state.contentIndex ?? -1))) {
      return { operation: 'revision', text: rawDelta, delta: rawDelta };
    }
    return { operation: 'append', text: previous + rawDelta, delta: rawDelta };
  }

  handleTranscriptDelta(event) {
    if (!event.delta) return;
    const { itemID, context } = this.transcriptItemContext(event);
    if (!context) return;
    const state = this.transcriptStates.get(itemID) || { text: '', revision: 0, contentIndex: -1 };
    const update = this.transcriptDeltaSemantics(state, event);
    const previousRevision = state.revision;
    state.text = update.text;
    state.revision += 1;
    state.contentIndex = Number.isFinite(Number(event.content_index)) ? Number(event.content_index) : state.contentIndex;
    this.transcriptStates.set(itemID, state);
    this.inputTranscriptByItem.set(itemID, state.text);
    this.emit({
      type: 'transcript',
      text: state.text,
      rawText: state.text,
      delta: update.delta,
      rawDelta: String(event.delta || ''),
      operation: update.operation,
      revision: state.revision,
      replacesRevision: update.operation === 'revision' ? previousRevision : undefined,
      final: false,
      hf: true,
      itemID,
    }, context);
  }

  handleTranscriptCompleted(event) {
    const { itemID, context } = this.transcriptItemContext(event);
    if (!context) return;
    const state = this.transcriptStates.get(itemID) || { text: '', revision: 0 };
    const transcript = String(event.transcript ?? state.text ?? '');
    const previous = state.text;
    const update = transcript === previous
      ? 'none'
      : transcript.startsWith(previous)
        ? 'append'
        : 'revision';
    const delta = update === 'append' ? transcript.slice(previous.length) : update === 'revision' ? transcript : '';
    const revision = state.revision + 1;
    this.lastFinalTranscript = transcript;
    this.emit({
      type: 'transcript',
      text: transcript,
      rawText: transcript,
      delta,
      operation: 'final',
      finalUpdate: update,
      revision,
      replacesRevision: update === 'revision' ? state.revision : undefined,
      final: true,
      hf: true,
      itemID,
    }, context);
    this.transcriptStates.delete(itemID);
    this.inputTranscriptByItem.delete(itemID);
    this.inputItemContexts.delete(itemID);
    this.inputItemTombstones.add(itemID, { reason: 'transcript-final', turnID: context.turnID });
    if (transcript.trim()) {
      this.awaitingProviderResponse = true;
      this.scheduleTurnWatchdog('transcript-completed', context);
      this.triggerResponseAfterFinalTranscript('transcript-completed');
    }
  }

  appendResponseText(response, delta) {
    const addition = String(delta || '');
    if (!addition) return;
    response.text += addition;
    if (response.providerID) this.responseTextById.set(response.providerID, response.text);
    this.lastAssistantText = response.text;
    this.emit({
      type: 'reply_delta',
      text: response.text,
      delta: addition,
      responseID: response.providerID || response.id,
      providerResponseID: response.providerID || undefined,
      final: false,
    }, response);
  }

  finalizeResponseText(response, text = '') {
    const finalText = String(text || response.text || '');
    if (!finalText) return;
    response.text = finalText;
    this.lastAssistantText = finalText;
    if (response.providerID) {
      this.responseTextById.set(response.providerID, finalText);
      this.finalReplySentById.add(response.providerID);
    }
    if (response.finalReplySent) return;
    response.finalReplySent = true;
    this.emit({
      type: 'reply',
      text: finalText,
      responseID: response.providerID || response.id,
      providerResponseID: response.providerID || undefined,
      final: true,
    }, response);
  }

  handleResponseDone(event) {
    const response = this.resolveResponseContext(event);
    if (!response) return;
    const responseText = extractHFResponseText(event.response) || response.text;
    if (responseText) this.finalizeResponseText(response, responseText);
    response.providerDone = true;
    this.responseInProgress = false;
    this.responseCreateOutstanding = false;
    const unresolvedTools = Array.from(this.pendingToolCalls.values()).filter((pending) => pending.responseID === response.id);
    if (unresolvedTools.length) {
      this.clearTurnWatchdog();
      this.emit({
        type: 'status',
        status: 'awaiting_tool_result',
        pendingToolCalls: unresolvedTools.length,
      }, response);
      return;
    }
    if (this.pendingResponseRequests.length) {
      this.terminalizeResponse('tool-followup', response);
      this.flushResponseQueue();
      return;
    }
    if (this.audioStarted) {
      this.pendingCompanionResultAfterAudio = true;
      return;
    }
    this.sendCompanionDoneResult(response);
  }

  handleHFMessage(raw) {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
    const event = safeJSONParse(text);
    if (!event || typeof event.type !== 'string' || this.terminal) return;

    if (!this.configured
        && !['session.created', 'session.updated', 'error'].includes(event.type)
        && !event.type.startsWith('rate_limits.')) {
      this.rejectProtocol('STALE_HF_CONFIG_EVENT', 'Rejected an HF event while session configuration was not ready.', event);
      return;
    }

    switch (event.type) {
      case 'session.created':
        if (this.upstreamAdmitted) {
          this.rejectProtocol('DUPLICATE_HF_SESSION_ADMISSION', 'Ignored a duplicate HF session admission event.', event);
          break;
        }
        this.upstreamAdmitted = true;
        this.pipelineSessionID = String(event.session?.id || event.session_id || event.event_id || '');
        this.sendSessionUpdate('session.created-admitted').catch(() => {});
        break;
      case 'session.updated':
        this.markConfigured('session.updated-admitted');
        break;
      case 'input_audio_buffer.speech_started': {
        const hadResponse = !!this.activeResponse || this.responseInProgress || this.audioStarted;
        const turn = this.prepareForUserTurn('speech-started', { force: hadResponse });
        this.emit({ type: 'status', status: 'user-speaking' }, turn);
        if (hadResponse) this.emit({ type: 'interrupted', reason: 'turn_detected' }, turn);
        break;
      }
      case 'input_audio_buffer.speech_stopped': {
        const turn = this.activeTurn || this.prepareForUserTurn('speech-stopped');
        this.emit({ type: 'status', status: 'transcribing' }, turn);
        this.awaitingProviderResponse = true;
        this.scheduleTurnWatchdog('speech-stopped', turn);
        break;
      }
      case 'conversation.item.input_audio_transcription.delta':
        this.handleTranscriptDelta(event);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.handleTranscriptCompleted(event);
        break;
      case 'response.created': {
        const response = this.resolveResponseContext(event);
        if (!response) break;
        this.responseInProgress = true;
        this.responseCreateOutstanding = false;
        this.emit({ type: 'status', status: 'thinking' }, response);
        break;
      }
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
      case 'response.output_text.delta': {
        const response = this.resolveResponseContext(event);
        if (response) this.appendResponseText(response, event.delta);
        break;
      }
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
      case 'response.output_text.done': {
        const response = this.resolveResponseContext(event);
        if (response) this.finalizeResponseText(response, event.transcript || event.text || response.text);
        break;
      }
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const response = this.resolveResponseContext(event);
        if (response) this.forwardAudioDelta(event.delta, response);
        break;
      }
      case 'response.output_audio.done':
      case 'response.audio.done': {
        const response = this.resolveResponseContext(event, { allowCreate: false });
        if (!response) break;
        response.audioDone = true;
        this.finishAudioIfNeeded(response);
        if (this.pendingCompanionResultAfterAudio && response.providerDone) {
          this.pendingCompanionResultAfterAudio = false;
          this.sendCompanionDoneResult(response);
        }
        break;
      }
      case 'response.function_call_arguments.done': {
        const response = this.resolveResponseContext(event);
        if (response) this.handleToolCall(event, response);
        break;
      }
      case 'response.done':
        this.handleResponseDone(event);
        break;
      case 'error': {
        const code = event.error?.type || event.error?.code || event.code || 'HF_REALTIME_ERROR';
        this.emit({
          type: 'error',
          code,
          message: event.error?.message || event.message || 'HF realtime error',
          recoverable: code !== 'session_limit_reached',
        });
        break;
      }
      default:
        break;
    }
  }

  registerToolCall(event, response) {
    const name = String(event.name || '').trim();
    const callID = String(event.call_id || '').trim();
    if (!callID) {
      this.rejectProtocol('INVALID_HF_TOOL_CALL', 'Rejected an HF tool call without a call ID.', event, response);
      return null;
    }
    if (this.toolCallTombstones.has(callID)) {
      this.rejectProtocol('STALE_HF_TOOL_CALL', 'Rejected a stale or already completed HF tool call.', event, response);
      return null;
    }
    if (this.pendingToolCalls.has(callID)) {
      this.rejectProtocol('DUPLICATE_HF_TOOL_CALL', 'Rejected a duplicate pending HF tool call.', event, response);
      return null;
    }
    if (this.pendingToolCalls.size >= 64) {
      this.rejectProtocol('HF_TOOL_REGISTRY_FULL', 'Rejected a tool call because the bounded tool registry is full.', event, response);
      return null;
    }
    const deadlineAt = Date.now() + HF_TOOL_RESULT_TIMEOUT_MS;
    const linked = linkedAbortController([
      this.lifecycleAbortController.signal,
      response.abortController.signal,
    ], deadlineAt);
    const pending = {
      callID,
      name,
      argumentsJSON: String(event.arguments || '{}'),
      responseID: response.id,
      providerResponseID: response.providerID,
      turnID: response.turnID,
      generationID: response.generationID,
      configID: response.configID,
      createdAt: Date.now(),
      deadlineAt,
      signal: linked.signal,
      abortController: linked.controller,
      cleanupSignal: linked.cleanup,
      timer: null,
      resolved: false,
    };
    pending.timer = setTimeout(() => this.expireToolCall(pending), HF_TOOL_RESULT_TIMEOUT_MS);
    pending.timer.unref?.();
    this.pendingToolCalls.set(callID, pending);
    return pending;
  }

  clearPendingToolCall(pending, reason = 'completed') {
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    if (!pending.abortController?.signal.aborted) pending.abortController?.abort(makeAbortError(`Tool call ${reason}`));
    pending.cleanupSignal?.();
  }

  expireToolCall(pending) {
    if (this.pendingToolCalls.get(pending.callID) !== pending || pending.resolved) return;
    this.rejectProtocol('HF_TOOL_RESULT_TIMEOUT', 'The correlated HF tool result missed its deadline.', {
      type: 'tool.result',
      call_id: pending.callID,
    }, pending);
    this.sendToolResult({
      callID: pending.callID,
      output: JSON.stringify({ ok: false, error: 'The tool result timed out.' }),
    });
  }

  handleToolCall(event = {}, response = this.activeResponse) {
    const pending = this.registerToolCall(event, response);
    if (!pending) return;
    this.clearTurnWatchdog();
    const { name, callID } = pending;
    if (name === 'wait_for_user') {
      this.sendToolResult({ callID, output: 'Waiting silently for the user.' });
      return;
    }
    if (name.startsWith('iphone_') || name.startsWith('android_')) {
      this.emit({
        type: 'iphone_tool',
        iphoneToolName: name,
        iphoneToolArguments: pending.argumentsJSON,
        callID,
        hf: true,
        toolDeadlineAt: pending.deadlineAt,
      }, pending);
      return;
    }
    if (!this.toolHandler) {
      this.sendToolResult({
        callID,
        output: JSON.stringify({ ok: false, error: `Unsupported VoiceClaw Realtime Companion tool: ${name}` }),
      });
      return;
    }
    Promise.resolve(this.toolHandler({
      name,
      callID,
      argumentsJSON: pending.argumentsJSON,
      event,
      bridge: this,
      signal: pending.signal,
      deadlineAt: pending.deadlineAt,
      hfSessionID: this.hfSessionID,
      hfGenerationID: pending.generationID,
      hfConfigID: pending.configID,
      hfTurnID: pending.turnID,
      hfResponseID: pending.responseID,
    })).then((result) => {
      if (result === undefined || this.pendingToolCalls.get(callID) !== pending) return;
      this.sendToolResult({
        callID,
        output: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }).catch((error) => {
      if (this.pendingToolCalls.get(callID) !== pending) return;
      this.sendToolResult({
        callID,
        output: JSON.stringify({ ok: false, error: error?.message || String(error) }),
      });
    });
  }

  sendToolResult({
    callID = '',
    output = '',
    continueResponse = true,
    terminal = false,
    hfGenerationID = '',
    hfConfigID = '',
    hfTurnID = '',
    hfResponseID = '',
  } = {}) {
    const id = String(callID || '').trim();
    const pending = this.pendingToolCalls.get(id);
    if (!pending) {
      const stale = this.toolCallTombstones.has(id);
      this.rejectProtocol(
        stale ? 'DUPLICATE_OR_STALE_HF_TOOL_RESULT' : 'UNKNOWN_HF_TOOL_RESULT',
        stale ? 'Rejected a duplicate or stale HF tool result.' : 'Rejected an HF tool result with no correlated pending call.',
        { type: 'tool.result', call_id: id },
      );
      return false;
    }
    const suppliedMatches = (!hfGenerationID || hfGenerationID === pending.generationID)
      && (!hfConfigID || hfConfigID === pending.configID)
      && (!hfTurnID || hfTurnID === pending.turnID)
      && (!hfResponseID || hfResponseID === pending.responseID);
    const ownsActiveResponse = this.activeResponse?.id === pending.responseID;
    if (!suppliedMatches || !ownsActiveResponse || !this.isContextCurrent(pending)) {
      this.pendingToolCalls.delete(id);
      this.clearPendingToolCall(pending, 'stale-result');
      this.toolCallTombstones.add(id, { reason: 'stale-result', responseID: pending.responseID });
      this.rejectProtocol('STALE_HF_TOOL_RESULT', 'Rejected an HF tool result from a stale generation, configuration, turn, or response.', {
        type: 'tool.result',
        call_id: id,
      }, pending);
      return false;
    }
    pending.resolved = true;
    this.pendingToolCalls.delete(id);
    this.clearPendingToolCall(pending, 'completed');
    this.toolCallTombstones.add(id, { reason: 'completed', responseID: pending.responseID });
    const response = this.activeResponse;
    if (response?.providerDone) {
      const unresolved = Array.from(this.pendingToolCalls.values()).some((item) => item.responseID === response.id);
      if (!unresolved) this.terminalizeResponse('tool-results-complete', response);
    }
    const itemOperation = this.enqueueControl('conversation.item.create.tool-result', async () => {
      await this.sendUpstream({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: id,
          output: String(output || ''),
        },
      });
    });
    if (!terminal) {
      // Legacy callers used continueResponse=false to avoid racing response.done.
      // The queue now serializes that race, so both values continue exactly once.
      this.queueResponseCreate(continueResponse === false ? 'deferred-tool-result' : 'tool-result', pending);
    }
    itemOperation.then(() => {
      this.flushResponseQueue();
    }).catch(() => {});
    return true;
  }

  sendCompanionDoneResult(response = this.activeResponse) {
    if (this.companionResultSent || !this.activeTurn || !this.isContextCurrent(this.activeTurn)) return;
    this.companionResultSent = true;
    this.pendingCompanionResultAfterAudio = false;
    this.clearTurnWatchdog();
    const context = response || this.activeTurn;
    this.emit({
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
      elapsedMs: Date.now() - this.activeTurn.createdAt,
      audioStreamed: this.audioBytes > 0 || !!response?.audioDone,
    }, context);
    this.emit({ type: 'status', status: 'ready', hf: true, bridgeReady: this.ready }, context);
    this.terminalizeTurn('turn-complete');
  }

  recordOutputAudioGap(audio, reason, response) {
    if (!this.outputAudioGap || this.outputAudioGap.responseID !== response.id) {
      this.finishOutputAudioGap('response-changed');
      this.outputAudioGap = {
        id: `hf-output-gap-${++this.gapSequence}`,
        responseID: response.id,
        context: response,
        droppedFrames: 0,
        droppedBytes: 0,
      };
      this.emit({
        type: 'audio_gap',
        direction: 'output',
        phase: 'start',
        reason,
        gapId: this.outputAudioGap.id,
      }, response);
    }
    this.outputAudioGap.droppedFrames += 1;
    this.outputAudioGap.droppedBytes += audio.length;
    this.emit({
      type: 'status',
      status: 'output_backpressure',
      reason,
      gapId: this.outputAudioGap.id,
      droppedFrames: this.outputAudioGap.droppedFrames,
      droppedBytes: this.outputAudioGap.droppedBytes,
    }, response);
  }

  finishOutputAudioGap(reason = 'output-recovered') {
    if (!this.outputAudioGap) return;
    const gap = this.outputAudioGap;
    this.outputAudioGap = null;
    this.emit({
      type: 'audio_gap',
      direction: 'output',
      phase: 'end',
      reason,
      gapId: gap.id,
      droppedFrames: gap.droppedFrames,
      droppedBytes: gap.droppedBytes,
    }, gap.context);
    this.emit({ type: 'status', status: 'output_backpressure_recovered', gapId: gap.id }, gap.context);
  }

  forwardAudioDelta(delta, response = this.activeResponse) {
    if (!response || !this.isContextCurrent(response)) {
      this.rejectProtocol('STALE_HF_AUDIO_DELTA', 'Rejected an audio delta from a stale HF response.', { type: 'response.output_audio.delta' }, response);
      return false;
    }
    let audio = decodeAudioDelta(delta);
    if (!audio.length) return false;
    if (audio.length % 2 !== 0) {
      this.recordOutputAudioGap(audio.subarray(audio.length - 1), 'unaligned-pcm-s16le', response);
      audio = audio.subarray(0, audio.length - 1);
      if (!audio.length) return false;
    }
    if (this.clientWs?.readyState !== WebSocket.OPEN) {
      this.recordOutputAudioGap(audio, 'client-not-open', response);
      return false;
    }
    const bufferedAmount = Math.max(0, Number(this.clientWs?.bufferedAmount || 0));
    if (bufferedAmount + audio.length > HF_MAX_CLIENT_AUDIO_BUFFERED_BYTES) {
      this.recordOutputAudioGap(audio, 'client-output-buffer-capacity', response);
      return false;
    }
    if (!this.audioStarted) {
      this.audioStarted = true;
      this.audioBytes = 0;
      this.audioResponseContext = response;
      this.emit({
        type: 'tts_audio_start',
        sampleRate: DEFAULT_HF_SAMPLE_RATE,
        channels: 1,
        encoding: 'pcm_s16le',
        engine: 'hf-speech-to-speech',
        responseID: response.providerID || response.id,
      }, response);
    }
    let sent = false;
    try {
      sent = this.clientWs.send(audio, { binary: true }) !== false;
    } catch {
      sent = false;
    }
    if (!sent) {
      this.recordOutputAudioGap(audio, 'client-output-backpressure', response);
      return false;
    }
    this.finishOutputAudioGap('output-flowing');
    this.audioBytes += audio.length;
    return true;
  }

  finishAudioIfNeeded(response = this.audioResponseContext || this.activeResponse) {
    if (!this.audioStarted) return;
    const audioBytes = this.audioBytes;
    this.audioStarted = false;
    this.audioBytes = 0;
    this.audioResponseContext = null;
    this.finishOutputAudioGap('audio-ended');
    this.emit({
      type: 'tts_audio_end',
      audioBytes,
      sampleRate: DEFAULT_HF_SAMPLE_RATE,
      channels: 1,
      encoding: 'pcm_s16le',
      responseID: response?.providerID || response?.id || undefined,
    }, response);
  }
}
