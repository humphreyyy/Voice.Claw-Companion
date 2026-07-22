import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VOICE_STREAM_RESUME_SCHEMA_VERSION,
  VOICE_STREAM_WIRE_FORMAT,
  VoiceStartSessionHandshakeRegistry,
  VoiceStreamResumeRegistry,
  VoiceStreamResumeSession,
  normalizeVoiceStreamWireFormat,
  voiceStreamOutputCapacityDecision,
} from '../server/voice-stream-resume.js';

const identity = {
  sessionID: 'server-session-1',
  clientSessionID: 'client-session-1',
  clientGeneration: 7,
  serverGeneration: 3,
  configRevision: 2,
  transportOperationID: '00000000-0000-0000-0000-000000000001',
  wireFormat: VOICE_STREAM_WIRE_FORMAT,
};

function fixture(options = {}) {
  let now = options.now ?? 1_900_000_000_000;
  const registry = new VoiceStreamResumeRegistry({
    now: () => now,
    scheduleTimers: false,
    ...options,
  });
  const owner = { attach() {} };
  const session = registry.createSession(identity, { owner });
  return {
    registry,
    session,
    owner,
    advance(milliseconds) { now += milliseconds; },
  };
}

function resumeEnvelope(overrides = {}) {
  return {
    type: 'resume_session',
    resumeSchemaVersion: VOICE_STREAM_RESUME_SCHEMA_VERSION,
    resumeAttemptID: 'resume-attempt-1',
    priorSessionID: identity.sessionID,
    clientSessionID: identity.clientSessionID,
    clientGeneration: identity.clientGeneration,
    serverGeneration: identity.serverGeneration,
    configRevision: identity.configRevision,
    transportOperationID: identity.transportOperationID,
    wireFormat: VOICE_STREAM_WIRE_FORMAT,
    lastAcknowledgedInboundProtocolSequence: 0,
    lastCommittedInput: null,
    lastAcceptedResponse: null,
    controlCursor: 0,
    ...overrides,
  };
}

test('disconnect mid-speech resumes at the next exact audio sequence without retaining PCM', () => {
  const { registry, session } = fixture();
  session.declareAudioFrame({ turnID: 'input-turn-1', audioSequence: 1, byteCount: 640 });
  assert.deepEqual(session.consumeAudioFrame(640), {
    accepted: true,
    duplicate: false,
    turnID: 'input-turn-1',
    audioSequence: 1,
  });
  session.detach('network-loss');

  const result = registry.prepareResume(resumeEnvelope());
  assert.equal(result.response.status, 'resumed');
  assert.deepEqual(result.response.nextExpectedAudio, {
    turnID: 'input-turn-1',
    audioSequence: 2,
  });
  assert.equal(result.response.lastCommittedInput, null);
  assert.equal(result.response.gap, null);
  assert.equal(session.snapshot().retainedEventBytes, 0);
});

test('disconnect mid-output fails closed when replay would cross non-replayable aligned audio', () => {
  const { registry, session } = fixture();
  const reply = session.recordEvent({
    type: 'reply',
    text: 'A response in progress.',
    turnID: 'turn-1',
    responseID: 'response-1',
  });
  session.recordEvent({
    type: 'tts_audio_start',
    turnID: 'turn-1',
    responseID: 'response-1',
    sampleRate: 24_000,
    channels: 1,
    encoding: 'pcm_s16le',
  });
  session.recordEvent({
    type: 'audio_chunk',
    turnID: 'turn-1',
    responseID: 'response-1',
    audio: { chunkID: 'chunk-1', byteCount: 320 },
  });
  session.detach('network-loss');

  const result = registry.prepareResume(resumeEnvelope({
    lastAcknowledgedInboundProtocolSequence: reply.protocolSequence,
    lastAcceptedResponse: {
      turnID: 'turn-1',
      responseID: 'response-1',
      protocolSequence: reply.protocolSequence,
    },
  }));
  assert.equal(result.response.status, 'gap');
  assert.equal(result.response.code, 'RESUME_CRITICAL_GAP');
  assert.deepEqual(result.response.gap.criticalKinds, ['audio_alignment']);
  assert.deepEqual(result.replay, []);
});

