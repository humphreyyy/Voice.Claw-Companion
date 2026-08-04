const DEFAULT_INPUT_SAMPLE_RATE = 48_000;
const DEFAULT_INPUT_CHANNELS = 1;
const MAX_PENDING_AUDIO_SECONDS = 0.2;
const MAX_PENDING_CONTROL_FRAMES = 32;
const AUDIO_DIAGNOSTIC_INTERVAL_MS = 1_000;

function asError(error) {
  if (error instanceof Error) return error;
  if (error?.error instanceof Error) return error.error;
  return new Error(String(error?.message || error || 'Unknown WebRTC error'));
}

function pcmBufferToInt16(pcm) {
  const source = Buffer.from(pcm);
  const samples = new Int16Array(Math.floor(source.length / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = source.readInt16LE(index * 2);
  }
  return samples;
}

export function pcmSamplesToBuffer(pcm) {
  const samples = pcm instanceof Int16Array ? pcm : pcmBufferToInt16(pcm);
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

// Retained as no-resampling compatibility helpers for focused relay tests and
// older callers. Both preserve the supplied PCM sample cadence exactly.
export function watchPcmToProviderPcm(pcm) {
  return pcmBufferToInt16(pcm);
}

export function providerPcmToWatchPcm(pcm) {
  return pcmSamplesToBuffer(pcm);
}

export class WatchAudioPacketCoalescer {
  constructor({ onPacket, targetBytes = 1_920, partialFlushMS = 12 }) {
    this.onPacket = onPacket;
    this.targetBytes = targetBytes;
    this.partialFlushMS = partialFlushMS;
    this.pending = Buffer.alloc(0);
    this.flushTimer = undefined;
    this.closed = false;
  }

  push(audio) {
    if (this.closed || !audio?.length) return;
    this.pending = this.pending.length
      ? Buffer.concat([this.pending, Buffer.from(audio)])
      : Buffer.from(audio);
    while (this.pending.length >= this.targetBytes) {
      this.onPacket(Buffer.from(this.pending.subarray(0, this.targetBytes)));
      this.pending = this.pending.subarray(this.targetBytes);
    }
    if (this.pending.length && !this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        if (this.closed || !this.pending.length) return;
        const remainder = this.pending;
        this.pending = Buffer.alloc(0);
        this.onPacket(Buffer.from(remainder));
      }, this.partialFlushMS);
      this.flushTimer.unref?.();
    }
  }

  close() {
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pending = Buffer.alloc(0);
  }
}

function controlMessageText(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  return String(data ?? '');
}

export class GPTLiveWatchNativePeer {
  static async create({ callbacks, signal }) {
    const imported = await import('@roamhq/wrtc');
    signal?.throwIfAborted();
    const wrtc = imported.default || imported;
    const audioSource = new wrtc.nonstandard.RTCAudioSource();
    const audioTrack = audioSource.createTrack();
    const peer = new wrtc.RTCPeerConnection();
    peer.addTrack(audioTrack);
    const dataChannel = peer.createDataChannel('oai-events', { ordered: true });
    return new GPTLiveWatchNativePeer({
      audioSource,
      audioTrack,
      callbacks,
      dataChannel,
      peer,
      RTCAudioSink: wrtc.nonstandard.RTCAudioSink,
    });
  }

  constructor(state) {
    this.state = state;
    this.connected = false;
    this.hasConnected = false;
    this.closed = false;
    this.controlOpen = false;
    this.controlWasOpen = false;
    this.pendingAudio = Buffer.alloc(0);
    this.pendingAudioSegments = [];
    this.inputSampleRate = DEFAULT_INPUT_SAMPLE_RATE;
    this.inputChannelCount = DEFAULT_INPUT_CHANNELS;
    this.audioQueueHighWaterBytes = 0;
    this.audioQueueHighWaterSeconds = 0;
    this.audioQueueMaxAgeMS = 0;
    this.audioQueueDroppedBytes = 0;
    this.audioQueueDroppedSeconds = 0;
    this.lastAudioDiagnosticAt = 0;
    this.pendingControls = [];
    this.controlQueueHighWater = 0;
    this.droppedControls = 0;
    this.audioSinks = new Map();

    state.peer.ontrack = (event) => this.attachInboundTrack(event.track);
    state.peer.onconnectionstatechange = () => {
      if (this.closed) return;
      const connectionState = state.peer.connectionState;
      if (connectionState === 'connected') {
        this.connected = true;
        this.hasConnected = true;
        this.flushPendingAudio();
        state.callbacks.onConnectionState?.(connectionState);
      } else if (['failed', 'disconnected', 'closed'].includes(connectionState)) {
        this.connected = false;
        this.pendingAudio = Buffer.alloc(0);
        this.pendingAudioSegments = [];
        state.callbacks.onConnectionState?.(connectionState);
      }
    };
    state.dataChannel.onopen = () => this.handleControlState('open');
    state.dataChannel.onclose = () => this.handleControlState('closed');
    state.dataChannel.onmessage = (event) => {
      if (!this.closed) state.callbacks.onControl(controlMessageText(event.data));
    };
    state.dataChannel.onerror = (event) => this.reportControlError(event);
  }

