#!/usr/bin/env node
import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const execFile = promisify(execFileCb);
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { default: WebSocket } = await import(require.resolve('ws', {
  paths: [join(here, '..', 'BridgeRuntime')],
}));

const url = process.env.VOICECLAW_COMPANION_WS_URL || 'ws://127.0.0.1:12321/ws';
const timeoutMs = Number(process.env.VOICECLAW_COMPANION_HF_SMOKE_TIMEOUT_MS || 180_000);
const sampleRate = 16_000;
const chunkMs = 40;
const bytesPerChunk = Math.round(sampleRate * 2 * chunkMs / 1000);
const skipAudio = /^(1|true|yes)$/i.test(process.env.VOICECLAW_HF_SMOKE_SKIP_AUDIO || '');
const promptText = process.argv.slice(2).join(' ').trim() || 'VoiceClaw realtime smoke test.';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startPayload() {
  const sessionToken = `hf-realtime-smoke-${Date.now().toString(36)}`;
  const serverVad = {
    enabled: true,
    mode: 'server_vad',
    sampleRate,
    sensitivity: 0.78,
    silenceDurationMs: 420,
    clientStreamsContinuously: true,
  };
  return {
    type: 'start_session',
    sessionToken,
    voice: 'cedar',
    ttsSpeed: 'normal',
    companionVoice: true,
    serverVad,
    companionVoicePayload: {
      source: 'hf-realtime-smoke',
      sessionToken,
      routeMode: 'standalone',
      brainMode: process.env.VOICECLAW_COMPANION_STREAM_SMOKE_BRAIN || 'qwen3.5-0.8b',
      qwenThinking: false,
      cerebrasAPIKey: process.env.CEREBRAS_API_KEY || '',
      cerebrasModel: process.env.VOICECLAW_COMPANION_STREAM_SMOKE_CEREBRAS_MODEL || 'gemma-4-31b',
      context: '',
      voice: 'cedar',
      localVoice: process.env.VOICECLAW_COMPANION_STREAM_SMOKE_LOCAL_VOICE || 'kokoro-af-heart',
      ttsSpeed: 'normal',
      gpt55DirectReasoning: 'low',
      openClawModel: 'gpt-5.5',
      openClawReasoning: 'low',
      runtime: 'openclaw',
      turnDetection: 'server_vad',
      vadSensitivity: 0.78,
      vadSilenceMs: 420,
      serverVad,
    },
  };
}

async function renderSpeechPCM(text) {
  const dir = await mkdtemp(join(tmpdir(), 'voiceclaw-hf-smoke-'));
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

async function sendPCM(ws, pcm) {
  const leadingSilence = Buffer.alloc(Math.round(sampleRate * 2 * 0.18));
  const trailingSilence = Buffer.alloc(Math.round(sampleRate * 2 * 0.75));
  const combined = Buffer.concat([leadingSilence, pcm, trailingSilence]);
  for (let offset = 0; offset < combined.length; offset += bytesPerChunk) {
    ws.send(combined.subarray(offset, Math.min(combined.length, offset + bytesPerChunk)));
    await sleep(chunkMs);
  }
  ws.send(JSON.stringify({
    type: 'client_speech_end_hint',
    reason: 'hf_smoke_audio_finished',
    silenceSeconds: 0.75,
    peakLevel: 0.5,
  }));
  ws.send(JSON.stringify({
    type: 'audio_end',
    reason: 'hf_smoke_audio_finished',
    audioBytes: combined.length,
  }));
}

function compactEvent(event) {
  return {
    type: event.type,
    status: event.status,
    source: event.source,
    hf: event.hf,
    final: event.final,
    filtered: event.filtered,
    text: typeof event.text === 'string' ? event.text.slice(0, 220) : undefined,
    rawText: typeof event.rawText === 'string' ? event.rawText.slice(0, 220) : undefined,
    reason: event.reason,
    message: typeof event.message === 'string' ? event.message.slice(0, 300) : undefined,
    planner: event.planner,
    brainMode: event.brainMode,
    audioStreamed: event.audioStreamed,
    audioBytes: event.audioBytes,
    iphoneToolName: event.iphoneToolName,
    iphoneToolArguments: typeof event.iphoneToolArguments === 'string'
      ? event.iphoneToolArguments.slice(0, 300)
      : event.iphoneToolArguments,
    callID: event.callID,
  };
}

async function run() {
  const ws = new WebSocket(url);
  const events = [];
  let finished = false;
  let ready = false;
  let sentAudio = false;
  let finalTranscript = '';
  let result = null;
  const startedAt = Date.now();

  function finish(ok, terminal, extra = {}) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { ws.close(); } catch {}
    console.log(JSON.stringify({
      ok,
      url,
      terminal,
      ready,
      sentAudio,
      finalTranscript,
      elapsedMs: Date.now() - startedAt,
      events,
      ...extra,
    }, null, 2));
    process.exit(ok ? 0 : 1);
  }

  const timer = setTimeout(() => {
    finish(false, 'timeout', { reason: `timed out after ${timeoutMs} ms` });
  }, timeoutMs);

  ws.on('open', () => {
    ws.send(JSON.stringify(startPayload()));
  });

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      events.push({ type: 'binary_audio', audioBytes: Buffer.byteLength(data) });
      return;
    }
    let event;
    try {
      event = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (['status', 'transcript', 'reply', 'reply_delta', 'companion_voice_result', 'tts_audio_start', 'tts_audio_end', 'interrupted', 'iphone_tool', 'error'].includes(event.type)) {
      events.push(compactEvent(event));
    }
    if (event.type === 'error') {
      finish(false, 'error', { error: event.message || event.error || 'unknown error' });
      return;
    }
    if (event.type === 'status' && event.status === 'ready' && event.hf) {
      ready = true;
      if (skipAudio) {
        finish(true, 'hf-ready');
        return;
      }
      if (!sentAudio) {
        sentAudio = true;
        const pcm = await renderSpeechPCM(promptText);
        await sendPCM(ws, pcm);
      }
    }
    if (event.type === 'transcript' && event.final) {
      finalTranscript = event.text || event.rawText || '';
    }
    if (event.type === 'iphone_tool' && event.callID) {
      ws.send(JSON.stringify({
        type: 'iphone_tool_result',
        callID: event.callID,
        output: JSON.stringify({
          ok: true,
          smoke: true,
          tool: event.iphoneToolName || '',
          arguments: event.iphoneToolArguments || {},
        }),
      }));
    }
    if (event.type === 'companion_voice_result') {
      result = event;
      finish(ready && sentAudio, 'companion_voice_result', { result: compactEvent(result) });
    }
  });

  ws.on('error', (error) => {
    finish(false, 'socket-error', { error: error.message });
  });

  ws.on('close', () => {
    if (!finished) finish(false, 'closed');
  });
}

await run();
