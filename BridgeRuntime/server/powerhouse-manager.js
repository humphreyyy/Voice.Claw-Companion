import { execFile as execFileCb, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import { getHFRealtimeStatus, installHFRealtimeRuntime, prewarmHFRealtimeRuntime } from './hf-realtime-sidecar.js';
import { getTtsStatus, getVoiceOptions, synthesizeStream } from './tts.js';
import { prewarmProcessing } from './dialogue.js';

const execFile = promisify(execFileCb);

const VALID_MODES = new Set(['light', 'balanced', 'maximum', 'presentation']);
const DEFAULT_MODE = normalizePowerhouseMode(process.env.VOICECLAW_POWERHOUSE_MODE || 'maximum');
const CONFIG_PATH = process.env.VOICECLAW_CONFIG_PATH || process.env.VOICECLAW_CONFIG || `${os.homedir()}/.voiceclaw/bridge.json`;
const HF_ROOT = process.env.VOICECLAW_HF_ROOT || `${os.homedir()}/.voiceclaw/hf-runtime`;
const HF_PYTHON = process.env.VOICECLAW_HF_PYTHON || `${HF_ROOT}/bin/python`;
const AGGRESSIVE_THREADS = Math.max(4, Number.parseInt(process.env.VOICECLAW_AGGRESSIVE_THREADS || String(os.cpus().length || 4), 10));
const HARDWARE_SNAPSHOT_TTL_MS = 10_000;
const STATUS_TTL_MS = 4_000;

let hardwareSnapshot = null;
let hardwareSnapshotAt = 0;
let cachedStatus = null;
let cachedStatusAt = 0;
let prewarmInFlight = null;
let lastPrewarm = null;
let bootPrewarmStarted = false;
let caffeinateProcess = null;

export function stopPowerhouseActivity(reason = 'shutdown') {
  if (!caffeinateProcess) return;
  const pid = caffeinateProcess.pid;
  console.log(`[powerhouse] stopping macOS activity assertion pid=${pid || 'unknown'} reason=${reason}`);
  try { caffeinateProcess.kill('SIGTERM'); } catch {}
  caffeinateProcess = null;
}

process.once('exit', () => {
  if (caffeinateProcess) {
    try { caffeinateProcess.kill('SIGTERM'); } catch {}
  }
});

export function normalizePowerhouseMode(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'off' || raw === 'minimal') return 'light';
  if (raw === 'max' || raw === 'aggressive' || raw === 'powerhouse') return 'maximum';
  if (raw === 'demo' || raw === 'stage' || raw === 'premier') return 'presentation';
  return VALID_MODES.has(raw) ? raw : 'maximum';
}

export function readPowerhouseModeFromConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return normalizePowerhouseMode(parsed.powerhouseMode || parsed.PowerhouseMode || DEFAULT_MODE);
  } catch {
    return DEFAULT_MODE;
  }
}

function defaultCompanionVoiceRuntimeProfile() {
  return {
    brainMode: 'qwen3.5-2b',
    sttProfile: 'parakeet-live',
    localVoice: 'kokoro-af-heart',
    prepareSet: 'recommended',
  };
}

export function readPrimaryCompanionVoiceRuntimeProfileFromConfig() {
  const fallback = defaultCompanionVoiceRuntimeProfile();
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    const profile = parsed.lastCompanionVoiceRuntimeProfile || parsed.companionVoiceRuntimeProfile || {};
    const brainMode = String(profile.brainMode || fallback.brainMode).trim() || fallback.brainMode;
    if (brainMode.startsWith('cerebras:') && !String(parsed.cerebrasAPIKey || process.env.CEREBRAS_API_KEY || '').trim()) {
      return fallback;
    }
    return {
      brainMode,
      sttProfile: String(profile.sttProfile || fallback.sttProfile).trim() || fallback.sttProfile,
      localVoice: String(profile.localVoice || profile.voice || fallback.localVoice).trim() || fallback.localVoice,
      cerebrasModel: String(profile.cerebrasModel || '').trim(),
      prepareSet: 'recommended',
    };
  } catch {
    return fallback;
  }
}

