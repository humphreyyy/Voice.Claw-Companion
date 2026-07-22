import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPANION_VOICE_AUDIO_ALIGNMENT_SCHEMA_VERSION,
  CompanionVoiceAudioAlignmentProducer,
  companionVoiceTextSegmentID,
} from '../server/voice-audio-alignment.js';

const context = {
  generation: 7,
  configRevision: 3,
  turnId: 12,
  responseId: 'response-12',
};

test('stable response identity is carried across text, audio, and interruption events', () => {
  const producer = new CompanionVoiceAudioAlignmentProducer('session-1');
  const segmentID = companionVoiceTextSegmentID(context.responseId);
  const reply = producer.decorate({ type: 'reply', text: 'Hello.', textSegmentID: segmentID }, context);
  const start = producer.decorate({
    type: 'tts_audio_start',
    encoding: 'pcm_s16le',
    sampleRate: 24_000,
    channels: 1,
  }, context);
  const interrupted = producer.decorate({ type: 'interrupted', reason: 'barge-in' }, context);

  for (const event of [reply, start, interrupted]) {
    assert.deepEqual(
      {
        schemaVersion: event.alignment.schemaVersion,
        sessionID: event.alignment.sessionID,
        generationID: event.alignment.generationID,
        turnID: event.alignment.turnID,
        responseID: event.alignment.responseID,
      },
      {
        schemaVersion: COMPANION_VOICE_AUDIO_ALIGNMENT_SCHEMA_VERSION,
        sessionID: 'session-1',
        generationID: '7',
        turnID: '12',
        responseID: 'response-12',
      },
    );
  }
  assert.equal(reply.alignment.textSegmentID, segmentID);
  assert.equal(start.alignment.audioStreamID, interrupted.alignment.audioStreamID);
});

test('PCM chunks receive stable IDs and exact cumulative byte frame and sample offsets', () => {
  const producer = new CompanionVoiceAudioAlignmentProducer('session-1');
  const start = producer.decorate({
    type: 'tts_audio_start',
    encoding: 'pcm_s16le',
    sampleRate: 16_000,
    channels: 2,
  }, context);
  const first = producer.prepareAudioChunk(Buffer.alloc(16), context);
  const second = producer.prepareAudioChunk(Buffer.alloc(8), context);
  const end = producer.decorate({ type: 'tts_audio_end' }, context);

  assert.equal(first.alignment.audioStreamID, start.alignment.audioStreamID);
  assert.equal(first.alignment.audioChunkID, `${start.alignment.audioStreamID}:chunk:0`);
  assert.deepEqual(first.audio, {
    streamID: start.alignment.audioStreamID,
    chunkID: `${start.alignment.audioStreamID}:chunk:0`,
    chunkSequence: 0,
    encoding: 'pcm_s16le',
    sampleRate: 16_000,
    channels: 2,
    bytesPerSample: 2,
    bytesPerFrame: 4,
    byteOffset: 0,
    byteCount: 16,
    endByteOffsetExclusive: 16,
    frameOffset: 0,
    frameCount: 4,
    endFrameOffsetExclusive: 4,
    sampleOffset: 0,
    sampleCount: 8,
    endSampleOffsetExclusive: 8,
  });
  assert.equal(second.audio.byteOffset, 16);
  assert.equal(second.audio.frameOffset, 4);
  assert.equal(second.audio.sampleOffset, 8);
  assert.equal(end.audio.totalByteCount, 24);
  assert.equal(end.audio.totalFrameCount, 6);
  assert.equal(end.audio.totalSampleCount, 12);
  assert.equal(end.audio.complete, true);
});

test('whole-response text mapping is emitted only against a completed exact stream', () => {
  const producer = new CompanionVoiceAudioAlignmentProducer('session-1');
  const segmentID = companionVoiceTextSegmentID(context.responseId);
  producer.decorate({
    type: 'tts_audio_start',
    encoding: 'pcm_s16le',
    sampleRate: 24_000,
    channels: 1,
  }, context);
  producer.prepareAudioChunk(Buffer.alloc(20), context);

  const premature = producer.decorate({ type: 'text_audio_alignment', textSegmentID: segmentID }, context);
  assert.equal(premature.alignmentStatus, 'unmapped');
  assert.equal(premature.textAudioAlignment, undefined);

  producer.decorate({ type: 'tts_audio_end' }, context);
  const mapped = producer.decorate({
    type: 'text_audio_alignment',
    text: 'The complete response.',
    textSegmentID: segmentID,
  }, context);
  assert.deepEqual(mapped.textAudioAlignment, {
    textSegmentID: segmentID,
    audioStreamID: mapped.alignment.audioStreamID,
    startByteOffset: 0,
    endByteOffsetExclusive: 20,
    startFrameOffset: 0,
    endFrameOffsetExclusive: 10,
    startSampleOffset: 0,
    endSampleOffsetExclusive: 10,
  });
});

test('misaligned PCM is explicitly excluded from exact alignment', () => {
  const producer = new CompanionVoiceAudioAlignmentProducer('session-1');
  producer.decorate({
    type: 'tts_audio_start',
    encoding: 'pcm_s16le',
    sampleRate: 24_000,
    channels: 1,
  }, context);
  assert.equal(producer.prepareAudioChunk(Buffer.alloc(3), context), null);

  const end = producer.decorate({ type: 'tts_audio_end' }, context);
  const mapped = producer.decorate({
    type: 'text_audio_alignment',
    textSegmentID: companionVoiceTextSegmentID(context.responseId),
  }, context);
  assert.equal(end.audio.complete, false);
  assert.equal(mapped.alignmentStatus, 'unmapped');
});
