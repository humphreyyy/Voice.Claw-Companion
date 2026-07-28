import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';

const testRoot = await mkdtemp(join(tmpdir(), 'voiceclaw-outer-hf-'));
process.env.VOICECLAW_OUTER_HF_TEST = '1';
process.env.VOICECLAW_CONFIG_PATH = join(testRoot, 'bridge.json');
process.env.REALTIME_LOG_DIR = join(testRoot, 'logs');
process.env.VOICECLAW_BRIDGE_TOKEN = 'outer-hf-test-token';
process.env.VOICECLAW_BRIDGE_PASSWORD = '';
process.env.OPENCLAW_GATEWAY_PASSWORD = '';
process.env.COMPANION_VOICE_HF_PREWARM = '0';
process.env.COMPANION_VOICE_HF_KEEPHOT = '0';
process.env.REALTIME_RESPONSE_CREATE_ACK_TIMEOUT_MS = '20';
process.env.REALTIME_MAX_PENDING_RESPONSE_INTENTS = '3';

const { outerHFIntegration } = await import('../server/index.js');

const wireFormat = Object.freeze({
  sampleRate: 16_000,
  channels: 1,
  encoding: 'pcm_s16le',
  bytesPerSample: 2,
});

function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('Timed out waiting for integration condition.'));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

function delayedToolRequest(overrides = {}) {
  return {
    name: 'openclaw_turn',
    callID: 'call-outer-1',
    argumentsJSON: JSON.stringify({ text: 'Inspect the delayed integration fixture and report the result.' }),
    bridge: { sendToolResult: () => true },
    payload: { sessionToken: 'outer-hf-session', routeMode: 'openclaw-bridge' },
    deadlineAt: Date.now() + 5_000,
    hfSessionID: 'hf-session-outer',
    hfGenerationID: 'hf-generation-7',
    hfConfigID: 'hf-config-7-2',
    hfTurnID: 'hf-turn-7-3',
    hfResponseID: 'hf-response-7-4',
    ...overrides,
  };
}

test('Codex route normalization and explicit runtime reject a stale OpenClaw binding', () => {
  const processing = outerHFIntegration.normalizeRealtimeProcessingPayload({
    routeMode: 'codex-app-server',
    processing: {},
  });
  assert.equal(processing.runtime, 'codex');

  const staleOpenClawSession = { runtime: 'openclaw', sessionID: 'old-openclaw-session' };
  const resolved = outerHFIntegration.resolveRealtimeRuntimeBinding(
    processing,
    staleOpenClawSession,
  );
  assert.equal(resolved.runtime, 'codex');
  assert.equal(resolved.boundRemoteSession, null);
});

test('an attached agent runtime remains usable when no explicit runtime overrides it', () => {
  const hermesSession = { runtime: 'hermes', sessionID: 'hermes-session' };
  const resolved = outerHFIntegration.resolveRealtimeRuntimeBinding({}, hermesSession);
  assert.equal(resolved.runtime, 'hermes');
  assert.equal(resolved.boundRemoteSession, hermesSession);
});

test('processing normalization preserves separate model route and runtime agent identities', () => {
  const current = outerHFIntegration.normalizeRealtimeProcessingPayload({
    agent: 'julian',
    openClawModel: 'gpt-5.6-sol',
    routeMode: 'openclaw-bridge',
    processing: {
      agent: 'gpt-5.6-sol',
      thinking: 'low',
    },
  });
  assert.equal(current.agent, 'gpt-5.6-sol');
  assert.equal(current.runtimeAgentID, 'julian');
  assert.equal(current.runtime, 'openclaw');

  const legacy = outerHFIntegration.normalizeRealtimeProcessingPayload({
    agent: 'gpt-5.5',
    routeMode: 'openclaw-bridge',
  });
  assert.equal(legacy.agent, 'gpt-5.5');
  assert.equal(legacy.runtimeAgentID, undefined);
});

