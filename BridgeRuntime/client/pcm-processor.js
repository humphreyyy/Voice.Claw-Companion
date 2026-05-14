/**
 * AudioWorklet processor: captures raw PCM float32 samples from the mic
 * and forwards them to the main thread in chunks.
 *
 * Runs at the AudioContext's sample rate (usually 48000 on iOS).
 * The main thread handles down-sampling to 16 kHz before sending to server.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._bufferSize = 4800; // ~100ms at 48kHz — flush frequently for low latency
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const samples = input[0]; // mono channel
    for (let i = 0; i < samples.length; i++) {
      this._buffer.push(samples[i]);
    }

    if (this._buffer.length >= this._bufferSize) {
      this.port.postMessage({ pcm: new Float32Array(this._buffer) });
      this._buffer = [];
    }

    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
