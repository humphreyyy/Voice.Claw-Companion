import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import WebSocket from 'ws';
import { GPTLiveWatchPeer } from './gpt-live-watch-peer.js';

const CHATGPT_GPT_LIVE_CALL_URL =
  'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas';
const ALLOWED_MODELS = new Set(['gpt-live-1-boulder-alpha', 'gpt-live-1-codex']);
const ALLOWED_VOICES = new Set([
  'juniper', 'maple', 'spruce', 'ember', 'vale', 'breeze', 'arbor', 'sol', 'cove',
]);
// GPT Live is real-time. Keeping seconds of Watch audio here makes a late
// relay replay stale speech after the provider becomes writable again.
const MAX_PRE_ADMISSION_AUDIO_SECONDS = 0.2;
const MAX_PENDING_CONTROL_MESSAGES = 32;
const MAX_WATCH_MESSAGE_BYTES = 4 * 1024 * 1024;
const DETACHED_SESSION_RETENTION_MS = 10 * 60_000;
const EXPIRED_RELAY_ID_TOMBSTONE_MS = 30 * 60_000;
const ADMISSION_FAMILY_FALLBACK_DELAY_MS = 250;
const MAX_ADMISSION_RESPONSE_BYTES = 1024 * 1024;

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
  return ALLOWED_VOICES.has(voice) ? voice : 'ember';
}

function boundedProductValue(raw, fallback) {
  const value = String(raw || '').trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : fallback;
}

function iPhoneUserAgent(req) {
  const version = boundedProductValue(req?.headers?.['x-voiceclaw-app-version'], 'unknown');
  const build = boundedProductValue(req?.headers?.['x-voiceclaw-app-build'], 'unknown');
  return `VoiceClaw-Realtime-iOS/${version} (${build})`;
}

