// ASR module — wraps whisper-cli for local speech-to-text
import { spawn } from 'node:child_process';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { executablePath, normalizeProcessPath } from './bin-paths.js';

normalizeProcessPath();

const WHISPER_CLI = executablePath(process.env.WHISPER_CLI || 'whisper-cli');
const FFMPEG_BIN = executablePath(process.env.FFMPEG_BIN || 'ffmpeg');
const WHISPER_SMALL_MODEL = join(os.homedir(), '.openclaw', 'models', 'ggml-small.bin');
const WHISPER_MEDIUM_MODEL = join(os.homedir(), '.openclaw', 'models', 'ggml-medium.bin');
const WHISPER_MODEL = process.env.WHISPER_MODEL || (existsSync(WHISPER_SMALL_MODEL) ? WHISPER_SMALL_MODEL : WHISPER_MEDIUM_MODEL);
const ASR_TIMEOUT_MS = Number.parseInt(process.env.ASR_TIMEOUT_MS || '25000', 10);
const FFMPEG_TIMEOUT_MS = Number.parseInt(process.env.FFMPEG_TIMEOUT_MS || '12000', 10);
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || join(os.homedir(), '.openclaw', 'openclaw.json');
const OPENAI_ASR_MODEL = process.env.OPENAI_ASR_MODEL || 'gpt-4o-mini-transcribe';
const OPENAI_ASR_TIMEOUT_MS = Number.parseInt(process.env.OPENAI_ASR_TIMEOUT_MS || '30000', 10);
const OPENAI_ASR_FALLBACK_ENABLED = process.env.OPENAI_ASR_FALLBACK !== '0';

function loadOpenAIASRConfig() {
  let fromConfig = null;
  try {
    const cfg = JSON.parse(readFileSync(OPENCLAW_CONFIG, 'utf8'));
    const candidates = [
      cfg?.messages?.stt?.providers?.openai?.apiKey,
      cfg?.messages?.asr?.providers?.openai?.apiKey,
      cfg?.messages?.tts?.providers?.openai?.apiKey,
      cfg?.talk?.providers?.openai?.apiKey,
      cfg?.openai?.apiKey,
      cfg?.apiKeys?.openai,
    ];
    for (const value of candidates) {
      const key = String(value || '').trim();
      if (key) {
        fromConfig = { apiKey: key, model: process.env.OPENAI_ASR_MODEL || OPENAI_ASR_MODEL };
        break;
      }
    }
  } catch {}

  if (process.env.OPENAI_API_KEY) {
    return { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_ASR_MODEL || fromConfig?.model || OPENAI_ASR_MODEL };
  }
  return fromConfig;
}

const OPENAI_ASR = loadOpenAIASRConfig();

/**
 * Write a WAV header for raw PCM s16le mono data at the given sample rate.
 * Returns a complete WAV Buffer ready for whisper-cli.
 */
function pcmToWav(pcmBuffer, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const headerSize = 44;
  const wav = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);   // file size - 8
  wav.write('WAVE', 8);

  // fmt sub-chunk
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);              // sub-chunk size
  wav.writeUInt16LE(1, 20);               // PCM format
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(wav, headerSize);

  return wav;
}

/**
 * Convert any audio buffer to 16kHz mono WAV via ffmpeg.
 * Used when input is NOT raw PCM (e.g., webm, ogg, mp4).
 */
async function toWavViaFfmpeg(inputBuffer, inputPath, wavPath, signal) {
  await writeFile(inputPath, inputBuffer);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));

    const proc = spawn(FFMPEG_BIN, [
      '-y', '-i', inputPath,
      '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
      wavPath
    ], { stdio: 'ignore' });

    let settled = false;
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timeout); fn(); };
    const timeout = setTimeout(() => { proc.kill('SIGTERM'); finish(() => reject(new Error('ffmpeg wav conversion timed out'))); }, FFMPEG_TIMEOUT_MS);
    const onAbort = () => { proc.kill('SIGTERM'); finish(() => reject(new Error('aborted'))); };
    signal?.addEventListener('abort', onAbort, { once: true });

    proc.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      if (code !== 0) return finish(() => reject(new Error(`ffmpeg wav conversion failed (code ${code})`)));
      finish(resolve);
    });
    proc.on('error', (err) => finish(() => reject(err)));
  });
}

