#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { default: WebSocket } = await import(require.resolve('ws', {
  paths: [join(here, '..', 'BridgeRuntime')],
}));

const url = process.env.VOICECLAW_COMPANION_WS_URL || 'ws://127.0.0.1:3101/ws';
const timeoutMs = Number(process.env.VOICECLAW_COMPANION_SERVER_VAD_SMOKE_TIMEOUT_MS || 45_000);
const sampleRate = 16_000;
const chunkMs = 40;
const samplesPerChunk = Math.round(sampleRate * chunkMs / 1000);

function pcmChunk(kind, phase = 0) {
  const buffer = Buffer.alloc(samplesPerChunk * 2);
  for (let i = 0; i < samplesPerChunk; i += 1) {
    let sample = 0;
    if (kind === 'speech') {
      const t = (phase + i) / sampleRate;
      sample = Math.round(Math.sin(2 * Math.PI * 240 * t) * 5200);
    }
    buffer.writeInt16LE(sample, i * 2);
  }
  return buffer;
}

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
    await sleep(100);
    for (let i = 0; i < 8; i += 1) {
      ws.send(pcmChunk('silence'));
      await sleep(chunkMs);
    }
    for (let i = 0; i < 28; i += 1) {
      ws.send(pcmChunk('speech', i * samplesPerChunk));
      await sleep(chunkMs);
    }
    for (let i = 0; i < 18; i += 1) {
      ws.send(pcmChunk('silence'));
      await sleep(chunkMs);
    }
  });

  ws.on('message', (data, isBinary) => {
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
    if (event.type === 'transcript' || event.type === 'companion_voice_result' || event.type === 'error') {
      clearTimeout(timer);
      const sawSpeechStart = events.some((item) => item.type === 'status' && item.status === 'user_speech_start');
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
