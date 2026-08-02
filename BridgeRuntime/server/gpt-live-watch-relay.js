import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { GPTLiveWatchPeer } from './gpt-live-watch-peer.js';

const CHATGPT_GPT_LIVE_CALL_URL =
  'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas';
const ALLOWED_MODELS = new Set(['gpt-live-1-boulder-alpha', 'gpt-live-1-codex']);
const ALLOWED_VOICES = new Set([
  'alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse',
]);
const MAX_PENDING_AUDIO_BYTES = 24_000 * 2 * 6;
const MAX_PENDING_CONTROL_MESSAGES = 32;
const MAX_WATCH_MESSAGE_BYTES = 4 * 1024 * 1024;
const SESSION_TTL_MS = 30 * 60_000;

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function parseJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function jwtPayload(token) {
  const encoded = String(token || '').split('.')[1];
  if (!encoded) return {};
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function chatGPTAccountID(token) {
  const payload = jwtPayload(token);
  const auth = payload['https://api.openai.com/auth'] || {};
  return String(
    auth.chatgpt_account_id
      || payload.chatgpt_account_id
      || payload.account_id
      || payload.accountId
      || '',
  ).trim();
}

function boundedModel(raw) {
  const model = String(raw || '').trim().toLowerCase();
  return ALLOWED_MODELS.has(model) ? model : 'gpt-live-1-boulder-alpha';
}

function boundedVoice(raw) {
  const voice = String(raw || '').trim().toLowerCase();
  return ALLOWED_VOICES.has(voice) ? voice : 'marin';
}

function callSession(model, session = {}) {
  return {
    model,
    instructions: String(session.instructions || '').trim(),
    audio: {
      output: {
        voice: boundedVoice(session?.audio?.output?.voice),
      },
    },
    delegation: { type: 'client' },
    ...(Array.isArray(session.initial_items) ? { initial_items: session.initial_items } : {}),
  };
}

function sendJSON(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(payload)); } catch {}
}

function sendError(ws, code, message) {
  sendJSON(ws, {
    type: 'error',
    error: {
      code,
      message,
    },
  });
}

function closeWithError(ws, code, message) {
  sendError(ws, code, message);
  try { ws.close(1011, String(code).slice(0, 123)); } catch { ws.terminate(); }
}

export async function createChatGPTLiveCall({
  accessToken,
  fetchImpl = fetch,
  model,
  offerSDP,
  requestID,
  session,
  signal,
}) {
  const accountID = chatGPTAccountID(accessToken);
  if (!accountID) throw new Error('The Companion ChatGPT OAuth token has no account identifier.');
  const response = await fetchImpl(CHATGPT_GPT_LIVE_CALL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'ChatGPT-Account-ID': accountID,
      'OpenAI-Alpha': 'quicksilver=v2',
      originator: 'voiceclaw_realtime_companion_watch',
      'session-id': requestID,
      'thread-id': requestID,
      'x-session-id': requestID,
      Accept: 'application/sdp',
      'Content-Type': 'application/json',
      'User-Agent': 'VoiceClaw-Realtime-Companion/Watch-GPT-Live-Relay',
    },
    body: JSON.stringify({
      sdp: offerSDP,
      session: callSession(model, session),
    }),
    signal,
  });
  const answerSDP = await response.text();
  if (!response.ok) {
    throw new Error(
      `GPT Live Companion OAuth admission failed with HTTP ${response.status}: ${answerSDP.slice(0, 800)}`,
    );
  }
  if (!answerSDP.trim()) throw new Error('GPT Live Companion OAuth admission returned no SDP answer.');
  return answerSDP;
}

export class GPTLiveWatchRelaySession {
  constructor({
    ws,
    req,
    resolveOAuthBearer,
    logger = console,
    createPeer = GPTLiveWatchPeer.create,
    createCall = createChatGPTLiveCall,
    sessionTTLMS = SESSION_TTL_MS,
  }) {
    this.ws = ws;
    this.req = req;
    this.resolveOAuthBearer = resolveOAuthBearer;
    this.logger = logger;
    this.createPeer = createPeer;
    this.createCall = createCall;
    this.sessionTTLMS = sessionTTLMS;
    this.closed = false;
    this.startPromise = null;
    this.peer = null;
    this.pendingAudio = Buffer.alloc(0);
    this.pendingControls = [];
    this.sessionStartedSeen = false;
    this.abortController = new AbortController();
    this.ttl = setTimeout(() => this.close('session-expired'), sessionTTLMS);
    this.ttl.unref?.();
    const url = new URL(req.url || '/', 'http://localhost');
    this.model = boundedModel(url.searchParams.get('model'));
  }

  attach() {
    this.ws.on('message', (data, isBinary) => this.handleWatchMessage(data, isBinary));
    this.ws.on('error', (error) => this.fail(error));
    this.ws.on('close', () => this.close('watch-disconnected'));
  }

