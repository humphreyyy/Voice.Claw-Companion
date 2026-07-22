import { createHash } from 'node:crypto';

export const VOICE_STREAM_RESUME_SCHEMA_VERSION = 1;

export const VOICE_STREAM_WIRE_FORMAT = Object.freeze({
  sampleRate: 16_000,
  channels: 1,
  encoding: 'pcm_s16le',
  bytesPerSample: 2,
});

export const VOICE_STREAM_RESUME_DEFAULTS = Object.freeze({
  retentionMs: 30_000,
  maxSessions: 64,
  maxEventsPerSession: 512,
  maxEventBytes: 128_000,
  maxBytesPerSession: 1_000_000,
  maxControlReceipts: 256,
  maxResumeReceipts: 32,
  maxResumeReceiptBytes: 2_000_000,
  maxInputFrameReceipts: 4_096,
});

const SENSITIVE_KEYS = new Set([
  'apiKey',
  'bearerToken',
  'gatewayPassword',
  'gatewayToken',
  'openAIAPIKey',
  'password',
  'token',
]);

const ALIGNMENT_EVENT_TYPES = new Set([
  'audio_chunk',
  'audio_gap',
  'text_audio_alignment',
  'tts_audio_start',
  'tts_audio_end',
]);

const TOOL_EVENT_TYPES = new Set([
  'iphone_tool',
  'iphone_tool_result',
  'tool_call',
  'tool_lifecycle',
  'tool_result',
]);

const RESULT_EVENT_TYPES = new Set([
  'companion_voice_result',
  'result',
]);

const RENDERED_AUDIO_TERMINAL_STATES = new Set(['final', 'interrupted']);

export class VoiceStreamResumeError extends Error {
  constructor(code, message, details = {}, { recoverable = false } = {}) {
    super(message);
    this.name = 'VoiceStreamResumeError';
    this.code = code;
    this.details = details;
    this.recoverable = recoverable;
  }
}

function cloneJSON(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function nonNegativeInteger(value, field, { required = true } = {}) {
  if ((value === undefined || value === null || value === '') && !required) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new VoiceStreamResumeError(
      'INVALID_RESUME_ENVELOPE',
      `${field} must be a non-negative safe integer.`,
      { field },
    );
  }
  return parsed;
}

function positiveInteger(value, field) {
  const parsed = nonNegativeInteger(value, field);
  if (parsed < 1) {
    throw new VoiceStreamResumeError(
      'INVALID_RESUME_ENVELOPE',
      `${field} must be greater than zero.`,
      { field },
    );
  }
  return parsed;
}

function requiredString(value, field, maximumLength = 256) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new VoiceStreamResumeError(
      'INVALID_RESUME_ENVELOPE',
      `${field} must be a non-empty string no longer than ${maximumLength} characters.`,
      { field },
    );
  }
  return normalized;
}

function optionalString(value, maximumLength = 256) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, maximumLength);
}

export function normalizeVoiceStreamWireFormat(value, field = 'wireFormat') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VoiceStreamResumeError(
      'UNSUPPORTED_AUDIO_FORMAT',
      `${field} must declare the Companion voice PCM wire format.`,
      { expected: VOICE_STREAM_WIRE_FORMAT, received: value ?? null },
    );
  }
  const normalized = {
    sampleRate: value.sampleRate,
    channels: value.channels,
    encoding: value.encoding,
    bytesPerSample: value.bytesPerSample,
  };
  const matches = Object.entries(VOICE_STREAM_WIRE_FORMAT)
    .every(([key, expected]) => normalized[key] === expected);
  if (!matches) {
    throw new VoiceStreamResumeError(
      'UNSUPPORTED_AUDIO_FORMAT',
      'Companion Realtime Voice requires 16 kHz mono signed 16-bit little-endian PCM.',
      { expected: VOICE_STREAM_WIRE_FORMAT, received: normalized },
    );
  }
  return { ...VOICE_STREAM_WIRE_FORMAT };
}

function sameWireFormat(left, right) {
  return Object.entries(VOICE_STREAM_WIRE_FORMAT)
    .every(([key]) => left?.[key] === right?.[key]);
}

function normalizeRenderedAudioAck(value, field = 'renderedAudioAck', { required = true } = {}) {
  if ((value === undefined || value === null) && !required) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VoiceStreamResumeError(
      'INVALID_RENDERED_AUDIO_ACK',
      `${field} must be an object.`,
      { field },
    );
  }
  const final = value.final === true;
  const interrupted = value.interrupted === true;
  const rawState = String(value.state ?? value.disposition ?? value.status ?? '').trim().toLowerCase();
  const state = interrupted ? 'interrupted' : (final ? 'final' : (rawState || 'rendering'));
  const flagStateConflict = (final && rawState && rawState !== 'final')
    || (interrupted && rawState && rawState !== 'interrupted');
  if (!['rendering', 'final', 'interrupted'].includes(state)
      || (final && interrupted)
      || flagStateConflict) {
    throw new VoiceStreamResumeError(
      'INVALID_RENDERED_AUDIO_ACK',
      `${field}.state must be rendering, final, or interrupted.`,
      { field: `${field}.state`, received: rawState || null },
    );
  }
  return {
    generation: nonNegativeInteger(
      value.generation ?? value.serverGeneration ?? value.sessionGeneration,
      `${field}.generation`,
    ),
    responseID: requiredString(value.responseID ?? value.responseId, `${field}.responseID`),
    streamID: requiredString(
      value.streamID ?? value.streamId ?? value.audioStreamID,
      `${field}.streamID`,
    ),
    chunkID: requiredString(
      value.chunkID ?? value.chunkId ?? value.audioChunkID,
      `${field}.chunkID`,
    ),
    chunkSequence: nonNegativeInteger(value.chunkSequence, `${field}.chunkSequence`),
    frameCursor: nonNegativeInteger(
      value.frameCursor ?? value.renderedFrameCursor ?? value.renderedFrames,
      `${field}.frameCursor`,
    ),
    byteCursor: nonNegativeInteger(
      value.byteCursor ?? value.renderedByteCursor ?? value.renderedBytes,
      `${field}.byteCursor`,
    ),
    state,
    final: state === 'final',
    interrupted: state === 'interrupted',
  };
}

function reconcileRenderedAudioAck(candidate, retained) {
  if (!candidate) return retained ? 'server_ahead' : 'not_reported';
  if (!retained) {
    throw new VoiceStreamResumeError(
      'RENDER_CURSOR_AHEAD',
      'The client rendered-audio cursor is ahead of server-retained progress.',
      { retained: null, received: cloneJSON(candidate) },
    );
  }
  if (candidate.responseID !== retained.responseID || candidate.streamID !== retained.streamID) {
    throw new VoiceStreamResumeError(
      'RENDER_STREAM_MISMATCH',
      'The client and server rendered-audio cursors refer to different streams.',
      { retained: cloneJSON(retained), received: cloneJSON(candidate) },
    );
  }
  if (candidate.chunkSequence === retained.chunkSequence
      && candidate.chunkID !== retained.chunkID) {
    throw new VoiceStreamResumeError(
      'RENDER_CHUNK_ID_CONFLICT',
      'The client and server disagree about the rendered chunk identity.',
      { retained: cloneJSON(retained), received: cloneJSON(candidate) },
    );
  }
  if (RENDERED_AUDIO_TERMINAL_STATES.has(candidate.state)
      && RENDERED_AUDIO_TERMINAL_STATES.has(retained.state)
      && candidate.state !== retained.state) {
    throw new VoiceStreamResumeError(
      'RENDER_TERMINAL_STATE_CONFLICT',
      'The client and server disagree about the terminal rendered-audio state.',
      { retained: cloneJSON(retained), received: cloneJSON(candidate) },
    );
  }

  const comparisons = [
    candidate.chunkSequence - retained.chunkSequence,
    candidate.frameCursor - retained.frameCursor,
    candidate.byteCursor - retained.byteCursor,
  ];
  const ahead = comparisons.some((comparison) => comparison > 0);
  const behind = comparisons.some((comparison) => comparison < 0);
  if (ahead && behind) {
    throw new VoiceStreamResumeError(
      'RENDER_CURSOR_DIVERGED',
      'Rendered-audio cursors cannot move ahead and behind on different axes.',
      { retained: cloneJSON(retained), received: cloneJSON(candidate) },
    );
  }
  if (ahead || (RENDERED_AUDIO_TERMINAL_STATES.has(candidate.state)
      && !RENDERED_AUDIO_TERMINAL_STATES.has(retained.state))) {
    throw new VoiceStreamResumeError(
      'RENDER_CURSOR_AHEAD',
      'The client rendered-audio cursor is ahead of server-retained progress.',
      { retained: cloneJSON(retained), received: cloneJSON(candidate) },
    );
  }
  if (behind || candidate.state !== retained.state) return 'server_ahead';
  return 'matched';
}