  async createOffer() {
    const offer = await this.state.peer.createOffer();
    await this.state.peer.setLocalDescription(offer);
    const sdp = this.state.peer.localDescription?.sdp;
    if (!sdp?.trim()) throw new Error('libwebrtc did not produce a GPT Live relay SDP offer');
    return sdp;
  }

  async applyAnswer(answerSdp) {
    await this.state.peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  }

  sendAudio(audio, { sampleRate = DEFAULT_INPUT_SAMPLE_RATE, channelCount = 1 } = {}) {
    if (this.closed || audio.length < 2) return;
    if (!this.connected && this.hasConnected) return;
    const normalizedRate = Math.max(8_000, Math.round(Number(sampleRate) || DEFAULT_INPUT_SAMPLE_RATE));
    const normalizedChannels = Math.max(1, Math.round(Number(channelCount) || 1));
    if (normalizedChannels !== 1) {
      this.reportMediaError(new Error(`Watch relay input must be mono PCM16; received ${normalizedChannels} channels`));
      return;
    }
    if (this.pendingAudio.length && normalizedRate !== this.inputSampleRate) {
      this.audioQueueDroppedBytes += this.pendingAudio.length;
      this.audioQueueDroppedSeconds += this.pendingAudio.length / (this.inputSampleRate * 2);
      this.pendingAudio = Buffer.alloc(0);
      this.pendingAudioSegments = [];
    }
    this.inputSampleRate = normalizedRate;
    this.inputChannelCount = normalizedChannels;
    const evenAudio = Buffer.from(audio).subarray(0, audio.length - (audio.length % 2));
    if (this.connected) {
      this.deliverAudioPacket(evenAudio);
      return;
    }
    const enqueuedAt = Date.now();
    this.pendingAudio = this.pendingAudio.length
      ? Buffer.concat([this.pendingAudio, evenAudio])
      : Buffer.from(evenAudio);
    this.pendingAudioSegments.push({ bytes: evenAudio.length, enqueuedAt });
    const maxBytes = Math.floor(this.inputSampleRate * 2 * MAX_PENDING_AUDIO_SECONDS);
    if (this.pendingAudio.length > maxBytes) {
      const droppedBytes = this.pendingAudio.length - maxBytes;
      this.pendingAudio = this.pendingAudio.subarray(this.pendingAudio.length - maxBytes);
      this.audioQueueDroppedBytes += droppedBytes;
      this.audioQueueDroppedSeconds += droppedBytes / (this.inputSampleRate * 2);
      this.consumeAudioSegmentMetadata(droppedBytes);
    }
    this.noteAudioQueueDiagnostics();
  }