function modeSpec(mode = DEFAULT_MODE) {
  const normalized = normalizePowerhouseMode(mode);
  const basePrimary = {
    id: 'primary',
    label: 'Primary/default realtime profile',
    options: readPrimaryCompanionVoiceRuntimeProfileFromConfig(),
    required: true,
  };
  const specs = {
    light: {
      mode: 'light',
      label: 'Light',
      summary: 'Keeps the bridge online and warms only the primary realtime profile when requested.',
      installPrepareSet: 'selected',
      maxParallel: 1,
      ttsProbeRepeats: 0,
      routePrewarmRepeats: 0,
      networkProbeRepeats: 0,
      profiles: [basePrimary],
      routePrewarm: false,
      networkPrewarm: false,
      ttsProbe: false,
    },
    balanced: {
      mode: 'balanced',
      label: 'Balanced',
      summary: 'Keeps the primary/default local realtime stack warm and prepares the recommended fallback STT/TTS profiles.',
      installPrepareSet: 'recommended',
      maxParallel: 3,
      ttsProbeRepeats: 1,
      routePrewarmRepeats: 1,
      networkProbeRepeats: 1,
      profiles: [basePrimary],
      routePrewarm: true,
      networkPrewarm: true,
      ttsProbe: true,
    },
    maximum: {
      mode: 'maximum',
      label: 'Maximum',
      summary: 'Aggressively installs, verifies, cycles fallback profiles, restores the primary hot runtime, and warms TTS, route, and network paths.',
      installPrepareSet: 'full',
      maxParallel: 8,
      ttsProbeRepeats: 3,
      routePrewarmRepeats: 2,
      networkProbeRepeats: 2,
      profiles: [
        basePrimary,
        {
          id: 'fast-whisper',
          label: 'Fast STT fallback',
          options: { brainMode: 'qwen3.5-2b', sttProfile: 'faster-whisper-fast', localVoice: 'kokoro-af-heart', prepareSet: '' },
          required: false,
        },
        {
          id: 'balanced-whisper',
          label: 'Balanced STT fallback',
          options: { brainMode: 'qwen3.5-2b', sttProfile: 'faster-whisper-balanced', localVoice: 'kokoro-af-heart', prepareSet: '' },
          required: false,
        },
        {
          id: 'accurate-mlx-whisper',
          label: 'Accurate MLX STT fallback',
          options: { brainMode: 'qwen3.5-2b', sttProfile: 'mlx-whisper-accurate', localVoice: 'kokoro-af-heart', prepareSet: '' },
          required: false,
        },
      ],
      routePrewarm: true,
      networkPrewarm: true,
      ttsProbe: true,
    },
    presentation: {
      mode: 'presentation',
      label: 'Presentation',
      summary: 'Uses the Mac like a realtime appliance: full local prep, repeated warm probes, fallback cycling, and primary-runtime restoration for lowest-latency live demos.',
      installPrepareSet: 'full',
      maxParallel: 12,
      ttsProbeRepeats: 5,
      routePrewarmRepeats: 3,
      networkProbeRepeats: 3,
      profiles: [
        basePrimary,
        {
          id: 'fast-whisper',
          label: 'Fast STT fallback',
          options: { brainMode: 'qwen3.5-2b', sttProfile: 'faster-whisper-fast', localVoice: 'kokoro-af-heart', prepareSet: '' },
          required: false,
        },
        {
          id: 'balanced-whisper',
          label: 'Balanced STT fallback',
          options: { brainMode: 'qwen3.5-2b', sttProfile: 'faster-whisper-balanced', localVoice: 'kokoro-af-heart', prepareSet: '' },
          required: false,
        },
        {
          id: 'accurate-mlx-whisper',
          label: 'Accurate MLX STT fallback',
          options: { brainMode: 'qwen3.5-2b', sttProfile: 'mlx-whisper-accurate', localVoice: 'kokoro-af-heart', prepareSet: '' },
          required: false,
        },
      ],
      routePrewarm: true,
      networkPrewarm: true,
      ttsProbe: true,
    },
  };
  return specs[normalized] || specs.maximum;
}

function memoryPressure(snapshot = {}) {
  const usedRatio = snapshot.memoryBytes?.total
    ? (snapshot.memoryBytes.total - snapshot.memoryBytes.freeApprox) / snapshot.memoryBytes.total
    : 0;
  const swapUsed = snapshot.swapBytes?.used || 0;
  if (usedRatio > 0.985 && swapUsed > 12 * 1024 * 1024 * 1024) return 'critical';
  if (usedRatio > 0.95 && swapUsed > 8 * 1024 * 1024 * 1024) return 'high';
  if (swapUsed > 4 * 1024 * 1024 * 1024 || usedRatio > 0.88) return 'elevated';
  return 'normal';
}

