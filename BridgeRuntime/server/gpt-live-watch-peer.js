import { randomInt } from 'node:crypto';

const PROVIDER_SAMPLE_RATE = 48_000;
const WATCH_SAMPLE_RATE = 24_000;
const PROVIDER_CHANNELS = 2;
const OPUS_FRAME_SAMPLES = 960;
const WATCH_FRAME_SAMPLES = 480;
const WATCH_FRAME_BYTES = WATCH_FRAME_SAMPLES * 2;
const MAX_PENDING_WATCH_FRAMES = 250;
const MAX_PENDING_CONTROL_FRAMES = 32;
const INBOUND_REORDER_DEPTH = 4;
const INBOUND_MAX_LATE_PACKETS = 100;
const RTP_SEQUENCE_MODULUS = 0x1_0000;
const RTP_SEQUENCE_HALF_RANGE = RTP_SEQUENCE_MODULUS / 2;

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function pcmBufferToInt16(pcm) {
  const samples = new Int16Array(Math.floor(pcm.length / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = pcm.readInt16LE(index * 2);
  }
  return samples;
}

// GPT Live's WebRTC media track is 48 kHz stereo Opus. The Watch relay uses
// 24 kHz mono PCM16, so this exact 2:1 conversion avoids a native audio dependency.
export function watchPcmToProviderPcm(pcm24kMono) {
  const mono = pcmBufferToInt16(pcm24kMono);
  const stereo = new Int16Array(mono.length * 2 * PROVIDER_CHANNELS);
  for (let index = 0; index < mono.length; index += 1) {
    const current = mono[index] ?? 0;
    const next = mono[index + 1] ?? current;
    const midpoint = Math.round((current + next) / 2);
    const providerFrame = index * 2;
    stereo[providerFrame * 2] = current;
    stereo[providerFrame * 2 + 1] = current;
    stereo[(providerFrame + 1) * 2] = midpoint;
    stereo[(providerFrame + 1) * 2 + 1] = midpoint;
  }
  return stereo;
}

export function providerPcmToWatchPcm(pcm48kStereo) {
  const providerFrames = Math.floor(pcm48kStereo.length / PROVIDER_CHANNELS);
  const watchFrames = Math.floor(providerFrames / 2);
  const output = Buffer.alloc(watchFrames * 2);
  for (let index = 0; index < watchFrames; index += 1) {
    const first = index * 4;
    const second = first + 2;
    const firstMono = Math.round(((pcm48kStereo[first] ?? 0) + (pcm48kStereo[first + 1] ?? 0)) / 2);
    const secondMono = Math.round(((pcm48kStereo[second] ?? 0) + (pcm48kStereo[second + 1] ?? 0)) / 2);
    output.writeInt16LE(Math.round((firstMono + secondMono) / 2), index * 2);
  }
  return output;
}

function forwardSequenceDistance(expected, sequenceNumber) {
  return (sequenceNumber - expected + RTP_SEQUENCE_MODULUS) & 0xffff;
}

export class GPTLiveWatchPeer {
  static async create({ callbacks, signal }) {
    const [werift, libopus] = await Promise.all([import('werift'), import('libopus-wasm')]);
    signal?.throwIfAborted();
    const peer = new werift.RTCPeerConnection({
      codecs: {
        audio: [werift.useOPUS({ payloadType: 111 })],
        video: [],
      },
    });
    const transceiver = peer.addTransceiver('audio', { direction: 'sendrecv' });
    const dataChannel = peer.createDataChannel('oai-events', { ordered: true });
    let encoder;
    let decoder;
    try {
      encoder = await libopus.createEncoder({
        application: libopus.Application.Voip,
        channels: PROVIDER_CHANNELS,
        sampleRate: PROVIDER_SAMPLE_RATE,
        frameSize: OPUS_FRAME_SAMPLES,
      });
      decoder = await libopus.createDecoder({
        channels: PROVIDER_CHANNELS,
        sampleRate: PROVIDER_SAMPLE_RATE,
      });
      signal?.throwIfAborted();
      return new GPTLiveWatchPeer({
        callbacks,
        dataChannel,
        decoder,
        encoder,
        peer,
        transceiver,
        werift,
      });
    } catch (error) {
      encoder?.free();
      decoder?.free();
      await peer.close().catch(() => undefined);
      throw error;
    }
  }

  constructor(state) {
    this.state = state;
    this.connected = false;
    this.closed = false;
    this.controlOpen = false;
    this.activeInboundSsrc = undefined;
    this.inbound = { pendingPackets: new Map(), nextSequence: undefined, flushTimer: undefined };
    this.mediaTimer = undefined;
    this.pendingAudio = Buffer.alloc(0);
    this.pendingControls = [];
    this.sequenceNumber = randomInt(RTP_SEQUENCE_MODULUS);
    this.timestamp = randomInt(0x1_0000_0000);
    this.subscribedTracks = new Set();

    state.peer.onTrack.subscribe((track) => this.attachInboundTrack(track));
    state.peer.connectionStateChange.subscribe((connectionState) => {
      if (this.closed) return;
      if (connectionState === 'connected') {
        this.connected = true;
        this.startMediaPump();
      } else if (['failed', 'disconnected', 'closed'].includes(connectionState)) {
        this.connected = false;
        state.callbacks.onError(new Error(`GPT Live relay media connection ${connectionState}`));
      }
    });
    state.dataChannel.stateChange.subscribe((channelState) => {
      if (this.closed) return;
      this.controlOpen = channelState === 'open';
      if (this.controlOpen) {
        for (const payload of this.pendingControls.splice(0)) state.dataChannel.send(payload);
        state.callbacks.onControlReady?.();
      } else if (channelState === 'closed') {
        state.callbacks.onError(new Error('GPT Live relay control channel closed'));
      }
    });
    state.dataChannel.onMessage.subscribe((message) => {
      if (this.closed) return;
      state.callbacks.onControl(typeof message === 'string' ? message : message.toString('utf8'));
    });
    state.dataChannel.error.subscribe((error) => state.callbacks.onError(asError(error)));
  }

  async createOffer() {
    const offer = await this.state.peer.createOffer();
    await this.state.peer.setLocalDescription(offer);
    const sdp = this.state.peer.localDescription?.sdp;
    if (!sdp?.trim()) throw new Error('werift did not produce a GPT Live relay SDP offer');
    return sdp;
  }

  async applyAnswer(answerSdp) {
    await this.state.peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    this.attachInboundTrack(this.state.transceiver.receiver.track);
  }

  sendAudio(audio) {
    if (this.closed || audio.length < 2) return;
    const evenAudio = audio.subarray(0, audio.length - (audio.length % 2));
    this.pendingAudio = this.pendingAudio.length
      ? Buffer.concat([this.pendingAudio, evenAudio])
      : Buffer.from(evenAudio);
    const maxBytes = WATCH_FRAME_BYTES * MAX_PENDING_WATCH_FRAMES;
    if (this.pendingAudio.length > maxBytes) {
      this.pendingAudio = this.pendingAudio.subarray(this.pendingAudio.length - maxBytes);
    }
  }

  sendControl(payload) {
    if (this.closed || !String(payload || '').trim()) return;
    if (this.controlOpen && this.state.dataChannel.readyState === 'open') {
      this.state.dataChannel.send(payload);
      return;
    }
    if (this.pendingControls.length >= MAX_PENDING_CONTROL_FRAMES) this.pendingControls.shift();
    this.pendingControls.push(payload);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.mediaTimer) clearInterval(this.mediaTimer);
    this.mediaTimer = undefined;
    this.pendingAudio = Buffer.alloc(0);
    this.pendingControls = [];
    this.clearInboundFlushTimer();
    this.inbound.pendingPackets.clear();
    try { this.state.dataChannel.close(); } catch {}
    this.state.encoder.free();
    this.state.decoder.free();
    void this.state.peer.close().catch(() => undefined);
  }

  attachInboundTrack(track) {
    if (track.kind !== 'audio' || this.subscribedTracks.has(track.uuid)) return;
    this.subscribedTracks.add(track.uuid);
    track.onReceiveRtp.subscribe((packet) => this.handleInboundRtp(packet));
  }

  handleInboundRtp(packet) {
    if (this.closed) return;
    try {
      const sequenceNumber = packet.header.sequenceNumber;
      if (this.activeInboundSsrc === undefined) this.activeInboundSsrc = packet.header.ssrc;
      else if (packet.header.ssrc !== this.activeInboundSsrc) {
        throw new Error('GPT Live relay audio source changed unexpectedly');
      }
      if (this.inbound.nextSequence === undefined) {
        this.inbound.nextSequence = (sequenceNumber + 1) & 0xffff;
        this.decodeInboundPacket(packet);
        return;
      }
      const distance = forwardSequenceDistance(this.inbound.nextSequence, sequenceNumber);
      if (distance >= RTP_SEQUENCE_HALF_RANGE) {
        const backward = forwardSequenceDistance(sequenceNumber, this.inbound.nextSequence);
        if (backward <= INBOUND_MAX_LATE_PACKETS) return;
        throw new Error('GPT Live relay RTP sequence changed unexpectedly');
      }
      if (this.inbound.pendingPackets.has(sequenceNumber)) return;
      if (distance === 0) {
        this.inbound.nextSequence = (this.inbound.nextSequence + 1) & 0xffff;
        this.decodeInboundPacket(packet);
        this.clearInboundFlushTimer();
        this.drainInboundPackets();
        return;
      }
      this.inbound.pendingPackets.set(sequenceNumber, packet);
      this.flushInboundReorderWindow(false);
      this.scheduleInboundFlush();
    } catch (error) {
      this.state.callbacks.onError(asError(error));
    }
  }

  flushInboundReorderWindow(force) {
    const expected = this.inbound.nextSequence;
    if (expected === undefined || !this.inbound.pendingPackets.size) return;
    const pending = [...this.inbound.pendingPackets.keys()]
      .map((sequenceNumber) => ({
        sequenceNumber,
        distance: forwardSequenceDistance(expected, sequenceNumber),
      }))
      .filter(({ distance }) => distance < RTP_SEQUENCE_HALF_RANGE)
      .sort((left, right) => left.distance - right.distance);
    const nearest = pending[0];
    const farthest = pending.at(-1);
    if (!nearest || !farthest || (!force && farthest.distance < INBOUND_REORDER_DEPTH)) return;
    this.clearInboundFlushTimer();
    const concealCount = Math.min(nearest.distance, INBOUND_REORDER_DEPTH);
    for (let index = 0; index < concealCount; index += 1) {
      this.inbound.nextSequence = ((this.inbound.nextSequence ?? 0) + 1) & 0xffff;
      this.emitInboundPcm(this.state.decoder.decodePacketLoss(OPUS_FRAME_SAMPLES));
    }
    if (nearest.distance > INBOUND_REORDER_DEPTH) this.inbound.nextSequence = nearest.sequenceNumber;
    this.drainInboundPackets();
  }

  drainInboundPackets() {
    while (this.inbound.nextSequence !== undefined) {
      const packet = this.inbound.pendingPackets.get(this.inbound.nextSequence);
      if (!packet) break;
      this.inbound.pendingPackets.delete(this.inbound.nextSequence);
      this.inbound.nextSequence = (this.inbound.nextSequence + 1) & 0xffff;
      this.decodeInboundPacket(packet);
    }
    if (!this.inbound.pendingPackets.size) this.clearInboundFlushTimer();
    else this.scheduleInboundFlush();
  }

  scheduleInboundFlush() {
    if (this.closed || this.inbound.flushTimer || !this.inbound.pendingPackets.size) return;
    this.inbound.flushTimer = setTimeout(() => {
      this.inbound.flushTimer = undefined;
      try { this.flushInboundReorderWindow(true); } catch (error) {
        this.state.callbacks.onError(asError(error));
      }
    }, INBOUND_REORDER_DEPTH * 20);
    this.inbound.flushTimer.unref?.();
  }

  clearInboundFlushTimer() {
    if (this.inbound.flushTimer) clearTimeout(this.inbound.flushTimer);
    this.inbound.flushTimer = undefined;
  }

  decodeInboundPacket(packet) {
    const opus = this.state.werift.dePacketizeRtpPackets('opus', [packet]).data;
    this.emitInboundPcm(this.state.decoder.decode(opus, { maxFrameSize: 5_760 }));
  }

  emitInboundPcm(decoded) {
    const audio = providerPcmToWatchPcm(decoded);
    if (audio.length) this.state.callbacks.onAudio(audio);
  }

  startMediaPump() {
    if (this.mediaTimer || this.closed) return;
    this.sendNextAudioFrame();
    this.mediaTimer = setInterval(() => this.sendNextAudioFrame(), 20);
    this.mediaTimer.unref?.();
  }

  sendNextAudioFrame() {
    if (!this.connected || this.closed) return;
    const frame = Buffer.alloc(WATCH_FRAME_BYTES);
    const queuedBytes = Math.min(this.pendingAudio.length, WATCH_FRAME_BYTES);
    if (queuedBytes) {
      this.pendingAudio.copy(frame, 0, 0, queuedBytes);
      this.pendingAudio = this.pendingAudio.subarray(queuedBytes);
    }
    try {
      const encoded = this.state.encoder.encode(watchPcmToProviderPcm(frame), {
        frameSize: OPUS_FRAME_SAMPLES,
      });
      const rtp = new this.state.werift.RtpPacket(
        new this.state.werift.RtpHeader({
          marker: false,
          payloadType: 111,
          sequenceNumber: this.sequenceNumber,
          timestamp: this.timestamp,
        }),
        Buffer.from(encoded),
      );
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
      this.timestamp = (this.timestamp + OPUS_FRAME_SAMPLES) >>> 0;
      void this.state.transceiver.sender.sendRtp(rtp).catch((error) => {
        this.state.callbacks.onError(asError(error));
      });
    } catch (error) {
      this.state.callbacks.onError(asError(error));
    }
  }
}