  sendControl(payload) {
    if (this.closed || !String(payload || '').trim()) return;
    if (this.controlOpen && this.state.dataChannel.readyState === 'open') {
      this.state.dataChannel.send(payload);
      return;
    }
    if (this.controlWasOpen) return;
    if (this.pendingControls.length >= MAX_PENDING_CONTROL_FRAMES) {
      this.pendingControls.shift();
      this.droppedControls += 1;
    }
    this.pendingControls.push(payload);
    this.controlQueueHighWater = Math.max(this.controlQueueHighWater, this.pendingControls.length);
    this.state.callbacks.onQueueDiagnostics?.({
      lane: 'control',
      currentCount: this.pendingControls.length,
      highWaterCount: this.controlQueueHighWater,
      droppedCount: this.droppedControls,
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.pendingAudio = Buffer.alloc(0);
    this.pendingAudioSegments = [];
    this.pendingControls = [];
    for (const sink of this.audioSinks.values()) {
      try { sink.stop(); } catch {}
    }
    this.audioSinks.clear();
    try { this.state.dataChannel.close(); } catch {}
    try { this.state.audioTrack.stop(); } catch {}
    try { this.state.peer.close(); } catch {}
  }

  handleControlState(channelState) {
    if (this.closed) return;
    this.controlOpen = channelState === 'open';
    if (this.controlOpen) {
      this.controlWasOpen = true;
      for (const payload of this.pendingControls.splice(0)) this.state.dataChannel.send(payload);
      this.state.callbacks.onControlReady?.();
    } else if (channelState === 'closed') {
      this.pendingControls = [];
    }
    this.state.callbacks.onControlState?.(channelState);
  }

  attachInboundTrack(track) {
    if (this.closed || track?.kind !== 'audio' || this.audioSinks.has(track.id)) return;
    const sink = new this.state.RTCAudioSink(track);
    this.audioSinks.set(track.id, sink);
    sink.ondata = (audioData) => {
      if (this.closed) return;
      try {
        const audio = pcmSamplesToBuffer(audioData.samples);
        if (audio.length) this.state.callbacks.onAudio({
          audio,
          sampleRate: Number(audioData.sampleRate) || DEFAULT_INPUT_SAMPLE_RATE,
          channelCount: Number(audioData.channelCount) || 1,
        });
      } catch (error) {
        this.reportMediaError(error);
      }
    };
  }

  flushPendingAudio() {
    if (!this.connected || this.closed || !this.pendingAudio.length) return;
    const pending = this.pendingAudio;
    const pendingSegments = this.pendingAudioSegments.map((segment) => ({ ...segment }));
    this.pendingAudio = Buffer.alloc(0);
    this.pendingAudioSegments = [];
    this.deliverAudioPacket(pending, { segments: pendingSegments });
    this.noteAudioQueueDiagnostics(true);
  }

  deliverAudioPacket(audio, { enqueuedAt = Date.now(), segments = null } = {}) {
    if (!this.connected || this.closed || !audio.length) return;
    const frameSamples = Math.max(1, Math.round(this.inputSampleRate / 100));
    const frameBytes = frameSamples * this.inputChannelCount * 2;
    this.pendingAudio = this.pendingAudio.length
      ? Buffer.concat([this.pendingAudio, audio])
      : Buffer.from(audio);
    if (Array.isArray(segments) && segments.length) {
      this.pendingAudioSegments.push(...segments.map((segment) => ({ ...segment })));
    } else {
      this.pendingAudioSegments.push({ bytes: audio.length, enqueuedAt });
    }
    while (this.pendingAudio.length >= frameBytes) {
      const frame = this.pendingAudio.subarray(0, frameBytes);
      this.pendingAudio = this.pendingAudio.subarray(frameBytes);
      this.consumeAudioSegmentMetadata(frameBytes);
      try {
        const samples = pcmBufferToInt16(frame);
        this.state.audioSource.onData({
          samples,
          sampleRate: this.inputSampleRate,
          bitsPerSample: 16,
          channelCount: this.inputChannelCount,
          numberOfFrames: frameSamples,
        });
      } catch (error) {
        this.reportMediaError(error);
        break;
      }
    }
    this.noteAudioQueueDiagnostics();
  }

  noteAudioQueueDiagnostics(force = false) {
    const now = Date.now();
    const bytesPerSecond = this.inputSampleRate * this.inputChannelCount * 2;
    const durationSeconds = this.pendingAudio.length / bytesPerSecond;
    const oldestEnqueuedAt = this.pendingAudioSegments[0]?.enqueuedAt;
    const ageMS = oldestEnqueuedAt ? Math.max(0, now - oldestEnqueuedAt) : 0;
    this.audioQueueHighWaterBytes = Math.max(this.audioQueueHighWaterBytes, this.pendingAudio.length);
    this.audioQueueHighWaterSeconds = Math.max(this.audioQueueHighWaterSeconds, durationSeconds);
    this.audioQueueMaxAgeMS = Math.max(this.audioQueueMaxAgeMS, ageMS);
    if (!force && now - this.lastAudioDiagnosticAt < AUDIO_DIAGNOSTIC_INTERVAL_MS) return;
    this.lastAudioDiagnosticAt = now;
    this.state.callbacks.onQueueDiagnostics?.({
      lane: 'audio',
      sampleRate: this.inputSampleRate,
      channelCount: this.inputChannelCount,
      currentBytes: this.pendingAudio.length,
      currentDurationSeconds: durationSeconds,
      oldestAgeMS: ageMS,
      highWaterBytes: this.audioQueueHighWaterBytes,
      highWaterDurationSeconds: this.audioQueueHighWaterSeconds,
      maxQueueAgeMS: this.audioQueueMaxAgeMS,
      droppedBytes: this.audioQueueDroppedBytes,
      droppedDurationSeconds: this.audioQueueDroppedSeconds,
    });
  }

  consumeAudioSegmentMetadata(consumedBytes) {
    let remaining = Math.max(0, consumedBytes);
    while (remaining > 0 && this.pendingAudioSegments.length) {
      const segment = this.pendingAudioSegments[0];
      if (remaining < segment.bytes) {
        segment.bytes -= remaining;
        return;
      }
      remaining -= segment.bytes;
      this.pendingAudioSegments.shift();
    }
  }

  reportControlError(error) {
    const normalized = asError(error);
    if (this.state.callbacks.onControlError) this.state.callbacks.onControlError(normalized);
    else this.state.callbacks.onError?.(normalized);
  }

  reportMediaError(error) {
    const normalized = asError(error);
    if (this.state.callbacks.onMediaError) this.state.callbacks.onMediaError(normalized);
    else this.state.callbacks.onError?.(normalized);
  }
}
