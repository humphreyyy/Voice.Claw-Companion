import { GPTLiveWatchNativePeer } from './gpt-live-watch-native-peer.js';

function serializedError(error) {
  return {
    message: String(error?.message || error || 'Unknown libwebrtc worker error'),
    stack: typeof error?.stack === 'string' ? error.stack : undefined,
  };
}

function send(message) {
  if (process.connected) process.send(message);
}

let closing = false;
let peer;

try {
  peer = await GPTLiveWatchNativePeer.create({
    callbacks: {
      onAudio({ audio, sampleRate, channelCount }) {
        send({ type: 'event', event: 'audio', audio, sampleRate, channelCount });
      },
      onControl(payload) { send({ type: 'event', event: 'control', payload }); },
      onControlReady() { send({ type: 'event', event: 'controlReady' }); },
      onConnectionState(state) { send({ type: 'event', event: 'connectionState', state }); },
      onControlState(state) { send({ type: 'event', event: 'controlState', state }); },
      onControlError(error) { send({ type: 'event', event: 'controlError', error: serializedError(error) }); },
      onMediaError(error) { send({ type: 'event', event: 'mediaError', error: serializedError(error) }); },
      onQueueDiagnostics(diagnostics) {
        send({ type: 'event', event: 'queueDiagnostics', diagnostics });
      },
      onError(error) { send({ type: 'event', event: 'error', error: serializedError(error) }); },
    },
  });
  send({ type: 'ready' });
} catch (error) {
  send({ type: 'event', event: 'error', error: serializedError(error) });
  process.exit(1);
}

function closeAndExit() {
  if (closing) return;
  closing = true;
  try { peer?.close(); } catch {}
  // The native addon's RTCAudioSource finalizer is unsafe during ordinary Node
  // environment teardown. Isolating it here and exiting immediately protects
  // the long-lived Companion process without changing relay semantics.
  process.exit(0);
}

process.on('message', async (message) => {
  if (!message || typeof message !== 'object' || closing) return;
  if (message.type === 'close') {
    closeAndExit();
    return;
  }
  if (message.type === 'audio') {
    peer.sendAudio(Buffer.from(message.audio), {
      sampleRate: message.sampleRate,
      channelCount: message.channelCount,
    });
    return;
  }
  if (message.type === 'control') {
    peer.sendControl(message.payload);
    return;
  }
  if (message.type !== 'request') return;
  try {
    let value;
    if (message.command === 'createOffer') value = await peer.createOffer();
    else if (message.command === 'applyAnswer') value = await peer.applyAnswer(message.answerSdp);
    else throw new Error(`Unsupported libwebrtc worker command: ${message.command}`);
    send({ type: 'response', requestID: message.requestID, ok: true, value });
  } catch (error) {
    send({
      type: 'response',
      requestID: message.requestID,
      ok: false,
      error: serializedError(error),
    });
  }
});

process.on('disconnect', closeAndExit);
process.on('SIGTERM', closeAndExit);
process.on('SIGINT', closeAndExit);