export function voiceStreamOutputCapacityDecision({
  bufferedAmount,
  binaryByteCount,
  eventBudgetByteCount,
  highWaterBytes,
  hardLimitBytes,
} = {}) {
  const buffered = nonNegativeInteger(bufferedAmount ?? 0, 'bufferedAmount');
  const binary = nonNegativeInteger(binaryByteCount ?? 0, 'binaryByteCount');
  const eventBudget = nonNegativeInteger(eventBudgetByteCount ?? 0, 'eventBudgetByteCount');
  const highWater = positiveInteger(highWaterBytes, 'highWaterBytes');
  const hardLimit = positiveInteger(hardLimitBytes, 'hardLimitBytes');
  if (hardLimit <= highWater) {
    throw new VoiceStreamResumeError(
      'INVALID_OUTPUT_CAPACITY',
      'hardLimitBytes must be greater than highWaterBytes.',
    );
  }
  const projectedBytes = buffered + binary + eventBudget;
  return {
    admitted: projectedBytes < highWater,
    hardFailure: projectedBytes >= hardLimit,
    projectedBytes,
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    if (!SENSITIVE_KEYS.has(key)) result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function fingerprint(value) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function sameIdentityValue(left, right) {
  return String(left ?? '') === String(right ?? '');
}

function normalizeCommit(value, field = 'lastCommittedInput') {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VoiceStreamResumeError(
      'INVALID_RESUME_ENVELOPE',
      `${field} must be an object or null.`,
      { field },
    );
  }
  return {
    turnID: requiredString(value.turnID ?? value.turnId, `${field}.turnID`),
    audioSequence: nonNegativeInteger(value.audioSequence, `${field}.audioSequence`),
  };
}

function sameCommit(left, right) {
  if (!left || !right) return left === right;
  return left.turnID === right.turnID && left.audioSequence === right.audioSequence;
}

function sequenceRanges(sequences) {
  const sorted = [...new Set(sequences)].sort((left, right) => left - right);
  const ranges = [];
  for (const sequence of sorted) {
    const current = ranges.at(-1);
    if (current && sequence === current.throughProtocolSequence + 1) {
      current.throughProtocolSequence = sequence;
    } else {
      ranges.push({
        fromProtocolSequence: sequence,
        throughProtocolSequence: sequence,
      });
    }
  }
  return ranges;
}

function normalizeAcceptedResponse(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VoiceStreamResumeError(
      'INVALID_RESUME_ENVELOPE',
      'lastAcceptedResponse must be an object or null.',
      { field: 'lastAcceptedResponse' },
    );
  }
  return {
    turnID: optionalString(value.turnID ?? value.turnId),
    responseID: requiredString(value.responseID ?? value.responseId, 'lastAcceptedResponse.responseID'),
    protocolSequence: nonNegativeInteger(
      value.protocolSequence,
      'lastAcceptedResponse.protocolSequence',
      { required: false },
    ),
  };
}

function eventHazard(event) {
  const type = String(event?.type || '');
  if (type === 'transcript' && event.final === true) return 'final_transcript';
  if (type === 'interrupted') return 'interruption';
  if (ALIGNMENT_EVENT_TYPES.has(type)) return 'audio_alignment';
  if (TOOL_EVENT_TYPES.has(type) || type.includes('tool')) return 'tool_lifecycle';
  if (RESULT_EVENT_TYPES.has(type)) return 'result';
  if (type === 'control_ack' || type === 'input_audio_ack') return 'control_receipt';
  return '';
}

function eventReplayable(event, encodedBytes, maximumEventBytes) {
  if (['audio_chunk', 'audio_gap'].includes(String(event?.type || ''))) return false;
  return encodedBytes <= maximumEventBytes;
}

function responseCodeForError(error) {
  if (error instanceof VoiceStreamResumeError) return error.code;
  return 'RESUME_INTERNAL_ERROR';
}

function responseMessageForError(error) {
  if (error instanceof VoiceStreamResumeError) return error.message;
  return 'The retained voice session could not be resumed.';
}

export class VoiceStreamResumeSession {
  constructor(identity, options = {}) {
    this.sessionID = requiredString(identity.sessionID ?? identity.sessionId, 'sessionID');
    this.clientSessionID = requiredString(identity.clientSessionID, 'clientSessionID');
    this.clientGeneration = nonNegativeInteger(identity.clientGeneration, 'clientGeneration');
    this.serverGeneration = nonNegativeInteger(
      identity.serverGeneration ?? identity.generation ?? 0,
      'serverGeneration',
    );
    this.configRevision = nonNegativeInteger(identity.configRevision ?? 0, 'configRevision');
    this.transportOperationID = requiredString(identity.transportOperationID, 'transportOperationID');
    this.wireFormat = Object.freeze(normalizeVoiceStreamWireFormat(identity.wireFormat));

    this.now = options.now || Date.now;
    this.retentionMs = boundedInteger(
      options.retentionMs,
      VOICE_STREAM_RESUME_DEFAULTS.retentionMs,
      1_000,
      5 * 60_000,
    );
    this.maxEvents = boundedInteger(
      options.maxEventsPerSession,
      VOICE_STREAM_RESUME_DEFAULTS.maxEventsPerSession,
      8,
      8_192,
    );
    this.maxEventBytes = boundedInteger(
      options.maxEventBytes,
      VOICE_STREAM_RESUME_DEFAULTS.maxEventBytes,
      1_024,
      1_000_000,
    );
    this.maxBytes = boundedInteger(
      options.maxBytesPerSession,
      VOICE_STREAM_RESUME_DEFAULTS.maxBytesPerSession,
      16_000,
      16_000_000,
    );
    this.maxControlReceipts = boundedInteger(
      options.maxControlReceipts,
      VOICE_STREAM_RESUME_DEFAULTS.maxControlReceipts,
      8,
      2_048,
    );
    this.maxResumeReceipts = boundedInteger(
      options.maxResumeReceipts,
      VOICE_STREAM_RESUME_DEFAULTS.maxResumeReceipts,
      2,
      256,
    );
    this.maxResumeReceiptBytes = boundedInteger(
      options.maxResumeReceiptBytes,
      Math.max(
        VOICE_STREAM_RESUME_DEFAULTS.maxResumeReceiptBytes,
        Math.min(32_000_000, this.maxBytes * 2),
      ),
      16_000,
      32_000_000,
    );
    this.maxInputFrameReceipts = boundedInteger(
      options.maxInputFrameReceipts,
      VOICE_STREAM_RESUME_DEFAULTS.maxInputFrameReceipts,
      64,
      32_768,
    );
    this.scheduleTimers = options.scheduleTimers !== false;
    this.onExpire = options.onExpire || null;
    this.onMutation = options.onMutation || null;

    this.createdAt = this.now();
    this.updatedAt = this.createdAt;
    this.detachedAt = 0;
    this.expiresAt = 0;
    this.expirationTimer = null;
    this.state = 'attached';
    this.closed = false;
    this.owner = null;

    this.protocolSequence = 0;
    this.events = [];
    this.eventBytes = 0;
    this.evictedThrough = 0;
    this.evictedCriticalThrough = 0;
    this.evictedCriticalKinds = new Set();

    this.controlCursor = 0;
    this.pendingControl = null;
    this.controlReceipts = new Map();
    this.resumeReceipts = new Map();
    this.resumeReceiptBytes = 0;

    this.activeInputTurnID = '';
    this.acceptedInputAudioSequence = 0;
    this.pendingInputFrame = null;
    this.inputGap = null;
    this.acceptedInputFrameByteCounts = new Map();
    this.lastCommittedInputFrameByteCounts = new Map();
    this.lastCommittedInput = null;
    this.lastCommitAck = null;
    this.committedInputs = new Map();
    this.lastRenderedAudioAck = null;

    this.active = {
      turnID: '',
      responseID: '',
      state: 'idle',
    };
  }