  handleWatchMessage(data, isBinary) {
    if (this.closed) return;
    if (isBinary) {
      closeWithError(this.ws, 'WATCH_LIVE_BINARY_UNSUPPORTED', 'GPT Live Watch relay requires JSON text frames.');
      this.close('invalid-watch-frame');
      return;
    }
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    if (Buffer.byteLength(text, 'utf8') > MAX_WATCH_MESSAGE_BYTES) {
      closeWithError(this.ws, 'WATCH_LIVE_MESSAGE_TOO_LARGE', 'GPT Live Watch relay message exceeded its size limit.');
      this.close('oversized-watch-frame');
      return;
    }
    const message = parseJSON(text);
    if (!message || typeof message.type !== 'string') {
      sendError(this.ws, 'WATCH_LIVE_INVALID_JSON', 'GPT Live Watch relay expected a typed JSON event.');
      return;
    }
    if (message.type === 'session.close') {
      this.peer?.sendControl(text);
      this.close('watch-session-close');
      return;
    }
    if (message.type === 'session.update' && !this.startPromise) {
      this.startPromise = this.start(message).catch((error) => this.fail(error));
      return;
    }
    if (message.type === 'input_audio.append') {
      const audio = Buffer.from(String(message.audio || ''), 'base64');
      if (!audio.length || audio.length % 2 !== 0) {
        sendError(this.ws, 'WATCH_LIVE_INVALID_AUDIO', 'GPT Live Watch audio must be non-empty PCM16.');
        return;
      }
      if (this.peer) this.peer.sendAudio(audio);
      else {
        this.pendingAudio = this.pendingAudio.length
          ? Buffer.concat([this.pendingAudio, audio])
          : audio;
        if (this.pendingAudio.length > MAX_PENDING_AUDIO_BYTES) {
          this.pendingAudio = this.pendingAudio.subarray(
            this.pendingAudio.length - MAX_PENDING_AUDIO_BYTES,
          );
        }
      }
      return;
    }
    if (this.peer) this.peer.sendControl(text);
    else {
      if (this.pendingControls.length >= MAX_PENDING_CONTROL_MESSAGES) this.pendingControls.shift();
      this.pendingControls.push(text);
    }
  }

  async start(initialUpdate) {
    const session = initialUpdate.session && typeof initialUpdate.session === 'object'
      ? initialUpdate.session
      : {};
    const signal = AbortSignal.any([
      this.abortController.signal,
      AbortSignal.timeout(45_000),
    ]);
    const peer = await this.createPeer({
      signal,
      callbacks: {
        onAudio: (audio) => sendJSON(this.ws, {
          type: 'output_audio.delta',
          audio: audio.toString('base64'),
        }),
        onControl: (payload) => this.forwardProviderControl(payload),
        onControlReady: () => {
          if (!this.sessionStartedSeen) {
            this.sessionStartedSeen = true;
            sendJSON(this.ws, {
              type: 'session.started',
              session: {
                id: `companion-watch-${randomUUID()}`,
                model: this.model,
                expires_at: Math.floor((Date.now() + this.sessionTTLMS) / 1000),
              },
            });
          }
        },
        onError: (error) => this.fail(error),
      },
    });
    if (this.closed) {
      peer.close();
      return;
    }
    this.peer = peer;
    const offerSDP = await peer.createOffer();
    const accessToken = await this.resolveOAuthBearer();
    const requestID = randomUUID().toLowerCase();
    const answerSDP = await this.createCall({
      accessToken,
      model: this.model,
      offerSDP,
      requestID,
      session,
      signal,
    });
    await peer.applyAnswer(answerSDP);
    peer.sendControl(JSON.stringify(initialUpdate));
    for (const control of this.pendingControls.splice(0)) peer.sendControl(control);
    if (this.pendingAudio.length) {
      peer.sendAudio(this.pendingAudio);
      this.pendingAudio = Buffer.alloc(0);
    }
    this.logger.info?.(`[gpt-live-watch-relay] connected model=${this.model}`);
  }

  forwardProviderControl(payload) {
    const parsed = parseJSON(payload);
    if (parsed?.type === 'output_audio.delta') return;
    if (parsed?.type === 'session.started') this.sessionStartedSeen = true;
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(payload);
  }

  fail(error) {
    if (this.closed) return;
    const normalized = asError(error);
    this.logger.warn?.(`[gpt-live-watch-relay] ${normalized.message}`);
    closeWithError(this.ws, 'GPT_LIVE_COMPANION_RELAY_FAILED', normalized.message);
    this.close('relay-error');
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.ttl);
    this.abortController.abort(new Error(`GPT Live Watch relay closed: ${reason}`));
    this.pendingAudio = Buffer.alloc(0);
    this.pendingControls = [];
    this.peer?.close();
    this.peer = null;
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      try { this.ws.close(1000, String(reason).slice(0, 123)); } catch { this.ws.terminate(); }
    }
  }
}

export function attachGPTLiveWatchRelaySocket(options) {
  const session = new GPTLiveWatchRelaySession(options);
  session.attach();
  return session;
}