test('disconnect mid-tool replays the original tool identity and protocol sequence', () => {
  const { registry, session } = fixture();
  session.recordEvent({ type: 'status', status: 'thinking' });
  const tool = session.recordEvent({
    type: 'iphone_tool',
    callID: 'call-42',
    name: 'create_reminder',
    lifecycle: 'requested',
    lifecycleRevision: 1,
    turnID: 'turn-2',
    responseID: 'response-2',
  });
  session.detach('network-loss');

  const result = registry.prepareResume(resumeEnvelope({
    lastAcknowledgedInboundProtocolSequence: 1,
  }));
  assert.equal(result.response.status, 'resumed');
  assert.equal(result.replay.length, 1);
  assert.deepEqual(result.replay[0], tool);
  assert.equal(result.replay[0].callID, 'call-42');
  assert.equal(result.response.active.state, 'tool');
});

test('stale generation and transport operation are stable typed rejections', () => {
  const { registry, session } = fixture();
  session.detach('network-loss');

  const staleGeneration = registry.prepareResume(resumeEnvelope({ clientGeneration: 6 }));
  assert.equal(staleGeneration.response.status, 'rejected');
  assert.equal(staleGeneration.response.code, 'STALE_GENERATION');
  assert.equal(staleGeneration.response.nextExpectedControlSequence, 1);
  assert.deepEqual(staleGeneration.response.nextExpectedAudio, {
    turnID: null,
    audioSequence: 1,
  });
  assert.deepEqual(staleGeneration.response.replay.eventSequences, []);
  assert.equal(staleGeneration.response.active.state, 'idle');

  const staleOperation = registry.prepareResume(resumeEnvelope({
    resumeAttemptID: 'resume-attempt-2',
    transportOperationID: '00000000-0000-0000-0000-000000000099',
  }));
  assert.equal(staleOperation.response.status, 'rejected');
  assert.equal(staleOperation.response.code, 'STALE_TRANSPORT_OPERATION');
});

test('a rejected resume attempt is receipted and replayed without observing later mutations', () => {
  const { registry, session } = fixture();
  session.detach('network-loss');
  const request = resumeEnvelope({ clientGeneration: 6 });

  const first = registry.prepareResume(request);
  session.recordEvent({ type: 'status', status: 'changed-after-rejection' });
  const duplicate = registry.prepareResume(request);

  assert.equal(first.response.status, 'rejected');
  assert.equal(first.response.idempotentReplay, false);
  assert.equal(duplicate.response.status, 'rejected');
  assert.equal(duplicate.response.idempotentReplay, true);
  assert.equal(duplicate.response.latestProtocolSequence, first.response.latestProtocolSequence);
  assert.throws(
    () => session.resume({ ...request, controlCursor: 1 }),
    (error) => error?.code === 'RESUME_IDEMPOTENCY_CONFLICT',
  );
});

test('duplicate resume attempt is idempotent and preserves replay identities', () => {
  const { registry, session } = fixture();
  const transcript = session.recordEvent({
    type: 'transcript',
    text: 'Hello',
    final: false,
    turnID: 'turn-3',
  });
  session.detach('network-loss');
  const request = resumeEnvelope();

  const first = registry.prepareResume(request);
  session.detach('resume-response-lost');
  const duplicate = registry.prepareResume(request);
  assert.equal(first.response.status, 'resumed');
  assert.equal(first.response.idempotentReplay, false);
  assert.equal(duplicate.response.status, 'resumed');
  assert.equal(duplicate.response.idempotentReplay, true);
  assert.deepEqual(duplicate.replay, first.replay);
  assert.deepEqual(duplicate.replay, [transcript]);
  assert.equal(session.snapshot().state, 'attached');
  assert.equal(session.snapshot().expiresAt, null);
});

