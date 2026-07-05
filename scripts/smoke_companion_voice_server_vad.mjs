#!/usr/bin/env node
import { execFile as execFileCb } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCb);
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { default: WebSocket } = await import(require.resolve('ws', {
  paths: [join(here, '..', 'BridgeRuntime')],
}));

const url = process.env.VOICECLAW_COMPANION_WS_URL || 'ws://127.0.0.1:12321/ws';
const timeoutMs = Number(process.env.VOICECLAW_COMPANION_SERVER_VAD_SMOKE_TIMEOUT_MS || 180_000);
const sampleRate = 16_000;
const chunkMs = 40;
const bytesPerChunk = Math.round(sampleRate * 2 * chunkMs / 1000);
const promptText = process.argv.slice(2).join(' ').trim() || 'VoiceClaw server voice activity detection smoke test.';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startPayload() {
  const sessionToken = `server-vad-smoke-${Date.now().toString(36)}`;
  const serverVad = {
    enabled: true,
    sampleRate,
    sensitivity: 0.82,
    silenceDurationMs: 360,
    startRms: 120,
    continueRms: 70,
  };
  return {
    type: 'start_session',
    sessionToken,
    voice: 'cedar',
    ttsSpeed: 'normal',
    companionVoice: true,
    serverVad,
    companionVoicePayload: {
      source: 'server-vad-smoke',
      sessionToken,
      routeMode: 'standalone',
      brainMode: process.env.VOICECLAW_COMPANION_STREAM_SMOKE_BRAIN || 'qwen3.5-2b',
      qwenThinking: false,
      localVoice: process.env.VOICECLAW_COMPANION_STREAM_SMOKE_LOCAL_VOICE || 'kokoro-af-heart',
      ttsSpeed: 'normal',
      gpt55DirectReasoning: 'low',
      openClawModel: 'gpt-5.5',
      openClawReasoning: 'low',
      runtime: 'openclaw',
      serverVad,
    },
  };
}

async function renderSpeechPCM(text) {
  const dir = await mkdtemp(join(tmpdir(), 'voiceclaw-server-vad-smoke-'));
  const aiffPath = join(dir, 'speech.aiff');
  const pcmPath = join(dir, 'speech.pcm');
  try {
    await execFile('/usr/bin/say', ['-o', aiffPath, text], { timeout: 30_000 });
    await execFile('/opt/homebrew/bin/ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-i', aiffPath,
      '-ac', '1',
      '-ar', String(sampleRate),
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      pcmPath,
    ], { timeout: 30_000 });
    return await readFile(pcmPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function sendPCMWithoutClientCommit(ws, pcm) {
  const leadingSilence = Buffer.alloc(Math.round(sampleRate * 2 * 0.24));
  const trailingSilence = Buffer.alloc(Math.round(sampleRate * 2 * 1.45));
  const combined = Buffer.concat([leadingSilence, pcm, trailingSilence]);
  for (let offset = 0; offset < combined.length; offset += bytesPerChunk) {
    ws.send(combined.subarray(offset, Math.min(combined.length, offset + bytesPerChunk)));
    await sleep(chunkMs);
  }
}

async function run() {
  const ws = new WebSocket(url);
  const events = [];
  let finished = false;

  const finish = (ok, terminal, extra = {}) => {
    if (finished) return;
    finished = true;
    try { ws.close(); } catch {}
    console.log(JSON.stringify({ ok, url, terminal, events, ...extra }, null, 2));
    process.exit(ok ? 0 : 1);
  };

  const timer = setTimeout(() => {
    finish(false, 'timeout', { reason: `timed out after ${timeoutMs} ms waiting for server VAD auto-commit` });
  }, timeoutMs);

  ws.on('open', async () => {
    ws.send(JSON.stringify(startPayload()));
  });

  ws.on('message', async (data, isBinary) => {
    if (isBinary) return;
    let event;
    try {
      event = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (['status', 'transcript', 'companion_voice_result', 'error', 'interrupted'].includes(event.type)) {
      events.push({
        type: event.type,
        status: event.status,
        text: event.text,
        filtered: event.filtered,
        reason: event.reason,
        message: event.message,
        transport: event.transport,
      });
    }
    if (event.type === 'status' && event.status === 'ready' && event.hf && !events.some((item) => item.status === 'sent-smoke-audio')) {
      events.push({ type: 'status', status: 'sent-smoke-audio' });
      const pcm = await renderSpeechPCM(promptText);
      await sendPCMWithoutClientCommit(ws, pcm);
    }
    const terminalTranscript = event.type === 'transcript' && event.final;
    if (terminalTranscript || event.type === 'companion_voice_result' || event.type === 'error') {
      clearTimeout(timer);
      const sawSpeechStart = events.some((item) => item.type === 'status' && (item.status === 'user_speech_start' || item.status === 'user-speaking'));
      const sawTranscribing = events.some((item) => item.type === 'status' && item.status === 'transcribing');
      const ok = event.type !== 'error' && sawSpeechStart && sawTranscribing;
      finish(ok, event.type, { sawSpeechStart, sawTranscribing });
    }
  });

  ws.on('error', (error) => {
    clearTimeout(timer);
    finish(false, 'socket-error', { reason: error.message });
  });
}

await run();