  setOwner(owner) {
    this.owner = owner || null;
    return this;
  }

  identityFields() {
    return {
      resumeSchemaVersion: VOICE_STREAM_RESUME_SCHEMA_VERSION,
      sessionID: this.sessionID,
      sessionId: this.sessionID,
      serverGeneration: this.serverGeneration,
      clientSessionID: this.clientSessionID,
      clientGeneration: this.clientGeneration,
      configRevision: this.configRevision,
      transportOperationID: this.transportOperationID,
      wireFormat: cloneJSON(this.wireFormat),
    };
  }

  recordEvent(originalEvent = {}) {
    this.assertOpen();
    this.pruneExpiredEvents();
    const sequence = ++this.protocolSequence;
    const event = {
      ...cloneJSON(originalEvent),
      ...this.identityFields(),
      protocolSequence: sequence,
      eventID: `${this.sessionID}:${sequence}`,
    };
    const encoded = JSON.stringify(event);
    const encodedBytes = Buffer.byteLength(encoded);
    const hazard = eventHazard(event);
    const replayable = eventReplayable(event, encodedBytes, this.maxEventBytes);
    const retainedBytes = replayable ? encodedBytes : 96 + Buffer.byteLength(hazard);
    this.events.push({
      sequence,
      event: replayable ? event : null,
      eventID: event.eventID,
      type: String(event.type || ''),
      hazard,
      replayable,
      bytes: retainedBytes,
      createdAt: this.now(),
    });
    this.eventBytes += retainedBytes;
    this.updateActiveFromEvent(event);
    this.enforceEventBounds();
    this.touch();
    return event;
  }

  markInputGap(code, details = {}) {
    if (!this.inputGap) {
      this.inputGap = {
        code,
        details: cloneJSON(details),
        observedAtProtocolSequence: this.protocolSequence,
      };
    }
    this.touch();
    return this.inputGap;
  }

  declareAudioFrame(message = {}) {
    this.assertOpen();
    const turnID = requiredString(message.turnID ?? message.turnId, 'turnID');
    const audioSequence = positiveInteger(message.audioSequence, 'audioSequence');
    const byteCount = nonNegativeInteger(message.byteCount, 'byteCount');
    const bytesPerFrame = this.wireFormat.channels * this.wireFormat.bytesPerSample;
    if (byteCount % bytesPerFrame !== 0) {
      throw new VoiceStreamResumeError(
        'INVALID_AUDIO_FRAME_ALIGNMENT',
        'Input audio byteCount must contain complete PCM frames for the admitted wire format.',
        { byteCount, bytesPerFrame, wireFormat: cloneJSON(this.wireFormat) },
      );
    }

    if (this.pendingInputFrame) {
      this.markInputGap('INPUT_FRAME_DECLARATION_OVERLAP', {
        pending: this.pendingInputFrame,
        received: { turnID, audioSequence, byteCount },
      });
      throw new VoiceStreamResumeError(
        'INPUT_FRAME_DECLARATION_OVERLAP',
        'A second input frame was declared before the preceding binary frame arrived.',
        { pending: cloneJSON(this.pendingInputFrame) },
      );
    }

    const committedSequence = this.committedInputs.get(turnID);
    if (committedSequence !== undefined && audioSequence <= committedSequence) {
      const retainedByteCount = sameCommit(
        { turnID, audioSequence: committedSequence },
        this.lastCommittedInput,
      ) ? this.lastCommittedInputFrameByteCounts.get(audioSequence) : undefined;
      if (retainedByteCount !== undefined && retainedByteCount !== byteCount) {
        throw new VoiceStreamResumeError(
          'INPUT_AUDIO_IDEMPOTENCY_CONFLICT',
          'An accepted input audio sequence was reused with a different byte count.',
          { turnID, audioSequence, expectedByteCount: retainedByteCount, receivedByteCount: byteCount },
        );
      }
      this.pendingInputFrame = { turnID, audioSequence, byteCount, duplicate: true };
      return { accepted: false, duplicate: true, turnID, audioSequence, byteCount };
    }

    if (!this.activeInputTurnID) {
      this.activeInputTurnID = turnID;
      this.acceptedInputAudioSequence = 0;
      this.acceptedInputFrameByteCounts = new Map();
    } else if (this.activeInputTurnID !== turnID) {
      this.markInputGap('INPUT_TURN_CHANGED_WITHOUT_COMMIT', {
        expectedTurnID: this.activeInputTurnID,
        receivedTurnID: turnID,
      });
      throw new VoiceStreamResumeError(
        'INPUT_TURN_CHANGED_WITHOUT_COMMIT',
        'Input audio changed turns before the active turn was committed.',
        { expectedTurnID: this.activeInputTurnID, receivedTurnID: turnID },
      );
    }

    if (audioSequence <= this.acceptedInputAudioSequence) {
      const retainedByteCount = this.acceptedInputFrameByteCounts.get(audioSequence);
      if (retainedByteCount !== undefined && retainedByteCount !== byteCount) {
        throw new VoiceStreamResumeError(
          'INPUT_AUDIO_IDEMPOTENCY_CONFLICT',
          'An accepted input audio sequence was reused with a different byte count.',
          { turnID, audioSequence, expectedByteCount: retainedByteCount, receivedByteCount: byteCount },
        );
      }
      this.pendingInputFrame = { turnID, audioSequence, byteCount, duplicate: true };
      return { accepted: false, duplicate: true, turnID, audioSequence, byteCount };
    }

    const expectedSequence = this.acceptedInputAudioSequence + 1;
    if (audioSequence !== expectedSequence) {
      this.markInputGap('INPUT_AUDIO_SEQUENCE_GAP', {
        turnID,
        expectedAudioSequence: expectedSequence,
        receivedAudioSequence: audioSequence,
      });
      throw new VoiceStreamResumeError(
        'INPUT_AUDIO_SEQUENCE_GAP',
        'Input audio sequence is not contiguous.',
        { turnID, expectedAudioSequence: expectedSequence, receivedAudioSequence: audioSequence },
      );
    }

    this.pendingInputFrame = { turnID, audioSequence, byteCount, duplicate: false };
    this.touch();
    return { accepted: true, duplicate: false, turnID, audioSequence, byteCount };
  }

  consumeAudioFrame(byteCount) {
    this.assertOpen();
    const actualByteCount = nonNegativeInteger(byteCount, 'binaryAudioByteCount');
    const pending = this.pendingInputFrame;
    this.pendingInputFrame = null;
    if (!pending) {
      this.markInputGap('UNFRAMED_INPUT_AUDIO', { byteCount: actualByteCount });
      throw new VoiceStreamResumeError(
        'UNFRAMED_INPUT_AUDIO',
        'Input binary audio arrived without a matching frame declaration.',
        { byteCount: actualByteCount },
      );
    }
    if (pending.byteCount !== actualByteCount) {
      this.markInputGap('INPUT_AUDIO_BYTE_COUNT_MISMATCH', {
        turnID: pending.turnID,
        audioSequence: pending.audioSequence,
        expectedByteCount: pending.byteCount,
        receivedByteCount: actualByteCount,
      });
      throw new VoiceStreamResumeError(
        'INPUT_AUDIO_BYTE_COUNT_MISMATCH',
        'Input binary frame length does not match its declaration.',
        {
          turnID: pending.turnID,
          audioSequence: pending.audioSequence,
          expectedByteCount: pending.byteCount,
          receivedByteCount: actualByteCount,
        },
      );
    }
    if (pending.duplicate) {
      return {
        accepted: false,
        duplicate: true,
        turnID: pending.turnID,
        audioSequence: pending.audioSequence,
      };
    }
    this.acceptedInputAudioSequence = pending.audioSequence;
    this.acceptedInputFrameByteCounts.set(pending.audioSequence, pending.byteCount);
    while (this.acceptedInputFrameByteCounts.size > this.maxInputFrameReceipts) {
      this.acceptedInputFrameByteCounts.delete(this.acceptedInputFrameByteCounts.keys().next().value);
    }
    this.touch();
    return {
      accepted: true,
      duplicate: false,
      turnID: pending.turnID,
      audioSequence: pending.audioSequence,
    };
  }