test('eviction of a final transcript produces an explicit critical gap', () => {
  const { registry, session } = fixture({ maxEventsPerSession: 8 });
  session.recordEvent({
    type: 'transcript',
    text: 'Final user words.',
    final: true,
    turnID: 'turn-final',
  });
  for (let index = 0; index < 9; index += 1) {
    session.recordEvent({ type: 'status', status: `status-${index}` });
  }
  session.detach('network-loss');

  const result = registry.prepareResume(resumeEnvelope());
  assert.equal(result.response.status, 'gap');
  assert.equal(result.response.gap.reasons.includes('critical_event_evicted'), true);
  assert.equal(result.response.gap.criticalKinds.includes('final_transcript'), true);
});

test('committed input is acknowledged once and duplicate audio never reaches the runtime', () => {
  const { registry, session } = fixture();
  session.declareAudioFrame({ turnID: 'input-turn-4', audioSequence: 1, byteCount: 320 });
  session.consumeAudioFrame(320);
  const commit = session.commitInput({ turnID: 'input-turn-4', audioSequence: 1 });
  const duplicateCommit = session.commitInput({ turnID: 'input-turn-4', audioSequence: 1 });
  assert.equal(commit.duplicate, false);
  assert.equal(duplicateCommit.duplicate, true);
  assert.deepEqual(duplicateCommit.event, commit.event);

  session.detach('network-loss');
  const result = registry.prepareResume(resumeEnvelope({
    lastCommittedInput: { turnID: 'input-turn-4', audioSequence: 1 },
  }));
  assert.equal(result.response.status, 'resumed');
  assert.deepEqual(result.response.lastCommittedInput, {
    turnID: 'input-turn-4',
    audioSequence: 1,
  });
  assert.deepEqual(result.response.nextExpectedAudio, { turnID: null, audioSequence: 1 });

  session.declareAudioFrame({ turnID: 'input-turn-4', audioSequence: 1, byteCount: 320 });
  assert.equal(session.consumeAudioFrame(320).duplicate, true);
});

test('interrupt acknowledgement survives disconnect and duplicate recovery is side-effect free', () => {
  const { registry, session } = fixture();
  const interrupt = {
    type: 'interrupt',
    reason: 'client-barge-in',
    controlSequence: 1,
    controlID: 'control-interrupt-1',
  };
  const handle = session.beginControl(interrupt);
  assert.equal(handle.execute, true);
  const ack = session.completeControl(handle, { status: 'applied' });
  session.detach('ack-lost');

  const result = registry.prepareResume(resumeEnvelope());
  assert.equal(result.response.status, 'resumed');
  assert.equal(result.response.acknowledgedControlCursor, 1);
  assert.equal(result.response.nextExpectedControlSequence, 2);
  assert.deepEqual(result.replay, [ack]);

  const duplicate = session.beginControl(interrupt);
  assert.equal(duplicate.execute, false);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.event, ack);
});

test('a disconnect between frame declaration and binary payload cannot resume silently', () => {
  const { registry, session } = fixture();
  session.declareAudioFrame({ turnID: 'input-turn-5', audioSequence: 1, byteCount: 640 });
  session.detach('network-loss');

  const result = registry.prepareResume(resumeEnvelope());
  assert.equal(result.response.status, 'gap');
  assert.equal(result.response.gap.reasons.includes('input_audio_gap'), true);
  assert.equal(result.response.gap.input.code, 'INPUT_FRAME_IN_FLIGHT');
});

test('a pending input frame cannot be replaced by a duplicate from a committed turn', () => {
  const { session } = fixture();
  session.declareAudioFrame({ turnID: 'committed-turn', audioSequence: 1, byteCount: 320 });
  session.consumeAudioFrame(320);
  session.commitInput({ turnID: 'committed-turn', audioSequence: 1 });
  session.declareAudioFrame({ turnID: 'active-turn', audioSequence: 1, byteCount: 640 });

  assert.throws(
    () => session.declareAudioFrame({ turnID: 'committed-turn', audioSequence: 1, byteCount: 320 }),
    (error) => error?.code === 'INPUT_FRAME_DECLARATION_OVERLAP',
  );
  assert.deepEqual(session.consumeAudioFrame(640), {
    accepted: true,
    duplicate: false,
    turnID: 'active-turn',
    audioSequence: 1,
  });
});

