#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { default: WebSocket } = await import(require.resolve('ws', {
  paths: [join(here, '..', 'BridgeRuntime')],
}));

const urls = process.env.VOICECLAW_COMPANION_WS_URL
  ? [process.env.VOICECLAW_COMPANION_WS_URL]
  : ['ws://127.0.0.1:12321/ws'];

const text = process.argv.slice(2).join(' ').trim() || 'Say briefly that Companion Realtime Voice streaming smoke test is working.';
const timeoutMs = Number(process.env.VOICECLAW_COMPANION_STREAM_SMOKE_TIMEOUT_MS || 45_000);

function startPayload() {
  const sessionToken = `stream-smoke-${Date.now().toString(36)}`;
  return {
    type: 'start_session',
    sessionToken,
    voice: 'cedar',
    ttsSpeed: 'normal',
    companionVoice: true,
    companionVoicePayload: {
      source: 'synthetic-stream-smoke',
      sessionToken,
      routeMode: 'standalone',
      brainMode: process.env.VOICECLAW_COMPANION_STREAM_SMOKE_BRAIN || 'qwen3.5-0.8b',
      qwenThinking: false,
      cerebrasAPIKey: process.env.CEREBRAS_API_KEY || '',
      cerebrasModel: process.env.VOICECLAW_COMPANION_STREAM_SMOKE_CEREBRAS_MODEL || 'gemma-4-31b',
      context: '',
      voice: 'cedar',
      localVoice: process.env.VOICECLAW_COMPANION_STREAM_SMOKE_LOCAL_VOICE || 'piper-ryan-high',
      ttsSpeed: 'normal',
      gpt55DirectReasoning: 'low',
      openClawModel: 'gpt-5.5',
      openClawReasoning: 'low',
      runtime: 'openclaw',
    },
  };
}

function smoke(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const seen = {
      ready: false,
      transcript: '',
      reply: '',
      result: null,
      audioBytes: 0,
      errors: [],
    };
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timed out after ${timeoutMs} ms waiting for companion_voice_result from ${url}`));
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify(startPayload()));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'companion_voice_text_turn', text }));
      }, 150);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        seen.audioBytes += Buffer.byteLength(data);
        return;
      }
      let event;
      try {
        event = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (event.type === 'status' && event.status === 'ready') seen.ready = true;
      if (event.type === 'transcript') seen.transcript = event.text || '';
      if (event.type === 'reply') seen.reply = event.text || '';
      if (event.type === 'companion_voice_result') {
        seen.result = event;
        clearTimeout(timer);
        ws.close();
        resolve({ url, seen });
      }
      if (event.type === 'error') seen.errors.push(event.message || event.error || 'unknown error');
    });

    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

let lastError;
for (const url of urls) {
  try {
    const { seen } = await smoke(url);
    console.log(JSON.stringify({
      ok: true,
      url,
      transcript: seen.transcript,
      replyPreview: seen.reply.slice(0, 240),
      planner: seen.result?.planner || '',
      brainMode: seen.result?.brainMode || '',
      transport: seen.result?.transport || '',
      audioBytes: seen.audioBytes,
    }, null, 2));
    process.exit(0);
  } catch (error) {
    lastError = error;
    console.error(`[stream-smoke] ${url} failed: ${error.message}`);
  }
}

console.error(`Companion streaming smoke failed: ${lastError?.message || 'unknown error'}`);
process.exit(1);
