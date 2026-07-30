// TTS module — OpenAI streaming-first voice plus local fallbacks
import { spawn, execFile as execFileCb } from 'node:child_process';
import { readFile, unlink, access, readdir } from 'node:fs/promises';
import { constants as fsConstants, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { promisify } from 'node:util';
import { executablePath, normalizeProcessPath } from './bin-paths.js';
import { PLATFORM_PATHS } from './platform-paths.js';

const execFile = promisify(execFileCb);
normalizeProcessPath();

const VOICECLAW_PIPER_MODEL_DIR = PLATFORM_PATHS.piperModelsDir;
const LEGACY_OPENCLAW_PIPER_MODEL_DIR = join(os.homedir(), '.openclaw', 'models', 'piper');
const PIPER_MODEL_DIR = process.env.PIPER_MODEL_DIR
  || (existsSync(VOICECLAW_PIPER_MODEL_DIR) ? VOICECLAW_PIPER_MODEL_DIR : LEGACY_OPENCLAW_PIPER_MODEL_DIR);
const DEFAULT_PIPER_MODEL = process.env.PIPER_MODEL || join(PIPER_MODEL_DIR, 'en_US-libritts-high.onnx');
const DEFAULT_PIPER_LENGTH_SCALE = process.env.PIPER_LENGTH_SCALE || '0.7';
const PIPER_BIN = executablePath(process.env.PIPER_BIN || 'python3');
const FFMPEG_BIN = executablePath(process.env.FFMPEG_BIN || 'ffmpeg');
const SAY_BIN = executablePath(process.env.SAY_BIN || 'say');
const HF_RUNTIME_PYTHON = process.env.VOICECLAW_HF_PYTHON || join(os.homedir(), '.voiceclaw', 'hf-runtime', 'bin', 'python');
const DEFAULT_PYTHON_BIN = executablePath(process.env.PYTHON_BIN || 'python3');
const KOKORO_HELPER = fileURLToPath(new URL('./kokoro_tts.py', import.meta.url));
const FALLBACK_RATE = process.env.TTS_RATE || '185';
const DEFAULT_SPEED = process.env.TTS_SPEED || 'fastest';
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || join(os.homedir(), '.openclaw', 'openclaw.json');
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';
const OPENAI_TTS_FORMAT = process.env.OPENAI_TTS_FORMAT || 'wav';
const OPENAI_TTS_CIRCUIT_MS = Number(process.env.OPENAI_TTS_CIRCUIT_MS || 120000);

const TTS_SPEED_PRESETS = [
  { id: 'slower', label: 'Slower', openai: 0.85, sayRate: 160, piperLengthScale: 0.82, kokoroSpeed: 0.90 },
  { id: 'normal', label: 'Normal', openai: 1.0, sayRate: 185, piperLengthScale: 0.70, kokoroSpeed: 1.0 },
  { id: 'faster', label: 'Faster', openai: 1.15, sayRate: 215, piperLengthScale: 0.60, kokoroSpeed: 1.10 },
  { id: 'fastest', label: 'Fastest', openai: 1.3, sayRate: 245, piperLengthScale: 0.52, kokoroSpeed: 1.20 },
];

function loadOpenAITtsConfig() {
  try {
    const bridgeConfig = process.env.VOICECLAW_CONFIG_PATH || process.env.VOICECLAW_CONFIG || join(os.homedir(), '.voiceclaw', 'bridge.json');
    const cfg = JSON.parse(readFileSync(bridgeConfig, 'utf8'));
    const candidates = [
      cfg?.openAIAPIKey,
      cfg?.OpenAIAPIKey,
      cfg?.openAIApiKey,
      cfg?.openaiAPIKey,
      cfg?.openaiApiKey,
      cfg?.apiKey,
    ];
    for (const value of candidates) {
      const key = String(value || '').trim();
      if (key) {
        return {
          apiKey: key,
          model: process.env.OPENAI_TTS_MODEL || OPENAI_TTS_MODEL,
          voice: process.env.OPENAI_TTS_VOICE || OPENAI_TTS_VOICE,
          provider: 'openai',
        };
      }
    }
  } catch {}

  let fromCfg = null;
  try {
    const raw = readFileSync(OPENCLAW_CONFIG, 'utf8');
    const cfg = JSON.parse(raw);
    const openai = cfg?.messages?.tts?.providers?.openai;
    if (openai?.apiKey) {
      fromCfg = {
        apiKey: openai.apiKey,
        model: process.env.OPENAI_TTS_MODEL || OPENAI_TTS_MODEL,
        voice: process.env.OPENAI_TTS_VOICE || openai.voice || OPENAI_TTS_VOICE,
        provider: cfg?.messages?.tts?.provider || 'openai',
      };
    }
  } catch {}

  if (process.env.OPENAI_API_KEY) {
    return {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_TTS_MODEL || fromCfg?.model || OPENAI_TTS_MODEL,
      voice: process.env.OPENAI_TTS_VOICE || fromCfg?.voice || OPENAI_TTS_VOICE,
      provider: 'openai',
    };
  }
  return fromCfg;
}

const OPENAI_TTS = loadOpenAITtsConfig();
let cachedVoiceOptions = null;
let openAICircuitUntil = 0;
let lastOpenAIError = '';
let lastEngine = '';
let lastFallback = '';
let cachedBackendStatus = null;

function isAbortError(err) {
  return err?.message === 'aborted'
    || err?.name === 'AbortError'
    || err?.code === 'ABORT_ERR'
    || String(err || '').includes('aborted');
}

function abortedStreamSummary({ engine, sampleRate = 16000, total = 0, started = false } = {}) {
  return {
    streamed: !!started,
    aborted: true,
    engine,
    encoding: 'pcm_s16le',
    sampleRate,
    channels: 1,
    audioBytes: total,
    audioContentType: 'audio/pcm',
  };
}

function openAICircuitOpen() {
  return OPENAI_TTS?.apiKey && Date.now() < openAICircuitUntil;
}

function markOpenAIFailure(err) {
  lastOpenAIError = err?.message || String(err || 'unknown OpenAI TTS failure');
  openAICircuitUntil = Date.now() + OPENAI_TTS_CIRCUIT_MS;
}

export function getTtsStatus() {
  return {
    preferredEngine: OPENAI_TTS?.apiKey ? 'openai-streaming' : 'local',
    openaiConfigured: !!OPENAI_TTS?.apiKey,
    openaiModel: OPENAI_TTS?.model || OPENAI_TTS_MODEL,
    openaiVoice: OPENAI_TTS?.voice || OPENAI_TTS_VOICE,
    openaiFormat: OPENAI_TTS_FORMAT,
    openaiStreaming: !!OPENAI_TTS?.apiKey,
    openaiCircuitOpen: openAICircuitOpen(),
    openaiCircuitUntil: openAICircuitOpen() ? new Date(openAICircuitUntil).toISOString() : null,
    lastOpenAIError: lastOpenAIError || null,
    lastEngine: lastEngine || null,
    lastFallback: lastFallback || null,
    backends: cachedBackendStatus || [],
  };
}

const OPENAI_GPT4O_MINI_TTS_VOICES = [
  'marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse',
];
const OPENAI_LEGACY_TTS_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'];

function titleCaseVoice(voice = '') {
  const clean = String(voice || '').trim();
  return clean ? clean[0].toUpperCase() + clean.slice(1) : 'Voice';
}

function openAIVoiceOptions() {
  if (!OPENAI_TTS?.apiKey) return [];
  const configuredVoice = OPENAI_TTS.voice || OPENAI_TTS_VOICE;
  const primaryModel = OPENAI_TTS.model || OPENAI_TTS_MODEL;
  const voices = Array.from(new Set([configuredVoice, ...OPENAI_GPT4O_MINI_TTS_VOICES].filter(Boolean)));
  const primary = voices.map((voice) => ({
    id: `openai-${voice}`,
    label: `OpenAI ${titleCaseVoice(voice)} (${primaryModel} streaming)`,
    engine: 'openai',
    model: primaryModel,
    openaiVoice: voice,
    default: voice === configuredVoice,
  }));
  const legacy = OPENAI_LEGACY_TTS_VOICES.map((voice) => ({
    id: `openai-${voice}-tts-1`,
    label: `OpenAI ${titleCaseVoice(voice)} (tts-1 low-latency legacy)`,
    engine: 'openai',
    model: 'tts-1',
    openaiVoice: voice,
    default: false,
  }));
  return [...primary, ...legacy];
}

const CURATED_VOICES = [
  ...openAIVoiceOptions(),
  {
    id: 'piper-libritts-high',
    label: 'Piper LibriTTS High',
    engine: 'piper',
    modelPath: join(PIPER_MODEL_DIR, 'en_US-libritts-high.onnx'),
    lengthScale: DEFAULT_PIPER_LENGTH_SCALE,
    default: !OPENAI_TTS,
  },
  {
    id: 'piper-ryan-high',
    label: 'Piper Ryan High',
    engine: 'piper',
    modelPath: join(PIPER_MODEL_DIR, 'en_US-ryan-high.onnx'),
    lengthScale: DEFAULT_PIPER_LENGTH_SCALE,
    default: false,
  },
  {
    id: 'say-samantha',
    label: 'Samantha (macOS)',
    engine: 'say',
    sayVoice: 'Samantha',
    rate: FALLBACK_RATE,
    default: false,
  },
  {
    id: 'say-flo-en-us',
    label: 'Flo (English US, macOS)',
    engine: 'say',
    sayVoice: 'Flo (English (US))',
    rate: FALLBACK_RATE,
    default: false,
  },
  {
    id: 'say-eddy-en-us',
    label: 'Eddy (English US, macOS)',
    engine: 'say',
    sayVoice: 'Eddy (English (US))',
    rate: FALLBACK_RATE,
    default: false,
  },
];

async function fileExists(path) {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function titleCaseWords(value = '') {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .trim();
}

function piperIDFromModelPath(modelPath = '') {
  const filename = String(modelPath || '').split('/').pop() || 'piper';
  const stem = filename.replace(/\.onnx$/i, '');
  const slug = stem
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `piper-${slug || 'voice'}`;
}

function piperLabelFromModelPath(modelPath = '') {
  const filename = String(modelPath || '').split('/').pop() || 'Piper Voice';
  const stem = filename.replace(/\.onnx$/i, '');
  const parts = stem.split('-');
  if (parts.length >= 3) {
    const locale = parts[0].replace(/_/g, '-').toUpperCase();
    const quality = parts[parts.length - 1];
    const voice = parts.slice(1, -1).join(' ');
    return `Piper ${titleCaseWords(voice)} (${locale}, ${titleCaseWords(quality)})`;
  }
  return `Piper ${titleCaseWords(stem)}`;
}

async function discoverPiperVoices() {
  try {
    const entries = await readdir(PIPER_MODEL_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.onnx'))
      .map((entry) => {
        const modelPath = join(PIPER_MODEL_DIR, entry.name);
        return {
          id: piperIDFromModelPath(modelPath),
          label: piperLabelFromModelPath(modelPath),
          engine: 'piper',
          modelPath,
          lengthScale: DEFAULT_PIPER_LENGTH_SCALE,
          default: modelPath === DEFAULT_PIPER_MODEL,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch {
    return [];
  }
}

async function loadSayVoices() {
  try {
    const { stdout } = await execFile(SAY_BIN, ['-v', '?'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const set = new Set();
    for (const line of String(stdout || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^(.+?)\s+[a-z]{2}_[A-Z]{2}\s+#/);
      if (match?.[1]) set.add(match[1].trim());
    }
    return set;
  } catch {
    return new Set();
  }
}

function uniquePythonCandidates() {
  return Array.from(new Set([
    process.env.VOICECLAW_HF_PYTHON || '',
    HF_RUNTIME_PYTHON,
    process.env.PYTHON_BIN || '',
    DEFAULT_PYTHON_BIN,
    'python3',
  ].map((item) => String(item || '').trim()).filter(Boolean)));
}

async function pythonModuleProbe(moduleName, pythonCandidates = uniquePythonCandidates()) {
  for (const pythonBin of pythonCandidates) {
    try {
      await execFile(executablePath(pythonBin), [
        '-c',
        `import importlib.util, sys; sys.exit(0 if importlib.util.find_spec(${JSON.stringify(moduleName)}) else 1)`,
      ], { timeout: 8000, maxBuffer: 1024 * 64 });
      return { available: true, python: executablePath(pythonBin) };
    } catch {}
  }
  return { available: false, python: '' };
}

async function pythonModuleAvailable(moduleName) {
  return (await pythonModuleProbe(moduleName)).available;
}

async function helperAvailable(path) {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function buildBackendStatus() {
  const [speechToSpeech, mlxAudio, nativeKokoro, pocket, fasterWhisper, whisperMLX, helper] = await Promise.all([
    pythonModuleProbe('speech_to_speech'),
    pythonModuleProbe('mlx_audio'),
    pythonModuleProbe('kokoro'),
    pythonModuleProbe('pocket_tts'),
    pythonModuleProbe('faster_whisper'),
    pythonModuleProbe('whisper_mlx'),
    helperAvailable(KOKORO_HELPER),
  ]);
  const kokoroInstalled = helper && (mlxAudio.available || nativeKokoro.available);

  return [
    { id: 'openai', label: 'OpenAI TTS', installed: !!OPENAI_TTS?.apiKey, selectable: !!OPENAI_TTS?.apiKey, role: 'tts' },
    { id: 'piper', label: 'Piper local TTS', installed: true, selectable: true, role: 'tts' },
    { id: 'macos-say', label: 'macOS system voices', installed: true, selectable: true, role: 'tts' },
    { id: 'speech-to-speech', label: 'Hugging Face speech-to-speech runtime', installed: speechToSpeech.available, selectable: false, role: 'pipeline', python: speechToSpeech.python || null },
    { id: 'qwen3-tts-mlx', label: 'Qwen3-TTS via MLX Audio', installed: speechToSpeech.available && mlxAudio.available, selectable: false, role: 'tts', python: mlxAudio.python || null },
    { id: 'kokoro-mlx', label: 'Kokoro via MLX Audio', installed: kokoroInstalled, selectable: kokoroInstalled, role: 'tts', python: mlxAudio.python || nativeKokoro.python || null },
    { id: 'pocket-tts', label: 'Pocket TTS', installed: speechToSpeech.available && pocket.available, selectable: false, role: 'tts', python: pocket.python || null },
    { id: 'faster-whisper', label: 'Faster Whisper STT', installed: fasterWhisper.available, selectable: false, role: 'stt', python: fasterWhisper.python || null },
    { id: 'whisper-mlx', label: 'Whisper MLX STT', installed: whisperMLX.available, selectable: false, role: 'stt', python: whisperMLX.python || null },
  ];
}

async function buildVoiceOptions() {
  const availableSayVoices = await loadSayVoices();
  const dynamicPiperVoices = await discoverPiperVoices();
  cachedBackendStatus = await buildBackendStatus();
  const options = [];
  const seenPiperModelPaths = new Set();
  const kokoroBackend = cachedBackendStatus.find((backend) => backend.id === 'kokoro-mlx' && backend.selectable);
  if (kokoroBackend?.python) {
    options.push(
      {
        id: 'kokoro-af-heart',
        label: 'Kokoro Heart (MLX)',
        engine: 'kokoro',
        pythonBin: kokoroBackend.python,
        model: process.env.KOKORO_MODEL || 'mlx-community/Kokoro-82M-bf16',
        kokoroVoice: 'af_heart',
        langCode: 'a',
        default: true,
      },
      {
        id: 'kokoro-bm-fable',
        label: 'Kokoro Fable (MLX)',
        engine: 'kokoro',
        pythonBin: kokoroBackend.python,
        model: process.env.KOKORO_MODEL || 'mlx-community/Kokoro-82M-bf16',
        kokoroVoice: 'bm_fable',
        langCode: 'b',
        default: false,
      },
    );
  }

  for (const candidate of [...CURATED_VOICES, ...dynamicPiperVoices]) {
    if (candidate.engine === 'piper') {
      const modelPath = candidate.modelPath || DEFAULT_PIPER_MODEL;
      if (seenPiperModelPaths.has(modelPath)) continue;
      if (await fileExists(modelPath)) {
        seenPiperModelPaths.add(modelPath);
        options.push({ ...candidate, modelPath });
      }
      continue;
    }
    if (candidate.engine === 'say') {
      if (availableSayVoices.has(candidate.sayVoice)) options.push({ ...candidate });
      continue;
    }
    if (candidate.engine === 'openai') {
      if (OPENAI_TTS?.apiKey && candidate.model && candidate.openaiVoice) options.push({ ...candidate });
    }
  }

  if (!options.length && await fileExists(DEFAULT_PIPER_MODEL)) {
    options.push({ id: 'piper-default-env', label: 'Piper Default', engine: 'piper', modelPath: DEFAULT_PIPER_MODEL, lengthScale: DEFAULT_PIPER_LENGTH_SCALE, default: true });
  }

  if (!options.length) {
    options.push({ id: 'say-samantha-fallback', label: 'Samantha (macOS)', engine: 'say', sayVoice: 'Samantha', rate: FALLBACK_RATE, default: true });
  }

  // If OpenAI is configured but the circuit is open, keep it selectable while the
  // runtime synth path automatically falls back to Piper/macOS for live audio.
  return options;
}

async function ensureVoiceOptions() {
  if (!cachedVoiceOptions) cachedVoiceOptions = await buildVoiceOptions();
  return cachedVoiceOptions;
}

function stripVoiceForClient(v) {
  return { id: v.id, label: v.label, engine: v.engine, default: !!v.default };
}

function pickDefaultVoice(voices) {
  return voices.find((v) => v.default) || voices[0];
}

function resolveSpeedPreset(speedId) {
  const requested = String(speedId || '').trim();
  return TTS_SPEED_PRESETS.find((preset) => preset.id === requested) || TTS_SPEED_PRESETS.find((preset) => preset.id === DEFAULT_SPEED) || TTS_SPEED_PRESETS[0];
}

export function getTtsSpeedOptions() {
  return { defaultSpeed: DEFAULT_SPEED, speeds: TTS_SPEED_PRESETS.map(({ id, label }) => ({ id, label })) };
}

export async function getVoiceOptions() {
  const voices = await ensureVoiceOptions();
  const defaultVoice = pickDefaultVoice(voices);
  return { defaultVoice: defaultVoice?.id, voices: voices.map(stripVoiceForClient), ...getTtsSpeedOptions(), status: getTtsStatus() };
}

export async function resolveVoiceConfig(requestedVoiceId) {
  const voices = await ensureVoiceOptions();
  const defaultVoice = pickDefaultVoice(voices);
  const requested = String(requestedVoiceId || '').trim();
  const selected = voices.find((v) => v.id === requested) || defaultVoice;
  const fallbackUsed = !!requested && selected?.id !== requested;

  return {
    id: selected.id,
    label: selected.label,
    engine: selected.engine,
    fallbackUsed,
    requested: requested || undefined,
    modelPath: selected.modelPath,
    lengthScale: selected.lengthScale,
    sayVoice: selected.sayVoice,
    rate: selected.rate,
    model: selected.model,
    openaiVoice: selected.openaiVoice,
    pythonBin: selected.pythonBin,
    kokoroVoice: selected.kokoroVoice,
    langCode: selected.langCode,
  };
}

function piperSampleRate(modelPath) {
  try {
    const raw = readFileSync(`${modelPath}.json`, 'utf8');
    const json = JSON.parse(raw);
    const rate = Number(json?.audio?.sample_rate || 0);
    return Number.isFinite(rate) && rate > 0 ? rate : 22050;
  } catch {
    return 22050;
  }
}

function pcmToWav(pcmBuffer, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(wav, 44);
  return wav;
}

/**
 * Synthesize text using a validated curated voice config.
 * OpenAI uses fetch body streaming so audio bytes are consumed incrementally by
 * the bridge; the current websocket protocol still sends one WAV buffer to
 * existing clients after synthesis completes, preserving compatibility.
 */
export async function synthesize(text, { signal, voice, speed } = {}) {
  const voiceCfg = await resolveVoiceConfig(voice?.id || voice);
  const speedPreset = resolveSpeedPreset(speed);
  console.log(`[tts] voice=${voiceCfg.id} engine=${voiceCfg.engine} speed=${speedPreset.id}`);

  if (voiceCfg.engine === 'openai' && !openAICircuitOpen()) {
    try {
      const audio = await synthesizeOpenAIStreaming(text, { signal, model: voiceCfg.model, voice: voiceCfg.openaiVoice, speed: speedPreset.openai });
      lastEngine = 'openai-streaming';
      lastFallback = '';
      return audio;
    } catch (err) {
      if (isAbortError(err)) throw err;
      markOpenAIFailure(err);
      console.warn(`[tts] OpenAI streaming (${voiceCfg.id}) failed, falling back to Piper Ryan:`, err.message);
      return await synthesizeLocalFallback(text, { signal, speedPreset, reason: 'openai-failed' });
    }
  }

  if (voiceCfg.engine === 'openai' && openAICircuitOpen()) {
    console.warn(`[tts] OpenAI circuit open until ${new Date(openAICircuitUntil).toISOString()}, using local fallback`);
    return await synthesizeLocalFallback(text, { signal, speedPreset, reason: 'openai-circuit-open' });
  }

  if (voiceCfg.engine === 'piper') {
    try {
      const audio = await synthesizePiper(text, { signal, modelPath: voiceCfg.modelPath, lengthScale: speedPreset.piperLengthScale });
      lastEngine = 'piper';
      lastFallback = '';
      return audio;
    } catch (err) {
      if (isAbortError(err)) throw err;
      console.warn(`[tts] Piper (${voiceCfg.id}) failed, falling back to macOS say:`, err.message);
      lastFallback = 'say-after-piper-failed';
      const audio = await synthesizeSay(text, { signal, sayVoice: 'Samantha', rate: speedPreset.sayRate });
      lastEngine = 'say';
      return audio;
    }
  }

  if (voiceCfg.engine === 'kokoro') {
    try {
      const audio = await synthesizeKokoro(text, {
        signal,
        pythonBin: voiceCfg.pythonBin,
        model: voiceCfg.model,
        kokoroVoice: voiceCfg.kokoroVoice,
        langCode: voiceCfg.langCode,
        speed: speedPreset.kokoroSpeed,
      });
      lastEngine = 'kokoro-mlx';
      lastFallback = '';
      return audio;
    } catch (err) {
      if (isAbortError(err)) throw err;
      console.warn(`[tts] Kokoro (${voiceCfg.id}) failed, falling back to Piper Ryan:`, err.message);
      return await synthesizeLocalFallback(text, { signal, speedPreset, reason: 'kokoro-failed' });
    }
  }

  const audio = await synthesizeSay(text, { signal, sayVoice: voiceCfg.sayVoice, rate: speedPreset.sayRate });
  lastEngine = 'say';
  lastFallback = '';
  return audio;
}

/**
 * Synthesize text and stream raw PCM chunks as soon as the selected engine
 * produces them. Returns a small summary when streaming succeeds, or a batch
 * WAV buffer for engines that cannot stream in the current process.
 */
export async function synthesizeStream(text, { signal, voice, speed, onStart, onChunk, onEnd } = {}) {
  const voiceCfg = await resolveVoiceConfig(voice?.id || voice);
  const speedPreset = resolveSpeedPreset(speed);
  const reply = String(text || '');
  console.log(`[tts-stream] voice=${voiceCfg.id} engine=${voiceCfg.engine} speed=${speedPreset.id}`);

  if (voiceCfg.engine === 'openai' && !openAICircuitOpen()) {
    try {
      const summary = await synthesizeOpenAIPCMStreaming(reply, {
        signal,
        model: voiceCfg.model,
        voice: voiceCfg.openaiVoice,
        speed: speedPreset.openai,
        onStart,
        onChunk,
        onEnd,
      });
      lastEngine = 'openai-streaming-pcm';
      lastFallback = '';
      return summary;
    } catch (err) {
      if (isAbortError(err)) return abortedStreamSummary({ engine: 'openai', sampleRate: 24000 });
      markOpenAIFailure(err);
      console.warn(`[tts-stream] OpenAI PCM streaming (${voiceCfg.id}) failed, falling back to Piper Ryan:`, err.message);
      return await synthesizePiperPCMStreaming(reply, {
        signal,
        modelPath: join(PIPER_MODEL_DIR, 'en_US-ryan-high.onnx'),
        lengthScale: speedPreset.piperLengthScale,
        fallbackReason: 'openai-stream-failed',
        onStart,
        onChunk,
        onEnd,
      });
    }
  }

  if (voiceCfg.engine === 'openai' && openAICircuitOpen()) {
    console.warn(`[tts-stream] OpenAI circuit open until ${new Date(openAICircuitUntil).toISOString()}, using local streaming fallback`);
    return await synthesizePiperPCMStreaming(reply, {
      signal,
      modelPath: join(PIPER_MODEL_DIR, 'en_US-ryan-high.onnx'),
      lengthScale: speedPreset.piperLengthScale,
      fallbackReason: 'openai-circuit-open',
      onStart,
      onChunk,
      onEnd,
    });
  }

  if (voiceCfg.engine === 'piper') {
    try {
      const summary = await synthesizePiperPCMStreaming(reply, {
        signal,
        modelPath: voiceCfg.modelPath,
        lengthScale: speedPreset.piperLengthScale,
        onStart,
        onChunk,
        onEnd,
      });
      lastEngine = 'piper-streaming-pcm';
      lastFallback = '';
      return summary;
    } catch (err) {
      if (isAbortError(err)) return abortedStreamSummary({ engine: 'piper', sampleRate: piperSampleRate(voiceCfg.modelPath) });
      console.warn(`[tts-stream] Piper streaming (${voiceCfg.id}) failed, falling back to batch macOS say:`, err.message);
      lastFallback = 'say-after-piper-stream-failed';
      const audio = await synthesizeSay(reply, { signal, sayVoice: 'Samantha', rate: speedPreset.sayRate });
      lastEngine = 'say';
      return { streamed: false, audio, audioContentType: 'audio/wav', audioBytes: audio.length, engine: 'say' };
    }
  }

  if (voiceCfg.engine === 'kokoro') {
    try {
      const summary = await synthesizeKokoroPCMStreaming(reply, {
        signal,
        pythonBin: voiceCfg.pythonBin,
        model: voiceCfg.model,
        kokoroVoice: voiceCfg.kokoroVoice,
        langCode: voiceCfg.langCode,
        speed: speedPreset.kokoroSpeed,
        onStart,
        onChunk,
        onEnd,
      });
      lastEngine = 'kokoro-mlx-streaming-pcm';
      lastFallback = '';
      return summary;
    } catch (err) {
      if (isAbortError(err)) return abortedStreamSummary({ engine: 'kokoro', sampleRate: 16000 });
      console.warn(`[tts-stream] Kokoro streaming (${voiceCfg.id}) failed, falling back to Piper Ryan:`, err.message);
      return await synthesizePiperPCMStreaming(reply, {
        signal,
        modelPath: join(PIPER_MODEL_DIR, 'en_US-ryan-high.onnx'),
        lengthScale: speedPreset.piperLengthScale,
        fallbackReason: 'kokoro-stream-failed',
        onStart,
        onChunk,
        onEnd,
      });
    }
  }

  const audio = await synthesizeSay(reply, { signal, sayVoice: voiceCfg.sayVoice, rate: speedPreset.sayRate });
  lastEngine = 'say';
  lastFallback = '';
  return { streamed: false, audio, audioContentType: 'audio/wav', audioBytes: audio.length, engine: 'say' };
}

async function synthesizeLocalFallback(text, { signal, speedPreset, reason } = {}) {
  try {
    const audio = await synthesizePiper(text, { signal, modelPath: join(PIPER_MODEL_DIR, 'en_US-ryan-high.onnx'), lengthScale: speedPreset.piperLengthScale });
    lastEngine = 'piper';
    lastFallback = reason || 'fallback';
    return audio;
  } catch (piperErr) {
    if (isAbortError(piperErr)) throw piperErr;
    console.warn('[tts] Piper fallback failed after OpenAI failure, falling back to macOS say:', piperErr.message);
    const audio = await synthesizeSay(text, { signal, sayVoice: 'Samantha', rate: speedPreset.sayRate });
    lastEngine = 'say';
    lastFallback = `${reason || 'fallback'};piper-failed`;
    return audio;
  }
}

async function synthesizePiperPCMStreaming(text, { signal, modelPath, lengthScale, fallbackReason, onStart, onChunk, onEnd } = {}) {
  console.log(`[tts-stream] piper model=${modelPath}`);
  const sampleRate = piperSampleRate(modelPath);
  const proc = spawn(PIPER_BIN, ['-m', 'piper', '--model', modelPath, '--length-scale', String(lengthScale || DEFAULT_PIPER_LENGTH_SCALE), '--output-raw'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let total = 0;
  let settled = false;
  let started = false;
  let aborted = false;

  let closeError = null;
  const closePromise = new Promise((resolve, reject) => {
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      aborted = true;
      proc.kill('SIGTERM');
      finish(resolve);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code !== 0) return finish(() => reject(new Error(`piper exited ${code}: ${stderr.slice(0, 200)}`)));
      finish(resolve);
    });
    proc.on('error', err => finish(() => reject(err)));
  }).catch((err) => {
    closeError = err;
  });

  if (signal?.aborted) {
    aborted = true;
    proc.kill('SIGTERM');
    return abortedStreamSummary({ engine: 'piper', sampleRate, total, started });
  }

  proc.stdin.write(text);
  proc.stdin.end();

  try {
    for await (const chunk of proc.stdout) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      if (!chunk?.length) continue;
      const buffer = Buffer.from(chunk);
      if (!started) {
        started = true;
        await onStart?.({
          streamed: true,
          engine: 'piper',
          encoding: 'pcm_s16le',
          sampleRate,
          channels: 1,
          contentType: 'audio/pcm',
        });
      }
      total += buffer.length;
      await onChunk?.(buffer);
    }
    await closePromise;
    if (closeError && !(aborted || isAbortError(closeError))) throw closeError;
  } catch (err) {
    proc.kill('SIGTERM');
    await closePromise;
    if (aborted || isAbortError(err)) {
      const summary = abortedStreamSummary({ engine: 'piper', sampleRate, total, started });
      if (started) await onEnd?.(summary);
      console.log(`[tts-stream] piper aborted after ${total} bytes`);
      return summary;
    }
    throw err;
  }

  if (aborted || signal?.aborted) {
    const summary = abortedStreamSummary({ engine: 'piper', sampleRate, total, started });
    if (started) await onEnd?.(summary);
    console.log(`[tts-stream] piper aborted after ${total} bytes`);
    return summary;
  }

  if (!total) throw new Error('piper returned no audio');
  const summary = {
    streamed: true,
    engine: 'piper',
    encoding: 'pcm_s16le',
    sampleRate,
    channels: 1,
    audioBytes: total,
    audioContentType: 'audio/pcm',
  };
  if (fallbackReason) {
    lastEngine = 'piper-streaming-pcm';
    lastFallback = fallbackReason;
  }
  await onEnd?.(summary);
  return summary;
}

async function synthesizeKokoroPCMStreaming(text, { signal, pythonBin, model, kokoroVoice, langCode, speed, onStart, onChunk, onEnd } = {}) {
  const py = executablePath(pythonBin || HF_RUNTIME_PYTHON || DEFAULT_PYTHON_BIN);
  console.log(`[tts-stream] kokoro model=${model || 'mlx-community/Kokoro-82M-bf16'} voice=${kokoroVoice || 'af_heart'} python=${py}`);
  const proc = spawn(py, [
    KOKORO_HELPER,
    '--model', model || 'mlx-community/Kokoro-82M-bf16',
    '--voice', kokoroVoice || 'af_heart',
    '--lang', langCode || 'a',
    '--speed', String(speed || 1.0),
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let total = 0;
  let settled = false;
  let started = false;
  let aborted = false;

  let closeError = null;
  const closePromise = new Promise((resolve, reject) => {
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      aborted = true;
      proc.kill('SIGTERM');
      finish(resolve);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code !== 0) return finish(() => reject(new Error(`kokoro exited ${code}: ${stderr.slice(0, 400)}`)));
      finish(resolve);
    });
    proc.on('error', err => finish(() => reject(err)));
  }).catch((err) => {
    closeError = err;
  });

  if (signal?.aborted) {
    aborted = true;
    proc.kill('SIGTERM');
    return abortedStreamSummary({ engine: 'kokoro', sampleRate: 16000, total, started });
  }

  proc.stdin.write(text);
  proc.stdin.end();

  try {
    for await (const chunk of proc.stdout) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      if (!chunk?.length) continue;
      const buffer = Buffer.from(chunk);
      if (!started) {
        started = true;
        await onStart?.({
          streamed: true,
          engine: 'kokoro',
          encoding: 'pcm_s16le',
          sampleRate: 16000,
          channels: 1,
          contentType: 'audio/pcm',
        });
      }
      total += buffer.length;
      await onChunk?.(buffer);
    }
    await closePromise;
    if (closeError && !(aborted || isAbortError(closeError))) throw closeError;
  } catch (err) {
    proc.kill('SIGTERM');
    await closePromise;
    if (aborted || isAbortError(err)) {
      const summary = abortedStreamSummary({ engine: 'kokoro', sampleRate: 16000, total, started });
      if (started) await onEnd?.(summary);
      console.log(`[tts-stream] kokoro aborted after ${total} bytes`);
      return summary;
    }
    throw err;
  }

  if (aborted || signal?.aborted) {
    const summary = abortedStreamSummary({ engine: 'kokoro', sampleRate: 16000, total, started });
    if (started) await onEnd?.(summary);
    console.log(`[tts-stream] kokoro aborted after ${total} bytes`);
    return summary;
  }

  if (!total) throw new Error(`kokoro returned no audio${stderr ? `: ${stderr.slice(0, 240)}` : ''}`);
  const summary = {
    streamed: true,
    engine: 'kokoro',
    encoding: 'pcm_s16le',
    sampleRate: 16000,
    channels: 1,
    audioBytes: total,
    audioContentType: 'audio/pcm',
  };
  await onEnd?.(summary);
  return summary;
}

async function synthesizeKokoro(text, { signal, pythonBin, model, kokoroVoice, langCode, speed } = {}) {
  const chunks = [];
  let total = 0;
  await synthesizeKokoroPCMStreaming(text, {
    signal,
    pythonBin,
    model,
    kokoroVoice,
    langCode,
    speed,
    onChunk: async (chunk) => {
      chunks.push(Buffer.from(chunk));
      total += chunk.length;
    },
  });
  if (!total) throw new Error('kokoro returned no audio');
  return pcmToWav(Buffer.concat(chunks, total), 16000, 1, 16);
}

async function synthesizePiper(text, { signal, modelPath, lengthScale } = {}) {
  console.log(`[tts] piper model=${modelPath}`);
  const id = randomUUID();
  const wavPath = join(os.tmpdir(), `vb-tts-${id}.wav`);

  try {
    await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'));
      const proc = spawn(PIPER_BIN, ['-m', 'piper', '--model', modelPath, '--length-scale', String(lengthScale || DEFAULT_PIPER_LENGTH_SCALE), '--output_file', wavPath], { stdio: ['pipe', 'ignore', 'ignore'] });
      const onAbort = () => { proc.kill('SIGTERM'); reject(new Error('aborted')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      proc.on('close', code => {
        signal?.removeEventListener('abort', onAbort);
        if (code !== 0) return reject(new Error(`piper exited ${code}`));
        resolve();
      });
      proc.on('error', reject);
      proc.stdin.write(text);
      proc.stdin.end();
    });
    return await readFile(wavPath);
  } finally {
    unlink(wavPath).catch(() => {});
  }
}

async function synthesizeOpenAIPCMStreaming(text, { signal, model, voice, speed, onStart, onChunk, onEnd } = {}) {
  if (!OPENAI_TTS?.apiKey) throw new Error('openai tts not configured');
  const controller = new AbortController();
  const onAbort = () => controller.abort(new Error('aborted'));
  if (signal?.aborted) throw new Error('aborted');
  signal?.addEventListener('abort', onAbort, { once: true });
  let total = 0;
  let started = false;
  let aborted = false;
  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_TTS.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || OPENAI_TTS.model || OPENAI_TTS_MODEL,
        voice: voice || OPENAI_TTS.voice || OPENAI_TTS_VOICE,
        input: String(text || ''),
        response_format: 'pcm',
        speed: speed || 1.0,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`openai tts ${response.status}: ${detail.slice(0, 220)}`);
    }

    if (!response.body?.getReader) {
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      total += buffer.length;
      if (buffer.length) {
        started = true;
        await onStart?.({
          streamed: true,
          engine: 'openai',
          encoding: 'pcm_s16le',
          sampleRate: 24000,
          channels: 1,
          contentType: 'audio/pcm',
          model: model || OPENAI_TTS.model || OPENAI_TTS_MODEL,
          voice: voice || OPENAI_TTS.voice || OPENAI_TTS_VOICE,
        });
        await onChunk?.(buffer);
      }
    } else {
      const reader = response.body.getReader();
      while (true) {
        if (signal?.aborted) {
          aborted = true;
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) {
          const buffer = Buffer.from(value);
          if (!started) {
            started = true;
            await onStart?.({
              streamed: true,
              engine: 'openai',
              encoding: 'pcm_s16le',
              sampleRate: 24000,
              channels: 1,
              contentType: 'audio/pcm',
              model: model || OPENAI_TTS.model || OPENAI_TTS_MODEL,
              voice: voice || OPENAI_TTS.voice || OPENAI_TTS_VOICE,
            });
          }
          total += buffer.length;
          await onChunk?.(buffer);
        }
      }
    }
    if (aborted || signal?.aborted) {
      const summary = abortedStreamSummary({ engine: 'openai', sampleRate: 24000, total, started });
      if (started) await onEnd?.(summary);
      console.log(`[tts-stream] openai aborted after ${total} bytes`);
      return summary;
    }
    if (!total) throw new Error('openai tts returned no audio');
    const summary = {
      streamed: true,
      engine: 'openai',
      encoding: 'pcm_s16le',
      sampleRate: 24000,
      channels: 1,
      audioBytes: total,
      audioContentType: 'audio/pcm',
    };
    await onEnd?.(summary);
    return summary;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

async function synthesizeSay(text, { signal, sayVoice, rate } = {}) {
  console.log(`[tts] say voice=${sayVoice || 'Samantha'} rate=${rate || FALLBACK_RATE}`);
  const id = randomUUID();
  const aiffPath = join(os.tmpdir(), `vb-tts-${id}.aiff`);
  const wavPath = join(os.tmpdir(), `vb-tts-${id}.wav`);

  try {
    await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'));
      const proc = spawn(SAY_BIN, ['-v', sayVoice || 'Samantha', '-r', String(rate || FALLBACK_RATE), '-o', aiffPath, text], { stdio: 'ignore' });
      const onAbort = () => { proc.kill('SIGTERM'); reject(new Error('aborted')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      proc.on('close', code => {
        signal?.removeEventListener('abort', onAbort);
        if (code !== 0) return reject(new Error(`say exited ${code}`));
        resolve();
      });
      proc.on('error', reject);
    });

    await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'));
      const proc = spawn(FFMPEG_BIN, ['-y', '-i', aiffPath, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', wavPath], { stdio: 'ignore' });
      const onAbort = () => { proc.kill('SIGTERM'); reject(new Error('aborted')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      proc.on('close', code => {
        signal?.removeEventListener('abort', onAbort);
        if (code !== 0) return reject(new Error(`ffmpeg exited ${code}`));
        resolve();
      });
      proc.on('error', reject);
    });
    return await readFile(wavPath);
  } finally {
    unlink(aiffPath).catch(() => {});
    unlink(wavPath).catch(() => {});
  }
}

async function synthesizeOpenAIStreaming(text, { signal, model, voice, speed } = {}) {
  if (!OPENAI_TTS?.apiKey) throw new Error('openai tts not configured');
  const controller = new AbortController();
  const onAbort = () => controller.abort(new Error('aborted'));
  if (signal?.aborted) throw new Error('aborted');
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_TTS.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || OPENAI_TTS.model || OPENAI_TTS_MODEL,
        voice: voice || OPENAI_TTS.voice || OPENAI_TTS_VOICE,
        input: String(text || ''),
        response_format: OPENAI_TTS_FORMAT,
        speed: speed || 1.0,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`openai tts ${response.status}: ${detail.slice(0, 220)}`);
    }

    if (!response.body?.getReader) {
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      if (signal?.aborted) throw new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        const buf = Buffer.from(value);
        chunks.push(buf);
        total += buf.length;
      }
    }
    if (!total) throw new Error('openai tts returned no audio');
    return Buffer.concat(chunks, total);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