  commitInput(message = {}) {
    this.assertOpen();
    const commit = normalizeCommit(message, 'inputCommit');
    if (sameCommit(commit, this.lastCommittedInput) && this.lastCommitAck) {
      return { duplicate: true, event: cloneJSON(this.lastCommitAck) };
    }
    if (this.inputGap) {
      throw new VoiceStreamResumeError(
        'INPUT_AUDIO_GAP',
        'Input audio cannot be committed after an unresolved frame gap.',
        cloneJSON(this.inputGap),
      );
    }
    if (this.pendingInputFrame) {
      this.markInputGap('INPUT_FRAME_IN_FLIGHT', { pending: this.pendingInputFrame });
      throw new VoiceStreamResumeError(
        'INPUT_FRAME_IN_FLIGHT',
        'Input audio cannot be committed before its declared binary frame arrives.',
        { pending: cloneJSON(this.pendingInputFrame) },
      );
    }
    if (!this.activeInputTurnID || commit.turnID !== this.activeInputTurnID) {
      throw new VoiceStreamResumeError(
        'INPUT_COMMIT_TURN_MISMATCH',
        'Input commit does not match the active input turn.',
        { expectedTurnID: this.activeInputTurnID || null, receivedTurnID: commit.turnID },
      );
    }
    if (commit.audioSequence !== this.acceptedInputAudioSequence) {
      throw new VoiceStreamResumeError(
        'INPUT_COMMIT_SEQUENCE_MISMATCH',
        'Input commit does not match the last accepted audio frame.',
        {
          turnID: commit.turnID,
          expectedAudioSequence: this.acceptedInputAudioSequence,
          receivedAudioSequence: commit.audioSequence,
        },
      );
    }

    this.lastCommittedInput = commit;
    this.lastCommittedInputFrameByteCounts = this.acceptedInputFrameByteCounts;
    this.committedInputs.set(commit.turnID, commit.audioSequence);
    while (this.committedInputs.size > 64) {
      this.committedInputs.delete(this.committedInputs.keys().next().value);
    }
    this.activeInputTurnID = '';
    this.acceptedInputAudioSequence = 0;
    this.acceptedInputFrameByteCounts = new Map();
    const event = this.recordEvent({
      type: 'input_audio_ack',
      status: 'committed',
      turnID: commit.turnID,
      audioSequence: commit.audioSequence,
      nextExpectedAudio: { turnID: null, audioSequence: 1 },
    });
    this.lastCommitAck = event;
    return { duplicate: false, event: cloneJSON(event) };
  }

  recordRenderedAudioAck(message = {}) {
    this.assertOpen();
    const acknowledgement = normalizeRenderedAudioAck(message);
    if (acknowledgement.generation !== this.serverGeneration) {
      throw new VoiceStreamResumeError(
        'STALE_RENDER_GENERATION',
        'Rendered audio acknowledgement belongs to a different server generation.',
        {
          expectedGeneration: this.serverGeneration,
          receivedGeneration: acknowledgement.generation,
        },
      );
    }

    const prior = this.lastRenderedAudioAck;
    if (prior) {
      const sameStream = acknowledgement.responseID === prior.responseID
        && acknowledgement.streamID === prior.streamID;
      if (!sameStream && !RENDERED_AUDIO_TERMINAL_STATES.has(prior.state)) {
        throw new VoiceStreamResumeError(
          'ACTIVE_RENDER_STREAM_CONFLICT',
          'A new rendered audio stream cannot replace a non-terminal stream.',
          { active: cloneJSON(prior) },
        );
      }
      if (sameStream) {
        const exactDuplicate = JSON.stringify(acknowledgement) === JSON.stringify(prior);
        if (exactDuplicate) return { duplicate: true, acknowledgement: cloneJSON(prior) };
        if (RENDERED_AUDIO_TERMINAL_STATES.has(prior.state)) {
          throw new VoiceStreamResumeError(
            'RENDER_STREAM_ALREADY_TERMINAL',
            'Rendered audio progress cannot advance after a final or interrupted acknowledgement.',
            { retained: cloneJSON(prior) },
          );
        }
        if (acknowledgement.chunkSequence < prior.chunkSequence
            || acknowledgement.frameCursor < prior.frameCursor
            || acknowledgement.byteCursor < prior.byteCursor) {
          throw new VoiceStreamResumeError(
            'RENDER_CURSOR_REGRESSION',
            'Rendered audio cursors must advance monotonically.',
            { retained: cloneJSON(prior), received: cloneJSON(acknowledgement) },
          );
        }
        if (acknowledgement.chunkSequence === prior.chunkSequence
            && acknowledgement.chunkID !== prior.chunkID) {
          throw new VoiceStreamResumeError(
            'RENDER_CHUNK_ID_CONFLICT',
            'A rendered audio chunk sequence cannot be rebound to a different chunk ID.',
            { retained: cloneJSON(prior), received: cloneJSON(acknowledgement) },
          );
        }
        if (acknowledgement.chunkSequence !== prior.chunkSequence
            && acknowledgement.chunkID === prior.chunkID) {
          throw new VoiceStreamResumeError(
            'RENDER_CHUNK_ID_CONFLICT',
            'A rendered audio chunk ID cannot be reused for another chunk sequence.',
            { retained: cloneJSON(prior), received: cloneJSON(acknowledgement) },
          );
        }
      }
    }

    this.lastRenderedAudioAck = acknowledgement;
    this.touch();
    return { duplicate: false, acknowledgement: cloneJSON(acknowledgement) };
  }

  beginControl(message = {}) {
    this.assertOpen();
    if (message.controlSequence === undefined && message.controlID === undefined) {
      return { legacy: true, execute: true };
    }
    const controlSequence = positiveInteger(message.controlSequence, 'controlSequence');
    const controlID = requiredString(message.controlID, 'controlID');
    const controlFingerprint = fingerprint(message);

    if (controlSequence <= this.controlCursor) {
      const receipt = this.controlReceipts.get(controlSequence);
      if (!receipt
          || receipt.controlID !== controlID
          || receipt.fingerprint !== controlFingerprint) {
        throw new VoiceStreamResumeError(
          'CONTROL_IDEMPOTENCY_CONFLICT',
          'A completed control sequence was reused with different content.',
          { controlSequence, controlID },
        );
      }
      return {
        legacy: false,
        execute: false,
        duplicate: true,
        event: cloneJSON(receipt.event),
      };
    }

    if (this.pendingControl) {
      throw new VoiceStreamResumeError(
        'CONTROL_OVERLAP',
        'A control is already being applied.',
        { pendingControlSequence: this.pendingControl.controlSequence },
        { recoverable: true },
      );
    }
    const expectedSequence = this.controlCursor + 1;
    if (controlSequence !== expectedSequence) {
      throw new VoiceStreamResumeError(
        'CONTROL_SEQUENCE_GAP',
        'Control sequence is not contiguous.',
        { expectedControlSequence: expectedSequence, receivedControlSequence: controlSequence },
      );
    }

    const handle = {
      legacy: false,
      execute: true,
      duplicate: false,
      controlSequence,
      controlID,
      controlType: optionalString(message.type, 128),
      fingerprint: controlFingerprint,
    };
    this.pendingControl = handle;
    this.touch();
    return handle;
  }