function workerMeta(id, spec = modeSpec(DEFAULT_MODE)) {
  if (id.startsWith('tts-probe')) {
    return { resource: 'local streaming TTS engine + audio synthesis cache', mode: spec.mode };
  }
  if (id.startsWith('route-prewarm')) {
    return { resource: 'OpenClaw/Hermes route processor + Node subprocess path', mode: spec.mode };
  }
  if (id.startsWith('network-openai') || id.startsWith('network-cerebras') || id.startsWith('network-hf')) {
    return { resource: 'network', mode: spec.mode };
  }
  const table = {
    'activity-assertion': {
      resource: 'macOS power management',
      mode: spec.mode,
    },
    'python-runtime-prime': {
      resource: 'Python import cache + NLTK/Silero/Torch/MLX filesystem cache',
      mode: spec.mode,
    },
    'hf-install': {
      resource: 'Python venv + Hugging Face cache + network',
      mode: spec.mode,
    },
    'hf-prewarm-primary': {
      resource: 'pooled HF sidecar; MPS/CPU + local model cache',
      mode: spec.mode,
    },
    'hf-prewarm-fast-whisper': {
      resource: 'pooled HF sidecar; CPU/MPS STT fallback',
      mode: spec.mode,
    },
    'hf-prewarm-balanced-whisper': {
      resource: 'pooled HF sidecar; CPU/MPS STT fallback',
      mode: spec.mode,
    },
    'hf-prewarm-accurate-mlx-whisper': {
      resource: 'pooled HF sidecar; MLX/MPS accurate STT fallback',
      mode: spec.mode,
    },
    'tts-probe': {
      resource: 'local streaming TTS engine + audio synthesis cache',
      mode: spec.mode,
    },
    'route-prewarm': {
      resource: 'OpenClaw/Hermes route processor + Node subprocess path',
      mode: spec.mode,
    },
    'network-openai': {
      resource: 'network',
      mode: spec.mode,
    },
    'network-cerebras': {
      resource: 'network',
      mode: spec.mode,
    },
    'network-hf': {
      resource: 'network',
      mode: spec.mode,
    },
  };
  return table[id] || { resource: '', mode: spec.mode };
}

async function commandText(command, args = [], timeout = 5000) {
  try {
    const { stdout } = await execFile(command, args, { timeout, maxBuffer: 1024 * 1024 });
    return String(stdout || '');
  } catch {
    return '';
  }
}

