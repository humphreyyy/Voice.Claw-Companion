import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { executablePath } from './bin-paths.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_REALTIME_TIMEOUT_MS = 30_000;
const DEFAULT_STATE_PATH = join(homedir(), '.voiceclaw', 'codex-app-server-sessions.json');
const DEFAULT_WORKSPACE_PATH = join(homedir(), '.voiceclaw', 'codex-workspace');
const REALTIME_FEATURE_NAME = 'realtime_conversation';
const SESSION_SCHEMA_VERSION = 1;
const MAX_STDERR_CHARS = 16_384;
const CODEX_REALTIME_RELAY_MAX_INPUT_BYTES = 1_000_000;
const CODEX_REALTIME_RELAY_MAX_BUFFERED_OUTPUT_BYTES = 8_000_000;

const VOICECLAW_CODEX_DEVELOPER_INSTRUCTIONS = `You are the Codex reasoning layer used by VoiceClaw Realtime.
Respond with concise plain text suitable for speech unless the user explicitly asks for detail.
Do not claim that an iPhone, Mac, OpenClaw, or Hermes action happened unless a tool result explicitly confirms it.
Do not expose hidden reasoning. Preserve concrete results, warnings, and next steps when they matter.`;

function boundedTimeout(value, fallback, minimum = 100, maximum = 30 * 60_000) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(numeric)));
}

function safeModel(value = '') {
  const model = String(value || '').trim();
  if (!model) return '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model)) {
    throw new Error('Codex model contains unsupported characters.');
  }
  return model;
}

function safeVoice(value = '') {
  const voice = String(value || '').trim().toLowerCase();
  if (!voice) return '';
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(voice)) {
    throw new Error('Codex realtime voice contains unsupported characters.');
  }
  return voice;
}

function safeRealtimeVersion(value = '', fallback = 'v3') {
  const version = String(value || '').trim().toLowerCase();
  return ['v1', 'v2', 'v3'].includes(version) ? version : fallback;
}

function safeReasoningEffort(value = '') {
  const effort = String(value || '').trim().toLowerCase();
  if (!effort) return '';
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra'].includes(effort)) {
    throw new Error(`Unsupported Codex reasoning effort: ${effort}`);
  }
  return effort;
}

function safeSessionKey(value = '') {
  const key = String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (key || 'voiceclaw-codex-default').slice(0, 160);
}

function errorFromRPC(error, method = '') {
  const message = String(error?.message || `Codex app-server request failed: ${method}`);
  const result = new Error(message);
  result.name = 'CodexAppServerRPCError';
  result.code = error?.code;
  result.data = error?.data;
  result.method = method;
  return result;
}

function turnFailure(turn = {}) {
  const message = turn?.error?.message || `Codex turn ${turn?.status || 'failed'}.`;
  const error = new Error(message);
  error.name = 'CodexTurnError';
  error.code = turn?.error?.codexErrorInfo || 'CODEX_TURN_FAILED';
  error.turn = turn;
  return error;
}

function absoluteWorkspacePath(value = '') {
  const requested = String(value || '').trim() || DEFAULT_WORKSPACE_PATH;
  return isAbsolute(requested) ? requested : resolve(requested);
}

function publicAccount(accountResult = {}) {
  const account = accountResult?.account;
  if (!account || typeof account !== 'object') {
    return {
      signedIn: false,
      type: null,
      planType: null,
      requiresOpenaiAuth: accountResult?.requiresOpenaiAuth !== false,
    };
  }
  return {
    signedIn: true,
    type: String(account.type || ''),
    planType: account.planType ? String(account.planType) : null,
    requiresOpenaiAuth: accountResult?.requiresOpenaiAuth !== false,
  };
}

function newTurnTracker(threadID, turnID) {
  return {
    threadID,
    turnID,
    status: 'inProgress',
    error: null,
    messageOrder: [],
    messages: new Map(),
    waiters: new Set(),
    completedAt: 0,
  };
}