  completeControl(handle, result = {}) {
    if (!handle || handle.legacy) return null;
    if (!handle.execute) return cloneJSON(handle.event);
    if (this.pendingControl !== handle) {
      throw new VoiceStreamResumeError(
        'CONTROL_OWNERSHIP_LOST',
        'The pending control no longer owns its sequence.',
        { controlSequence: handle.controlSequence },
      );
    }

    const acknowledgedControlCursor = handle.controlSequence;
    const status = String(result.status || 'applied');
    const event = this.recordEvent({
      type: 'control_ack',
      status,
      code: optionalString(result.code, 128) || undefined,
      message: optionalString(result.message, 512) || undefined,
      controlSequence: handle.controlSequence,
      controlID: handle.controlID,
      controlType: handle.controlType,
      acknowledgedControlCursor,
      renderedAudioAck: result.renderedAudioAck
        ? cloneJSON(result.renderedAudioAck)
        : undefined,
    });
    this.pendingControl = null;
    this.controlCursor = acknowledgedControlCursor;
    this.controlReceipts.set(handle.controlSequence, {
      controlID: handle.controlID,
      fingerprint: handle.fingerprint,
      event,
    });
    while (this.controlReceipts.size > this.maxControlReceipts) {
      this.controlReceipts.delete(this.controlReceipts.keys().next().value);
    }
    return cloneJSON(event);
  }

  updateIdentity({ serverGeneration, configRevision } = {}) {
    if (serverGeneration !== undefined) {
      this.serverGeneration = nonNegativeInteger(serverGeneration, 'serverGeneration');
    }
    if (configRevision !== undefined) {
      this.configRevision = nonNegativeInteger(configRevision, 'configRevision');
    }
    this.touch();
  }

  detach(reason = 'socket-closed') {
    if (this.closed) return;
    if (this.pendingInputFrame?.duplicate) {
      this.pendingInputFrame = null;
    } else if (this.pendingInputFrame) {
      this.markInputGap('INPUT_FRAME_IN_FLIGHT', {
        reason,
        pending: this.pendingInputFrame,
      });
    }
    this.state = 'detached';
    this.detachedAt = this.now();
    this.expiresAt = this.detachedAt + this.retentionMs;
    if (this.expirationTimer) clearTimeout(this.expirationTimer);
    if (this.scheduleTimers) {
      this.expirationTimer = setTimeout(() => this.expire('retention-expired'), this.retentionMs);
      this.expirationTimer.unref?.();
    }
    this.touch();
  }

  attach() {
    this.assertOpen();
    if (this.expirationTimer) clearTimeout(this.expirationTimer);
    this.expirationTimer = null;
    this.state = 'attached';
    this.detachedAt = 0;
    this.expiresAt = 0;
    this.touch();
  }

  expire(reason = 'expired') {
    if (this.closed) return;
    this.closed = true;
    this.state = 'expired';
    if (this.expirationTimer) clearTimeout(this.expirationTimer);
    this.expirationTimer = null;
    try { this.owner?.onExpire?.(reason); } catch {}
    try { this.onExpire?.(this, reason); } catch {}
  }

  resume(request = {}) {
    this.assertOpen();
    this.pruneExpiredEvents();
    this.pruneResumeReceipts();
    const normalized = this.normalizeResumeRequest(request);
    const requestFingerprint = fingerprint(normalized);
    const priorReceipt = this.resumeReceipts.get(normalized.resumeAttemptID);
    if (priorReceipt) {
      if (priorReceipt.fingerprint !== requestFingerprint) {
        throw new VoiceStreamResumeError(
          'RESUME_IDEMPOTENCY_CONFLICT',
          'resumeAttemptID was reused with a different resume envelope.',
          { resumeAttemptID: normalized.resumeAttemptID },
        );
      }
      if (priorReceipt.response.status === 'resumed') this.attach();
      return {
        response: { ...cloneJSON(priorReceipt.response), idempotentReplay: true },
        replay: cloneJSON(priorReceipt.replay),
      };
    }

    let outcome;
    try {
      const renderedAudioReconciliation = this.validateResumeIdentity(normalized);
      outcome = this.buildResumeOutcome(normalized, renderedAudioReconciliation);
    } catch (error) {
      if (!(error instanceof VoiceStreamResumeError)) throw error;
      outcome = this.buildRejectedResumeOutcome(normalized, error);
    }
    const receipt = {
      fingerprint: requestFingerprint,
      response: cloneJSON(outcome.response),
      replay: cloneJSON(outcome.replay),
      createdAt: this.now(),
    };
    receipt.bytes = Buffer.byteLength(JSON.stringify({
      response: receipt.response,
      replay: receipt.replay,
    })) + 128;
    if (receipt.bytes <= this.maxResumeReceiptBytes) {
      this.resumeReceipts.set(normalized.resumeAttemptID, receipt);
      this.resumeReceiptBytes += receipt.bytes;
      this.enforceResumeReceiptBounds();
    }
    if (outcome.response.status === 'resumed') this.attach();
    return outcome;
  }

  snapshot() {
    this.pruneExpiredEvents();
    this.pruneResumeReceipts();
    return {
      ...this.identityFields(),
      state: this.state,
      protocolSequence: this.protocolSequence,
      retainedFromProtocolSequence: this.events[0]?.sequence ?? (this.protocolSequence + 1),
      retainedThroughProtocolSequence: this.events.at(-1)?.sequence ?? this.protocolSequence,
      retainedEventCount: this.events.length,
      retainedEventBytes: this.eventBytes,
      retainedResumeReceiptCount: this.resumeReceipts.size,
      retainedResumeReceiptBytes: this.resumeReceiptBytes,
      evictedThroughProtocolSequence: this.evictedThrough,
      evictedCriticalThroughProtocolSequence: this.evictedCriticalThrough,
      evictedCriticalKinds: [...this.evictedCriticalKinds].sort(),
      acknowledgedControlCursor: this.controlCursor,
      nextExpectedControlSequence: this.controlCursor + 1,
      lastCommittedInput: cloneJSON(this.lastCommittedInput),
      lastRenderedAudioAck: cloneJSON(this.lastRenderedAudioAck),
      nextExpectedAudio: this.nextExpectedAudio(),
      inputGap: cloneJSON(this.inputGap),
      active: cloneJSON(this.active),
      detachedAt: this.detachedAt || null,
      expiresAt: this.expiresAt || null,
    };
  }

  normalizeResumeRequest(request) {
    const cursor = request.cursor && typeof request.cursor === 'object' ? request.cursor : {};
    return {
      resumeSchemaVersion: nonNegativeInteger(
        request.resumeSchemaVersion ?? VOICE_STREAM_RESUME_SCHEMA_VERSION,
        'resumeSchemaVersion',
      ),
      resumeAttemptID: requiredString(request.resumeAttemptID, 'resumeAttemptID'),
      priorSessionID: requiredString(
        request.priorSessionID ?? request.sessionID ?? request.sessionId,
        'priorSessionID',
      ),
      clientSessionID: requiredString(request.clientSessionID, 'clientSessionID'),
      clientGeneration: nonNegativeInteger(request.clientGeneration, 'clientGeneration'),
      serverGeneration: nonNegativeInteger(
        request.serverGeneration ?? request.generation,
        'serverGeneration',
        { required: false },
      ),
      configRevision: nonNegativeInteger(
        request.configRevision,
        'configRevision',
        { required: false },
      ),
      transportOperationID: requiredString(request.transportOperationID, 'transportOperationID'),
      wireFormat: normalizeVoiceStreamWireFormat(request.wireFormat),
      lastAcknowledgedInboundProtocolSequence: nonNegativeInteger(
        request.lastAcknowledgedInboundProtocolSequence
          ?? cursor.inboundProtocolSequence
          ?? cursor.protocolSequence
          ?? 0,
        'lastAcknowledgedInboundProtocolSequence',
      ),
      lastCommittedInput: normalizeCommit(
        request.lastCommittedInput ?? cursor.lastCommittedInput,
      ),
      lastAcceptedResponse: normalizeAcceptedResponse(
        request.lastAcceptedResponse ?? cursor.lastAcceptedResponse,
      ),
      lastRenderedAudioAck: normalizeRenderedAudioAck(
        request.lastRenderedAudioAck ?? cursor.lastRenderedAudioAck,
        'lastRenderedAudioAck',
        { required: false },
      ),
      controlCursor: nonNegativeInteger(
        request.controlCursor ?? cursor.controlCursor ?? 0,
        'controlCursor',
      ),
    };
  }