async function runPrimeCommand(command, args = [], timeout = 120_000) {
  try {
    const { stdout, stderr } = await execFile(command, args, {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        TOKENIZERS_PARALLELISM: 'true',
        OMP_NUM_THREADS: String(AGGRESSIVE_THREADS),
        OPENBLAS_NUM_THREADS: String(AGGRESSIVE_THREADS),
        VECLIB_MAXIMUM_THREADS: String(AGGRESSIVE_THREADS),
        NUMEXPR_NUM_THREADS: String(AGGRESSIVE_THREADS),
        MKL_NUM_THREADS: String(AGGRESSIVE_THREADS),
        PYTORCH_ENABLE_MPS_FALLBACK: '1',
        PYTORCH_MPS_HIGH_WATERMARK_RATIO: process.env.PYTORCH_MPS_HIGH_WATERMARK_RATIO || '0.0',
        HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE || '1',
      },
    });
    return { ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function ensurePowerhouseActivity(spec) {
  if (spec.mode === 'light') return { state: 'skipped', summary: 'Light mode does not hold a macOS activity assertion.' };
  if (caffeinateProcess && !caffeinateProcess.killed) {
    return { state: 'ready', summary: `Powerhouse activity assertion already active (pid ${caffeinateProcess.pid}).`, pid: caffeinateProcess.pid };
  }
  if (/^(1|true|yes)$/i.test(String(process.env.VOICECLAW_DISABLE_CAFFEINATE || ''))) {
    return { state: 'skipped', summary: 'Powerhouse activity assertion disabled by environment.' };
  }
  caffeinateProcess = spawn('/usr/bin/caffeinate', ['-dimsu'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  caffeinateProcess.unref();
  caffeinateProcess.on('exit', () => {
    caffeinateProcess = null;
  });
  return {
    state: 'ready',
    summary: `macOS sleep/display/disk idle suppression active for VoiceClaw Powerhouse runtime (pid ${caffeinateProcess.pid}).`,
    pid: caffeinateProcess.pid,
  };
}

function parseVMStat(text = '') {
  const pageSize = Number(String(text).match(/page size of (\d+) bytes/i)?.[1] || 16384);
  const pages = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^Pages\s+([^:]+):\s+([0-9.]+)/i);
    if (!match) continue;
    pages[match[1].trim().toLowerCase().replace(/\s+/g, '_')] = Number(match[2]) || 0;
  }
  const freePages = (pages.free || 0) + (pages.speculative || 0);
  return {
    pageSize,
    freeApprox: freePages * pageSize,
    compressor: (pages.occupied_by_compressor || 0) * pageSize,
  };
}

function parseSwap(text = '') {
  const match = String(text).match(/total\s*=\s*([0-9.]+)M\s+used\s*=\s*([0-9.]+)M\s+free\s*=\s*([0-9.]+)M/i);
  if (!match) return { total: 0, used: 0, free: 0 };
  return {
    total: Math.round(Number(match[1]) * 1024 * 1024),
    used: Math.round(Number(match[2]) * 1024 * 1024),
    free: Math.round(Number(match[3]) * 1024 * 1024),
  };
}

export async function getHardwareSnapshot({ force = false } = {}) {
  if (!force && hardwareSnapshot && Date.now() - hardwareSnapshotAt < HARDWARE_SNAPSHOT_TTL_MS) return hardwareSnapshot;
  const [brand, physical, logical, vm, swap, gpu] = await Promise.all([
    commandText('sysctl', ['-n', 'machdep.cpu.brand_string']).then((text) => text.trim()),
    commandText('sysctl', ['-n', 'hw.physicalcpu']).then((text) => Number(text.trim()) || os.cpus().length),
    commandText('sysctl', ['-n', 'hw.logicalcpu']).then((text) => Number(text.trim()) || os.cpus().length),
    commandText('vm_stat'),
    commandText('sysctl', ['vm.swapusage']),
    commandText('system_profiler', ['SPDisplaysDataType'], 10_000),
  ]);
  const vmParsed = parseVMStat(vm);
  const snapshot = {
    capturedAt: new Date().toISOString(),
    host: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    cpuBrand: brand || os.cpus()[0]?.model || 'CPU',
    cpuCores: {
      physical,
      logical,
      performanceEfficiencySplit: /Apple M4/i.test(brand) ? '4 performance / 6 efficiency' : '',
    },
    gpu: {
      description: /Apple M4/i.test(gpu) ? 'Apple M4 integrated GPU / Metal-capable unified memory' : 'GPU detected by macOS',
      metal: /Metal/i.test(gpu),
    },
    loadAverage: os.loadavg(),
    memoryBytes: {
      total: os.totalmem(),
      freeApprox: Math.max(os.freemem(), vmParsed.freeApprox),
      compressor: vmParsed.compressor,
    },
    swapBytes: parseSwap(swap),
  };
  snapshot.memoryPressure = memoryPressure(snapshot);
  snapshot.summary = `${snapshot.cpuBrand}; ${snapshot.cpuCores.physical} CPU cores; ${Math.round(snapshot.memoryBytes.total / 1024 / 1024 / 1024)} GB unified memory; memory pressure ${snapshot.memoryPressure}.`;
  hardwareSnapshot = snapshot;
  hardwareSnapshotAt = Date.now();
  return snapshot;
}

async function runLimited(tasks, limit = 2) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  return results;
}

async function timedWorker(id, label, specOrFn, maybeFn) {
  const spec = typeof specOrFn === 'function' ? modeSpec(DEFAULT_MODE) : specOrFn;
  const fn = typeof specOrFn === 'function' ? specOrFn : maybeFn;
  const meta = workerMeta(id, spec);
  const startedAt = Date.now();
  try {
    const result = await fn();
    return {
      id,
      label,
      resource: result?.resource || meta.resource,
      mode: result?.mode || meta.mode,
      state: result?.state || 'ready',
      ok: result?.ok !== false && result?.state !== 'error',
      elapsedMs: Date.now() - startedAt,
      summary: result?.summary || 'Ready.',
      detail: result,
    };
  } catch (error) {
    return {
      id,
      label,
      resource: meta.resource,
      mode: meta.mode,
      state: 'failed',
      ok: false,
      elapsedMs: Date.now() - startedAt,
      summary: error?.message || String(error),
    };
  }
}

async function probeNetworkEndpoint(id, label, url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
    return {
      id,
      label,
      state: response.ok || response.status < 500 ? 'ready' : 'degraded',
      ok: response.ok || response.status < 500,
      summary: `${label} reachable with HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      id,
      label,
      state: 'degraded',
      ok: false,
      summary: `${label} probe failed: ${error?.message || String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function getPowerhouseStatus({ mode = readPowerhouseModeFromConfig(), force = false } = {}) {
  if (!force && cachedStatus && Date.now() - cachedStatusAt < STATUS_TTL_MS) return cachedStatus;
  const spec = modeSpec(mode);
  const [hardware, tts, hf] = await Promise.all([
    getHardwareSnapshot(),
    getVoiceOptions().catch((error) => ({ status: { lastError: error?.message || String(error) }, voices: [] })),
    getHFRealtimeStatus({ prepareSet: spec.installPrepareSet === 'full' ? 'full' : 'recommended' }).catch((error) => ({ state: 'error', summary: error?.message || String(error) })),
  ]);
  const pressure = hardware.memoryPressure;
  const ready = hf.state === 'ready' && pressure !== 'critical';
  cachedStatus = {
    ok: ready,
    state: ready ? 'ready' : pressure === 'critical' ? 'resource_pressure' : 'needs_setup',
    mode: spec.mode,
    label: spec.label,
    summary: ready
      ? `${spec.label} Powerhouse is prepared. ${spec.summary}`
      : `${spec.label} Powerhouse needs attention. HF state: ${hf.state || 'unknown'}; memory pressure: ${pressure}.`,
    hardware,
    tts: tts.status || getTtsStatus(),
    voiceCount: Array.isArray(tts.voices) ? tts.voices.length : 0,
    hfRealtime: hf,
    lastPrewarm,
    resourcePosture: resourcePosture(spec, hardware),
    workerPlan: buildWorkerPlan(spec, hardware),
  };
  cachedStatusAt = Date.now();
  return cachedStatus;
}

export function getPowerhouseQuickStatus({ mode = readPowerhouseModeFromConfig() } = {}) {
  const spec = modeSpec(mode);
  if (cachedStatus) {
    return {
      ok: cachedStatus.ok,
      state: cachedStatus.state,
      mode: cachedStatus.mode || spec.mode,
      label: cachedStatus.label || spec.label,
      summary: cachedStatus.summary || `${spec.label} Powerhouse status is cached.`,
      cached: true,
      stale: Date.now() - cachedStatusAt >= STATUS_TTL_MS,
      lastCheckedAt: cachedStatusAt ? new Date(cachedStatusAt).toISOString() : '',
      lastPrewarm,
    };
  }

  if (prewarmInFlight) {
    return {
      ok: false,
      state: 'warming',
      mode: spec.mode,
      label: spec.label,
      summary: `${spec.label} Powerhouse warmup is running. Bridge liveness is separate from full voice-runtime readiness.`,
      cached: false,
      lastCheckedAt: '',
      lastPrewarm,
    };
  }

  if (lastPrewarm) {
    return {
      ok: lastPrewarm.ok !== false,
      state: lastPrewarm.state || (lastPrewarm.ok === false ? 'degraded' : 'ready'),
      mode: lastPrewarm.mode || spec.mode,
      label: lastPrewarm.label || spec.label,
      summary: lastPrewarm.summary || `${spec.label} Powerhouse last warm pass is available.`,
      cached: false,
      lastCheckedAt: '',
      lastPrewarm,
    };
  }

  return {
    ok: false,
    state: 'not_checked',
    mode: spec.mode,
    label: spec.label,
    summary: `${spec.label} Powerhouse readiness has not completed yet. Bridge liveness is available; use the Powerhouse status endpoint for full runtime checks.`,
    cached: false,
    lastCheckedAt: '',
    lastPrewarm: null,
  };
}

function buildWorkerPlan(spec, hardware) {
  return [
    { id: 'activity-assertion', label: 'macOS Powerhouse activity assertion', state: spec.mode === 'light' ? 'on-demand' : 'planned-hot', resource: 'macOS power management', mode: spec.mode },
    { id: 'python-runtime-prime', label: 'Python / Silero / MLX import priming', state: spec.mode === 'light' ? 'on-demand' : 'planned-hot', resource: 'CPU + filesystem cache', mode: spec.mode },
    { id: 'vad', label: 'Silero VAD / endpointing', state: 'planned-hot', resource: 'CPU efficiency cores', mode: spec.mode },
    { id: 'stt-live', label: 'Live STT profile', state: 'planned-hot', resource: 'MPS/CPU', mode: spec.mode },
    { id: 'stt-fallbacks', label: 'Fallback STT profiles', state: spec.mode === 'light' ? 'cold' : 'planned-warm', resource: 'CPU/MPS', mode: spec.mode },
    { id: 'local-llm', label: 'Local Companion Realtime Voice LLM', state: 'planned-hot', resource: /Apple/i.test(hardware.cpuBrand || '') ? 'Apple Silicon unified memory' : 'CPU/GPU', mode: spec.mode },
    { id: 'tts-streaming', label: 'Streaming TTS', state: spec.ttsProbe ? 'planned-hot' : 'on-demand', resource: 'CPU/MPS/network depending on voice', mode: spec.mode },
    { id: 'route-layer', label: 'OpenClaw / Hermes route layer', state: spec.routePrewarm ? 'planned-warm' : 'on-demand', resource: 'Node subprocess + route runtime', mode: spec.mode },
    { id: 'network', label: 'Provider and bridge endpoint probes', state: spec.networkPrewarm ? 'planned-warm' : 'on-demand', resource: 'network', mode: spec.mode },
  ];
}

function resourcePosture(spec, hardware) {
  const physicalCores = Math.max(1, Number(hardware.cpuCores?.physical || 4));
  const logicalCores = Math.max(physicalCores, Number(hardware.cpuCores?.logical || physicalCores));
  const maxWorkers = Math.max(1, Math.min(spec.maxParallel || 1, logicalCores + 2));
  const profileCycle = orderedProfileWarmCycle(spec);
  const primaryProfile = profileCycle.find((profile) => profile.id === 'primary' || profile.id === 'selected' || profile.required) || profileCycle[0] || null;
  return {
    mode: spec.mode,
    label: spec.label,
    priority: spec.mode === 'light' ? 'conservative'
      : spec.mode === 'balanced' ? 'high'
        : spec.mode === 'maximum' ? 'aggressive'
          : 'presentation-critical',
    parallelWorkers: maxWorkers,
    physicalCores,
    logicalCores,
    memoryPressure: hardware.memoryPressure,
    strategy: spec.mode === 'light'
      ? 'Keep bridge responsive and warm the primary runtime only on demand.'
      : 'Run independent route/TTS/network/cache workers concurrently and keep multiple HF speech-to-speech profile sidecars hot on adjacent localhost ports.',
    hfSidecarPolicy: 'A pool of speech-to-speech WebSocket sidecars owns adjacent realtime ports. The primary/default profile comes online first while fallback profiles are warmed afterward in parallel.',
    profileCycle: profileCycle.map((profile) => ({
      id: profile.id,
      label: profile.label,
      brainMode: profile.options?.brainMode || '',
      sttProfile: profile.options?.sttProfile || '',
      localVoice: profile.options?.localVoice || '',
      finalHot: profile.id === 'primary' || profile.id === 'selected',
    })),
    primaryRuntimeProfile: primaryProfile ? {
      id: primaryProfile.id,
      label: primaryProfile.label,
      brainMode: primaryProfile.options?.brainMode || '',
      sttProfile: primaryProfile.options?.sttProfile || '',
      localVoice: primaryProfile.options?.localVoice || '',
    } : null,
    activityAssertion: spec.mode !== 'light',
    aggressiveThreads: AGGRESSIVE_THREADS,
    hfNumPipelines: Number.parseInt(process.env.VOICECLAW_HF_NUM_PIPELINES || '1', 10),
    ttsProbeRepeats: spec.ttsProbeRepeats || 0,
    routePrewarmRepeats: spec.routePrewarmRepeats || 0,
    networkProbeRepeats: spec.networkProbeRepeats || 0,
  };
}

function orderedProfileWarmCycle(spec) {
  const primary = spec.profiles.filter((profile) => profile.id === 'primary' || profile.id === 'selected' || profile.required);
  const fallbacks = spec.profiles.filter((profile) => !(profile.id === 'primary' || profile.id === 'selected' || profile.required));
  return [...primary, ...fallbacks];
}

function repeatedTasks(count, makeTask) {
  return Array.from({ length: Math.max(0, count) }, (_, index) => makeTask(index + 1));
}

export async function prewarmPowerhouseRuntime(options = {}) {
  if (prewarmInFlight) return await prewarmInFlight;
  prewarmInFlight = (async () => {
    const mode = normalizePowerhouseMode(options.mode || readPowerhouseModeFromConfig());
    const spec = modeSpec(mode);
    const startedAt = Date.now();
    const hardware = await getHardwareSnapshot({ force: true });
    const workers = [];
    const posture = resourcePosture(spec, hardware);

    workers.push(await timedWorker('activity-assertion', 'Hold macOS Powerhouse activity assertion', spec, async () => {
      const result = ensurePowerhouseActivity(spec);
      return {
        ok: result.state === 'ready' || result.state === 'skipped',
        state: result.state,
        summary: result.summary,
        pid: result.pid,
      };
    }));

    if (options.install !== false) {
      workers.push(await timedWorker('hf-install', `Install/verify ${spec.installPrepareSet} HF profiles`, spec, () => installHFRealtimeRuntime({
        prepareSet: spec.installPrepareSet,
        brainMode: 'qwen3.5-2b',
        sttProfile: 'parakeet-live',
        localVoice: 'kokoro-af-heart',
      })));
    }

    if (spec.mode !== 'light') {
      workers.push(await timedWorker('python-runtime-prime', 'Prime Python, MLX, Torch, NLTK, and Silero caches', spec, async () => {
        const script = [
          'import importlib, os',
          'mods = ["speech_to_speech", "mlx", "mlx_audio", "torch", "kokoro", "soundfile", "faster_whisper"]',
          'loaded = []',
          'failed = []',
          'for name in mods:',
          '    try:',
          '        importlib.import_module(name)',
          '        loaded.append(name)',
          '    except Exception as exc:',
          '        failed.append(f"{name}:{type(exc).__name__}")',
          'try:',
          '    import nltk',
          '    nltk.download("averaged_perceptron_tagger_eng", quiet=True)',
          '    loaded.append("nltk:averaged_perceptron_tagger_eng")',
          'except Exception as exc:',
          '    failed.append(f"nltk:{type(exc).__name__}")',
          'try:',
          '    import torch',
          '    torch.hub.load("snakers4/silero-vad", "silero_vad", trust_repo=True)',
          '    loaded.append("silero_vad")',
          'except Exception as exc:',
          '    failed.append(f"silero:{type(exc).__name__}")',
          'print("loaded=" + ",".join(loaded))',
          'print("failed=" + ",".join(failed))',
        ].join('\n');
        const result = await runPrimeCommand(HF_PYTHON, ['-c', script], spec.mode === 'presentation' ? 240_000 : 180_000);
        return {
          ok: result.ok,
          state: result.ok ? 'ready' : 'degraded',
          summary: result.ok
            ? `Python runtime primed with ${AGGRESSIVE_THREADS} aggressive threads. ${result.stdout.trim().split('\n').slice(-2).join(' ')}`
            : `Python runtime prime failed: ${result.error}`,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      }));
    }

    const independentTasks = [];

    if (spec.ttsProbe) {
      independentTasks.push(...repeatedTasks(spec.ttsProbeRepeats || 1, (index) => () => timedWorker(`tts-probe-${index}`, `Warm streaming TTS voice path ${index}`, spec, async () => {
        let streamed = false;
        let bytes = 0;
        const controller = new AbortController();
        const timeoutMs = spec.mode === 'maximum' || spec.mode === 'presentation' ? 60_000 : 25_000;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const result = await synthesizeStream('Ready.', {
            signal: controller.signal,
            voice: 'kokoro-af-heart',
            speed: 'fastest',
            onStart: () => { streamed = true; },
            onChunk: (chunk) => { bytes += chunk.length; },
          });
          const audioBytes = bytes || result?.audioBytes || 0;
          return {
            ok: audioBytes > 0,
            state: audioBytes > 0 ? 'ready' : 'degraded',
            summary: audioBytes > 0
              ? `Streaming TTS warmed (${result?.engine || 'engine'}; ${audioBytes} bytes).`
              : `Streaming TTS probe completed without audio bytes under ${spec.label} load; TTS remains installed but should be rechecked after sidecars settle.`,
            streamed,
            bytes: audioBytes,
          };
        } finally {
          clearTimeout(timer);
        }
      })));
    }

    if (spec.routePrewarm) {
      independentTasks.push(...repeatedTasks(spec.routePrewarmRepeats || 1, (index) => () => timedWorker(`route-prewarm-${index}`, `Warm OpenClaw / Hermes route processing ${index}`, spec, () => prewarmProcessing({ sessionToken: `powerhouse-prewarm-${index}`, fastMode: 'on' }))));
    }

    if (spec.networkPrewarm) {
      independentTasks.push(...repeatedTasks(spec.networkProbeRepeats || 1, (index) => () => timedWorker(`network-openai-${index}`, `Probe OpenAI API edge ${index}`, spec, () => probeNetworkEndpoint(`network-openai-${index}`, 'OpenAI API edge', 'https://api.openai.com/v1/models'))));
      independentTasks.push(...repeatedTasks(spec.networkProbeRepeats || 1, (index) => () => timedWorker(`network-cerebras-${index}`, `Probe Cerebras API edge ${index}`, spec, () => probeNetworkEndpoint(`network-cerebras-${index}`, 'Cerebras API edge', 'https://api.cerebras.ai/v1/models'))));
      independentTasks.push(...repeatedTasks(spec.networkProbeRepeats || 1, (index) => () => timedWorker(`network-hf-${index}`, `Probe Hugging Face edge ${index}`, spec, () => probeNetworkEndpoint(`network-hf-${index}`, 'Hugging Face edge', 'https://huggingface.co'))));
    }

    const profileCycle = orderedProfileWarmCycle(spec);
    const primaryProfiles = profileCycle.filter((profile) => profile.id === 'primary' || profile.id === 'selected' || profile.required);
    const fallbackProfiles = profileCycle.filter((profile) => !(profile.id === 'primary' || profile.id === 'selected' || profile.required));
    const toProfileTask = (profile) => () => timedWorker(
      `hf-prewarm-${profile.id}`,
      `Warm ${profile.label}${profile.id === 'primary' || profile.id === 'selected' ? ' as primary active sidecar' : ''}`,
      spec,
      () => prewarmHFRealtimeRuntime(profile.options),
    );
    const independentPromise = runLimited(independentTasks, posture.parallelWorkers);
    const primaryResults = await runLimited(primaryProfiles.map(toProfileTask), Math.max(1, Math.min(2, posture.parallelWorkers)));
    const fallbackResults = await runLimited(fallbackProfiles.map(toProfileTask), posture.parallelWorkers);
    const independentResults = await independentPromise;
    const profileResults = [...primaryResults, ...fallbackResults];
    workers.push(...profileResults, ...independentResults);

    const failedRequired = workers.filter((worker) => !worker.ok && ['hf-install', 'hf-prewarm-primary', 'hf-prewarm-selected'].includes(worker.id));
    lastPrewarm = {
      ok: failedRequired.length === 0,
      state: failedRequired.length ? 'degraded' : 'ready',
      mode: spec.mode,
      label: spec.label,
      summary: failedRequired.length
        ? `${spec.label} Powerhouse warmed with required failures: ${failedRequired.map((worker) => worker.summary).join('; ')}`
        : `${spec.label} Powerhouse warm pass completed across ${workers.length} workers in ${Date.now() - startedAt} ms.`,
      elapsedMs: Date.now() - startedAt,
      hardware,
      resourcePosture: posture,
      workers,
    };
    cachedStatus = null;
    return lastPrewarm;
  })();
  try {
    return await prewarmInFlight;
  } finally {
    prewarmInFlight = null;
  }
}

export async function maybeStartPowerhouseOnBoot() {
  if (bootPrewarmStarted) return null;
  bootPrewarmStarted = true;
  const mode = readPowerhouseModeFromConfig();
  if (mode === 'light') return null;
  if (!/^(1|true|yes)$/i.test(String(process.env.VOICECLAW_POWERHOUSE_BOOT_PREWARM || '1'))) return null;
  return prewarmPowerhouseRuntime({
    mode,
    install: /^(1|true|yes)$/i.test(String(process.env.VOICECLAW_POWERHOUSE_BOOT_INSTALL || '0')),
  });
}

export function powerhouseModes() {
  return ['light', 'balanced', 'maximum', 'presentation'].map((mode) => {
    const spec = modeSpec(mode);
    return { id: spec.mode, label: spec.label, summary: spec.summary };
  });
}