test('duplicate input audio must preserve the accepted frame byte count', () => {
  const { session } = fixture();
  session.declareAudioFrame({ turnID: 'input-idempotency', audioSequence: 1, byteCount: 320 });
  session.consumeAudioFrame(320);

  assert.throws(
    () => session.declareAudioFrame({ turnID: 'input-idempotency', audioSequence: 1, byteCount: 640 }),
    (error) => error?.code === 'INPUT_AUDIO_IDEMPOTENCY_CONFLICT',
  );
});

test('an interrupted duplicate frame retry does not create a false input gap', () => {
  const { registry, session } = fixture();
  session.declareAudioFrame({ turnID: 'input-duplicate', audioSequence: 1, byteCount: 320 });
  session.consumeAudioFrame(320);
  session.declareAudioFrame({ turnID: 'input-duplicate', audioSequence: 1, byteCount: 320 });
  session.detach('duplicate-frame-disconnected');

  const result = registry.prepareResume(resumeEnvelope());
  assert.equal(result.response.status, 'resumed');
  assert.deepEqual(result.response.nextExpectedAudio, {
    turnID: 'input-duplicate',
    audioSequence: 2,
  });
});

test('unframed audio after framed mode begins is rejected before runtime admission', () => {
  const { session } = fixture();
  session.declareAudioFrame({ turnID: 'input-turn-6', audioSequence: 1, byteCount: 320 });
  session.consumeAudioFrame(320);

  assert.throws(
    () => session.consumeAudioFrame(320),
    (error) => error?.code === 'UNFRAMED_INPUT_AUDIO',
  );
  assert.equal(session.snapshot().inputGap.code, 'UNFRAMED_INPUT_AUDIO');
});

test('bounded journals enforce event count and memory caps without retaining oversized payloads', () => {
  const session = new VoiceStreamResumeSession(identity, {
    scheduleTimers: false,
    maxEventsPerSession: 8,
    maxEventBytes: 1_024,
    maxBytesPerSession: 16_000,
  });
  for (let index = 0; index < 40; index += 1) {
    session.recordEvent({
      type: 'status',
      status: `event-${index}`,
      diagnostic: 'x'.repeat(index === 39 ? 10_000 : 64),
    });
  }
  const snapshot = session.snapshot();
  assert.ok(snapshot.retainedEventCount <= 8);
  assert.ok(snapshot.retainedEventBytes <= 16_000);
  assert.equal(snapshot.retainedThroughProtocolSequence, 40);
});

test('duplicate-resume receipts have an independent retention and memory cap', () => {
  const session = new VoiceStreamResumeSession(identity, {
    scheduleTimers: false,
    maxEventsPerSession: 32,
    maxEventBytes: 8_000,
    maxBytesPerSession: 16_000,
    maxResumeReceipts: 32,
    maxResumeReceiptBytes: 16_000,
  });
  for (let index = 0; index < 8; index += 1) {
    session.recordEvent({
      type: 'status',
      status: `receipt-event-${index}`,
      diagnostic: 'r'.repeat(512),
    });
  }
  for (let index = 0; index < 12; index += 1) {
    const outcome = session.resume(resumeEnvelope({
      resumeAttemptID: `bounded-receipt-${index}`,
    }));
    assert.equal(outcome.response.status, 'resumed');
  }

  const snapshot = session.snapshot();
  assert.ok(snapshot.retainedResumeReceiptCount < 12);
  assert.ok(snapshot.retainedResumeReceiptBytes <= 16_000);
});

