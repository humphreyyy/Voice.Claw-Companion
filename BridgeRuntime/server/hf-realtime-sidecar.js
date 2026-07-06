import { spawn, execFile as execFileCb } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
const HF_HOME = process.env.HF_HOME || process.env.HUGGINGFACE_HUB_CACHE?.replace(/\/hub$/g, '') || join(os.homedir(), '.cache', 'huggingface');
const HF_VENV = process.env.VOICECLAW_HF_VENV || HF_ROOT;
const HF_PYTHON = process.env.VOICECLAW_HF_PYTHON || join(HF_VENV, 'bin', 'python');
const HF_CLI = process.env.VOICECLAW_HF_CLI || join(HF_VENV, 'bin', 'speech-to-speech');
const HF_LOG_DIR = process.env.VOICECLAW_HF_LOG_DIR || join(os.homedir(), 'Library', 'Application Support', 'VoiceClaw Companion', 'logs');
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
const VOICECLAW_HF_NUM_PIPELINES = Math.max(1, Number.parseInt(process.env.VOICECLAW_HF_NUM_PIPELINES || '1', 10));
const VOICECLAW_HF_LATENCY_TIER = process.env.VOICECLAW_HF_LATENCY_TIER || '0';
const VOICECLAW_HF_THROUGHPUT_TIER = process.env.VOICECLAW_HF_THROUGHPUT_TIER || '0';
const HF_PACKAGE_SPEC = process.env.VOICECLAW_HF_PACKAGE_SPEC || 'speech-to-speech';
const HF_INSTALL_TIMEOUT_MS = Number.parseInt(process.env.VOICECLAW_HF_INSTALL_TIMEOUT_MS || String(90 * 60 * 1000), 10);
const HF_START_TIMEOUT_MS = Number.parseInt(process.env.VOICECLAW_HF_START_TIMEOUT_MS || String(15 * 60 * 1000), 10);
const HF_START_ATTEMPTS = Math.max(1, Number.parseInt(process.env.VOICECLAW_HF_START_ATTEMPTS || '3', 10));
const HF_CACHE_CHECK_TIMEOUT_MS = Math.max(1000, Number.parseInt(process.env.VOICECLAW_HF_CACHE_CHECK_TIMEOUT_MS || '2000', 10));
const HF_CACHE_CHECK_TTL_MS = Math.max(1000, Number.parseInt(process.env.VOICECLAW_HF_CACHE_CHECK_TTL_MS || '60000', 10));
const HF_IMPORT_CHECK_TIMEOUT_MS = Math.max(1000, Number.parseInt(process.env.VOICECLAW_HF_IMPORT_CHECK_TIMEOUT_MS || '30000', 10));
const HF_DEFAULT_LOCAL_MODEL = process.env.VOICECLAW_HF_LOCAL_MODEL || 'mlx-community/Qwen3.5-2B-4bit';
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
  'gpt-5.4-mini': { model: 'gpt-5.4-mini', label: 'GPT-5.4-mini' },
  'gpt-5.4-nano': { model: 'gpt-5.4-nano', label: 'GPT-5.4-nano' },
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
let installInFlight = null;
let cerebrasResponsesAdapter = null;
let cerebrasResponsesAdapterKey = '';
let cerebrasResponsesAdapterBaseURL = '';
let shutdownCleanupInstalled = false;
let shutdownCleanupStarted = false;
const hfModelCache = new Map();
const pythonImportCache = new Map();
const pythonPackageVersionCache = new Map();
const pythonImportInFlight = new Map();
const pythonPackageVersionInFlight = new Map();
const hfModelCacheInFlight = new Map();

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
    }
  }
}

async function stopSidecarRecord(record, reason = 'restart') {
  if (!record?.proc || record.proc.killed) return;
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
  reservedHFPorts.clear();
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
  const fallback = HF_PORT + HF_POOL_SIZE + Math.floor(Math.random() * 1000);
  reservedHFPorts.add(fallback);
  return fallback;
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
  if (!clean || clean === 'local' || clean === 'qwen' || clean === 'qwen35' || clean === 'qwen3.5') return 'qwen3.5-2b';
  if (clean === 'cerebras') return `cerebras:${HF_DEFAULT_CEREBRAS_MODEL}`;
  if (['gpt-5.4-mini', 'gpt54-mini', 'gpt54mini', 'gpt-54-mini', 'openai/gpt-5.4-mini'].includes(clean.toLowerCase())) return 'gpt-5.4-mini';
  if (['gpt-5.4-nano', 'gpt54-nano', 'gpt54nano', 'gpt-54-nano', 'openai/gpt-5.4-nano'].includes(clean.toLowerCase())) return 'gpt-5.4-nano';
  return clean;
}