function relaySessionIDFromRequest(req) {
  const value = String(req?.headers?.['x-voiceclaw-live-relay-session'] || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{7,127}$/.test(value) ? value : '';
}

function addressFamilyRank(family) {
  if (Number(family) === 4) return 0;
  if (Number(family) === 6) return 1;
  return 2;
}

export function createIPv4FirstLookup(lookupImpl = dnsLookup) {
  return (hostname, options, callback) => {
    const requestedOptions = options && typeof options === 'object'
      ? options
      : { family: options };
    lookupImpl(hostname, {
      ...requestedOptions,
      all: true,
      verbatim: true,
    }, (error, addresses, family) => {
      if (error) {
        callback(error);
        return;
      }
      const records = (Array.isArray(addresses) ? addresses : [addresses])
        .filter(Boolean)
        .map((entry) => (typeof entry === 'string'
          ? { address: entry, family: Number(family) || 0 }
          : entry))
        .sort((left, right) => addressFamilyRank(left.family) - addressFamilyRank(right.family));
      if (!records.length) {
        const noAddress = new Error(`No network address was resolved for ${hostname}.`);
        noAddress.code = 'ENOTFOUND';
        callback(noAddress);
        return;
      }
      if (requestedOptions.all) callback(null, records);
      else callback(null, records[0].address, records[0].family);
    });
  };
}

// This is one HTTP request. Node's socket layer attempts the IPv4-sorted
// addresses and falls back to IPv6 before any request body can be replayed.
export function requestChatGPTLiveAdmission({
  body,
  headers,
  lookupImpl = dnsLookup,
  requestImpl = httpsRequest,
  signal,
  url = CHATGPT_GPT_LIVE_CALL_URL,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    let request;
    try {
      request = requestImpl(url, {
        method: 'POST',
        headers,
        signal,
        lookup: createIPv4FirstLookup(lookupImpl),
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: ADMISSION_FAMILY_FALLBACK_DELAY_MS,
      }, (response) => {
        const chunks = [];
        let byteCount = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          const buffer = Buffer.from(chunk);
          byteCount += buffer.length;
          if (byteCount > MAX_ADMISSION_RESPONSE_BYTES) {
            const oversized = new Error('GPT Live Companion OAuth admission response exceeded its size limit.');
            response.destroy?.();
            settle(reject, oversized);
            return;
          }
          chunks.push(buffer);
        });
        response.once('aborted', () => settle(
          reject,
          new Error('GPT Live Companion OAuth admission response ended unexpectedly.'),
        ));
        response.once('error', (error) => settle(reject, asError(error)));
        response.once('end', () => {
          const status = Number(response.statusCode) || 0;
          settle(resolve, {
            body: Buffer.concat(chunks).toString('utf8'),
            ok: status >= 200 && status < 300,
            status,
          });
        });
      });
    } catch (error) {
      settle(reject, asError(error));
      return;
    }
    request.once('error', (error) => settle(reject, asError(error)));
    request.end(body);
  });
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
  admissionRequest = requestChatGPTLiveAdmission,
  model,
  offerSDP,
  requestID,
  session,
  signal,
  userAgent,
}) {
  const accountID = chatGPTAccountID(accessToken);
  if (!accountID) throw new Error('The Companion ChatGPT OAuth token has no account identifier.');
  const body = JSON.stringify({
    sdp: offerSDP,
    session: callSession(model, session),
  });
  const response = await admissionRequest({
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'ChatGPT-Account-ID': accountID,
      'OpenAI-Alpha': 'quicksilver=v2',
      originator: 'voiceclaw_realtime_ios',
      'session-id': requestID,
      'thread-id': requestID,
      Accept: 'application/sdp',
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
      'User-Agent': userAgent || 'VoiceClaw-Realtime-iOS/unknown (unknown)',
    },
    body,
    signal,
  });
  const answerSDP = response.body;
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
    detachedRetentionMS = DETACHED_SESSION_RETENTION_MS,
    relaySessionID = relaySessionIDFromRequest(req) || randomUUID().toLowerCase(),
    clientIdentity = '',
    onClosed = () => {},
  }) {
    this.ws = ws;
    this.req = req;
    this.resolveOAuthBearer = resolveOAuthBearer;
    this.logger = logger;
    this.createPeer = createPeer;
    this.createCall = createCall;
    this.detachedRetentionMS = detachedRetentionMS;
    this.relaySessionID = relaySessionID;
    this.clientIdentity = clientIdentity;
    this.onClosed = onClosed;
    this.closed = false;
    this.startPromise = null;
    this.peer = null;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.pendingAudioDroppedBytes = 0;
    this.pendingControlHighWater = 0;
    this.pendingControlDropped = 0;
    this.pendingControls = [];
    this.sessionStartedSeen = false;
    this.providerSessionStartedPayload = null;
    this.providerAdmitted = false;
    this.providerMediaInterrupted = false;
    this.providerMediaState = 'connecting';
    this.providerMediaUnavailableReported = false;
    this.providerControlDegraded = false;
    this.providerControlState = 'connecting';
    this.detachTTL = null;
    this.detachedAt = null;
    this.abortController = new AbortController();
    const url = new URL(req.url || '/', 'http://localhost');
    this.model = boundedModel(url.searchParams.get('model'));
    this.userAgent = iPhoneUserAgent(req);
  }

  attach() {
    this.attachSocket(this.ws, this.req);
  }

  attachSocket(ws, req = this.req) {
    if (this.closed || !ws) return false;
    clearTimeout(this.detachTTL);
    this.detachTTL = null;
    this.detachedAt = null;
    const previous = this.ws;
    this.ws = ws;
    this.req = req;
    this.userAgent = iPhoneUserAgent(req);
    if (previous && previous !== ws && previous.readyState === WebSocket.OPEN) {
      try { previous.close(1012, 'replaced by retained session attachment'); } catch { previous.terminate(); }
    }
    ws.on('message', (data, isBinary) => this.handleWatchMessage(ws, data, isBinary));
    ws.on('error', (error) => {
      this.logger.warn?.(`[gpt-live-watch-relay] Watch socket error: ${asError(error).message}`);
      this.detachSocket(ws, 'watch-socket-error');
    });
    ws.on('close', () => this.detachSocket(ws, 'watch-disconnected'));
    if (this.sessionStartedSeen) {
      this.sendProviderSessionStarted();
      this.sendCurrentProviderTransportState();
    }
    return true;
  }

  detachSocket(ws, reason) {
    if (this.closed || this.ws !== ws) return;
    this.ws = null;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.pendingControls = [];
    this.detachedAt = Date.now();
    clearTimeout(this.detachTTL);
    this.detachTTL = setTimeout(
      () => this.close('watch-detached-expired'),
      this.detachedRetentionMS,
    );
    this.detachTTL.unref?.();
    this.logger.info?.(`[gpt-live-watch-relay] detached relay=${this.relaySessionID} reason=${reason}; retaining provider peer for ${this.detachedRetentionMS}ms`);
  }

  statusSnapshot(now = Date.now()) {
    const watchAttached = !!this.ws
      && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING);
    const providerControl = this.providerControlDegraded
      ? this.providerControlState
      : this.providerControlState === 'open'
        ? 'active'
        : this.providerControlState;
    const retainedForMS = watchAttached || this.detachedAt == null
      ? this.detachedRetentionMS
      : Math.max(0, this.detachedRetentionMS - Math.max(0, now - this.detachedAt));
    return {
      id: this.relaySessionID,
      state: watchAttached ? 'active' : 'detached',
      watchAttached,
      retained: !this.closed,
      retainedForMS,
      provider: {
        admitted: this.providerAdmitted,
        media: this.currentProviderMediaStatus(),
        control: providerControl,
      },
    };
  }

  handleWatchMessage(ws, data, isBinary) {
    if (this.closed || this.ws !== ws) return;
    if (isBinary) {
      closeWithError(ws, 'WATCH_LIVE_BINARY_UNSUPPORTED', 'GPT Live Watch relay requires JSON text frames.');
      this.close('invalid-watch-frame');
      return;
    }
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    if (Buffer.byteLength(text, 'utf8') > MAX_WATCH_MESSAGE_BYTES) {
      closeWithError(ws, 'WATCH_LIVE_MESSAGE_TOO_LARGE', 'GPT Live Watch relay message exceeded its size limit.');
      this.close('oversized-watch-frame');
      return;
    }
    const message = parseJSON(text);
    if (!message || typeof message.type !== 'string') {
      sendError(ws, 'WATCH_LIVE_INVALID_JSON', 'GPT Live Watch relay expected a typed JSON event.');
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
        sendError(ws, 'WATCH_LIVE_INVALID_AUDIO', 'GPT Live Watch audio must be non-empty PCM16.');
        return;
      }
      const sampleRate = Math.max(8_000, Math.min(96_000, Math.round(
        Number(message.sample_rate) || 24_000,
      )));
      const channelCount = Math.max(1, Math.min(2, Math.round(
        Number(message.channels) || 1,
      )));
      if (this.peer && !this.providerMediaInterrupted) {
        this.peer.sendAudio(audio, { sampleRate, channelCount });
      }
      else if (this.providerMediaInterrupted) return;
      else {
        this.enqueuePreAdmissionAudio(audio, { sampleRate, channelCount });
      }
      return;
    }
    if (this.peer) this.peer.sendControl(text);
    else {
      if (this.pendingControls.length >= MAX_PENDING_CONTROL_MESSAGES) {
        this.pendingControls.shift();
        this.pendingControlDropped += 1;
      }
      this.pendingControls.push(text);
      this.pendingControlHighWater = Math.max(
        this.pendingControlHighWater,
        this.pendingControls.length,
      );
      this.logger.info?.(
        `[gpt-live-watch-relay] pre-admission control currentCount=${this.pendingControls.length} highWaterCount=${this.pendingControlHighWater} droppedCount=${this.pendingControlDropped}`,
      );
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
        onAudio: (packet) => {
          const audio = Buffer.isBuffer(packet) ? packet : packet.audio;
          const sampleRate = Buffer.isBuffer(packet) ? 24_000 : packet.sampleRate;
          const channelCount = Buffer.isBuffer(packet) ? 1 : packet.channelCount;
          this.sendWatchJSON({
            type: 'output_audio.delta',
            audio: audio.toString('base64'),
            sample_rate: sampleRate,
            channels: channelCount,
          });
        },
        onControl: (payload) => this.forwardProviderControl(payload),
        onControlReady: () => {},
        onConnectionState: (state) => this.handleProviderConnectionState(state),
        onControlState: (state) => this.handleProviderControlState(state),
        onControlError: (error) => this.handleProviderControlError(error),
        onMediaError: (error) => this.handleProviderMediaError(error),
        onQueueDiagnostics: (diagnostics) => {
          this.logger.info?.(`[gpt-live-watch-relay] queue ${JSON.stringify(diagnostics)}`);
        },
        onError: (error) => this.handleUnexpectedProviderError(error),
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
      userAgent: this.userAgent,
    });
    this.providerAdmitted = true;
    await peer.applyAnswer(answerSDP);
    for (const control of this.pendingControls.splice(0)) peer.sendControl(control);
    if (this.pendingControlHighWater || this.pendingControlDropped) {
      this.logger.info?.(
        `[gpt-live-watch-relay] pre-admission control flushed currentCount=0 highWaterCount=${this.pendingControlHighWater} droppedCount=${this.pendingControlDropped}`,
      );
    }
    if (this.pendingAudio.length) {
      for (const pending of this.pendingAudio.splice(0)) {
        peer.sendAudio(pending.audio, {
          sampleRate: pending.sampleRate,
          channelCount: pending.channelCount,
        });
      }
      this.pendingAudioBytes = 0;
    }
    this.logger.info?.(`[gpt-live-watch-relay] connected model=${this.model}`);
  }

  enqueuePreAdmissionAudio(audio, { sampleRate, channelCount }) {
    const bytesPerSecond = sampleRate * channelCount * 2;
    const maxBytes = Math.max(2, Math.floor(bytesPerSecond * MAX_PRE_ADMISSION_AUDIO_SECONDS));
    let retained = Buffer.from(audio);
    if (retained.length > maxBytes) {
      this.pendingAudioDroppedBytes += retained.length - maxBytes;
      retained = retained.subarray(retained.length - maxBytes);
    }
    this.pendingAudio.push({
      audio: retained,
      sampleRate,
      channelCount,
      enqueuedAt: Date.now(),
    });
    this.pendingAudioBytes += retained.length;
    while (this.pendingAudioBytes > maxBytes && this.pendingAudio.length > 1) {
      const dropped = this.pendingAudio.shift();
      this.pendingAudioBytes -= dropped.audio.length;
      this.pendingAudioDroppedBytes += dropped.audio.length;
    }
    this.logger.info?.(
      `[gpt-live-watch-relay] pre-admission audio currentBytes=${this.pendingAudioBytes} maxBytes=${maxBytes} droppedBytes=${this.pendingAudioDroppedBytes}`,
    );
  }

  forwardProviderControl(payload) {
    const parsed = parseJSON(payload);
    if (parsed?.type === 'output_audio.delta') return;
    if (parsed?.type === 'session.started') {
      this.sessionStartedSeen = true;
      this.providerSessionStartedPayload = payload;
    }
    this.sendWatchRaw(payload);
  }

  sendWatchJSON(payload) {
    if (this.ws) sendJSON(this.ws, payload);
  }

  sendWatchRaw(payload) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(payload); } catch {}
  }

  sendProviderSessionStarted() {
    if (this.providerSessionStartedPayload) {
      this.sendWatchRaw(this.providerSessionStartedPayload);
    }
  }

  handleProviderConnectionState(state) {
    if (this.closed) return;
    this.providerMediaState = state;
    if (state === 'connected') {
      const wasInterrupted = this.providerMediaInterrupted;
      const wasUnavailableReported = this.providerMediaUnavailableReported;
      this.providerMediaInterrupted = false;
      this.providerMediaUnavailableReported = false;
      if (this.providerControlDegraded) this.sendControlDegradedState();
      else if (wasInterrupted || wasUnavailableReported) {
        this.sendWatchJSON({
          type: 'transport.resumed',
          transport: 'provider-webrtc-media',
          media: 'active',
          control: 'active',
        });
      }
      return;
    }
    if (['disconnected', 'failed', 'closed'].includes(state)) {
      this.interruptProviderMedia(`GPT Live relay media connection ${state}`, state);
    }
  }

  handleProviderControlState(state) {
    if (this.closed) return;
    this.providerControlState = state;
    if (state === 'open') {
      const wasDegraded = this.providerControlDegraded;
      this.providerControlDegraded = false;
      if (wasDegraded) this.sendCurrentProviderTransportState();
      return;
    }
    if (state !== 'closed') return;
    if (!this.providerAdmitted) {
      this.fail(new Error('GPT Live relay control channel closed during provider admission.'));
      return;
    }
    this.providerControlDegraded = true;
    this.sendControlDegradedState();
  }

  handleProviderControlError(error) {
    if (!this.providerAdmitted) {
      this.fail(error);
      return;
    }
    this.providerControlDegraded = true;
    this.providerControlState = 'error';
    this.sendControlDegradedState(asError(error).message);
  }

  handleProviderMediaError(error) {
    if (!this.providerAdmitted) {
      this.fail(error);
      return;
    }
    this.interruptProviderMedia(asError(error).message, 'error');
  }

  handleUnexpectedProviderError(error) {
    this.handleProviderMediaError(error);
  }

  interruptProviderMedia(message, state = 'interrupted') {
    if (this.closed) return;
    this.providerMediaInterrupted = true;
    this.providerMediaUnavailableReported = true;
    this.providerMediaState = state;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.sendWatchJSON({
      type: 'transport.interrupted',
      transport: 'provider-webrtc-media',
      media: 'interrupted',
      control: this.providerControlDegraded ? this.providerControlState : 'active',
      message,
    });
    this.logger.warn?.(`[gpt-live-watch-relay] provider media interrupted relay=${this.relaySessionID}: ${message}`);
  }

  sendControlDegradedState(message) {
    const media = this.currentProviderMediaStatus();
    const accurateMessage = message || (media === 'active'
      ? 'GPT Live relay control channel closed; viable audio remains active.'
      : media === 'connecting'
        ? 'GPT Live relay control channel closed; audio transport is still connecting.'
        : 'GPT Live relay control channel closed; audio transport is also interrupted.');
    this.sendWatchJSON({
      type: 'transport.degraded',
      transport: 'provider-webrtc-control',
      media,
      control: this.providerControlState,
      message: accurateMessage,
    });
    this.logger.warn?.(`[gpt-live-watch-relay] provider control degraded relay=${this.relaySessionID}: ${accurateMessage}`);
  }

  sendCurrentProviderTransportState() {
    if (this.providerMediaInterrupted) {
      this.providerMediaUnavailableReported = true;
      this.sendWatchJSON({
        type: 'transport.interrupted',
        transport: 'provider-webrtc-media',
        media: 'interrupted',
        control: this.providerControlDegraded ? this.providerControlState : 'active',
        message: 'GPT Live retained provider media remains interrupted.',
      });
    } else if (this.providerControlDegraded) {
      this.sendControlDegradedState();
    } else if (this.providerMediaState !== 'connected') {
      this.providerMediaUnavailableReported = true;
      this.sendWatchJSON({
        type: 'transport.interrupted',
        transport: 'provider-webrtc-media',
        media: 'connecting',
        control: 'active',
        message: 'GPT Live retained provider media is still connecting. End and restart if it does not resume.',
      });
    } else {
      this.providerMediaUnavailableReported = false;
      this.sendWatchJSON({
        type: 'transport.resumed',
        transport: 'provider-webrtc',
        media: this.currentProviderMediaStatus(),
        control: 'active',
      });
    }
  }

  currentProviderMediaStatus() {
    if (this.providerMediaInterrupted) return 'interrupted';
    return this.providerMediaState === 'connected' ? 'active' : 'connecting';
  }

  fail(error) {
    if (this.closed) return;
    const normalized = asError(error);
    this.logger.warn?.(`[gpt-live-watch-relay] ${normalized.message}`);
    if (this.ws) closeWithError(this.ws, 'GPT_LIVE_COMPANION_RELAY_FAILED', normalized.message);
    this.close('relay-error');
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.detachTTL);
    this.detachedAt = null;
    this.abortController.abort(new Error(`GPT Live Watch relay closed: ${reason}`));
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.pendingControls = [];
    this.peer?.close();
    this.peer = null;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      try { this.ws.close(1000, String(reason).slice(0, 123)); } catch { this.ws.terminate(); }
    }
    this.ws = null;
    this.onClosed(this, reason);
  }
}