function trackerText(tracker) {
  return tracker.messageOrder
    .map((itemID) => String(tracker.messages.get(itemID) || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

export class CodexAppServerClient {
  constructor({
    codexPath = process.env.VOICECLAW_CODEX_BIN || executablePath('codex'),
    spawnProcess = spawn,
    clientVersion = process.env.VOICECLAW_COMPANION_VERSION || 'dev',
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    realtimeTimeoutMs = DEFAULT_REALTIME_TIMEOUT_MS,
    environment = process.env,
  } = {}) {
    this.codexPath = codexPath;
    this.spawnProcess = spawnProcess;
    this.clientVersion = String(clientVersion || 'dev');
    this.requestTimeoutMs = boundedTimeout(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.turnTimeoutMs = boundedTimeout(turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS);
    this.realtimeTimeoutMs = boundedTimeout(realtimeTimeoutMs, DEFAULT_REALTIME_TIMEOUT_MS);
    this.environment = environment;
    this.child = null;
    this.stdoutLines = null;
    this.startPromise = null;
    this.ready = false;
    this.generation = 0;
    this.nextRequestID = 1;
    this.pending = new Map();
    this.notificationListeners = new Set();
    this.turnTrackers = new Map();
    this.stderrTail = '';
    this.initializeResult = null;
    this.lastExit = null;
    this.lastRealtimeProbes = new Map();
  }

  async start() {
    if (this.ready && this.child) return this.initializeResult;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#startProcess();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #startProcess() {
    this.stop('restart');
    this.stderrTail = '';
    this.lastExit = null;
    const child = this.spawnProcess(this.codexPath, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...this.environment },
    });
    this.child = child;
    this.generation += 1;

    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${String(chunk || '')}`.slice(-MAX_STDERR_CHARS);
    });

    this.stdoutLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.stdoutLines.on('line', (line) => this.#handleLine(line));
    child.once('error', (error) => this.#handleExit(null, null, error));
    child.once('exit', (code, signal) => this.#handleExit(code, signal));

    const initialized = await this.request('initialize', {
      clientInfo: {
        name: 'voiceclaw_companion',
        title: 'VoiceClaw Companion',
        version: this.clientVersion,
      },
      capabilities: {
        experimentalApi: true,
      },
    }, { skipStart: true, timeoutMs: this.requestTimeoutMs });
    this.notify('initialized', {});
    this.initializeResult = initialized;
    this.ready = true;
    return initialized;
  }

  stop(reason = 'stopped') {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.initializeResult = null;
    this.stdoutLines?.close?.();
    this.stdoutLines = null;
    const error = new Error(`Codex app-server ${reason}.`);
    error.code = 'CODEX_APP_SERVER_STOPPED';
    this.#rejectPending(error);
    if (child && !child.killed) {
      try { child.kill('SIGTERM'); } catch {}
    }
  }

  async request(method, params = {}, { timeoutMs = this.requestTimeoutMs, skipStart = false } = {}) {
    if (!skipStart) await this.start();
    const child = this.child;
    if (!child?.stdin?.writable) throw new Error('Codex app-server stdin is unavailable.');
    const id = this.nextRequestID++;
    const timeout = boundedTimeout(timeoutMs, this.requestTimeoutMs);
    return await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex app-server request timed out: ${method}`);
        error.code = 'CODEX_APP_SERVER_TIMEOUT';
        error.method = method;
        rejectPromise(error);
      }, timeout);
      timer.unref?.();
      this.pending.set(id, {
        method,
        resolve: (result) => {
          clearTimeout(timer);
          resolvePromise(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
      });
      try {
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        rejectPromise(error);
      }
    });
  }

  notify(method, params = {}) {
    const child = this.child;
    if (!child?.stdin?.writable) throw new Error('Codex app-server stdin is unavailable.');
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  onNotification(listener) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async status({ refreshToken = false } = {}) {
    await this.start();
    const [accountResult, featureResult] = await Promise.all([
      this.request('account/read', { refreshToken: refreshToken === true }),
      this.request('experimentalFeature/list', { limit: 100 }),
    ]);
    const features = Array.isArray(featureResult?.data) ? featureResult.data : [];
    const realtimeFeature = features.find((feature) => feature?.name === REALTIME_FEATURE_NAME) || null;
    const webSocketProbe = this.lastRealtimeProbes.get('websocket') || null;
    const webRTCProbe = this.lastRealtimeProbes.get('webrtc') || null;
    const protocolProbes = [...this.lastRealtimeProbes.entries()]
      .filter(([key]) => key.includes(':'))
      .map(([, probe]) => probe);
    const probes = protocolProbes.length ? protocolProbes : [webSocketProbe, webRTCProbe].filter(Boolean);
    const verifiedTransport = probes.find((probe) => probe?.ok) || null;
    const verifiedV1 = probes.find((probe) => probe?.ok && probe?.version === 'v1') || null;
    const verifiedV3 = probes.find((probe) => probe?.ok && probe?.version === 'v3') || null;
    const verifiedV2 = probes.find((probe) => probe?.ok && probe?.version === 'v2') || null;
    return {
      state: 'ready',
      binary: this.codexPath,
      generation: this.generation,
      userAgent: this.initializeResult?.userAgent || '',
      platformFamily: this.initializeResult?.platformFamily || '',
      platformOs: this.initializeResult?.platformOs || '',
      account: publicAccount(accountResult),
      realtime: {
        method: 'thread/realtime/start',
        experimental: true,
        localFeaturePresent: !!realtimeFeature,
        localFeatureEnabled: realtimeFeature?.enabled === true,
        stage: realtimeFeature?.stage || null,
        backendAdmission: verifiedTransport
          ? 'verified'
          : (probes.length ? 'rejected' : 'unverified'),
        available: !!verifiedTransport,
        availablePaths: probes
          .filter((probe) => probe?.ok)
          .map((probe) => ({
            transport: probe.transport,
            version: probe.version,
            model: probe.model || null,
            voice: probe.voice || null,
            verifiedAt: probe.at,
          })),
        protocols: {
          v1: {
            name: 'Legacy Bidi',
            endpoint: '/v1/realtime',
            backendAdmission: verifiedV1 ? 'verified' : (probes.some((probe) => probe.version === 'v1') ? 'rejected' : 'unverified'),
          },
          v2: {
            name: 'Realtime Voice',
            endpoint: '/v1/realtime',
            backendAdmission: verifiedV2 ? 'verified' : (probes.some((probe) => probe.version === 'v2') ? 'rejected' : 'unverified'),
          },
          v3: {
            name: 'Frameless Bidi',
            endpoint: '/v1/live',
            backendAdmission: verifiedV3 ? 'verified' : (probes.some((probe) => probe.version === 'v3') ? 'rejected' : 'unverified'),
          },
        },
        transports: {
          websocket: {
            supportedByAppServer: true,
            mediaPath: 'thread/realtime/appendAudio and thread/realtime/outputAudio/delta',
            authPath: 'OpenAI API key in the current Codex core implementation',
            backendAdmission: webSocketProbe ? (webSocketProbe.ok ? 'verified' : 'rejected') : 'unverified',
            lastProbeAt: webSocketProbe?.at || null,
            lastError: webSocketProbe?.ok === false ? webSocketProbe.error : null,
            lastVersion: webSocketProbe?.version || null,
            lastModel: webSocketProbe?.model || null,
            lastVoice: webSocketProbe?.voice || null,
          },
          webrtc: {
            supportedByAppServer: true,
            mediaPath: 'client RTCPeerConnection plus Codex sideband',
            authPath: 'Codex app-server managed call creation',
            backendAdmission: webRTCProbe ? (webRTCProbe.ok ? 'verified' : 'rejected') : 'unverified',
            lastProbeAt: webRTCProbe?.at || null,
            lastError: webRTCProbe?.ok === false ? webRTCProbe.error : null,
            lastVersion: webRTCProbe?.version || null,
            lastModel: webRTCProbe?.model || null,
            lastVoice: webRTCProbe?.voice || null,
          },
        },
      },
    };
  }

  async startThread({
    model = '',
    cwd,
    developerInstructions = VOICECLAW_CODEX_DEVELOPER_INSTRUCTIONS,
  } = {}) {
    return await this.request('thread/start', {
      ...(safeModel(model) ? { model: safeModel(model) } : {}),
      cwd: absoluteWorkspacePath(cwd),
      approvalPolicy: 'never',
      sandbox: 'read-only',
      personality: 'pragmatic',
      serviceName: 'voiceclaw_companion',
      developerInstructions,
      ephemeral: false,
    });
  }

  async resumeThread(threadID) {
    const value = String(threadID || '').trim();
    if (!value) throw new Error('Codex thread id is required.');
    return await this.request('thread/resume', { threadId: value });
  }

  async runTextTurn({
    threadID,
    text,
    model = '',
    reasoningEffort = '',
    timeoutMs = this.turnTimeoutMs,
  } = {}) {
    const message = String(text || '').trim();
    if (!message) throw new Error('Codex turn text is required.');
    const response = await this.request('turn/start', {
      threadId: String(threadID || '').trim(),
      clientUserMessageId: randomUUID(),
      input: [{ type: 'text', text: message, text_elements: [] }],
      ...(safeModel(model) ? { model: safeModel(model) } : {}),
      ...(safeReasoningEffort(reasoningEffort) ? { effort: safeReasoningEffort(reasoningEffort) } : {}),
    }, { timeoutMs });
    const turnID = String(response?.turn?.id || '').trim();
    if (!turnID) throw new Error('Codex app-server did not return a turn id.');
    return await this.#waitForTurn(String(threadID || '').trim(), turnID, timeoutMs);
  }

  async startRealtimeWebRTC({
    threadID,
    sdp,
    model = '',
    version = 'v3',
    voice = '',
    outputModality = 'audio',
    timeoutMs = this.realtimeTimeoutMs,
  } = {}) {
    // SDP is a wire-format document. Preserve its CRLF terminator exactly; trimming it causes
    // the Realtime call endpoint to reject otherwise valid browser offers with invalid_offer/EOF.
    const offer = String(sdp || '');
    if (!offer.startsWith('v=0')) throw new Error('Codex realtime needs a valid WebRTC SDP offer.');
    if (offer.length > 2_000_000) throw new Error('Codex realtime SDP offer is too large.');
    const targetThreadID = String(threadID || '').trim();
    if (!targetThreadID) throw new Error('Codex realtime thread id is required.');
    const timeout = boundedTimeout(timeoutMs, this.realtimeTimeoutMs);
    const requestedVersion = safeRealtimeVersion(version);
    const requestedModel = safeModel(model);
    const requestedVoice = safeVoice(voice);
    const answerPromise = this.#waitForNotification(
      (message) => message?.method === 'thread/realtime/sdp'
        && message?.params?.threadId === targetThreadID,
      timeout,
      'Codex realtime did not return an SDP answer before timeout.',
      (message) => String(message?.params?.sdp || ''),
    );
    const errorPromise = this.#waitForNotification(
      (message) => message?.method === 'thread/realtime/error'
        && message?.params?.threadId === targetThreadID,
      timeout,
      'Codex realtime did not report a terminal result before timeout.',
      (message) => {
        throw new Error(String(message?.params?.message || 'Codex realtime failed.'));
      },
    );
    try {
      await this.request('thread/realtime/start', {
        threadId: targetThreadID,
        outputModality: outputModality === 'text' ? 'text' : 'audio',
        version: requestedVersion,
        ...(requestedModel ? { model: requestedModel } : {}),
        ...(requestedVoice ? { voice: requestedVoice } : {}),
        transport: { type: 'webrtc', sdp: offer },
      }, { timeoutMs: timeout });
      const answer = await Promise.race([answerPromise, errorPromise]);
      if (!answer.startsWith('v=0')) throw new Error('Codex realtime returned an invalid SDP answer.');
      this.#recordRealtimeProbe('webrtc', true, null, {
        version: requestedVersion,
        model: requestedModel,
        voice: requestedVoice,
      });
      return { threadID: targetThreadID, sdp: answer, version: requestedVersion, model: requestedModel || null, voice: requestedVoice || null, outputModality };
    } catch (error) {
      this.#recordRealtimeProbe('webrtc', false, error, {
        version: requestedVersion,
        model: requestedModel,
        voice: requestedVoice,
      });
      throw error;
    }
  }

  async startRealtimeWebSocket({
    threadID,
    model = '',
    version = 'v3',
    voice = '',
    outputModality = 'audio',
    timeoutMs = this.realtimeTimeoutMs,
  } = {}) {
    const targetThreadID = String(threadID || '').trim();
    if (!targetThreadID) throw new Error('Codex realtime thread id is required.');
    const timeout = boundedTimeout(timeoutMs, this.realtimeTimeoutMs);
    const requestedVersion = safeRealtimeVersion(version);
    const requestedModel = safeModel(model);
    const requestedVoice = safeVoice(voice);
    const startedPromise = this.#waitForNotification(
      (message) => message?.method === 'thread/realtime/started'
        && message?.params?.threadId === targetThreadID,
      timeout,
      'Codex realtime WebSocket did not report startup before timeout.',
      (message) => ({
        realtimeSessionID: message?.params?.realtimeSessionId || null,
        negotiatedVersion: message?.params?.version || version,
      }),
    );
    const errorPromise = this.#waitForNotification(
      (message) => message?.method === 'thread/realtime/error'
        && message?.params?.threadId === targetThreadID,
      timeout,
      'Codex realtime WebSocket did not report a terminal result before timeout.',
      (message) => {
        throw new Error(String(message?.params?.message || 'Codex realtime WebSocket failed.'));
      },
    );
    try {
      await this.request('thread/realtime/start', {
        threadId: targetThreadID,
        outputModality: outputModality === 'text' ? 'text' : 'audio',
        version: requestedVersion,
        ...(requestedModel ? { model: requestedModel } : {}),
        ...(requestedVoice ? { voice: requestedVoice } : {}),
        transport: { type: 'websocket' },
      }, { timeoutMs: timeout });
      const started = await Promise.race([startedPromise, errorPromise]);
      this.#recordRealtimeProbe('websocket', true, null, {
        version: started.negotiatedVersion || requestedVersion,
        model: requestedModel,
        voice: requestedVoice,
      });
      return {
        threadID: targetThreadID,
        transport: 'websocket',
        version: started.negotiatedVersion,
        model: requestedModel || null,
        voice: requestedVoice || null,
        outputModality,
        realtimeSessionID: started.realtimeSessionID,
      };
    } catch (error) {
      this.#recordRealtimeProbe('websocket', false, error, {
        version: requestedVersion,
        model: requestedModel,
        voice: requestedVoice,
      });
      throw error;
    }
  }

  async appendRealtimeAudio({ threadID, data, sampleRate, numChannels = 1, samplesPerChannel, itemID } = {}) {
    const targetThreadID = String(threadID || '').trim();
    const audioData = String(data || '').trim();
    if (!targetThreadID) throw new Error('Codex realtime thread id is required.');
    if (!audioData) throw new Error('Codex realtime audio data is required.');
    const rate = Number(sampleRate);
    const channels = Number(numChannels);
    if (!Number.isInteger(rate) || rate < 8_000 || rate > 192_000) throw new Error('Codex realtime sample rate is invalid.');
    if (!Number.isInteger(channels) || channels < 1 || channels > 8) throw new Error('Codex realtime channel count is invalid.');
    return await this.request('thread/realtime/appendAudio', {
      threadId: targetThreadID,
      audio: {
        data: audioData,
        sampleRate: rate,
        numChannels: channels,
        ...(Number.isInteger(Number(samplesPerChannel)) ? { samplesPerChannel: Number(samplesPerChannel) } : {}),
        ...(itemID ? { itemId: String(itemID) } : {}),
      },
    });
  }

  async appendRealtimeText({ threadID, text, role = 'user' } = {}) {
    const targetThreadID = String(threadID || '').trim();
    const value = String(text || '').trim();
    if (!targetThreadID || !value) throw new Error('Codex realtime thread id and text are required.');
    const normalizedRole = ['user', 'developer', 'assistant'].includes(role) ? role : 'user';
    return await this.request('thread/realtime/appendText', {
      threadId: targetThreadID,
      text: value,
      role: normalizedRole,
    });
  }

  async appendRealtimeSpeech({ threadID, text } = {}) {
    const targetThreadID = String(threadID || '').trim();
    const value = String(text || '').trim();
    if (!targetThreadID || !value) throw new Error('Codex realtime thread id and speech text are required.');
    return await this.request('thread/realtime/appendSpeech', { threadId: targetThreadID, text: value });
  }

  async stopRealtime(threadID) {
    const targetThreadID = String(threadID || '').trim();
    if (!targetThreadID) throw new Error('Codex realtime thread id is required.');
    return await this.request('thread/realtime/stop', { threadId: targetThreadID });
  }

  #recordRealtimeProbe(transport, ok, error = null, metadata = {}) {
    const probe = {
      transport,
      ok,
      at: new Date().toISOString(),
      error: ok ? '' : String(error?.message || error || 'Unknown realtime error.'),
      version: safeRealtimeVersion(metadata.version || '', ''),
      model: safeModel(metadata.model || ''),
      voice: safeVoice(metadata.voice || ''),
    };
    this.lastRealtimeProbes.set(transport, probe);
    if (probe.version) this.lastRealtimeProbes.set(`${transport}:${probe.version}`, probe);
  }

  #waitForNotification(predicate, timeoutMs, timeoutMessage, transform = (message) => message) {
    return new Promise((resolvePromise, rejectPromise) => {
      const unsubscribe = this.onNotification((message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        unsubscribe();
        try {
          resolvePromise(transform(message));
        } catch (error) {
          rejectPromise(error);
        }
      });
      const timer = setTimeout(() => {
        unsubscribe();
        const error = new Error(timeoutMessage);
        error.code = 'CODEX_REALTIME_TIMEOUT';
        rejectPromise(error);
      }, timeoutMs);
      timer.unref?.();
    });
  }

  #waitForTurn(threadID, turnID, timeoutMs) {
    const tracker = this.#turnTracker(threadID, turnID);
    if (tracker.completedAt) return this.#turnResult(tracker);
    const timeout = boundedTimeout(timeoutMs, this.turnTimeoutMs);
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = { resolve: resolvePromise, reject: rejectPromise, timer: null };
      waiter.timer = setTimeout(() => {
        tracker.waiters.delete(waiter);
        const error = new Error(`Codex turn timed out: ${turnID}`);
        error.code = 'CODEX_TURN_TIMEOUT';
        rejectPromise(error);
      }, timeout);
      waiter.timer.unref?.();
      tracker.waiters.add(waiter);
    });
  }

  #turnTracker(threadID, turnID) {
    let tracker = this.turnTrackers.get(turnID);
    if (!tracker) {
      tracker = newTurnTracker(threadID, turnID);
      this.turnTrackers.set(turnID, tracker);
    }
    return tracker;
  }

  #turnResult(tracker) {
    if (tracker.status !== 'completed') throw turnFailure(tracker.error || { status: tracker.status });
    return {
      threadID: tracker.threadID,
      turnID: tracker.turnID,
      status: tracker.status,
      text: trackerText(tracker),
    };
  }

  #handleLine(line) {
    const raw = String(line || '').trim();
    if (!raw) return;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      this.stderrTail = `${this.stderrTail}\n[non-json stdout] ${raw}`.slice(-MAX_STDERR_CHARS);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(errorFromRPC(message.error, pending.method));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      this.#rejectServerRequest(message);
      return;
    }
    if (message.method) this.#handleNotification(message);
  }

  #rejectServerRequest(message) {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify({
      id: message.id,
      error: {
        code: -32601,
        message: `VoiceClaw Companion does not handle server request ${message.method}.`,
      },
    })}\n`);
  }

  #handleNotification(message) {
    const params = message?.params || {};
    const turnID = String(params?.turnId || params?.turn?.id || '').trim();
    const threadID = String(params?.threadId || '').trim();
    if (turnID) {
      const tracker = this.#turnTracker(threadID, turnID);
      if (message.method === 'item/agentMessage/delta') {
        const itemID = String(params.itemId || 'agent-message');
        if (!tracker.messages.has(itemID)) tracker.messageOrder.push(itemID);
        tracker.messages.set(itemID, `${tracker.messages.get(itemID) || ''}${String(params.delta || '')}`);
      } else if (message.method === 'item/completed' && params?.item?.type === 'agentMessage') {
        const itemID = String(params.item.id || 'agent-message');
        if (!tracker.messages.has(itemID)) tracker.messageOrder.push(itemID);
        tracker.messages.set(itemID, String(params.item.text || ''));
      } else if (message.method === 'turn/completed') {
        tracker.status = String(params?.turn?.status || 'failed');
        tracker.error = params?.turn || { status: tracker.status };
        tracker.completedAt = Date.now();
        for (const waiter of tracker.waiters) {
          clearTimeout(waiter.timer);
          try {
            waiter.resolve(this.#turnResult(tracker));
          } catch (error) {
            waiter.reject(error);
          }
        }
        tracker.waiters.clear();
        const cleanup = setTimeout(() => this.turnTrackers.delete(turnID), 5 * 60_000);
        cleanup.unref?.();
      }
    }
    for (const listener of this.notificationListeners) {
      try { listener(message); } catch {}
    }
  }

  #handleExit(code, signal, cause = null) {
    if (!this.child) return;
    this.child = null;
    this.ready = false;
    this.initializeResult = null;
    this.lastExit = {
      code,
      signal: signal || null,
      at: new Date().toISOString(),
      error: cause?.message || '',
    };
    const suffix = this.stderrTail.trim() ? ` ${this.stderrTail.trim().slice(-2000)}` : '';
    const error = cause || new Error(`Codex app-server exited (code=${code ?? 'unknown'}, signal=${signal || 'none'}).${suffix}`);
    error.code = error.code || 'CODEX_APP_SERVER_EXITED';
    this.#rejectPending(error);
    for (const tracker of this.turnTrackers.values()) {
      for (const waiter of tracker.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      tracker.waiters.clear();
    }
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export class CodexAppServerBridge {
  constructor({
    client = new CodexAppServerClient(),
    statePath = process.env.VOICECLAW_CODEX_SESSION_STATE || DEFAULT_STATE_PATH,
    workspacePath = process.env.VOICECLAW_CODEX_CWD || DEFAULT_WORKSPACE_PATH,
  } = {}) {
    this.client = client;
    this.statePath = statePath;
    this.workspacePath = absoluteWorkspacePath(workspacePath);
    this.sessions = new Map();
    this.loadedGeneration = 0;
    this.sessionLocks = new Map();
    this.realtimeLease = null;
    this.loadPromise = this.#loadState();
    this.client.onNotification((message) => {
      if (message?.method === 'thread/realtime/closed'
          && message?.params?.threadId === this.realtimeLease?.threadID) {
        this.realtimeLease = null;
      }
    });
  }

  async status(options = {}) {
    await this.loadPromise;
    const status = await this.client.status(options);
    return {
      ...status,
      workspacePath: this.workspacePath,
      persistedSessionCount: this.sessions.size,
      supported: {
        account: 'account/read',
        textTurns: ['thread/start', 'thread/resume', 'turn/start'],
        realtime: 'thread/realtime/start (experimental; availability is verified independently by protocol and transport negotiation)',
      },
      realtimeLease: this.realtimeLease ? {
        sessionKey: this.realtimeLease.sessionKey,
        threadID: this.realtimeLease.threadID,
        ownerID: this.realtimeLease.ownerID,
        acquiredAt: this.realtimeLease.acquiredAt,
        touchedAt: this.realtimeLease.touchedAt,
      } : null,
    };
  }

  async runTurn({
    sessionKey = '',
    sessionMode = 'attach',
    text,
    model = '',
    reasoningEffort = '',
    timeoutMs,
  } = {}) {
    const key = safeSessionKey(sessionKey);
    return await this.#withSessionLock(key, async () => {
      const session = await this.#ensureSession({
        sessionKey: key,
        sessionMode,
        model,
      });
      const result = await this.client.runTextTurn({
        threadID: session.threadID,
        text,
        model,
        reasoningEffort,
        timeoutMs,
      });
      session.updatedAt = new Date().toISOString();
      await this.#saveState();
      return { ...result, sessionKey: key, model: safeModel(model) || null };
    });
  }

  async startRealtimeWebRTC({
    sessionKey = '',
    sessionMode = 'attach',
    sdp,
    model = '',
    version = 'v3',
    voice = '',
    outputModality = 'audio',
    timeoutMs,
  } = {}) {
    const key = safeSessionKey(sessionKey);
    return await this.#withSessionLock(key, async () => {
      const session = await this.#ensureSession({ sessionKey: key, sessionMode, model });
      const result = await this.client.startRealtimeWebRTC({
        threadID: session.threadID,
        sdp,
        model,
        version,
        voice,
        outputModality,
        timeoutMs,
      });
      return { ...result, sessionKey: key };
    });
  }

  async startRealtimeWebSocket({
    sessionKey = '',
    sessionMode = 'attach',
    model = '',
    version = 'v3',
    voice = '',
    outputModality = 'audio',
    timeoutMs,
    leaseOwnerID = '',
  } = {}) {
    const key = safeSessionKey(sessionKey);
    return await this.#withSessionLock(key, async () => {
      const session = await this.#ensureSession({ sessionKey: key, sessionMode, model });
      await this.#acquireRealtimeLease({
        sessionKey: key,
        threadID: session.threadID,
        ownerID: String(leaseOwnerID || randomUUID()),
      });
      const ownerID = this.realtimeLease?.ownerID || null;
      try {
        const result = await this.client.startRealtimeWebSocket({
          threadID: session.threadID,
          model,
          version,
          voice,
          outputModality,
          timeoutMs,
        });
        return { ...result, sessionKey: key, leaseOwnerID: ownerID };
      } catch (error) {
        // A rejected admission must not consume the single Codex realtime slot.
        if (ownerID && this.realtimeLease?.ownerID === ownerID) this.realtimeLease = null;
        throw error;
      }
    });
  }

  touchRealtimeLease(ownerID) {
    if (!this.realtimeLease || this.realtimeLease.ownerID !== ownerID) return false;
    this.realtimeLease.touchedAt = Date.now();
    return true;
  }

  async releaseRealtimeLease(ownerID, reason = 'relay stopped') {
    const lease = this.realtimeLease;
    if (!lease || (ownerID && lease.ownerID !== ownerID)) return false;
    try {
      await this.client.stopRealtime(lease.threadID);
    } finally {
      if (this.realtimeLease?.ownerID === lease.ownerID) this.realtimeLease = null;
    }
    return true;
  }

  onNotification(listener) {
    return this.client.onNotification(listener);
  }

  async appendRealtimeAudio(options = {}) {
    return await this.client.appendRealtimeAudio(options);
  }

  async appendRealtimeText(options = {}) {
    return await this.client.appendRealtimeText(options);
  }

  async appendRealtimeSpeech(options = {}) {
    return await this.client.appendRealtimeSpeech(options);
  }

  async stopRealtime(threadID) {
    const result = await this.client.stopRealtime(threadID);
    if (this.realtimeLease?.threadID === threadID) this.realtimeLease = null;
    return result;
  }

  stop() {
    this.realtimeLease = null;
    this.client.stop();
  }

  async #acquireRealtimeLease({ sessionKey, threadID, ownerID }) {
    const current = this.realtimeLease;
    if (current) {
      // Codex currently admits one realtime session. A new VoiceClaw start owns that
      // slot and replaces the prior lease so stale/disconnected clients cannot strand it.
      try { await this.client.stopRealtime(current.threadID); } catch {}
      if (this.realtimeLease?.ownerID === current.ownerID) this.realtimeLease = null;
    }
    this.realtimeLease = {
      sessionKey,
      threadID,
      ownerID,
      acquiredAt: Date.now(),
      touchedAt: Date.now(),
    };
  }

  async #ensureSession({ sessionKey, sessionMode, model }) {
    await this.loadPromise;
    await mkdir(this.workspacePath, { recursive: true });
    await this.client.start();
    if (this.loadedGeneration !== this.client.generation) {
      this.loadedGeneration = this.client.generation;
      for (const session of this.sessions.values()) session.loadedGeneration = 0;
    }
    const mode = String(sessionMode || 'attach').trim().toLowerCase();
    let session = this.sessions.get(sessionKey) || null;
    if (mode === 'new') session = null;
    if (session && session.loadedGeneration !== this.client.generation) {
      try {
        await this.client.resumeThread(session.threadID);
        session.loadedGeneration = this.client.generation;
        return session;
      } catch {
        session = null;
      }
    }
    if (session) return session;
    const started = await this.client.startThread({ model, cwd: this.workspacePath });
    const threadID = String(started?.thread?.id || '').trim();
    if (!threadID) throw new Error('Codex app-server did not return a thread id.');
    session = {
      sessionKey,
      threadID,
      model: safeModel(model) || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      loadedGeneration: this.client.generation,
    };
    this.sessions.set(sessionKey, session);
    await this.#saveState();
    return session;
  }

  async #withSessionLock(sessionKey, operation) {
    const previous = this.sessionLocks.get(sessionKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.sessionLocks.set(sessionKey, current);
    try {
      return await current;
    } finally {
      if (this.sessionLocks.get(sessionKey) === current) this.sessionLocks.delete(sessionKey);
    }
  }

  async #loadState() {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (parsed?.schemaVersion !== SESSION_SCHEMA_VERSION || !Array.isArray(parsed.sessions)) return;
      for (const session of parsed.sessions) {
        const sessionKey = safeSessionKey(session?.sessionKey);
        const threadID = String(session?.threadID || '').trim();
        if (!threadID) continue;
        this.sessions.set(sessionKey, {
          sessionKey,
          threadID,
          model: session?.model ? safeModel(session.model) : null,
          createdAt: session?.createdAt || null,
          updatedAt: session?.updatedAt || null,
          loadedGeneration: 0,
        });
      }
    } catch {}
  }

  async #saveState() {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      sessions: [...this.sessions.values()].map(({ loadedGeneration: _ignored, ...session }) => session),
    };
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.statePath);
  }
}

function relaySocketOpen(ws) {
  return ws?.readyState === 1;
}

function relayJSON(ws, payload) {
  if (!relaySocketOpen(ws)) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

function decodeRelayAudio(value) {
  const encoded = String(value || '').trim();
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('Codex realtime input_audio.data must be valid base64 PCM16 audio.');
  }
  const audio = Buffer.from(encoded, 'base64');
  if (!audio.length || audio.length > CODEX_REALTIME_RELAY_MAX_INPUT_BYTES) {
    throw new Error(`Codex realtime input audio must be between 1 and ${CODEX_REALTIME_RELAY_MAX_INPUT_BYTES} bytes.`);
  }
  return audio;
}

function relaySamplesPerChannel(audio, channels) {
  const frameBytes = 2 * channels;
  if (audio.length % frameBytes !== 0) {
    throw new Error('Codex realtime input audio must contain complete signed 16-bit PCM frames.');
  }
  return audio.length / frameBytes;
}

/**
 * Relays the verified Codex app-server V2 WebSocket media path to an authenticated
 * VoiceClaw client. V3 is deliberately not accepted here: its `/v1/live` backend
 * admission is a separate capability and must never be inferred from V2 success.
 */
export function attachCodexRealtimeRelaySocket({
  ws,
  bridge,
  defaultModel = 'gpt-realtime-2.1-mini',
  defaultVoice = 'marin',
} = {}) {
  if (!ws || !bridge) throw new Error('Codex realtime relay requires a socket and bridge.');

  let activeThreadID = '';
  let inputSampleRate = 24_000;
  let inputChannels = 1;
  let closed = false;
  const leaseOwnerID = randomUUID();
  let operationQueue = Promise.resolve();

  const sendError = (error, code = 'CODEX_REALTIME_RELAY_ERROR') => {
    relayJSON(ws, {
      type: 'error',
      code: String(error?.code || code),
      message: String(error?.message || error || 'Codex realtime relay failed.'),
    });
  };

  const appendAudio = async (audio) => {
    if (!activeThreadID) throw new Error('Start the Codex realtime relay before sending audio.');
    if (audio.length > CODEX_REALTIME_RELAY_MAX_INPUT_BYTES) {
      throw new Error(`Codex realtime input audio exceeds ${CODEX_REALTIME_RELAY_MAX_INPUT_BYTES} bytes.`);
    }
    await bridge.appendRealtimeAudio({
      threadID: activeThreadID,
      data: audio.toString('base64'),
      sampleRate: inputSampleRate,
      numChannels: inputChannels,
      samplesPerChannel: relaySamplesPerChannel(audio, inputChannels),
    });
    bridge.touchRealtimeLease(leaseOwnerID);
  };

  const unsubscribe = bridge.onNotification((message) => {
    const method = String(message?.method || '');
    const params = message?.params || {};
    if (!activeThreadID || params.threadId !== activeThreadID || !method.startsWith('thread/realtime/')) return;

    if (method === 'thread/realtime/outputAudio/delta') {
      const audio = params.audio || {};
      let decoded;
      try {
        decoded = decodeRelayAudio(audio.data);
      } catch (error) {
        sendError(error, 'CODEX_REALTIME_OUTPUT_AUDIO_INVALID');
        return;
      }
      const projectedBytes = Number(ws.bufferedAmount || 0) + decoded.length;
      if (projectedBytes > CODEX_REALTIME_RELAY_MAX_BUFFERED_OUTPUT_BYTES) {
        sendError(new Error('Codex realtime output exceeded the client backpressure limit.'), 'CODEX_REALTIME_OUTPUT_BACKPRESSURE');
        try { ws.close(1013, 'output backpressure'); } catch {}
        return;
      }
      relayJSON(ws, {
        type: 'output_audio',
        byteLength: decoded.length,
        sampleRate: Number(audio.sampleRate || 0),
        numChannels: Number(audio.numChannels || 0),
        samplesPerChannel: audio.samplesPerChannel ?? null,
        itemID: audio.itemId || null,
      });
      if (relaySocketOpen(ws)) ws.send(decoded, { binary: true });
      return;
    }

    relayJSON(ws, {
      type: 'codex_realtime_event',
      method,
      params,
    });
    if (method === 'thread/realtime/closed') activeThreadID = '';
  });

  const processControl = async (message) => {
    const type = String(message?.type || '').trim().toLowerCase();
    if (type === 'start') {
      if (activeThreadID) await bridge.stopRealtime(activeThreadID).catch(() => {});
      const requestedVersion = String(message.version || 'v2').trim().toLowerCase();
      if (requestedVersion !== 'v2') {
        const error = new Error('This relay exposes only verified Codex Realtime Voice V2. GPT Live V3 requires separate backend admission.');
        error.code = 'CODEX_REALTIME_VERSION_NOT_ADMITTED';
        throw error;
      }
      const format = message.inputAudio && typeof message.inputAudio === 'object' ? message.inputAudio : {};
      const encoding = String(format.encoding || 'pcm_s16le').trim().toLowerCase();
      inputSampleRate = Number(format.sampleRate || 24_000);
      inputChannels = Number(format.numChannels || 1);
      if (encoding !== 'pcm_s16le') throw new Error('Codex realtime relay input must use pcm_s16le.');
      if (!Number.isInteger(inputSampleRate) || inputSampleRate < 8_000 || inputSampleRate > 192_000) {
        throw new Error('Codex realtime relay input sample rate is invalid.');
      }
      if (!Number.isInteger(inputChannels) || inputChannels < 1 || inputChannels > 2) {
        throw new Error('Codex realtime relay input channel count is invalid.');
      }
      const result = await bridge.startRealtimeWebSocket({
        sessionKey: message.sessionKey || message.sessionToken || '',
        sessionMode: message.sessionMode || 'attach',
        version: 'v2',
        model: message.model || defaultModel,
        voice: message.voice || defaultVoice,
        outputModality: message.outputModality || 'audio',
        timeoutMs: message.timeoutMs,
        leaseOwnerID,
      });
      if (closed) {
        await bridge.stopRealtime(result.threadID).catch(() => {});
        return;
      }
      activeThreadID = result.threadID;
      relayJSON(ws, {
        type: 'started',
        protocol: 'v2',
        transport: 'codex-app-server-websocket',
        sessionKey: result.sessionKey,
        model: result.model,
        voice: result.voice,
        outputModality: result.outputModality,
        realtimeSessionID: result.realtimeSessionID,
        inputAudio: {
          encoding: 'pcm_s16le',
          sampleRate: inputSampleRate,
          numChannels: inputChannels,
        },
      });
      return;
    }
    if (type === 'input_audio') {
      bridge.touchRealtimeLease(leaseOwnerID);
      await appendAudio(decodeRelayAudio(message.data));
      return;
    }
    if (type === 'input_text') {
      if (!activeThreadID) throw new Error('Start the Codex realtime relay before sending text.');
      await bridge.appendRealtimeText({ threadID: activeThreadID, text: message.text, role: message.role || 'user' });
      bridge.touchRealtimeLease(leaseOwnerID);
      return;
    }
    if (type === 'input_speech') {
      if (!activeThreadID) throw new Error('Start the Codex realtime relay before sending speech.');
      await bridge.appendRealtimeSpeech({ threadID: activeThreadID, text: message.text });
      bridge.touchRealtimeLease(leaseOwnerID);
      return;
    }
    if (type === 'stop') {
      if (activeThreadID) await bridge.releaseRealtimeLease(leaseOwnerID, 'client stop');
      activeThreadID = '';
      relayJSON(ws, { type: 'stopped' });
      return;
    }
    if (type === 'ping') {
      relayJSON(ws, { type: 'pong' });
      return;
    }
    throw new Error(`Unsupported Codex realtime relay control: ${type || '(missing)'}`);
  };

  const onMessage = (data, isBinary) => {
    operationQueue = operationQueue
      .then(async () => {
        if (closed) return;
        if (isBinary) {
          const audio = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
          await appendAudio(audio);
          return;
        }
        let message;
        try {
          message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data || ''));
        } catch {
          throw new Error('Codex realtime relay controls must be valid JSON.');
        }
        await processControl(message);
      })
      .catch((error) => sendError(error));
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    ws.off?.('message', onMessage);
    unsubscribe?.();
    if (activeThreadID) {
      operationQueue = operationQueue
        .catch(() => {})
        .then(() => bridge.releaseRealtimeLease(leaseOwnerID, 'relay disconnected'))
        .catch(() => {});
    }
    activeThreadID = '';
  };

  ws.on('message', onMessage);
  ws.once?.('close', cleanup);
  ws.once?.('error', cleanup);
  relayJSON(ws, {
    type: 'ready',
    protocol: 'v2',
    transport: 'codex-app-server-websocket',
    defaultModel,
    defaultVoice,
  });

  return {
    close: cleanup,
    whenIdle: () => operationQueue,
  };
}

export const __codexAppServerTestHooks = Object.freeze({
  safeModel,
  safeReasoningEffort,
  safeSessionKey,
  trackerText,
  realtimeFeatureName: REALTIME_FEATURE_NAME,
});