test('output pressure is decided before audio preparation and produces no hidden protocol sequence', () => {
  const { session } = fixture();
  const fakeSocket = { bufferedAmount: 1_500 };
  let pendingGap = null;
  let prepareCount = 0;

  const submit = (byteCount) => {
    const decision = voiceStreamOutputCapacityDecision({
      bufferedAmount: fakeSocket.bufferedAmount,
      binaryByteCount: byteCount,
      eventBudgetByteCount: 256,
      highWaterBytes: 2_000,
      hardLimitBytes: 4_000,
    });
    if (!decision.admitted) {
      pendingGap = pendingGap || { droppedFrames: 0, droppedBytes: 0 };
      pendingGap.droppedFrames += 1;
      pendingGap.droppedBytes += byteCount;
      return false;
    }
    if (pendingGap) {
      session.recordEvent({ type: 'audio_gap', phase: 'complete', ...pendingGap });
      pendingGap = null;
    }
    prepareCount += 1;
    session.recordEvent({ type: 'audio_chunk', audio: { byteCount } });
    return true;
  };

  assert.equal(submit(320), false);
  assert.equal(prepareCount, 0);
  assert.equal(session.snapshot().protocolSequence, 0);

  fakeSocket.bufferedAmount = 0;
  assert.equal(submit(320), true);
  assert.equal(prepareCount, 1);
  assert.deepEqual(
    session.events.map((record) => ({ sequence: record.sequence, type: record.type })),
    [
      { sequence: 1, type: 'audio_gap' },
      { sequence: 2, type: 'audio_chunk' },
    ],
  );
});

test('start_session handshake is idempotent across an outcome-unknown retry', async () => {
  const registry = new VoiceStartSessionHandshakeRegistry({ scheduleTimers: false });
  const owner = { id: 'retained-runtime' };
  const request = {
    type: 'start_session',
    clientSessionID: 'client-session-start',
    clientGeneration: 4,
    transportOperationID: 'transport-operation-start',
    wireFormat: VOICE_STREAM_WIRE_FORMAT,
  };
  let runtimeStarts = 0;
  const first = registry.begin({
    authenticatedClientIdentity: 'authenticated-client-fingerprint',
    transportOperationID: request.transportOperationID,
    request,
    owner,
  });
  assert.equal(first.execute, true);
  runtimeStarts += 1;

  const retryWhileOutcomeUnknown = registry.begin({
    authenticatedClientIdentity: 'authenticated-client-fingerprint',
    transportOperationID: request.transportOperationID,
    request,
    owner: { id: 'replacement-runtime-must-not-start' },
  });
  assert.equal(retryWhileOutcomeUnknown.execute, false);
  assert.equal(retryWhileOutcomeUnknown.receipt, null);

  const receipt = {
    type: 'start_session_ack',
    status: 'accepted',
    serverGeneration: 1,
    transportOperationID: request.transportOperationID,
  };
  registry.complete(first, receipt, { owner });
  const completedRetry = await retryWhileOutcomeUnknown.completion;
  assert.deepEqual(completedRetry.receipt, receipt);
  assert.equal(completedRetry.owner, owner);
  assert.equal(runtimeStarts, 1);

  const retryAfterReceipt = registry.begin({
    authenticatedClientIdentity: 'authenticated-client-fingerprint',
    transportOperationID: request.transportOperationID,
    request,
  });
  assert.equal(retryAfterReceipt.execute, false);
  assert.deepEqual(retryAfterReceipt.receipt, receipt);
  assert.equal(runtimeStarts, 1);
});

test('start_session idempotency key rejects payload drift and isolates authenticated clients', () => {
  const registry = new VoiceStartSessionHandshakeRegistry();
  const request = {
    type: 'start_session',
    transportOperationID: 'shared-operation',
    wireFormat: VOICE_STREAM_WIRE_FORMAT,
  };
  registry.begin({
    authenticatedClientIdentity: 'client-a',
    transportOperationID: request.transportOperationID,
    request,
  });
  assert.throws(
    () => registry.begin({
      authenticatedClientIdentity: 'client-a',
      transportOperationID: request.transportOperationID,
      request: { ...request, companionVoice: true },
    }),
    (error) => error?.code === 'START_SESSION_IDEMPOTENCY_CONFLICT',
  );
  assert.equal(registry.begin({
    authenticatedClientIdentity: 'client-b',
    transportOperationID: request.transportOperationID,
    request,
  }).execute, true);
});

