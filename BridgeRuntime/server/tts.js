// TTS module — OpenAI streaming-first voice plus local fallbacks
import { spawn, execFile as execFileCb } from 'node:child_process';
import { readFile, unlink, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { promisify } from 'node:util';
import { executablePath, normalizeProcessPath } from './bin-paths.js';

const execFile = promisify(execFileCb);
normalizeProcessPath();

const DEFAULT_PIPER_MODEL = process.env.PIPER_MODEL || join(os.homedir(), '.openclaw', 'models', 'piper', 'en_US-libritts-high.onnx');
const DEFAULT_PIPER_LENGTH_SCALE = process.env.PIPER_LENGTH_SCALE || '0.7';
const PIPER_BIN = executablePath(process.env.PIPER_BIN || 'python3');
const FFMPEG_BIN = executablePath(process.env.FFMPEG_BIN || 'ffmpeg');
const SAY_BIN = executablePath(process.env.SAY_BIN || 'say');
const FALLBACK_RATE = process.env.TTS_RATE || '185';
const DEFAULT_SPEED = process.env.TTS_SPEED || 'fastest';
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || join(os.homedir(), '.openclaw', 'openclaw.json');
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';
const OPENAI_TTS_FORMAT = process.env.OPENAI_TTS_FORMAT || 'wav';
const OPENAI_TTS_CIRCUIT_MS = Number(process.env.OPENAI_TTS_CIRCUIT_MS || 120000);

const TTS_SPEED_PRESETS = [
  { id: 'slower', label: 'Slower', openai: 0.85, sayRate: 160, piperLengthScale: 0.82 },
  { id: 'normal', label: 'Normal', openai: 1.0, sayRate: 185, piperLengthScale: 0.70 },
  { id: 'faster', label: 'Faster', openai: 1.15, sayRate: 215, piperLengthScale: 0.60 },
  { id: 'fastest', label: 'Fastest', openai: 1.3, sayRate: 245, piperLengthScale: 0.52 },
];

function loadOpenAITtsConfig() {
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
    modelPath: join(os.homedir(), '.openclaw', 'models', 'piper', 'en_US-libritts-high.onnx'),
    lengthScale: DEFAULT_PIPER_LENGTH_SCALE,
    default: !OPENAI_TTS,
  },
  {
    id: 'piper-ryan-high',
    label: 'Piper Ryan High',
    engine: 'piper',
    modelPath: join(os.homedir(), '.openclaw', 'models', 'piper', 'en_US-ryan-high.onnx'),
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

async function loadSayVoices() {
  try {
    const { stdout } = await execFile('say', ['-v', '?'], { timeout: 5000, maxBuffer: 1024 * 1024 });
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

async function buildVoiceOptions() {
  const availableSayVoices = await loadSayVoices();
  const options = [];

  for (const candidate of CURATED_VOICES) {
    if (candidate.engine === 'piper') {
      const modelPath = candidate.modelPath || DEFAULT_PIPER_MODEL;
      if (await fileExists(modelPath)) options.push({ ...candidate, modelPath });
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
  };
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
      if (err.message === 'aborted') throw err;
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
      if (err.message === 'aborted') throw err;
      console.warn(`[tts] Piper (${voiceCfg.id}) failed, falling back to macOS say:`, err.message);
      lastFallback = 'say-after-piper-failed';
      const audio = await synthesizeSay(text, { signal, sayVoice: 'Samantha', rate: speedPreset.sayRate });
      lastEngine = 'say';
      return audio;
    }
  }

  const audio = await synthesizeSay(text, { signal, sayVoice: voiceCfg.sayVoice, rate: speedPreset.sayRate });
  lastEngine = 'say';
  lastFallback = '';
  return audio;
}

async function synthesizeLocalFallback(text, { signal, speedPreset, reason } = {}) {
  try {
    const audio = await synthesizePiper(text, { signal, modelPath: join(os.homedir(), '.openclaw', 'models', 'piper', 'en_US-ryan-high.onnx'), lengthScale: speedPreset.piperLengthScale });
    lastEngine = 'piper';
    lastFallback = reason || 'fallback';
    return audio;
  } catch (piperErr) {
    if (piperErr.message === 'aborted') throw piperErr;
    console.warn('[tts] Piper fallback failed after OpenAI failure, falling back to macOS say:', piperErr.message);
    const audio = await synthesizeSay(text, { signal, sayVoice: 'Samantha', rate: speedPreset.sayRate });
    lastEngine = 'say';
    lastFallback = `${reason || 'fallback'};piper-failed`;
    return audio;
  }
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
