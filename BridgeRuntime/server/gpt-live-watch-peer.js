import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export {
  pcmSamplesToBuffer,
  providerPcmToWatchPcm,
  WatchAudioPacketCoalescer,
  watchPcmToProviderPcm,
} from './gpt-live-watch-native-peer.js';

const WORKER_PATH = fileURLToPath(new URL('./gpt-live-watch-native-worker.js', import.meta.url));
const STARTUP_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const CLOSE_GRACE_MS = 500;

function asError(value, fallback = 'Unknown GPT Live libwebrtc worker error') {
  if (value instanceof Error) return value;
  const error = new Error(String(value?.message || value || fallback));
  if (value?.stack) error.stack = value.stack;
  return error;
}

export class GPTLiveWatchPeer {
  static async create({ callbacks, signal }) {
    signal?.throwIfAborted();
    const child = fork(WORKER_PATH, [], {
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const peer = new GPTLiveWatchPeer({ callbacks, child });
    await peer.waitUntilReady(signal);
    return peer;
  }

  constructor({ callbacks, child }) {
    this.callbacks = callbacks;
    this.child = child;
    this.closed = false;
    this.ready = false;
    this.nextRequestID = 1;
    this.pendingRequests = new Map();
    this.readyWaiters = [];
    this.stderr = '';

    child.on('message', (message) => this.handleMessage(message));
    child.on('error', (error) => this.handleWorkerFailure(error));
    child.on('exit', (code, signal) => {
      if (this.closed) return;
      const detail = this.stderr.trim();
      const reason = signal
        ? `signal ${signal}`
        : `exit code ${code ?? 'unknown'}`;
      this.handleWorkerFailure(new Error(
        `GPT Live libwebrtc worker stopped unexpectedly (${reason})${detail ? `: ${detail}` : ''}`,
      ));
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_192);
    });
  }

  async waitUntilReady(signal) {
    if (this.ready) return;
    if (this.closed) throw new Error('GPT Live libwebrtc worker closed during startup');
    await new Promise((resolve, reject) => {
      let waiter;
      const removeWaiter = () => {
        const index = this.readyWaiters.indexOf(waiter);
        if (index >= 0) this.readyWaiters.splice(index, 1);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('GPT Live libwebrtc worker did not become ready in time'));
      }, STARTUP_TIMEOUT_MS);
      timeout.unref?.();
      const onAbort = () => {
        cleanup();
        reject(signal.reason || new Error('GPT Live libwebrtc worker startup was cancelled'));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        removeWaiter();
      };
      waiter = {
        resolve: () => { cleanup(); resolve(); },
        reject: (error) => { cleanup(); reject(error); },
      };
      this.readyWaiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  createOffer() {
    return this.request('createOffer');
  }

  applyAnswer(answerSdp) {
    return this.request('applyAnswer', { answerSdp });
  }

  sendAudio(audio, { sampleRate, channelCount } = {}) {
    this.send({ type: 'audio', audio: Buffer.from(audio), sampleRate, channelCount });
  }

  sendControl(payload) {
    this.send({ type: 'control', payload: String(payload) });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const closedError = new Error('GPT Live libwebrtc worker was closed');
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(closedError);
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(closedError);
    }
    this.pendingRequests.clear();
    if (this.child.connected) this.child.send({ type: 'close' }, () => {});
    const killTimer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    }, CLOSE_GRACE_MS);
    killTimer.unref?.();
  }

  request(command, payload = {}) {
    if (this.closed) return Promise.reject(new Error('GPT Live libwebrtc worker is closed'));
    const requestID = this.nextRequestID++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestID);
        reject(new Error(`GPT Live libwebrtc worker timed out during ${command}`));
      }, REQUEST_TIMEOUT_MS);
      timeout.unref?.();
      this.pendingRequests.set(requestID, { resolve, reject, timeout });
      this.send({ type: 'request', requestID, command, ...payload }, (error) => {
        const pending = this.pendingRequests.get(requestID);
        if (!pending) return;
        this.pendingRequests.delete(requestID);
        clearTimeout(pending.timeout);
        pending.reject(error);
      });
    });
  }

  send(message, onFailure) {
    if (this.closed || !this.child.connected) {
      onFailure?.(new Error('GPT Live libwebrtc worker is unavailable'));
      return;
    }
    this.child.send(message, (error) => {
      if (error) onFailure?.(error);
    });
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object' || this.closed) return;
    if (message.type === 'ready') {
      this.ready = true;
      for (const waiter of this.readyWaiters.splice(0)) waiter.resolve();
      return;
    }
    if (message.type === 'response') {
      const pending = this.pendingRequests.get(message.requestID);
      if (!pending) return;
      this.pendingRequests.delete(message.requestID);
      clearTimeout(pending.timeout);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(asError(message.error));
      return;
    }
    if (message.type !== 'event') return;
    if (message.event === 'audio') this.callbacks.onAudio({
      audio: Buffer.from(message.audio),
      sampleRate: message.sampleRate,
      channelCount: message.channelCount,
    });
    else if (message.event === 'control') this.callbacks.onControl(message.payload);
    else if (message.event === 'queueDiagnostics') {
      this.callbacks.onQueueDiagnostics?.(message.diagnostics);
    }
    else if (message.event === 'controlReady') this.callbacks.onControlReady?.();
    else if (message.event === 'connectionState') this.callbacks.onConnectionState?.(message.state);
    else if (message.event === 'controlState') this.callbacks.onControlState?.(message.state);
    else if (message.event === 'controlError') {
      const error = asError(message.error);
      if (this.callbacks.onControlError) this.callbacks.onControlError(error);
      else this.callbacks.onError?.(error);
    } else if (message.event === 'mediaError') {
      const error = asError(message.error);
      if (this.callbacks.onMediaError) this.callbacks.onMediaError(error);
      else this.callbacks.onError?.(error);
    }
    else if (message.event === 'error') this.callbacks.onError?.(asError(message.error));
  }

  handleWorkerFailure(error) {
    if (this.closed) return;
    this.closed = true;
    const normalized = asError(error);
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(normalized);
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(normalized);
    }
    this.pendingRequests.clear();
    this.callbacks.onError?.(normalized);
  }
}