test('sidecar interruption aborts an actual delayed outer tool with stable downstream identity', async () => {
  const controller = new AbortController();
  let downstream = null;
  const sent = [];
  const deadlineAt = Date.now() + 5_000;
  const task = outerHFIntegration.handleHFRealtimeCompanionToolCall(delayedToolRequest({
    signal: controller.signal,
    deadlineAt,
    bridge: { sendToolResult: (result) => sent.push(result) },
    replyGenerator: (_text, options) => {
      downstream = options;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
  }));

  await waitFor(() => downstream !== null);
  assert.ok(downstream.signal instanceof AbortSignal);
  assert.equal(downstream.signal.aborted, false);
  assert.match(downstream.requestId, /^voiceclaw-hf-tool:call-outer-1:[a-f0-9]{32}$/);
  assert.equal(downstream.deadlineAt, deadlineAt);

  controller.abort(new Error('client interruption'));
  await task;
  assert.equal(downstream.signal.aborted, true);
  assert.deepEqual(sent, []);
});

test('an unsupported delayed tool is permanently detached after its deadline', async () => {
  let downstream = null;
  let resolveDelayed;
  const sent = [];
  const task = outerHFIntegration.handleHFRealtimeCompanionToolCall(delayedToolRequest({
    callID: 'call-stale-result',
    deadlineAt: Date.now() + 50,
    bridge: { sendToolResult: (result) => sent.push(result) },
    replyGenerator: (_text, options) => {
      downstream = options;
      return new Promise((resolve) => { resolveDelayed = resolve; });
    },
  }));

  await waitFor(() => downstream !== null);
  await task;
  assert.equal(downstream.signal.aborted, true);
  resolveDelayed('late stale answer');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(sent, []);
});

test('credential rotation changes opaque outer runtime identity without exposing credentials', async () => {
  const base = {
    brainMode: 'cerebras:gemma-4-31b',
    cerebrasModel: 'gemma-4-31b',
    sttProfile: 'parakeet-live',
    localVoice: 'kokoro-af-heart',
    cerebrasAPIKey: 'csk-live-first-secret',
    authRevision: 'revision-one',
  };
  const first = await outerHFIntegration.companionVoiceHFBridgeConfigKey(base);
  const rotated = await outerHFIntegration.companionVoiceHFBridgeConfigKey({
    ...base,
    cerebrasAPIKey: 'csk-live-second-secret',
    authRevision: 'revision-two',
  });

  assert.notEqual(first, rotated);
  assert.equal(first.includes(base.cerebrasAPIKey), false);
  assert.equal(first.includes(base.authRevision), false);
  assert.equal(rotated.includes('csk-live-second-secret'), false);
  assert.equal(rotated.includes('revision-two'), false);
  const identity = JSON.parse(rotated).providerAuth;
  assert.equal(identity.source, 'cerebras');
  assert.match(identity.credentialFingerprint, /^[a-f0-9]{24}$/);
  assert.match(identity.revisionFingerprint, /^[a-f0-9]{24}$/);
});

test('a rotated credential dispatches exactly one orderly new-generation restart', async () => {
  const currentConfigKey = await outerHFIntegration.companionVoiceHFBridgeConfigKey({
    brainMode: 'cerebras:gemma-4-31b',
    cerebrasAPIKey: 'credential-before-rotation',
  });
  const nextConfigKey = await outerHFIntegration.companionVoiceHFBridgeConfigKey({
    brainMode: 'cerebras:gemma-4-31b',
    cerebrasAPIKey: 'credential-after-rotation',
  });
  let restarts = 0;
  let updates = 0;
  const transition = outerHFIntegration.dispatchHFCompanionConfigTransition({
    bridge: { ready: true },
    record: { configuring: false },
    currentConfigKey,
    nextConfigKey,
    context: { generation: 4, configRevision: 9 },
    restart: async (reason) => {
      restarts += 1;
      assert.equal(reason, 'config_update-runtime-change');
      return 'new-generation-ready';
    },
    update: async () => {
      updates += 1;
    },
  });

  assert.equal(transition.action, 'restart');
  assert.equal(await transition.operation, 'new-generation-ready');
  assert.equal(restarts, 1);
  assert.equal(updates, 0);
});

test('WebSocket authorization completes before session or HF allocation', async () => {
  const { httpServer, wsPath } = outerHFIntegration;
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  const url = `ws://127.0.0.1:${address.port}${wsPath}`;

  try {
    const rejectedStatus = await new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Authorization: 'Bearer incorrect-token' } });
      ws.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
      ws.once('open', () => reject(new Error('Unauthorized WebSocket unexpectedly opened.')));
      ws.once('error', () => {});
    });
    assert.equal(rejectedStatus, 401);

    const events = [];
    const pending = new WebSocket(url);
    pending.on('message', (data) => events.push(JSON.parse(String(data))));
    await once(pending, 'open');
    pending.send(JSON.stringify({
      type: 'start_session',
      token: 'incorrect-token',
      companionVoice: true,
      companionVoicePayload: { brainMode: 'qwen3.5-0.8b' },
    }));
    const [closeCode] = await once(pending, 'close');
    assert.equal(closeCode, 1008);
    assert.equal(events.some((event) => event.status === 'preparing-hf-runtime'), false);
    assert.equal(events.some((event) => event.type === 'processing'), false);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('GPT Live WebRTC start, stop, and text routes are authenticated and advertised', async () => {
  const { httpServer } = outerHFIntegration;
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    for (const path of [
      '/realtime/codex/webrtc',
      '/realtime/codex/webrtc/stop',
      '/realtime/codex/webrtc/text',
    ]) {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 401, `${path} must reject unauthenticated requests`);
    }

    const configResponse = await fetch(`${origin}/config`, {
      headers: { Authorization: 'Bearer outer-hf-test-token' },
    });
    assert.equal(configResponse.status, 200);
    const config = await configResponse.json();
    assert.equal(config.realtime.codexAppServer.webRTCPath, '/realtime/codex/webrtc');
    assert.equal(config.realtime.codexAppServer.webRTCStopPath, '/realtime/codex/webrtc/stop');
    assert.equal(config.realtime.codexAppServer.webRTCTextPath, '/realtime/codex/webrtc/text');
    assert.equal(config.realtime.codexAppServer.realtime.v3Live.version, 'v3');
    assert.equal(config.realtime.codexAppServer.realtime.v3Live.model, 'gpt-live-1-codex');
    assert.equal(config.realtime.codexAppServer.realtime.v3Live.admission, 'verified-after-sdp-answer');
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('response.create timeout is observation-only and pending intents are bounded', async () => {
  const sessionToken = 'sideband-outcome-unknown-test';
  const sent = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(payload) { sent.push(JSON.parse(String(payload))); },
  };
  outerHFIntegration.setRealtimeSidebandForTest(sessionToken, socket);
  try {
    assert.equal(outerHFIntegration.requestSidebandResponseCreate(
      socket,
      sessionToken,
      { instructions: 'First response.' },
      'first',
    ), true);
    for (let index = 0; index < 8; index += 1) {
      outerHFIntegration.requestSidebandResponseCreate(
        socket,
        sessionToken,
        { instructions: `Queued response ${index}.` },
        `queued-${index}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(sent.filter((event) => event.type === 'response.create').length, 1);
    const unknown = outerHFIntegration.realtimeSidebandStateSnapshot(sessionToken);
    assert.equal(unknown.activeResponseId, 'requested');
    assert.equal(unknown.pendingResponseCreates, 3);
    assert.equal(unknown.responseIntentOverflowCount, 5);
    assert.ok(unknown.responseCreateOutcomeUnknownAt);

    await outerHFIntegration.handleRealtimeSidebandEvent(socket, {
      type: 'response.created',
      response: { id: 'provider-response-1' },
    }, sessionToken);
    await outerHFIntegration.handleRealtimeSidebandEvent(socket, {
      type: 'response.done',
      response: { id: 'provider-response-1', output: [] },
    }, sessionToken);
    assert.equal(sent.filter((event) => event.type === 'response.create').length, 2);
  } finally {
    outerHFIntegration.clearRealtimeSidebandForTest(sessionToken);
  }
});

test('duplicate start_session returns one durable receipt without advancing generation', async () => {
  const { httpServer, wsPath } = outerHFIntegration;
  const beforeMetrics = outerHFIntegration.credentialBoundaryRuntimeSnapshot();
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  const events = [];
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}${wsPath}`, {
    headers: { Authorization: 'Bearer outer-hf-test-token' },
  });
  ws.on('message', (data) => events.push(JSON.parse(String(data))));
  try {
    await once(ws, 'open');
    const start = {
      type: 'start_session',
      token: 'outer-hf-test-token',
      protocolVersion: 1,
      clientSessionID: 'idempotent-start-client',
      clientGeneration: 9,
      configRevision: 4,
      transportOperationID: 'idempotent-start-operation',
      wireFormat,
      companionVoice: false,
    };
    ws.send(JSON.stringify(start));
    try {
      await waitFor(() => events.some((event) => event.type === 'start_session_ack'), 15_000);
    } catch (error) {
      throw new Error(`${error.message} Events: ${JSON.stringify(events)}`);
    }
    ws.send(JSON.stringify(start));
    await waitFor(() => events.filter((event) => event.type === 'start_session_ack').length === 2, 15_000);

    const acknowledgements = events.filter((event) => event.type === 'start_session_ack');
    assert.equal(acknowledgements[0].serverGeneration, 1);
    assert.equal(acknowledgements[1].serverGeneration, 1);
    assert.equal(acknowledgements[0].sessionID, acknowledgements[1].sessionID);
    assert.equal(acknowledgements[0].protocolSequence, acknowledgements[1].protocolSequence);
    assert.equal(acknowledgements[1].idempotentReplay, true);
    assert.deepEqual(acknowledgements[0].wireFormat, wireFormat);
    assert.equal(events.filter((event) => event.type === 'processing').length, 1);
    const afterDuplicateMetrics = outerHFIntegration.credentialBoundaryRuntimeSnapshot();
    assert.equal(
      afterDuplicateMetrics.startSessionApplications - beforeMetrics.startSessionApplications,
      1,
    );

    ws.send(JSON.stringify({
      type: 'rendered_audio_ack',
      controlSequence: 1,
      controlID: 'rendered-audio-control-1',
      generation: 1,
      responseID: 'response-render-integration',
      streamID: 'response-render-integration:audio:0',
      chunkID: 'response-render-integration:audio:0:chunk:0',
      chunkSequence: 0,
      frameCursor: 320,
      byteCursor: 640,
      state: 'interrupted',
    }));
    await waitFor(() => events.some((event) => (
      event.type === 'control_ack'
      && event.controlID === 'rendered-audio-control-1'
      && event.code === 'RENDERED_AUDIO_ACK_RETAINED'
    )), 5_000);
    const renderedReceipt = events.find((event) => event.controlID === 'rendered-audio-control-1');
    assert.deepEqual(renderedReceipt.renderedAudioAck, {
      generation: 1,
      responseID: 'response-render-integration',
      streamID: 'response-render-integration:audio:0',
      chunkID: 'response-render-integration:audio:0:chunk:0',
      chunkSequence: 0,
      frameCursor: 320,
      byteCursor: 640,
      state: 'interrupted',
      final: false,
      interrupted: true,
    });
  } finally {
    const closed = once(ws, 'close');
    ws.close(1000, 'test complete');
    await closed;
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('legacy start_session compatibility is explicit and remains non-resumable', async () => {
  const { httpServer, wsPath } = outerHFIntegration;
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  const events = [];
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}${wsPath}`, {
    headers: { Authorization: 'Bearer outer-hf-test-token' },
  });
  ws.on('message', (data) => events.push(JSON.parse(String(data))));
  try {
    await once(ws, 'open');
    ws.send(JSON.stringify({
      type: 'start_session',
      sessionToken: 'legacy-compatibility-session',
      companionVoice: false,
    }));
    await waitFor(() => events.some((event) => event.type === 'start_session_ack'), 15_000);
    await waitFor(() => events.some((event) => event.status === 'ready'), 15_000);

    const acknowledgement = events.find((event) => event.type === 'start_session_ack');
    assert.equal(acknowledgement.protocolMode, 'legacy');
    assert.equal(acknowledgement.resumeSupported, false);
    assert.equal(acknowledgement.inputAudioFraming, 'legacy-unframed');
    assert.equal(acknowledgement.receiptDurable, false);
    assert.equal(acknowledgement.wireFormat, null);
    assert.equal(acknowledgement.protocolSequence, undefined);
  } finally {
    const closed = once(ws, 'close');
    ws.close(1000, 'test complete');
    await closed;
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('resumable start requires framing from the first binary payload', async () => {
  const { httpServer, wsPath } = outerHFIntegration;
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  const events = [];
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}${wsPath}`, {
    headers: { Authorization: 'Bearer outer-hf-test-token' },
  });
  ws.on('message', (data) => events.push(JSON.parse(String(data))));
  try {
    await once(ws, 'open');
    ws.send(JSON.stringify({
      type: 'start_session',
      protocolVersion: 1,
      clientSessionID: 'framing-required-client',
      clientGeneration: 1,
      configRevision: 0,
      transportOperationID: 'framing-required-operation',
      wireFormat,
      companionVoice: false,
    }));
    await waitFor(() => events.some((event) => event.type === 'start_session_ack'), 15_000);
    ws.send(Buffer.alloc(320));
    await waitFor(() => events.some((event) => event.code === 'UNFRAMED_INPUT_AUDIO'), 5_000);

    const acknowledgement = events.find((event) => event.type === 'start_session_ack');
    assert.equal(acknowledgement.protocolMode, 'resumable-v1');
    assert.equal(acknowledgement.resumeSupported, true);
    assert.equal(acknowledgement.inputAudioFraming, 'required');
    assert.equal(acknowledgement.receiptDurable, true);
  } finally {
    const closed = once(ws, 'close');
    ws.close(1000, 'test complete');
    await closed;
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('unsupported start_session wire format is rejected before session readiness', async () => {
  const { httpServer, wsPath } = outerHFIntegration;
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  const events = [];
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}${wsPath}`, {
    headers: { Authorization: 'Bearer outer-hf-test-token' },
  });
  ws.on('message', (data) => events.push(JSON.parse(String(data))));
  try {
    await once(ws, 'open');
    ws.send(JSON.stringify({
      type: 'start_session',
      protocolVersion: 1,
      clientSessionID: 'wire-mismatch-client',
      clientGeneration: 1,
      configRevision: 0,
      transportOperationID: 'wire-mismatch-operation',
      wireFormat: { ...wireFormat, sampleRate: 24_000 },
      companionVoice: false,
    }));
    await waitFor(() => events.some((event) => event.code === 'UNSUPPORTED_AUDIO_FORMAT'));
    assert.equal(events.some((event) => event.type === 'start_session_ack'), false);
    assert.equal(events.some((event) => event.status === 'ready'), false);
  } finally {
    const closed = once(ws, 'close');
    ws.close(1000, 'test complete');
    await closed;
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('authenticated cross-socket retry attaches to the original start_session runtime', async () => {
  const { httpServer, wsPath } = outerHFIntegration;
  const beforeMetrics = outerHFIntegration.credentialBoundaryRuntimeSnapshot();
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  const url = `ws://127.0.0.1:${address.port}${wsPath}`;
  const options = { headers: { Authorization: 'Bearer outer-hf-test-token' } };
  const firstEvents = [];
  const secondEvents = [];
  const first = new WebSocket(url, options);
  const start = {
    type: 'start_session',
    token: 'outer-hf-test-token',
    protocolVersion: 1,
    clientSessionID: 'cross-socket-start-client',
    clientGeneration: 12,
    configRevision: 1,
    transportOperationID: 'cross-socket-start-operation',
    wireFormat,
    companionVoice: false,
  };
  let second = null;
  first.on('message', (data) => firstEvents.push(JSON.parse(String(data))));
  try {
    await once(first, 'open');
    first.send(JSON.stringify(start));
    await waitFor(() => firstEvents.some((event) => event.type === 'start_session_ack'), 15_000);
    const originalReceipt = firstEvents.find((event) => event.type === 'start_session_ack');
    const firstClosed = once(first, 'close');

    second = new WebSocket(url, options);
    second.on('message', (data) => secondEvents.push(JSON.parse(String(data))));
    await once(second, 'open');
    second.send(JSON.stringify(start));
    await waitFor(() => secondEvents.some((event) => event.type === 'start_session_ack'), 15_000);
    await firstClosed;

    const duplicateReceipt = secondEvents.find((event) => event.type === 'start_session_ack');
    assert.equal(duplicateReceipt.idempotentReplay, true);
    assert.equal(duplicateReceipt.sessionID, originalReceipt.sessionID);
    assert.equal(duplicateReceipt.serverGeneration, originalReceipt.serverGeneration);
    assert.equal(duplicateReceipt.protocolSequence, originalReceipt.protocolSequence);
    const afterMetrics = outerHFIntegration.credentialBoundaryRuntimeSnapshot();
    assert.equal(afterMetrics.startSessionApplications - beforeMetrics.startSessionApplications, 1);
  } finally {
    if (first.readyState === WebSocket.OPEN) first.close(1000, 'test complete');
    if (second?.readyState === WebSocket.OPEN) {
      const closed = once(second, 'close');
      second.close(1000, 'test complete');
      await closed;
    }
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('resume_session handoff reconciles and replays a persisted rendered-audio cursor', async () => {
  const { httpServer, wsPath } = outerHFIntegration;
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  const url = `ws://127.0.0.1:${address.port}${wsPath}`;
  const options = { headers: { Authorization: 'Bearer outer-hf-test-token' } };
  const firstEvents = [];
  const secondEvents = [];
  const first = new WebSocket(url, options);
  let second = null;
  first.on('message', (data) => firstEvents.push(JSON.parse(String(data))));
  try {
    await once(first, 'open');
    first.send(JSON.stringify({
      type: 'start_session',
      protocolVersion: 1,
      clientSessionID: 'resume-handoff-client',
      clientGeneration: 3,
      configRevision: 2,
      transportOperationID: 'resume-handoff-operation',
      wireFormat,
      companionVoice: false,
    }));
    await waitFor(() => firstEvents.some((event) => event.type === 'start_session_ack'), 15_000);
    await waitFor(() => firstEvents.some((event) => event.status === 'ready'), 15_000);
    const startReceipt = firstEvents.find((event) => event.type === 'start_session_ack');
    first.send(JSON.stringify({
      type: 'rendered_audio_ack',
      controlSequence: 1,
      controlID: 'resume-render-control',
      generation: startReceipt.serverGeneration,
      responseID: 'resume-render-response',
      streamID: 'resume-render-response:audio:0',
      chunkID: 'resume-render-response:audio:0:chunk:0',
      chunkSequence: 0,
      frameCursor: 160,
      byteCursor: 320,
      state: 'rendering',
    }));
    await waitFor(() => firstEvents.some((event) => event.controlID === 'resume-render-control'), 5_000);
    const renderedAudioAck = firstEvents.find(
      (event) => event.controlID === 'resume-render-control',
    ).renderedAudioAck;
    const protocolCursor = Math.max(
      ...firstEvents.map((event) => Number(event.protocolSequence || 0)),
    );

    const firstClosed = once(first, 'close');
    first.terminate();
    await firstClosed;

    second = new WebSocket(url, options);
    second.on('message', (data) => secondEvents.push(JSON.parse(String(data))));
    await once(second, 'open');
    const resume = {
      type: 'resume_session',
      resumeSchemaVersion: 1,
      resumeAttemptID: 'resume-handoff-attempt',
      priorSessionID: startReceipt.sessionID,
      clientSessionID: 'resume-handoff-client',
      clientGeneration: 3,
      serverGeneration: startReceipt.serverGeneration,
      configRevision: startReceipt.configRevision,
      transportOperationID: 'resume-handoff-operation',
      wireFormat,
      lastAcknowledgedInboundProtocolSequence: protocolCursor,
      lastCommittedInput: null,
      lastAcceptedResponse: null,
      lastRenderedAudioAck: renderedAudioAck,
      controlCursor: 1,
    };
    second.send(JSON.stringify(resume));
    await waitFor(() => secondEvents.some((event) => event.type === 'resume_result'), 5_000);
    second.send(JSON.stringify(resume));
    await waitFor(() => secondEvents.filter((event) => event.type === 'resume_result').length === 2, 5_000);

    const results = secondEvents.filter((event) => event.type === 'resume_result');
    assert.equal(results[0].status, 'resumed');
    assert.equal(results[0].renderedAudioReconciliation, 'matched');
    assert.deepEqual(results[0].lastRenderedAudioAck, renderedAudioAck);
    assert.equal(results[0].idempotentReplay, false);
    assert.equal(results[1].idempotentReplay, true);
    assert.deepEqual(results[1].lastRenderedAudioAck, renderedAudioAck);
  } finally {
    if (first.readyState === WebSocket.OPEN) first.close(1000, 'test complete');
    if (second?.readyState === WebSocket.OPEN) {
      const closed = once(second, 'close');
      second.close(1000, 'test complete');
      await closed;
    }
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