  validateResumeIdentity(request) {
    if (request.resumeSchemaVersion !== VOICE_STREAM_RESUME_SCHEMA_VERSION) {
      throw new VoiceStreamResumeError(
        'UNSUPPORTED_RESUME_SCHEMA',
        'The requested resume schema is not supported.',
        { supported: VOICE_STREAM_RESUME_SCHEMA_VERSION, received: request.resumeSchemaVersion },
      );
    }
    if (request.priorSessionID !== this.sessionID) {
      throw new VoiceStreamResumeError('SESSION_NOT_FOUND', 'The prior voice session is not retained.');
    }
    if (request.clientSessionID !== this.clientSessionID) {
      throw new VoiceStreamResumeError(
        'STALE_CLIENT_SESSION',
        'The resume envelope belongs to a different client session.',
      );
    }
    if (!sameIdentityValue(request.clientGeneration, this.clientGeneration)) {
      throw new VoiceStreamResumeError(
        'STALE_GENERATION',
        'The resume envelope belongs to a stale client generation.',
        { expectedClientGeneration: this.clientGeneration, receivedClientGeneration: request.clientGeneration },
      );
    }
    if (request.serverGeneration !== null
        && !sameIdentityValue(request.serverGeneration, this.serverGeneration)) {
      throw new VoiceStreamResumeError(
        'STALE_SERVER_GENERATION',
        'The retained server generation no longer matches the client cursor.',
        { expectedServerGeneration: this.serverGeneration, receivedServerGeneration: request.serverGeneration },
      );
    }
    if (request.configRevision !== null
        && !sameIdentityValue(request.configRevision, this.configRevision)) {
      throw new VoiceStreamResumeError(
        'STALE_CONFIG_REVISION',
        'The retained configuration revision no longer matches the client cursor.',
        { expectedConfigRevision: this.configRevision, receivedConfigRevision: request.configRevision },
      );
    }
    if (request.transportOperationID !== this.transportOperationID) {
      throw new VoiceStreamResumeError(
        'STALE_TRANSPORT_OPERATION',
        'The resume envelope belongs to a different transport operation.',
      );
    }
    if (!sameWireFormat(request.wireFormat, this.wireFormat)) {
      throw new VoiceStreamResumeError(
        'WIRE_FORMAT_MISMATCH',
        'The retained voice stream uses a different PCM wire format.',
        { expected: cloneJSON(this.wireFormat), received: cloneJSON(request.wireFormat) },
      );
    }
    if (request.lastAcknowledgedInboundProtocolSequence > this.protocolSequence) {
      throw new VoiceStreamResumeError(
        'PROTOCOL_CURSOR_AHEAD',
        'The client protocol cursor is ahead of the server journal.',
        {
          latestProtocolSequence: this.protocolSequence,
          receivedProtocolSequence: request.lastAcknowledgedInboundProtocolSequence,
        },
      );
    }
    if (request.controlCursor > this.controlCursor) {
      throw new VoiceStreamResumeError(
        'CONTROL_CURSOR_AHEAD',
        'The client control cursor is ahead of the server receipt journal.',
        { acknowledgedControlCursor: this.controlCursor, receivedControlCursor: request.controlCursor },
      );
    }
    if (request.lastAcceptedResponse?.protocolSequence !== null
        && request.lastAcceptedResponse?.protocolSequence !== undefined
        && request.lastAcceptedResponse.protocolSequence > request.lastAcknowledgedInboundProtocolSequence) {
      throw new VoiceStreamResumeError(
        'INVALID_ACCEPTED_RESPONSE_CURSOR',
        'The accepted response cursor is ahead of the acknowledged inbound cursor.',
      );
    }
    if (request.lastCommittedInput && !sameCommit(request.lastCommittedInput, this.lastCommittedInput)) {
      throw new VoiceStreamResumeError(
        'INPUT_COMMIT_MISMATCH',
        'The client and server disagree about the last committed input turn.',
        {
          serverLastCommittedInput: cloneJSON(this.lastCommittedInput),
          clientLastCommittedInput: cloneJSON(request.lastCommittedInput),
        },
      );
    }
    if (request.lastRenderedAudioAck?.generation !== undefined
        && request.lastRenderedAudioAck.generation !== this.serverGeneration) {
      throw new VoiceStreamResumeError(
        'STALE_RENDER_GENERATION',
        'The rendered-audio resume cursor belongs to a different server generation.',
        {
          expectedGeneration: this.serverGeneration,
          receivedGeneration: request.lastRenderedAudioAck.generation,
        },
      );
    }
    return reconcileRenderedAudioAck(request.lastRenderedAudioAck, this.lastRenderedAudioAck);
  }

  buildRejectedResumeOutcome(request, error) {
    const cursor = request.lastAcknowledgedInboundProtocolSequence;
    return {
      replay: [],
      response: {
        type: 'resume_result',
        ...this.identityFields(),
        status: 'rejected',
        code: responseCodeForError(error),
        message: responseMessageForError(error),
        recoverable: !!error.recoverable,
        priorSessionID: this.sessionID,
        resumeAttemptID: request.resumeAttemptID,
        lastAcknowledgedInboundProtocolSequence: cursor,
        latestProtocolSequence: this.protocolSequence,
        acknowledgedControlCursor: this.controlCursor,
        nextExpectedControlSequence: this.controlCursor + 1,
        lastCommittedInput: cloneJSON(this.lastCommittedInput),
        lastRenderedAudioAck: cloneJSON(this.lastRenderedAudioAck),
        renderedAudioReconciliation: 'rejected',
        nextExpectedAudio: this.nextExpectedAudio(),
        replay: {
          requestedAfterProtocolSequence: cursor,
          retainedFromProtocolSequence: this.events[0]?.sequence ?? (this.protocolSequence + 1),
          retainedThroughProtocolSequence: this.events.at(-1)?.sequence ?? this.protocolSequence,
          fromProtocolSequence: null,
          throughProtocolSequence: null,
          eventCount: 0,
          eventSequences: [],
          skippedNonCritical: 0,
          skippedNonCriticalRanges: [],
        },
        active: cloneJSON(this.active),
        gap: null,
        details: cloneJSON(error.details || {}),
        idempotentReplay: false,
      },
    };
  }