function openAIBrainModelForMode(brainMode = '') {
  return HF_OPENAI_BRAIN_MODELS[normalizeBrainMode(brainMode)] || null;
}

function localMiddleBrainRequired(brainMode = '') {
  const normalized = normalizeBrainMode(brainMode);
  return normalized === 'qwen3.5-2b';
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
      label: 'Local Qwen 3.5 2B + Parakeet Live STT + Kokoro TTS',
      required: true,
      options: { brainMode: 'qwen3.5-2b', sttProfile: 'parakeet-live', localVoice: 'kokoro-af-heart' },
    },
    {
      id: 'local-qwen-fast-whisper-kokoro',
      label: 'Local Qwen 3.5 2B + Faster Whisper Fast STT + Kokoro TTS',
      required: false,
      options: { brainMode: 'qwen3.5-2b', sttProfile: 'faster-whisper-fast', localVoice: 'kokoro-af-heart' },
    },
    {
      id: 'local-qwen-balanced-whisper-kokoro',
      label: 'Local Qwen 3.5 2B + Faster Whisper Balanced STT + Kokoro TTS',
      required: false,
      options: { brainMode: 'qwen3.5-2b', sttProfile: 'faster-whisper-balanced', localVoice: 'kokoro-af-heart' },
    },
  ];
  if (normalized === 'full') {
    profiles.push({
      id: 'local-qwen-mlx-whisper-kokoro',
      label: 'Local Qwen 3.5 2B + Whisper MLX Accurate STT + Kokoro TTS',
      required: false,
      options: { brainMode: 'qwen3.5-2b', sttProfile: 'mlx-whisper-accurate', localVoice: 'kokoro-af-heart' },
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
    ...(profile?.options || { brainMode: 'qwen3.5-2b', sttProfile: 'parakeet-live', localVoice: 'kokoro-af-heart' }),
    ...(options || {}),
    prepareSet: '',
  };
}

function hfRealtimeProfileKey(options = {}) {
  return JSON.stringify({
    brainMode: normalizeBrainMode(options.brainMode || 'qwen3.5-2b'),
    sttProfile: normalizeSTTProfile(options.sttProfile || ''),
    localVoice: String(options.localVoice || options.voice || 'kokoro-af-heart').trim().toLowerCase(),
  });
}

function hfSidecarIdentityKey(options = {}) {
  const brainMode = normalizeBrainMode(options.brainMode || 'qwen3.5-2b');
  const sttConfig = sttProfileConfig(options.sttProfile || options.sttQualityProfile || '');
  const ttsConfig = ttsConfigForHF(options);
  const prefix = brainMode.startsWith('cerebras:')
    ? `cerebras:${normalizeCerebrasModel(String(options.cerebrasModel || brainMode.slice('cerebras:'.length) || HF_DEFAULT_CEREBRAS_MODEL))}`
    : openAIBrainModelForMode(brainMode)
      ? `openai:${openAIBrainModelForMode(brainMode).model}`
    : `local:${HF_DEFAULT_LOCAL_MODEL}`;
  return `${prefix}:stt:${sttConfig.id}:tts:${ttsConfig.engine}:${ttsConfig.device || 'default'}:${ttsConfig.voice}`;
}

function primaryHFRealtimeProfileOptions(options = {}) {
  return {
    brainMode: normalizeBrainMode(options.brainMode || 'qwen3.5-2b'),
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

async function hfPoolHealth({ timeoutMs = 700, port = HF_PORT } = {}) {
  try {
    const pool = await fetchJSON(`${hfHttpBase(port)}/v1/pool`, { timeoutMs });
    return { reachable: true, pool };
  } catch (error) {
    return { reachable: false, error: error?.message || String(error) };
  }
}

export async function getHFRealtimeStatus(options = {}) {
  if (options.prepareSet) return await getHFRealtimeProfileSetStatus(options);
  return await getHFRealtimeSingleStatus(options);
}

async function getHFRealtimeSingleStatus(options = {}) {
  const brainMode = normalizeBrainMode(options.brainMode || process.env.VOICECLAW_HF_BRAIN_MODE || 'qwen3.5-2b');
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
  const requireOpenAIKey = openAIMiddleBrainRequired(brainMode);
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
  const requestedKey = hfSidecarIdentityKey({
    ...options,
    brainMode,
    sttProfile,
    localVoice: options.localVoice || options.voice || ttsConfig.voice,
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
    { id: 'middle-qwen35-2b-local', label: 'Qwen 3.5 2B local Companion Realtime Voice LLM', model: HF_DEFAULT_LOCAL_MODEL, cached: localModelCached, required: requireLocalMiddleBrain },
  ];
  const openAIKeyReady = !requireOpenAIKey || !!openAIKeyFromPayload(options);
  const cerebrasKeyReady = !requireCerebrasKey || !!cerebrasKeyFromPayload(options);
  const missingSTTModules = sttModuleStatuses.filter((item) => item.required && !item.ready);
  const missingTTSModules = ttsModuleStatuses.filter((item) => item.required && !item.ready);
  const missingRequiredModels = requiredModels.filter((model) => model.required && !model.cached);
  const ready = runtimeReady && missingSTTModules.length === 0 && missingTTSModules.length === 0 && missingRequiredModels.length === 0 && openAIKeyReady && cerebrasKeyReady;
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
      detail: 'Add a Cerebras API key in VoiceClaw Companion or sync it from VoiceClaw Realtime before using the Cerebras Companion Realtime Voice LLM.',
      installable: false,
      command: 'manual setup required',
    }] : []),
    ...(!openAIKeyReady ? [{
      id: 'openai-api-key',
      label: 'OpenAI API key',
      detail: 'Add an OpenAI API key in VoiceClaw Companion before using an OpenAI model as the Companion Realtime Voice LLM.',
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
    requireOpenAIKey,
    openAIKeyReady,
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
  if (localMiddleBrainRequired(options.brainMode || process.env.VOICECLAW_HF_BRAIN_MODE || 'qwen3.5-2b')) {
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

function normalizeCerebrasModel(model = '') {
  const clean = String(model || '').trim();
  if (!clean) return HF_DEFAULT_CEREBRAS_MODEL;
  if (clean === 'gemma-4-31B-it' || clean === 'google/gemma-4-31B-it:cerebras') return 'gemma-4-31b';
  return clean;
}

async function readJSONBody(req, limitBytes = 200 * 1024 * 1024) {
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

async function sidecarConfigFromPayload(payload = {}, { port = HF_PORT } = {}) {
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
    const adapterBaseURL = await ensureCerebrasResponsesAdapter(key);
    return {
      key: `cerebras:${model}:stt:${sttConfig.id}:tts:${ttsConfig.engine}:${ttsConfig.device || 'default'}:${ttsConfig.voice}`,
      env: {
        OPENAI_API_KEY: 'voiceclaw-local-cerebras-responses-adapter',
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
    };
  }

  const openAIBrain = openAIBrainModelForMode(brainMode);
  if (openAIBrain) {
    const model = openAIBrain.model;
    const apiKey = openAIKeyFromPayload(payload);
    if (!apiKey) {
      throw new Error(`OpenAI API key is required for the ${openAIBrain.label} Companion Realtime Voice LLM.`);
    }
    return {
      key: `openai:${model}:stt:${sttConfig.id}:tts:${ttsConfig.engine}:${ttsConfig.device || 'default'}:${ttsConfig.voice}`,
      env: {
        OPENAI_API_KEY: apiKey,
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
      '--llm_gen_max_new_tokens', '192',
      '--thresh', '0.5',
      '--min_silence_ms', '360',
      '--min_speech_ms', '384',
      '--speech_pad_ms', '240',
      '--num_pipelines', String(VOICECLAW_HF_NUM_PIPELINES),
      '--log_level', process.env.VOICECLAW_HF_LOG_LEVEL || 'info',
    ],
    port,
  };
}

async function appendLog(path, chunk) {
  try {
    await mkdir(HF_LOG_DIR, { recursive: true });
    await appendFile(path, chunk);
  } catch {}
}

async function launchHFRealtimeSidecarOnce(config, attempt) {
  const port = config.port || HF_PORT;
  const existing = sidecarPool.get(config.key);
  if (existing) {
    const existingHealth = await hfPoolHealth({ port: existing.port });
    if (existing.proc && !existing.proc.killed && existingHealth.reachable) {
      const owner = await verifyHFPortOwner(existing.proc.pid, existing.port);
      if (owner.ok) {
        sidecar = existing.proc;
        sidecarKey = existing.key;
        sidecarPort = existing.port;
        return { wsURL: existing.wsURL, key: existing.key, port: existing.port, health: existingHealth };
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
  };
  sidecarPool.set(config.key, record);
  let earlyExit = null;

  proc.stdout.on('data', (chunk) => appendLog(HF_STDOUT_LOG, chunk));
  proc.stderr.on('data', (chunk) => appendLog(HF_STDERR_LOG, chunk));
  proc.on('exit', (code, signal) => {
    earlyExit = { code, signal };
    reservedHFPorts.delete(port);
    appendLog(HF_STDERR_LOG, `\n[hf-sidecar] exited code=${code} signal=${signal} attempt=${attempt}\n`);
    if (sidecar === proc || sidecarKey === config.key) {
      sidecar = null;
      sidecarKey = '';
    }
    if (sidecarPool.get(config.key)?.proc === proc) {
      sidecarPool.delete(config.key);
    }
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < HF_START_TIMEOUT_MS) {
    const nextHealth = await hfPoolHealth({ port });
    if (nextHealth.reachable) {
      const owner = await verifyHFPortOwner(proc.pid, port);
      if (owner.ok) {
        console.log(`[hf-sidecar] ready key=${config.key} pid=${proc.pid} attempt=${attempt} port=${port} portOwners=${owner.owners.join(',')}`);
        for (const ownerPid of owner.owners || []) {
          applyRealtimeProcessPolicy(ownerPid, `${config.key}:listener`).catch(() => {});
        }
        await cleanupStaleHFProcesses(`post-launch-attempt-${attempt}`, { keepPids: poolKeepPids([proc.pid]) });
        return { wsURL: hfWsURL(port), key: config.key, port, health: nextHealth };
      }
      throw new Error(`HF speech-to-speech sidecar became reachable on ${port}, but the listener is stale or wrong (${owner.reason}).`);
    }
    if (earlyExit) {
      throw new Error(`HF speech-to-speech sidecar exited early with code ${earlyExit.code ?? 'unknown'} signal ${earlyExit.signal ?? 'none'}. Check ${HF_STDERR_LOG}.`);
    }
    await sleep(1000);
  }

  await stopSidecarRecord(record, `startup-timeout-attempt-${attempt}`);
  sidecarPool.delete(config.key);
  reservedHFPorts.delete(port);
  throw new Error(`HF speech-to-speech sidecar did not become ready on ${port} within ${Math.round(HF_START_TIMEOUT_MS / 1000)} seconds. Check ${HF_STDERR_LOG}.`);
}

export async function ensureHFRealtimeSidecar(payload = {}) {
  const status = await getHFRealtimeStatus({ brainMode: payload.brainMode, ...payload });
  if (status.requireOpenAIKey && !status.openAIKeyReady) {
    throw new Error('OpenAI API key is required for the selected OpenAI Companion Realtime Voice LLM.');
  }
  if (status.requireCerebrasKey && !status.cerebrasKeyReady) {
    throw new Error('Cerebras API key is required for the HF/Cerebras Companion Realtime Voice LLM.');
  }
  if (status.state !== 'ready') {
    throw new Error('HF speech-to-speech runtime is not installed. Use Companion setup to install the HF runtime first.');
  }

  await dropDeadPoolRecords();
  const identityConfig = await sidecarConfigFromPayload(payload, { port: HF_PORT });
  const key = identityConfig.key;
  if (sidecarStartingByKey.has(key)) return await sidecarStartingByKey.get(key);
  const existingRecord = sidecarPool.get(key);
  const preferredPort = key === sidecarKey ? sidecarPort : preferredHFPoolPortForKey(key);
  const port = existingRecord?.port || await allocateHFPoolPort(preferredPort);
  const config = await sidecarConfigFromPayload(payload, { port });
  if (config.key.startsWith('cerebras:') && !cerebrasKeyFromPayload(payload)) {
    throw new Error('Cerebras API key is required for the HF/Cerebras Companion Realtime Voice LLM.');
  }
  if (config.key.startsWith('openai:') && !openAIKeyFromPayload(payload)) {
    throw new Error('OpenAI API key is required for the selected OpenAI Companion Realtime Voice LLM.');
  }

  const startPromise = (async () => {
    const record = sidecarPool.get(config.key);
    const health = record ? await hfPoolHealth({ port: record.port }) : { reachable: false };
    if (record?.proc && !record.proc.killed && health.reachable) {
      const owner = await verifyHFPortOwner(record.proc.pid, record.port);
      if (owner.ok) {
        sidecar = record.proc;
        sidecarKey = record.key;
        sidecarPort = record.port;
        await cleanupStaleHFProcesses('tracked-sidecar-cleanup', { keepPids: poolKeepPids() });
        return { wsURL: record.wsURL, key: record.key, port: record.port, health };
      }
      console.warn(`[hf-sidecar] tracked sidecar is not the active HF listener; restarting (${owner.reason})`);
    }

    let lastError = null;
    for (let attempt = 1; attempt <= HF_START_ATTEMPTS; attempt += 1) {
      try {
        return await launchHFRealtimeSidecarOnce(config, attempt);
      } catch (error) {
        lastError = error;
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
        if (attempt < HF_START_ATTEMPTS) await sleep(Math.min(5000, 1000 * attempt));
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
  try {
    return await startPromise;
  } finally {
    if (sidecarStarting === startPromise) sidecarStarting = null;
    sidecarStartingByKey.delete(config.key);
  }
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
    if (!candidate) return process.env.VOICECLAW_HF_KOKORO_VOICE || 'af_heart';
    if (lower.startsWith('kokoro-')) return candidate.slice('kokoro-'.length).replace(/-/g, '_') || 'af_heart';
    if (lower.includes('heart')) return 'af_heart';
    if (lower.includes('fable')) return 'bm_fable';
    return candidate.replace(/^openai-/i, '').replace(/^piper-/i, '').replace(/-/g, '_') || 'af_heart';
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
    this.turnWatchdogTimer = null;
    this.hfHeartbeatTimer = null;
    this.hfLastPongAt = 0;
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
        this.startHFHeartbeat(ws);
        clearTimeout(timeout);
        resolve();
      });
      ws.on('pong', () => {
        this.hfLastPongAt = Date.now();
      });
      ws.on('message', (data) => this.handleHFMessage(data));
      ws.on('close', () => {
        this.stopHFHeartbeat();
        if (this.closed) return;
        this.closed = true;
        if (!this.configured) return;
        this.send({ type: 'error', message: 'HF realtime websocket closed unexpectedly' });
        this.send({ type: 'status', status: 'closed' });
      });
      ws.on('error', (error) => {
        if (!this.configured) this.stopHFHeartbeat();
        if (!this.configured) reject(error);
        else this.send({ type: 'error', message: `HF realtime websocket error: ${error.message}` });
      });
    });
  }

  startHFHeartbeat(ws) {
    this.stopHFHeartbeat();
    this.hfLastPongAt = Date.now();
    this.hfHeartbeatTimer = setInterval(() => {
      if (this.closed || ws.readyState !== WebSocket.OPEN) return;
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
    if (this.hfHeartbeatTimer) {
      clearInterval(this.hfHeartbeatTimer);
      this.hfHeartbeatTimer = null;
    }
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
    this.prepareForUserTurn('end-of-speech-padding');
    const vad = turnDetectionForHF(this.payload);
    const paddingMs = Math.max(650, Math.min(1600, Number(vad.silence_duration_ms || 420) + 320));
    const silence = Buffer.alloc(Math.round((DEFAULT_HF_SAMPLE_RATE * 2 * paddingMs) / 1000));
    this.hfWs.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: encodePCMChunk(silence),
    }));
    this.awaitingResponseAfterTranscript = true;
    this.scheduleTurnWatchdog('end-of-speech-padding');
  }

  interrupt(reason = 'client-barge-in') {
    if (this.hfWs?.readyState === WebSocket.OPEN) {
      this.hfWs.send(JSON.stringify({ type: 'response.cancel' }));
    }
    this.responseInProgress = false;
    this.pendingToolFollowupResponse = false;
    this.pendingCompanionResultAfterAudio = false;
    this.awaitingToolFollowup = false;
    this.clearTurnWatchdog();
    this.finishAudioIfNeeded();
    this.send({ type: 'interrupted', reason });
  }

  flushPendingToolFollowupResponse() {
    if (!this.pendingToolFollowupResponse || this.responseInProgress || this.hfWs?.readyState !== WebSocket.OPEN) return false;
    this.pendingToolFollowupResponse = false;
    this.awaitingToolFollowup = true;
    this.hfWs.send(JSON.stringify(this.responseCreateEvent()));
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
    this.clearResponseCreateFallback();
    this.clearTurnWatchdog();
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
    this.stopHFHeartbeat();
    if (this.configureTimer) clearTimeout(this.configureTimer);
    if (this.responseCreateTimer) clearTimeout(this.responseCreateTimer);
    if (this.turnWatchdogTimer) clearTimeout(this.turnWatchdogTimer);
    try { this.hfWs?.close(); } catch {}
  }

  clearResponseCreateFallback() {
    this.awaitingResponseAfterTranscript = false;
    if (this.responseCreateTimer) {
      clearTimeout(this.responseCreateTimer);
      this.responseCreateTimer = null;
    }
  }

  triggerResponseAfterFinalTranscript(reason = 'transcript-completed') {
    if (!this.lastFinalTranscript.trim() || this.responseInProgress || this.hfWs?.readyState !== WebSocket.OPEN) return;
    if (this.responseCreateTimer) clearTimeout(this.responseCreateTimer);
    this.responseCreateTimer = setTimeout(() => {
      this.responseCreateTimer = null;
      if (this.closed || this.companionResultSent || this.responseInProgress || this.hfWs?.readyState !== WebSocket.OPEN) return;
      if (!this.lastFinalTranscript.trim()) return;
      this.awaitingResponseAfterTranscript = false;
      this.hfWs.send(JSON.stringify(this.responseCreateEvent()));
      this.scheduleTurnWatchdog(`response-create-${reason}`);
    }, 80);
  }

  responseCreateEvent() {
    const voice = ttsConfigForHF(this.payload).voice;
    return {
      type: 'response.create',
      response: {
        output_modalities: ['text', 'audio'],
        audio: {
          output: { voice },
        },
      },
    };
  }

  scheduleTurnWatchdog(reason = 'turn') {
    if (this.turnWatchdogTimer) clearTimeout(this.turnWatchdogTimer);
    this.turnWatchdogTimer = setTimeout(() => {
      this.turnWatchdogTimer = null;
      if (this.closed || this.companionResultSent) return;
      this.clearResponseCreateFallback();
      this.responseInProgress = false;
      this.pendingToolFollowupResponse = false;
      this.pendingCompanionResultAfterAudio = false;
      this.awaitingToolFollowup = false;
      const audioStreamed = this.audioStarted;
      this.finishAudioIfNeeded();
      this.send({
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
        elapsedMs: TURN_WATCHDOG_MS,
        audioStreamed,
      });
      this.send({ type: 'status', status: 'ready', reason: `hf-turn-watchdog-${reason}` });
    }, Math.max(10_000, TURN_WATCHDOG_MS));
  }

  clearTurnWatchdog() {
    if (this.turnWatchdogTimer) {
      clearTimeout(this.turnWatchdogTimer);
      this.turnWatchdogTimer = null;
    }
  }

  prepareForUserTurn(reason = 'user-turn') {
    this.clearResponseCreateFallback();
    this.clearTurnWatchdog();
    this.awaitingResponseAfterTranscript = false;
    this.responseInProgress = false;
    this.pendingToolFollowupResponse = false;
    this.pendingCompanionResultAfterAudio = false;
    this.awaitingToolFollowup = false;
    this.companionResultSent = false;
    this.lastFinalTranscript = '';
    this.lastAssistantText = '';
    this.send({ type: 'status', status: 'user-turn-open', reason });
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
    const voice = ttsConfigForHF(this.payload).voice;
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
    this.hfWs.send(JSON.stringify({ type: 'session.update', session }));
    if (this.configureTimer) clearTimeout(this.configureTimer);
    this.configureTimer = setTimeout(() => this.markConfigured('session.update-accepted'), 900);
  }

  updateSession({ payload = this.payload, tools = this.tools, instructions = this.instructions } = {}) {
    this.payload = payload || {};
    this.tools = Array.isArray(tools) ? tools : [];
    this.instructions = instructions || 'You are VoiceClaw Realtime, a fast conversational voice assistant.';
    this.configured = false;
    this.sendSessionUpdate();
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
        this.prepareForUserTurn('speech-started');
        this.send({ type: 'status', status: 'user-speaking' });
        this.send({ type: 'interrupted', reason: 'turn_detected' });
        break;
      case 'input_audio_buffer.speech_stopped':
        this.send({ type: 'status', status: 'transcribing' });
        this.awaitingResponseAfterTranscript = true;
        this.scheduleTurnWatchdog('speech-stopped');
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
        this.scheduleTurnWatchdog('transcript-completed');
        this.triggerResponseAfterFinalTranscript('transcript-completed');
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
        this.clearTurnWatchdog();
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