/**
 * Transcribe an audio buffer using whisper-cli.
 * Accepts raw PCM s16le 16kHz mono (from WebSocket binary frames)
 * or any format ffmpeg can read (webm, ogg, mp4, wav, etc.).
 *
 * Raw PCM is detected by absence of known container magic bytes.
 * Returns { text: string } or throws.
 * Caller can pass an AbortSignal to cancel.
 */
export async function transcribe(audioBuffer, { signal } = {}) {
  const id = randomUUID();
  const wavPath = join(os.tmpdir(), `vb-asr-${id}.wav`);
  const tmpPath = join(os.tmpdir(), `vb-asr-${id}.tmp`);

  try {
    // Detect if this is a known container format or raw PCM
    const isContainer = detectContainer(audioBuffer);

    if (isContainer) {
      // Container format (webm, ogg, mp4, wav, etc.) — use ffmpeg
      await toWavViaFfmpeg(audioBuffer, tmpPath, wavPath, signal);
    } else {
      // Raw PCM s16le 16kHz mono — wrap with WAV header directly
      const wavBuf = pcmToWav(audioBuffer, 16000);
      await writeFile(wavPath, wavBuf);
    }

    try {
      const text = await transcribeWithWhisperCLI(wavPath, { signal });
      return { text, source: 'whisper-cli', fallback: false };
    } catch (err) {
      if (err.message === 'aborted') throw err;
      if (!OPENAI_ASR_FALLBACK_ENABLED || !OPENAI_ASR?.apiKey) throw err;
      console.warn(`[asr] local whisper failed; falling back to OpenAI transcription: ${err.message}`);
      const text = await transcribeWithOpenAI(wavPath, { signal });
      return { text, source: 'openai', fallback: true };
    }
  } finally {
    unlink(wavPath).catch(() => {});
    unlink(tmpPath).catch(() => {});
  }
}

async function transcribeWithWhisperCLI(wavPath, { signal } = {}) {
  return await new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));

    const args = [
      '-m', WHISPER_MODEL,
      '-f', wavPath,
      '--no-timestamps',
      '-t', '4',
      '-l', 'en',
      '--no-prints',
    ];

    const proc = spawn(WHISPER_CLI, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    let settled = false;
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timeout); fn(); };
    const timeout = setTimeout(() => { proc.kill('SIGTERM'); finish(() => reject(new Error('speech-to-text timed out'))); }, ASR_TIMEOUT_MS);
    const onAbort = () => { proc.kill('SIGTERM'); finish(() => reject(new Error('aborted'))); };
    signal?.addEventListener('abort', onAbort, { once: true });

    proc.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      if (code !== 0) return finish(() => reject(new Error(`whisper exited ${code}: ${stderr.slice(0, 200)}`)));
      finish(() => resolve(stdout.trim()));
    });
    proc.on('error', (err) => finish(() => reject(err)));
  });
}

async function transcribeWithOpenAI(wavPath, { signal } = {}) {
  if (!OPENAI_ASR?.apiKey) throw new Error('openai asr not configured');
  if (signal?.aborted) throw new Error('aborted');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('openai speech-to-text timed out')), OPENAI_ASR_TIMEOUT_MS);
  const onAbort = () => controller.abort(new Error('aborted'));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const audio = await readFile(wavPath);
    const form = new FormData();
    form.append('model', OPENAI_ASR.model || OPENAI_ASR_MODEL);
    form.append('response_format', 'json');
    form.append('file', new Blob([audio], { type: 'audio/wav' }), 'voiceclaw-turn.wav');
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_ASR.apiKey}`,
      },
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`openai speech-to-text ${response.status}: ${detail.slice(0, 220)}`);
    }
    const json = await response.json();
    return String(json?.text || '').trim();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Check if buffer starts with known audio container magic bytes.
 */
function detectContainer(buf) {
  if (buf.length < 12) return false;

  // RIFF/WAV
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true;
  // OGG
  if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return true;
  // WebM/Matroska (EBML header)
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return true;
  // ftyp (MP4/M4A)
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return true;
  // FLAC
  if (buf[0] === 0x66 && buf[1] === 0x4C && buf[2] === 0x61 && buf[3] === 0x43) return true;

  return false;
}