  buildResumeOutcome(request, renderedAudioReconciliation = 'not_reported') {
    const cursor = request.lastAcknowledgedInboundProtocolSequence;
    const retained = this.events.filter((record) => record.sequence > cursor);
    const retainedCriticalBarrier = retained.find((record) => record.hazard && !record.replayable);
    const evictedCritical = cursor < this.evictedCriticalThrough;
    const gapReasons = [];
    const gapKinds = new Set();

    if (evictedCritical) {
      gapReasons.push('critical_event_evicted');
      for (const kind of this.evictedCriticalKinds) gapKinds.add(kind);
    }
    if (retainedCriticalBarrier) {
      gapReasons.push('non_replayable_critical_event');
      gapKinds.add(retainedCriticalBarrier.hazard);
    }
    if (this.inputGap) {
      gapReasons.push('input_audio_gap');
      gapKinds.add('input_audio');
    }

    const replay = retained
      .filter((record) => record.replayable && record.event)
      .map((record) => cloneJSON(record.event));
    const skippedSequences = retained
      .filter((record) => !record.replayable && !record.hazard)
      .map((record) => record.sequence);
    const skippedNonCriticalRanges = sequenceRanges(skippedSequences);
    if (cursor < this.evictedThrough && !evictedCritical) {
      const evictedRange = {
        fromProtocolSequence: cursor + 1,
        throughProtocolSequence: this.evictedThrough,
      };
      const firstRetainedRange = skippedNonCriticalRanges[0];
      if (firstRetainedRange
          && firstRetainedRange.fromProtocolSequence === evictedRange.throughProtocolSequence + 1) {
        firstRetainedRange.fromProtocolSequence = evictedRange.fromProtocolSequence;
      } else {
        skippedNonCriticalRanges.unshift(evictedRange);
      }
    }
    const skippedNonCritical = skippedNonCriticalRanges.reduce(
      (count, range) => count + range.throughProtocolSequence - range.fromProtocolSequence + 1,
      0,
    );
    const status = gapReasons.length ? 'gap' : 'resumed';
    const response = {
      type: 'resume_result',
      ...this.identityFields(),
      status,
      code: status === 'resumed' ? 'RESUME_OK' : 'RESUME_CRITICAL_GAP',
      message: status === 'resumed'
        ? 'The retained voice stream was resumed.'
        : 'The retained voice stream has a critical replay gap and cannot continue safely.',
      resumeAttemptID: request.resumeAttemptID,
      priorSessionID: this.sessionID,
      lastAcknowledgedInboundProtocolSequence: cursor,
      latestProtocolSequence: this.protocolSequence,
      acknowledgedControlCursor: this.controlCursor,
      nextExpectedControlSequence: this.controlCursor + 1,
      lastCommittedInput: cloneJSON(this.lastCommittedInput),
      lastRenderedAudioAck: cloneJSON(this.lastRenderedAudioAck),
      renderedAudioReconciliation,
      nextExpectedAudio: this.nextExpectedAudio(),
      replay: {
        requestedAfterProtocolSequence: cursor,
        retainedFromProtocolSequence: this.events[0]?.sequence ?? (this.protocolSequence + 1),
        retainedThroughProtocolSequence: this.events.at(-1)?.sequence ?? this.protocolSequence,
        fromProtocolSequence: replay[0]?.protocolSequence ?? null,
        throughProtocolSequence: replay.at(-1)?.protocolSequence ?? null,
        eventCount: replay.length,
        eventSequences: replay.map((event) => event.protocolSequence),
        skippedNonCritical,
        skippedNonCriticalRanges,
      },
      active: cloneJSON(this.active),
      gap: gapReasons.length ? {
        reasons: gapReasons,
        criticalKinds: [...gapKinds].sort(),
        evictedThroughProtocolSequence: this.evictedThrough,
        input: cloneJSON(this.inputGap),
      } : null,
      idempotentReplay: false,
    };
    return { response, replay: status === 'resumed' ? replay : [] };
  }

  nextExpectedAudio() {
    return {
      turnID: this.activeInputTurnID || null,
      audioSequence: this.activeInputTurnID
        ? this.acceptedInputAudioSequence + 1
        : 1,
    };
  }

  updateActiveFromEvent(event) {
    const type = String(event?.type || '');
    const turnID = optionalString(event.turnID ?? event.turnId);
    const responseID = optionalString(event.responseID ?? event.responseId);
    if (turnID) this.active.turnID = turnID;
    if (responseID) this.active.responseID = responseID;

    if (type === 'interrupted') {
      this.active.state = 'interrupted';
    } else if (type === 'iphone_tool' || type.includes('tool')) {
      this.active.state = 'tool';
    } else if (type === 'tts_audio_start' || type === 'audio_chunk') {
      this.active.state = 'output';
    } else if (type === 'transcript' || type === 'reply' || type === 'reply_delta') {
      this.active.state = 'responding';
    } else if ((type === 'companion_voice_result' && event.done !== false)
        || type === 'tts_audio_end') {
      this.active.state = 'idle';
    }
  }

  enforceEventBounds() {
    while (this.events.length > this.maxEvents || this.eventBytes > this.maxBytes) {
      this.evictOldestEvent();
    }
  }

  pruneExpiredEvents() {
    const oldestAllowed = this.now() - this.retentionMs;
    while (this.events[0]?.createdAt < oldestAllowed) this.evictOldestEvent();
  }

  pruneResumeReceipts() {
    const oldestAllowed = this.now() - this.retentionMs;
    for (const [attemptID, receipt] of this.resumeReceipts) {
      if (receipt.createdAt >= oldestAllowed) continue;
      this.resumeReceipts.delete(attemptID);
      this.resumeReceiptBytes = Math.max(0, this.resumeReceiptBytes - receipt.bytes);
    }
  }

  enforceResumeReceiptBounds() {
    while (this.resumeReceipts.size > this.maxResumeReceipts
        || this.resumeReceiptBytes > this.maxResumeReceiptBytes) {
      const attemptID = this.resumeReceipts.keys().next().value;
      const receipt = this.resumeReceipts.get(attemptID);
      if (attemptID === undefined || !receipt) break;
      this.resumeReceipts.delete(attemptID);
      this.resumeReceiptBytes = Math.max(0, this.resumeReceiptBytes - receipt.bytes);
    }
  }

  evictOldestEvent() {
    const removed = this.events.shift();
    if (!removed) return;
    this.eventBytes = Math.max(0, this.eventBytes - removed.bytes);
    this.evictedThrough = Math.max(this.evictedThrough, removed.sequence);
    if (removed.hazard) {
      this.evictedCriticalThrough = Math.max(this.evictedCriticalThrough, removed.sequence);
      this.evictedCriticalKinds.add(removed.hazard);
    }
  }

  touch() {
    this.updatedAt = this.now();
    try { this.onMutation?.(this); } catch {}
  }

  assertOpen() {
    if (this.closed) {
      throw new VoiceStreamResumeError(
        'SESSION_EXPIRED',
        'The retained voice stream has expired.',
      );
    }
  }
}