test('a failed start_session outcome is retained and does not execute again', async () => {
  const registry = new VoiceStartSessionHandshakeRegistry({ scheduleTimers: false });
  const request = {
    type: 'start_session',
    transportOperationID: 'failed-start-operation',
    wireFormat: VOICE_STREAM_WIRE_FORMAT,
  };
  const first = registry.begin({
    authenticatedClientIdentity: 'failed-start-client',
    transportOperationID: request.transportOperationID,
    request,
  });
  const failure = new Error('admission failed');
  failure.code = 'START_ADMISSION_FAILED';
  registry.fail(first, failure);

  const retry = registry.begin({
    authenticatedClientIdentity: 'failed-start-client',
    transportOperationID: request.transportOperationID,
    request,
  });
  assert.equal(retry.execute, false);
  assert.equal(retry.duplicate, true);
  assert.equal((await retry.completion).error, failure);
  assert.equal(registry.snapshot()[0].state, 'failed');
});

test('wire format admission requires the immutable 16 kHz mono PCM contract', () => {
  assert.deepEqual(normalizeVoiceStreamWireFormat(VOICE_STREAM_WIRE_FORMAT), {
    sampleRate: 16_000,
    channels: 1,
    encoding: 'pcm_s16le',
    bytesPerSample: 2,
  });
  assert.throws(
    () => normalizeVoiceStreamWireFormat({
      ...VOICE_STREAM_WIRE_FORMAT,
      sampleRate: 24_000,
    }),
    (error) => error?.code === 'UNSUPPORTED_AUDIO_FORMAT',
  );
  assert.throws(
    () => normalizeVoiceStreamWireFormat({
      ...VOICE_STREAM_WIRE_FORMAT,
      sampleRate: '16000',
    }),
    (error) => error?.code === 'UNSUPPORTED_AUDIO_FORMAT',
  );
  assert.throws(
    () => normalizeVoiceStreamWireFormat({
      ...VOICE_STREAM_WIRE_FORMAT,
      encoding: 'PCM_S16LE',
    }),
    (error) => error?.code === 'UNSUPPORTED_AUDIO_FORMAT',
  );

  const { registry, session } = fixture();
  session.detach('network-loss');
  const mismatch = registry.prepareResume(resumeEnvelope({
    wireFormat: { ...VOICE_STREAM_WIRE_FORMAT, channels: 2 },
  }));
  assert.equal(mismatch.response.status, 'rejected');
  assert.equal(mismatch.response.code, 'UNSUPPORTED_AUDIO_FORMAT');
  assert.deepEqual(session.snapshot().wireFormat, VOICE_STREAM_WIRE_FORMAT);
  assert.equal(Object.isFrozen(session.wireFormat), true);
  assert.throws(() => {
    session.wireFormat.sampleRate = 24_000;
  }, TypeError);
  const forged = session.recordEvent({
    type: 'status',
    serverGeneration: 99,
    wireFormat: { ...VOICE_STREAM_WIRE_FORMAT, sampleRate: 24_000 },
  });
  assert.equal(forged.serverGeneration, identity.serverGeneration);
  assert.deepEqual(forged.wireFormat, VOICE_STREAM_WIRE_FORMAT);
});