export class GPTLiveWatchRelaySessionRegistry {
  constructor({
    detachedRetentionMS = DETACHED_SESSION_RETENTION_MS,
    logger = console,
  } = {}) {
    this.detachedRetentionMS = detachedRetentionMS;
    this.logger = logger;
    this.sessions = new Map();
    this.activeSessionKeyByClient = new Map();
    this.expiredSessionKeys = new Map();
  }

  attach(options) {
    this.pruneExpiredTombstones();
    const clientIdentity = String(options.clientIdentity || '').trim();
    const requestedRelaySessionID = relaySessionIDFromRequest(options.req);
    if (!clientIdentity) {
      closeWithError(
        options.ws,
        'WATCH_LIVE_RELAY_IDENTITY_REQUIRED',
        'GPT Live Watch relay requires an authenticated client identity.',
      );
      return null;
    }
    const relaySessionID = requestedRelaySessionID || `legacy-${randomUUID().toLowerCase()}`;
    if (!requestedRelaySessionID) {
      this.logger.warn?.(
        '[gpt-live-watch-relay] Watch client did not provide a stable relay-session identity; using one-connection compatibility mode.',
      );
    }

    const key = `${clientIdentity}:${relaySessionID}`;
    if (this.expiredSessionKeys.has(key)) {
      closeWithError(
        options.ws,
        'WATCH_LIVE_RELAY_SESSION_EXPIRED',
        'The retained GPT Live Watch session expired. Restart the session from the Watch.',
      );
      return null;
    }

    const retained = this.sessions.get(key);
    if (retained && !retained.closed) {
      retained.attachSocket(options.ws, options.req);
      return retained;
    }

    const previousKey = this.activeSessionKeyByClient.get(clientIdentity);
    if (previousKey && previousKey !== key) {
      this.sessions.get(previousKey)?.close('superseded-by-new-watch-session');
    }

    const session = new GPTLiveWatchRelaySession({
      ...options,
      clientIdentity,
      relaySessionID,
      detachedRetentionMS: options.detachedRetentionMS ?? this.detachedRetentionMS,
      onClosed: (closedSession, reason) => this.sessionClosed(key, closedSession, reason),
    });
    this.sessions.set(key, session);
    this.activeSessionKeyByClient.set(clientIdentity, key);
    session.attach();
    return session;
  }