export class VoiceStartSessionHandshakeRegistry {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.retentionMs = boundedInteger(options.retentionMs, 5 * 60_000, 5_000, 30 * 60_000);
    this.maxEntries = boundedInteger(options.maxEntries, 256, 8, 4_096);
    this.entries = new Map();
  }

  begin({ authenticatedClientIdentity, transportOperationID, request, owner = null } = {}) {
    this.prune();
    const clientIdentity = requiredString(
      authenticatedClientIdentity,
      'authenticatedClientIdentity',
      512,
    );
    const operationID = requiredString(transportOperationID, 'transportOperationID');
    const key = fingerprint({ clientIdentity, operationID });
    const requestFingerprint = fingerprint(request || {});
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new VoiceStreamResumeError(
          'START_SESSION_IDEMPOTENCY_CONFLICT',
          'transportOperationID was reused with a different start_session request.',
          { transportOperationID: operationID },
        );
      }
      existing.updatedAt = this.now();
      return {
        execute: false,
        duplicate: true,
        key,
        owner: existing.owner,
        receipt: cloneJSON(existing.receipt),
        error: existing.error || null,
        completion: existing.completion,
      };
    }

    this.ensureCapacity();
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    const entry = {
      key,
      clientIdentity,
      operationID,
      requestFingerprint,
      owner,
      state: 'pending',
      receipt: null,
      error: null,
      createdAt: this.now(),
      updatedAt: this.now(),
      completion,
      resolveCompletion,
    };
    this.entries.set(key, entry);
    return { execute: true, duplicate: false, key, entry };
  }

  complete(handle, receipt, { owner = undefined } = {}) {
    const entry = handle?.entry;
    if (!entry || this.entries.get(entry.key) !== entry) {
      throw new VoiceStreamResumeError(
        'START_SESSION_OWNERSHIP_LOST',
        'The start_session handshake no longer owns its idempotency key.',
      );
    }
    if (entry.state === 'completed') return cloneJSON(entry.receipt);
    if (entry.state !== 'pending') {
      throw new VoiceStreamResumeError(
        'START_SESSION_OUTCOME_COMMITTED',
        'The start_session handshake already has a terminal outcome.',
      );
    }
    entry.state = 'completed';
    entry.receipt = cloneJSON(receipt);
    if (owner !== undefined) entry.owner = owner;
    entry.updatedAt = this.now();
    entry.resolveCompletion({
      receipt: cloneJSON(entry.receipt),
      owner: entry.owner,
    });
    return cloneJSON(entry.receipt);
  }

  fail(handle, error) {
    const entry = handle?.entry;
    if (!entry || this.entries.get(entry.key) !== entry) return;
    if (entry.state !== 'pending') return;
    entry.state = 'failed';
    entry.owner = null;
    entry.error = error;
    entry.updatedAt = this.now();
    entry.resolveCompletion({ error });
  }

  releaseOwner(owner, { exceptKey = '' } = {}) {
    for (const entry of this.entries.values()) {
      if (entry.owner !== owner || entry.key === exceptKey) continue;
      entry.owner = null;
      entry.updatedAt = this.now();
    }
  }

  prune() {
    const oldestAllowed = this.now() - this.retentionMs;
    for (const [key, entry] of this.entries) {
      if (entry.state !== 'pending' && entry.updatedAt < oldestAllowed) this.entries.delete(key);
    }
  }

  ensureCapacity() {
    if (this.entries.size < this.maxEntries) return;
    const victim = [...this.entries.values()]
      .filter((entry) => entry.state !== 'pending')
      .sort((left, right) => left.updatedAt - right.updatedAt)[0];
    if (victim) {
      this.entries.delete(victim.key);
      return;
    }
    throw new VoiceStreamResumeError(
      'START_SESSION_CAPACITY',
      'The start_session idempotency registry is at capacity.',
      { maxEntries: this.maxEntries },
      { recoverable: true },
    );
  }

  snapshot() {
    this.prune();
    return [...this.entries.values()].map((entry) => ({
      transportOperationID: entry.operationID,
      state: entry.state,
      hasOwner: !!entry.owner,
      hasReceipt: !!entry.receipt,
      hasError: !!entry.error,
    }));
  }
}

export class VoiceStreamResumeRegistry {
  constructor(options = {}) {
    this.options = { ...options };
    this.now = options.now || Date.now;
    this.maxSessions = boundedInteger(
      options.maxSessions,
      VOICE_STREAM_RESUME_DEFAULTS.maxSessions,
      1,
      1_024,
    );
    this.sessions = new Map();
  }

  createSession(identity, { owner = null } = {}) {
    this.prune();
    const sessionID = requiredString(identity.sessionID ?? identity.sessionId, 'sessionID');
    const existing = this.sessions.get(sessionID);
    if (existing && !existing.closed) {
      throw new VoiceStreamResumeError(
        'SESSION_ID_CONFLICT',
        'A retained voice stream already owns this server session ID.',
        { sessionID },
      );
    }
    this.ensureCapacity();
    const session = new VoiceStreamResumeSession(identity, {
      ...this.options,
      onExpire: (expired, reason) => {
        if (this.sessions.get(expired.sessionID) === expired) {
          this.sessions.delete(expired.sessionID);
        }
        try { this.options.onExpire?.(expired, reason); } catch {}
      },
    });
    session.setOwner(owner);
    this.sessions.set(sessionID, session);
    return session;
  }

  getSession(sessionID) {
    this.prune();
    return this.sessions.get(String(sessionID || '').trim()) || null;
  }

  prepareResume(request = {}) {
    let session = null;
    try {
      const priorSessionID = requiredString(
        request.priorSessionID ?? request.sessionID ?? request.sessionId,
        'priorSessionID',
      );
      session = this.getSession(priorSessionID);
      if (!session) {
        throw new VoiceStreamResumeError(
          'SESSION_NOT_FOUND',
          'The prior voice stream is no longer retained.',
          { priorSessionID },
        );
      }
      if (!session.owner?.attach) {
        throw new VoiceStreamResumeError(
          'RUNTIME_NOT_RETAINED',
          'The prior voice runtime is no longer available for socket handoff.',
          { priorSessionID },
        );
      }
      const outcome = session.resume(request);
      return { session, owner: session.owner, ...outcome };
    } catch (error) {
      const priorSessionID = optionalString(
        request.priorSessionID ?? request.sessionID ?? request.sessionId,
      );
      const snapshot = session?.snapshot() || null;
      const rawProtocolCursor = Number(
        request.lastAcknowledgedInboundProtocolSequence
          ?? request.cursor?.inboundProtocolSequence
          ?? request.cursor?.protocolSequence
          ?? 0,
      );
      const protocolCursor = Number.isSafeInteger(rawProtocolCursor) && rawProtocolCursor >= 0
        ? rawProtocolCursor
        : 0;
      return {
        session,
        owner: session?.owner || null,
        replay: [],
        response: {
          type: 'resume_result',
          resumeSchemaVersion: VOICE_STREAM_RESUME_SCHEMA_VERSION,
          ...(session?.identityFields() || {}),
          status: 'rejected',
          code: responseCodeForError(error),
          message: responseMessageForError(error),
          recoverable: !!error?.recoverable,
          priorSessionID: priorSessionID || null,
          resumeAttemptID: optionalString(request.resumeAttemptID) || null,
          lastAcknowledgedInboundProtocolSequence: protocolCursor,
          latestProtocolSequence: snapshot?.protocolSequence ?? 0,
          acknowledgedControlCursor: snapshot?.acknowledgedControlCursor ?? 0,
          nextExpectedControlSequence: snapshot?.nextExpectedControlSequence ?? 1,
          lastCommittedInput: cloneJSON(snapshot?.lastCommittedInput ?? null),
          lastRenderedAudioAck: cloneJSON(snapshot?.lastRenderedAudioAck ?? null),
          renderedAudioReconciliation: 'rejected',
          nextExpectedAudio: cloneJSON(snapshot?.nextExpectedAudio ?? {
            turnID: null,
            audioSequence: 1,
          }),
          replay: {
            requestedAfterProtocolSequence: protocolCursor,
            retainedFromProtocolSequence: snapshot?.retainedFromProtocolSequence ?? null,
            retainedThroughProtocolSequence: snapshot?.retainedThroughProtocolSequence ?? null,
            fromProtocolSequence: null,
            throughProtocolSequence: null,
            eventCount: 0,
            eventSequences: [],
            skippedNonCritical: 0,
            skippedNonCriticalRanges: [],
          },
          active: cloneJSON(snapshot?.active ?? {
            turnID: '',
            responseID: '',
            state: 'unknown',
          }),
          gap: null,
          details: cloneJSON(error?.details || {}),
          idempotentReplay: false,
        },
      };
    }
  }

  closeSession(sessionID, reason = 'closed') {
    const key = String(sessionID || '').trim();
    const session = this.sessions.get(key);
    if (!session) return false;
    session.expire(reason);
    this.sessions.delete(key);
    return true;
  }

  prune() {
    const now = this.now();
    for (const [sessionID, session] of this.sessions) {
      if (session.closed || (session.expiresAt && session.expiresAt <= now)) {
        session.expire('retention-expired');
        this.sessions.delete(sessionID);
      }
    }
  }

  ensureCapacity() {
    if (this.sessions.size < this.maxSessions) return;
    const candidates = [...this.sessions.values()]
      .filter((session) => session.state === 'detached')
      .sort((left, right) => left.updatedAt - right.updatedAt);
    const victim = candidates[0];
    if (victim) {
      this.closeSession(victim.sessionID, 'registry-capacity');
      return;
    }
    throw new VoiceStreamResumeError(
      'RESUME_SESSION_CAPACITY',
      'The retained voice session registry is at capacity.',
      { maxSessions: this.maxSessions },
      { recoverable: true },
    );
  }

  snapshot() {
    this.prune();
    return [...this.sessions.values()].map((session) => session.snapshot());
  }
}