test('rendered audio progress is monotonic, durable, and returned by resume_result', () => {
  const { registry, session } = fixture();
  const first = {
    type: 'rendered_audio_ack',
    generation: identity.serverGeneration,
    responseID: 'response-render-1',
    streamID: 'response-render-1:audio:0',
    chunkID: 'response-render-1:audio:0:chunk:0',
    chunkSequence: 0,
    frameCursor: 160,
    byteCursor: 320,
    state: 'rendering',
  };
  assert.equal(session.recordRenderedAudioAck(first).duplicate, false);
  assert.equal(session.recordRenderedAudioAck(first).duplicate, true);
  assert.throws(
    () => session.recordRenderedAudioAck({ ...first, frameCursor: 159 }),
    (error) => error?.code === 'RENDER_CURSOR_REGRESSION',
  );
  assert.throws(
    () => session.recordRenderedAudioAck({ ...first, chunkID: 'different-chunk-id', frameCursor: 200, byteCursor: 400 }),
    (error) => error?.code === 'RENDER_CHUNK_ID_CONFLICT',
  );
  assert.throws(
    () => session.recordRenderedAudioAck({ ...first, chunkSequence: 1, frameCursor: 200, byteCursor: 400 }),
    (error) => error?.code === 'RENDER_CHUNK_ID_CONFLICT',
  );
  assert.throws(
    () => session.recordRenderedAudioAck({ ...first, state: 'interrupted', final: true }),
    (error) => error?.code === 'INVALID_RENDERED_AUDIO_ACK',
  );
  const final = {
    ...first,
    chunkID: 'response-render-1:audio:0:chunk:1',
    chunkSequence: 1,
    frameCursor: 320,
    byteCursor: 640,
    state: 'final',
  };
  session.recordRenderedAudioAck(final);
  session.detach('network-loss');

  const result = registry.prepareResume(resumeEnvelope({ lastRenderedAudioAck: first }));
  assert.equal(result.response.status, 'resumed');
  assert.equal(result.response.renderedAudioReconciliation, 'server_ahead');
  const { type: _transportType, ...canonicalFinal } = final;
  assert.deepEqual(result.response.lastRenderedAudioAck, {
    ...canonicalFinal,
    final: true,
    interrupted: false,
  });
  assert.deepEqual(session.snapshot().lastRenderedAudioAck, result.response.lastRenderedAudioAck);
});

test('rendered audio resume reconciliation rejects ahead, divergent, and foreign cursors', () => {
  const cases = [
    {
      expected: 'RENDER_CURSOR_AHEAD',
      update: { frameCursor: 321, byteCursor: 642 },
    },
    {
      expected: 'RENDER_CURSOR_DIVERGED',
      update: { chunkSequence: 2, frameCursor: 319, byteCursor: 638 },
    },
    {
      expected: 'RENDER_STREAM_MISMATCH',
      update: { responseID: 'foreign-response', streamID: 'foreign-stream' },
    },
  ];

  for (const [index, entry] of cases.entries()) {
    const { registry, session } = fixture();
    const retained = {
      generation: identity.serverGeneration,
      responseID: 'response-render-reconcile',
      streamID: 'response-render-reconcile:audio:0',
      chunkID: 'response-render-reconcile:audio:0:chunk:1',
      chunkSequence: 1,
      frameCursor: 320,
      byteCursor: 640,
      state: 'rendering',
    };
    session.recordRenderedAudioAck(retained);
    session.detach('network-loss');
    const result = registry.prepareResume(resumeEnvelope({
      resumeAttemptID: `render-reconcile-${index}`,
      lastRenderedAudioAck: { ...retained, ...entry.update },
    }));
    assert.equal(result.response.status, 'rejected');
    assert.equal(result.response.code, entry.expected);
  }
});

test('rendered audio control receipts echo the exact persisted cursor', () => {
  const { session } = fixture();
  const message = {
    type: 'rendered_audio_ack',
    controlSequence: 1,
    controlID: 'render-control-1',
    generation: identity.serverGeneration,
    responseID: 'response-render-receipt',
    streamID: 'response-render-receipt:audio:0',
    chunkID: 'response-render-receipt:audio:0:chunk:0',
    chunkSequence: 0,
    frameCursor: 160,
    byteCursor: 320,
    state: 'rendering',
  };
  const handle = session.beginControl(message);
  const rendered = session.recordRenderedAudioAck(message);
  const receipt = session.completeControl(handle, {
    status: 'applied',
    code: 'RENDERED_AUDIO_ACK_RETAINED',
    renderedAudioAck: rendered.acknowledgement,
  });

  assert.deepEqual(receipt.renderedAudioAck, rendered.acknowledgement);
  assert.deepEqual(session.snapshot().lastRenderedAudioAck, rendered.acknowledgement);
});
