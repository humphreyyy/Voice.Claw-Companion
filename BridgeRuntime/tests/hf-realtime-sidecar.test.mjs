import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { HFRealtimeBridge } from '../server/hf-realtime-sidecar.js';

const OPEN = 1;
const CLOSED = 3;

class FakeHFSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
  }

  open() {
    this.readyState = OPEN;
    this.emit('open');
  }

  send(data, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    this.sent.push(JSON.parse(String(data)));
    queueMicrotask(() => done?.());
  }

  ping() {}

  close() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    queueMicrotask(() => this.emit('close', 1000, Buffer.alloc(0)));
  }

  terminate() {
    this.close();
  }
}

function admittedStack() {
  return {
    sampleRate: 16_000,
    channels: 1,
    encoding: 'pcm_s16le',
    bytesPerSample: 2,
    stt: { profile: 'parakeet-live', backend: 'parakeet-tdt', model: 'parakeet' },
    llm: { provider: 'local', model: 'qwen' },
    tts: { engine: 'kokoro', model: 'kokoro', voice: 'af_heart', device: 'cpu' },
  };
}

async function settleBridge(bridge) {
  await bridge.drainControls();
  await new Promise((resolve) => setImmediate(resolve));
  await bridge.drainControls();
}

async function createHarness({
  toolHandler = null,
  admission = admittedStack(),
  runtimeIdentityKey = 'focused-stack',
  queueBeforeAdmission = false,
  payload = {},
} = {}) {
  const events = [];
  const binary = [];
  const socket = new FakeHFSocket();
  let leasesReleased = 0;
  const bridge = new HFRealtimeBridge({
    clientWs: {
      readyState: OPEN,
      send(data) {
        binary.push(Buffer.from(data));
        return true;
      },
    },
    send(event) {
      events.push(event);
      return true;
    },
    payload: {
      sessionToken: 'focused-sidecar-test',
      brainMode: 'qwen3.5-0.8b',
      sttProfile: 'parakeet-live',
      localVoice: 'kokoro-af-heart',
      ...payload,
    },
    tools: [{ type: 'function', name: 'iphone_test', parameters: { type: 'object', properties: {} } }],
    toolHandler,
    sidecarResolver: async (_payload, options) => {
      assert.equal(options.acquireLease, true);
      if (queueBeforeAdmission) {
        options.onQueued({
          reason: 'pipeline-capacity',
          position: 1,
          poolSize: 2,
          pipelineCapacity: 1,
        });
      }
      return {
        wsURL: 'ws://focused.test/v1/realtime',
        key: 'focused-stack',
        port: 18765,
        admission,
        releaseLease() {
          leasesReleased += 1;
        },
      };
    },
    runtimeIdentityResolver: async () => ({ key: runtimeIdentityKey }),
    webSocketFactory: () => {
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
  await bridge.start();
  return { bridge, socket, events, binary, leasesReleased: () => leasesReleased };
}

function providerEvent(type, extra = {}) {
  return Buffer.from(JSON.stringify({ type, ...extra }));
}

test('ready is acknowledged only after the upstream pipeline claim and selected stack admission', async () => {
  const harness = await createHarness();
  const { bridge, socket, events } = harness;
  try {
    assert.equal(bridge.ready, false);
    assert.equal(events.some((event) => event.type === 'status' && event.status === 'ready'), false);

    socket.emit('message', providerEvent('session.created', {
      event_id: 'evt_session_claim',
      session: { id: 'hf-pipeline-session-1' },
    }));
    await settleBridge(bridge);

    const ready = events.find((event) => event.type === 'status' && event.status === 'ready' && event.source);
    assert.ok(ready);
    assert.equal(ready.source, 'session.created-admitted');
    assert.equal(ready.bridgeReady, true);
    assert.deepEqual(ready.admission, admittedStack());
    assert.equal(ready.pipelineSessionID, 'hf-pipeline-session-1');
    assert.equal(ready.hfSessionID, 'focused-sidecar-test');
    assert.equal(typeof ready.hfGenerationID, 'string');
    assert.equal(typeof ready.hfConfigID, 'string');
    assert.equal(socket.sent.filter((event) => event.type === 'session.update').length, 1);
  } finally {
    bridge.close();
  }
  assert.equal(harness.leasesReleased(), 1);
});

test('a pipeline claim with an unconfirmed audio or provider stack never becomes ready', async () => {
  const invalid = { ...admittedStack(), sampleRate: 24_000 };
  const { bridge, socket, events } = await createHarness({ admission: invalid });
  try {
    socket.emit('message', providerEvent('session.created', { session: { id: 'invalid-pipeline' } }));
    await settleBridge(bridge);
    assert.equal(bridge.ready, false);
    assert.equal(events.some((event) => event.type === 'status' && event.status === 'ready'), false);
    assert.equal(events.some((event) => (
      event.type === 'error'
      && event.code === 'HF_PIPELINE_ADMISSION_INVALID'
    )), true);
  } finally {
    bridge.close();
  }
});

test('pipeline admission does not coerce or omit immutable PCM fields', async () => {
  for (const admission of [
    { ...admittedStack(), sampleRate: '16000' },
    { ...admittedStack(), channels: '1' },
    { ...admittedStack(), bytesPerSample: undefined },
  ]) {
    const { bridge, socket, events } = await createHarness({ admission });
    try {
      socket.emit('message', providerEvent('session.created', { session: { id: 'invalid-pcm-shape' } }));
      await settleBridge(bridge);
      assert.equal(bridge.ready, false);
      assert.equal(events.some((event) => event.code === 'HF_PIPELINE_ADMISSION_INVALID'), true);
    } finally {
      bridge.close();
    }
  }
});

test('bounded runtime admission is reported as queued before readiness', async () => {
  const { bridge, socket, events } = await createHarness({ queueBeforeAdmission: true });
  try {
    const queued = events.find((event) => event.type === 'status' && event.status === 'queued-hf-runtime');
    assert.ok(queued);
    assert.equal(queued.bridgeReady, false);
    assert.equal(queued.reason, 'pipeline-capacity');
    assert.equal(queued.position, 1);
    socket.emit('message', providerEvent('session.created', { session: { id: 'queued-pipeline' } }));
    await settleBridge(bridge);
    assert.equal(events.some((event) => (
      event.type === 'status'
      && event.status === 'ready'
      && event.bridgeReady === true
    )), true);
  } finally {
    bridge.close();
  }
});

test('same-runtime configuration updates advance config identity and ACK on the admitted pipeline', async () => {
  const { bridge, socket, events } = await createHarness();
  try {
    socket.emit('message', providerEvent('session.created', { session: { id: 'config-pipeline' } }));
    await settleBridge(bridge);
    const previousConfigID = bridge.hfConfigID;
    const previousRevision = bridge.hfConfigRevision;
    const generationID = bridge.hfGenerationID;
    const update = bridge.updateSession({ instructions: 'Updated instructions.' });
    assert.equal(bridge.ready, false);
    await update;
    await settleBridge(bridge);
    assert.equal(bridge.ready, true);
    assert.equal(bridge.hfConfigRevision, previousRevision + 1);
    assert.notEqual(bridge.hfConfigID, previousConfigID);
    assert.equal(bridge.hfGenerationID, generationID);
    assert.equal(events.some((event) => (
      event.type === 'status'
      && event.status === 'ready'
      && event.source === 'session.update-on-admitted-pipeline'
      && event.hfConfigID === bridge.hfConfigID
    )), true);
  } finally {
    bridge.close();
  }
});

test('provider credential or runtime identity changes require a new terminal generation', async () => {
  const { bridge, socket, events } = await createHarness({ runtimeIdentityKey: 'different-provider-credential' });
  socket.emit('message', providerEvent('session.created', { session: { id: 'credential-pipeline' } }));
  await settleBridge(bridge);
  await bridge.updateSession({ payload: { ...bridge.payload, cerebrasAPIKey: 'rotated' } });
  assert.equal(bridge.terminal, true);
  assert.equal(bridge.ready, false);
  assert.equal(events.some((event) => (
    event.type === 'error'
    && event.code === 'HF_RUNTIME_IDENTITY_CHANGED'
  )), true);
  assert.equal(events.some((event) => (
    event.type === 'status'
    && event.status === 'closed'
    && event.requiresNewGeneration === true
  )), true);
});

test('transcript partials append, revise, finalize, and release item state', async () => {
  const { bridge, socket, events } = await createHarness();
  try {
    socket.emit('message', providerEvent('session.created', { session: { id: 'pipeline-2' } }));
    await settleBridge(bridge);
    bridge.sendAudio(Buffer.alloc(640));
    bridge.handleHFMessage(providerEvent('input_audio_buffer.speech_started'));
    bridge.handleHFMessage(providerEvent('conversation.item.input_audio_transcription.delta', {
      item_id: 'input-1',
      content_index: 0,
      delta: 'hel',
    }));
    bridge.handleHFMessage(providerEvent('conversation.item.input_audio_transcription.delta', {
      item_id: 'input-1',
      content_index: 1,
      delta: 'hello',
    }));
    bridge.handleHFMessage(providerEvent('conversation.item.input_audio_transcription.delta', {
      item_id: 'input-1',
      content_index: 2,
      delta: 'hullo',
    }));
    bridge.handleHFMessage(providerEvent('conversation.item.input_audio_transcription.completed', {
      item_id: 'input-1',
      transcript: 'hullo world',
    }));

    const transcripts = events.filter((event) => event.type === 'transcript');
    assert.deepEqual(transcripts.map((event) => event.text), ['hel', 'hello', 'hullo', 'hullo world']);
    assert.deepEqual(transcripts.map((event) => event.operation), ['partial', 'append', 'revision', 'final']);
    assert.equal(transcripts.at(-1).finalUpdate, 'append');
    assert.equal(transcripts.at(-1).final, true);
    assert.equal(bridge.transcriptStates.size, 0);
    assert.equal(bridge.inputItemContexts.size, 0);
    assert.equal(bridge.inputItemTombstones.has('input-1'), true);
    bridge.terminalizeTurn('transcript-test-complete');
    bridge.handleHFMessage(providerEvent('conversation.item.input_audio_transcription.delta', {
      item_id: 'input-1',
      delta: ' late',
    }));
    assert.equal(events.some((event) => (
      event.type === 'protocol_rejection'
      && event.code === 'STALE_HF_TRANSCRIPT_EVENT'
    )), true);
  } finally {
    bridge.close();
  }
});

test('provider-managed response creation remains the compatibility default', async () => {
  const { bridge, socket } = await createHarness();
  try {
    socket.emit('message', providerEvent('session.created', { session: { id: 'provider-managed-response' } }));
    await settleBridge(bridge);
    bridge.sendAudio(Buffer.alloc(640));
    bridge.handleHFMessage(providerEvent('input_audio_buffer.speech_stopped'));
    bridge.handleHFMessage(providerEvent('conversation.item.input_audio_transcription.completed', {
      item_id: 'provider-managed-input',
      transcript: 'respond without an explicit create',
    }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    await settleBridge(bridge);
    assert.equal(socket.sent.filter((event) => event.type === 'response.create').length, 0);
  } finally {
    bridge.close();
  }
});

test('explicit response creation admits one intent per turn without timeout duplication', async () => {
  const { bridge, socket } = await createHarness({ payload: { hfExplicitResponseCreate: true } });
  try {
    socket.emit('message', providerEvent('session.created', { session: { id: 'explicit-response' } }));
    await settleBridge(bridge);
    bridge.sendAudio(Buffer.alloc(640));
    bridge.handleHFMessage(providerEvent('input_audio_buffer.speech_stopped'));
    bridge.handleHFMessage(providerEvent('conversation.item.input_audio_transcription.completed', {
      item_id: 'explicit-input-1',
      transcript: 'create one response',
    }));
    bridge.handleHFMessage(providerEvent('conversation.item.input_audio_transcription.completed', {
      item_id: 'explicit-input-2',
      transcript: 'create one response',
    }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    await settleBridge(bridge);
    assert.equal(socket.sent.filter((event) => event.type === 'response.create').length, 1);
  } finally {
    bridge.close();
  }
});

test('interrupt tombstones the response and rejects late text and audio', async () => {
  const { bridge, socket, events, binary } = await createHarness();
  try {
    socket.emit('message', providerEvent('session.created', { session: { id: 'pipeline-3' } }));
    await settleBridge(bridge);
    bridge.sendAudio(Buffer.alloc(640));
    bridge.handleHFMessage(providerEvent('input_audio_buffer.speech_stopped'));
    bridge.handleHFMessage(providerEvent('conversation.item.input_audio_transcription.completed', {
      item_id: 'input-stale',
      transcript: 'hello',
    }));
    bridge.handleHFMessage(providerEvent('response.created', { response: { id: 'resp_stale' } }));
    bridge.handleHFMessage(providerEvent('response.output_text.delta', { response_id: 'resp_stale', delta: 'old' }));
    await bridge.interrupt('test-interrupt');
    await settleBridge(bridge);

    const binaryBefore = binary.length;
    bridge.handleHFMessage(providerEvent('response.output_text.delta', { response_id: 'resp_stale', delta: ' late' }));
    bridge.handleHFMessage(providerEvent('response.output_audio.delta', {
      response_id: 'resp_stale',
      delta: Buffer.alloc(640).toString('base64'),
    }));

    assert.equal(binary.length, binaryBefore);
    const rejections = events.filter((event) => event.type === 'protocol_rejection' && event.code === 'STALE_HF_RESPONSE_EVENT');
    assert.equal(rejections.length, 2);
    assert.equal(events.some((event) => event.type === 'reply_delta' && event.text === 'old late'), false);
  } finally {
    bridge.close();
  }
});

test('tool registry rejects duplicates and continues once after a correlated result', async () => {
  const { bridge, socket, events } = await createHarness();
  try {
    socket.emit('message', providerEvent('session.created', { session: { id: 'pipeline-4' } }));
    await settleBridge(bridge);
    bridge.sendAudio(Buffer.alloc(640));
    bridge.handleHFMessage(providerEvent('input_audio_buffer.speech_stopped'));
    bridge.handleHFMessage(providerEvent('conversation.item.input_audio_transcription.completed', {
      item_id: 'input-tool',
      transcript: 'run the tool',
    }));
    bridge.handleHFMessage(providerEvent('response.function_call_arguments.done', {
      response_id: 'resp_tool',
      call_id: 'call_tool_1',
      name: 'iphone_test',
      arguments: '{"value":1}',
    }));
    bridge.handleHFMessage(providerEvent('response.function_call_arguments.done', {
      response_id: 'resp_tool',
      call_id: 'call_tool_1',
      name: 'iphone_test',
      arguments: '{"value":1}',
    }));
    bridge.handleHFMessage(providerEvent('response.done', {
      response: { id: 'resp_tool', status: 'completed' },
    }));

    assert.equal(events.some((event) => event.type === 'iphone_tool' && event.callID === 'call_tool_1'), true);
    assert.equal(events.some((event) => event.type === 'protocol_rejection' && event.code === 'DUPLICATE_HF_TOOL_CALL'), true);
    assert.equal(events.some((event) => event.type === 'status' && event.status === 'awaiting_tool_result'), true);
    assert.equal(bridge.sendToolResult({ callID: 'call_tool_1', output: '{"ok":true}', continueResponse: false }), true);
    await settleBridge(bridge);
    assert.equal(socket.sent.filter((event) => event.type === 'conversation.item.create').length, 1);
    assert.equal(socket.sent.filter((event) => event.type === 'response.create').length, 1);
    assert.ok(
      socket.sent.findIndex((event) => event.type === 'conversation.item.create')
      < socket.sent.findIndex((event) => event.type === 'response.create'),
    );

    assert.equal(bridge.sendToolResult({ callID: 'call_tool_1', output: '{"ok":true}' }), false);
    assert.equal(events.some((event) => (
      event.type === 'protocol_rejection'
      && event.code === 'DUPLICATE_OR_STALE_HF_TOOL_RESULT'
    )), true);
  } finally {
    bridge.close();
  }
});

test('a tool result received before response.done still schedules one serialized continuation', async () => {
  const { bridge, socket } = await createHarness();
  try {
    socket.emit('message', providerEvent('session.created', { session: { id: 'pipeline-tool-race' } }));
    await settleBridge(bridge);
    bridge.sendAudio(Buffer.alloc(640));
    bridge.handleHFMessage(providerEvent('input_audio_buffer.speech_stopped'));
    bridge.handleHFMessage(providerEvent('conversation.item.input_audio_transcription.completed', {
      item_id: 'input-tool-race',
      transcript: 'run it',
    }));
    bridge.handleHFMessage(providerEvent('response.function_call_arguments.done', {
      response_id: 'resp_tool_race',
      call_id: 'call_tool_race',
      name: 'iphone_test',
      arguments: '{}',
    }));
    assert.equal(bridge.sendToolResult({ callID: 'call_tool_race', output: '{"ok":true}' }), true);
    bridge.handleHFMessage(providerEvent('response.done', {
      response: { id: 'resp_tool_race', status: 'completed' },
    }));
    await settleBridge(bridge);
    assert.equal(socket.sent.filter((event) => event.type === 'conversation.item.create').length, 1);
    assert.equal(socket.sent.filter((event) => event.type === 'response.create').length, 1);
    assert.ok(
      socket.sent.findIndex((event) => event.type === 'conversation.item.create')
      < socket.sent.findIndex((event) => event.type === 'response.create'),
    );
  } finally {
    bridge.close();
  }
});

test('a tool result with stale generation correlation is rejected and tombstoned', async () => {
  const { bridge, socket, events } = await createHarness();
  try {
    socket.emit('message', providerEvent('session.created', { session: { id: 'pipeline-tool-stale' } }));
    await settleBridge(bridge);
    bridge.sendAudio(Buffer.alloc(640));
    bridge.handleHFMessage(providerEvent('input_audio_buffer.speech_stopped'));
    bridge.handleHFMessage(providerEvent('conversation.item.input_audio_transcription.completed', {
      item_id: 'input-tool-stale',
      transcript: 'run it',
    }));
    bridge.handleHFMessage(providerEvent('response.function_call_arguments.done', {
      response_id: 'resp_tool_stale',
      call_id: 'call_tool_stale',
      name: 'iphone_test',
      arguments: '{}',
    }));

    assert.equal(bridge.sendToolResult({
      callID: 'call_tool_stale',
      output: '{"ok":true}',
      hfGenerationID: 'stale-generation',
    }), false);
    assert.equal(bridge.pendingToolCalls.has('call_tool_stale'), false);
    assert.equal(bridge.toolCallTombstones.has('call_tool_stale'), true);
    assert.equal(events.some((event) => (
      event.type === 'protocol_rejection'
      && event.code === 'STALE_HF_TOOL_RESULT'
    )), true);
  } finally {
    bridge.close();
  }
});

test('tool handlers receive a real deadline signal which aborts with the turn', async () => {
  let observed = null;
  const harness = await createHarness({
    toolHandler: (request) => {
      observed = request;
      return new Promise(() => {});
    },
  });
  const { bridge, socket } = harness;
  try {
    socket.emit('message', providerEvent('session.created', { session: { id: 'pipeline-5' } }));
    await settleBridge(bridge);
    bridge.sendAudio(Buffer.alloc(640));
    bridge.handleHFMessage(providerEvent('input_audio_buffer.speech_stopped'));
    bridge.handleHFMessage(providerEvent('conversation.item.input_audio_transcription.completed', {
      item_id: 'input-signal',
      transcript: 'check status',
    }));
    bridge.handleHFMessage(providerEvent('response.function_call_arguments.done', {
      response_id: 'resp_signal',
      call_id: 'call_signal_1',
      name: 'bridge_status',
      arguments: '{}',
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(observed?.signal instanceof AbortSignal);
    assert.equal(observed.signal.aborted, false);
    assert.ok(observed.deadlineAt > Date.now());
    await bridge.interrupt('abort-tool');
    assert.equal(observed.signal.aborted, true);
  } finally {
    bridge.close();
  }
});

test('pending PCM is hard bounded and reports explicit input gaps', () => {
  const events = [];
  const bridge = new HFRealtimeBridge({
    clientWs: { readyState: OPEN, send: () => true },
    send: (event) => events.push(event),
  });
  const frame = Buffer.alloc(80_000);
  try {
    for (let index = 0; index < 5; index += 1) bridge.sendAudio(frame);
    assert.ok(bridge.pendingAudioBytes <= 16_000 * 2 * 8);
    assert.ok(bridge.pendingAudio.length <= 512);
    assert.equal(events.some((event) => (
      event.type === 'audio_gap'
      && event.direction === 'input'
      && event.phase === 'start'
      && event.reason === 'pending-audio-overflow'
    )), true);
    assert.equal(events.some((event) => event.type === 'status' && event.status === 'input_backpressure'), true);
  } finally {
    bridge.close();
  }
});

test('an oversized ready-state PCM frame is rejected before websocket buffering', async () => {
  const { bridge, socket, events } = await createHarness();
  try {
    socket.emit('message', providerEvent('session.created', { session: { id: 'pipeline-input-cap' } }));
    await settleBridge(bridge);
    const appendsBefore = socket.sent.filter((event) => event.type === 'input_audio_buffer.append').length;
    assert.equal(bridge.sendAudio(Buffer.alloc((16_000 * 2 * 8) + 2)), false);
    assert.equal(
      socket.sent.filter((event) => event.type === 'input_audio_buffer.append').length,
      appendsBefore,
    );
    assert.equal(events.some((event) => (
      event.type === 'audio_gap'
      && event.direction === 'input'
      && event.phase === 'start'
      && event.reason === 'audio-frame-too-large'
    )), true);
  } finally {
    bridge.close();
  }
});

test('outgoing PCM never grows the client websocket buffer past its hard bound', async () => {
  const { bridge, socket, events, binary } = await createHarness();
  try {
    socket.emit('message', providerEvent('session.created', { session: { id: 'pipeline-output-cap' } }));
    await settleBridge(bridge);
    bridge.sendAudio(Buffer.alloc(640));
    bridge.handleHFMessage(providerEvent('input_audio_buffer.speech_stopped'));
    bridge.handleHFMessage(providerEvent('conversation.item.input_audio_transcription.completed', {
      item_id: 'input-output-cap',
      transcript: 'speak',
    }));
    bridge.handleHFMessage(providerEvent('response.created', { response: { id: 'resp_output_cap' } }));
    bridge.clientWs.bufferedAmount = 16_000 * 2 * 6;
    bridge.handleHFMessage(providerEvent('response.output_audio.delta', {
      response_id: 'resp_output_cap',
      delta: Buffer.alloc(640).toString('base64'),
    }));

    assert.equal(binary.length, 0);
    assert.equal(events.some((event) => (
      event.type === 'audio_gap'
      && event.direction === 'output'
      && event.phase === 'start'
      && event.reason === 'client-output-buffer-capacity'
    )), true);
    assert.equal(events.some((event) => event.type === 'status' && event.status === 'output_backpressure'), true);
  } finally {
    bridge.close();
  }
});

test('terminal close clears readiness and requires a new bridge generation', async () => {
  const { bridge, socket, events } = await createHarness();
  socket.emit('message', providerEvent('session.created', { session: { id: 'pipeline-6' } }));
  await settleBridge(bridge);
  assert.equal(bridge.ready, true);
  bridge.close('terminal-test');
  assert.equal(bridge.ready, false);
  assert.equal(bridge.configured, false);
  assert.equal(bridge.closed, true);
  assert.equal(bridge.terminal, true);
  await assert.rejects(() => bridge.start(), { code: 'HF_GENERATION_CLOSED' });
  await bridge.updateSession();
  assert.equal(events.some((event) => (
    event.type === 'protocol_rejection'
    && event.code === 'HF_GENERATION_CLOSED'
  )), true);
});