  sessionClosed(key, session, reason) {
    if (this.sessions.get(key) === session) this.sessions.delete(key);
    if (this.activeSessionKeyByClient.get(session.clientIdentity) === key) {
      this.activeSessionKeyByClient.delete(session.clientIdentity);
    }
    if (reason === 'watch-detached-expired') {
      this.expiredSessionKeys.set(key, Date.now() + EXPIRED_RELAY_ID_TOMBSTONE_MS);
    }
  }

  pruneExpiredTombstones(now = Date.now()) {
    for (const [key, expiresAt] of this.expiredSessionKeys) {
      if (expiresAt <= now) this.expiredSessionKeys.delete(key);
    }
  }

  status({ clientIdentity, relaySessionID, now = Date.now() } = {}) {
    this.pruneExpiredTombstones(now);
    const normalizedClientIdentity = String(clientIdentity || '').trim();
    const normalizedRelaySessionID = String(relaySessionID || '').trim();
    if (!normalizedClientIdentity || !normalizedRelaySessionID) {
      return { state: 'missing' };
    }
    const key = `${normalizedClientIdentity}:${normalizedRelaySessionID}`;
    if (this.expiredSessionKeys.has(key)) {
      return { state: 'expired', id: normalizedRelaySessionID };
    }
    const session = this.sessions.get(key);
    if (!session || session.closed) {
      return { state: 'missing', id: normalizedRelaySessionID };
    }
    return session.statusSnapshot(now);
  }

  closeAll(reason = 'registry-close') {
    for (const session of [...this.sessions.values()]) session.close(reason);
    this.sessions.clear();
    this.activeSessionKeyByClient.clear();
  }
}

export function attachGPTLiveWatchRelaySocket(options) {
  if (options.registry) return options.registry.attach(options);
  const session = new GPTLiveWatchRelaySession(options);
  session.attach();
  return session;
}
