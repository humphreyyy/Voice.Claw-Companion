export const COMPANION_VOICE_AUDIO_ALIGNMENT_SCHEMA_VERSION = 1;

const PCM_BYTES_PER_SAMPLE = new Map([
  ['pcm_s16le', 2],
]);

function nonEmptyString(value) {
  const text = String(value ?? '').trim();
  return text || '';
}

function nonNegativeSafeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function positiveSafeInteger(value) {
  const number = nonNegativeSafeInteger(value);
  return number !== null && number > 0 ? number : null;
}

function checkedAdd(lhs, rhs) {
  const result = lhs + rhs;
  return Number.isSafeInteger(result) && result >= lhs ? result : null;
}

function checkedMultiply(lhs, rhs) {
  const result = lhs * rhs;
  return Number.isSafeInteger(result) && (lhs === 0 || result / lhs === rhs) ? result : null;
}

function formatFromEvent(event = {}) {
  const encoding = nonEmptyString(event.encoding).toLowerCase();
  const sampleRate = positiveSafeInteger(event.sampleRate);
  const channels = positiveSafeInteger(event.channels);
  const bytesPerSample = PCM_BYTES_PER_SAMPLE.get(encoding) || null;
  const bytesPerFrame = bytesPerSample && channels
    ? checkedMultiply(bytesPerSample, channels)
    : null;
  if (!encoding || !sampleRate || !channels || !bytesPerSample || !bytesPerFrame) return null;
  return { encoding, sampleRate, channels, bytesPerSample, bytesPerFrame };
}

function sameFormat(lhs, rhs) {
  return lhs?.encoding === rhs?.encoding
    && lhs?.sampleRate === rhs?.sampleRate
    && lhs?.channels === rhs?.channels
    && lhs?.bytesPerSample === rhs?.bytesPerSample
    && lhs?.bytesPerFrame === rhs?.bytesPerFrame;
}

export function companionVoiceTextSegmentID(responseID, sequence = 0) {
  const response = nonEmptyString(responseID);
  const index = nonNegativeSafeInteger(sequence);
  return response && index !== null ? `${response}:text:${index}` : '';
}

export class CompanionVoiceAudioAlignmentProducer {
  constructor(sessionID) {
    this.sessionID = nonEmptyString(sessionID);
    this.activeStreams = new Map();
    this.streamSequences = new Map();
  }

  identity(context = {}) {
    const responseID = nonEmptyString(context.responseId);
    const turnID = nonEmptyString(context.turnId);
    if (!this.sessionID || !responseID || !turnID) return null;
    return {
      schemaVersion: COMPANION_VOICE_AUDIO_ALIGNMENT_SCHEMA_VERSION,
      sessionID: this.sessionID,
      generationID: nonEmptyString(context.generation),
      configRevision: nonEmptyString(context.configRevision),
      turnID,
      responseID,
    };
  }

  decorate(event = {}, context = {}) {
    const identity = this.identity(context);
    if (!identity) return { ...event };

    let outgoing = {
      ...event,
      alignment: {
        ...(event.alignment || {}),
        ...identity,
      },
    };
    const responseID = identity.responseID;

    if (event.type === 'tts_audio_start') {
      const format = formatFromEvent(event);
      if (!format) {
        return {
          ...outgoing,
          alignmentStatus: 'unknown_audio_format',
        };
      }
      let stream = this.activeStreams.get(responseID);
      if (!stream || stream.ended || !sameFormat(stream.format, format)) {
        const sequence = this.streamSequences.get(responseID) || 0;
        this.streamSequences.set(responseID, sequence + 1);
        stream = {
          id: `${responseID}:audio:${sequence}`,
          sequence,
          format,
          nextChunkSequence: 0,
          nextByteOffset: 0,
          nextFrameOffset: 0,
          nextSampleOffset: 0,
          ended: false,
          valid: true,
        };
        this.activeStreams.set(responseID, stream);
      }
      outgoing = this.decorateWithStream(outgoing, stream);
      outgoing.audio = {
        streamID: stream.id,
        ...stream.format,
      };
    } else if (event.type === 'tts_audio_end') {
      const stream = this.activeStreams.get(responseID);
      if (stream) {
        stream.ended = true;
        outgoing = this.decorateWithStream(outgoing, stream);
        outgoing.audio = {
          streamID: stream.id,
          ...stream.format,
          totalByteCount: stream.nextByteOffset,
          totalFrameCount: stream.nextFrameOffset,
          totalSampleCount: stream.nextSampleOffset,
          endByteOffsetExclusive: stream.nextByteOffset,
          endFrameOffsetExclusive: stream.nextFrameOffset,
          endSampleOffsetExclusive: stream.nextSampleOffset,
          complete: stream.valid,
        };
      } else {
        outgoing.alignmentStatus = 'unknown_audio_stream';
      }
    } else if (event.type === 'text_audio_alignment') {
      const stream = this.activeStreams.get(responseID);
      const textSegmentID = nonEmptyString(event.textSegmentID);
      if (stream?.ended && stream.valid && textSegmentID && stream.nextFrameOffset > 0) {
        outgoing = this.decorateWithStream(outgoing, stream, { textSegmentID });
        outgoing.textAudioAlignment = {
          textSegmentID,
          audioStreamID: stream.id,
          startByteOffset: 0,
          endByteOffsetExclusive: stream.nextByteOffset,
          startFrameOffset: 0,
          endFrameOffsetExclusive: stream.nextFrameOffset,
          startSampleOffset: 0,
          endSampleOffsetExclusive: stream.nextSampleOffset,
        };
      } else {
        outgoing.alignmentStatus = 'unmapped';
      }
    } else {
      const stream = this.activeStreams.get(responseID);
      const textSegmentID = nonEmptyString(event.textSegmentID);
      if (stream) outgoing = this.decorateWithStream(outgoing, stream, { textSegmentID });
      else if (textSegmentID) outgoing.alignment = { ...outgoing.alignment, textSegmentID };
    }

    return outgoing;
  }

  prepareAudioChunk(buffer, context = {}) {
    const identity = this.identity(context);
    const stream = identity ? this.activeStreams.get(identity.responseID) : null;
    const byteCount = Number(buffer?.length || 0);
    if (!identity || !stream || stream.ended || !stream.valid || !byteCount) return null;
    if (!Number.isSafeInteger(byteCount) || byteCount < 0 || byteCount % stream.format.bytesPerFrame !== 0) {
      stream.valid = false;
      return null;
    }

    const frameCount = byteCount / stream.format.bytesPerFrame;
    const sampleCount = checkedMultiply(frameCount, stream.format.channels);
    const endByteOffset = checkedAdd(stream.nextByteOffset, byteCount);
    const endFrameOffset = checkedAdd(stream.nextFrameOffset, frameCount);
    const endSampleOffset = sampleCount === null
      ? null
      : checkedAdd(stream.nextSampleOffset, sampleCount);
    if (sampleCount === null || endByteOffset === null || endFrameOffset === null || endSampleOffset === null) {
      stream.valid = false;
      return null;
    }

    const chunkSequence = stream.nextChunkSequence;
    const audioChunkID = `${stream.id}:chunk:${chunkSequence}`;
    const audio = {
      streamID: stream.id,
      chunkID: audioChunkID,
      chunkSequence,
      ...stream.format,
      byteOffset: stream.nextByteOffset,
      byteCount,
      endByteOffsetExclusive: endByteOffset,
      frameOffset: stream.nextFrameOffset,
      frameCount,
      endFrameOffsetExclusive: endFrameOffset,
      sampleOffset: stream.nextSampleOffset,
      sampleCount,
      endSampleOffsetExclusive: endSampleOffset,
    };

    stream.nextChunkSequence += 1;
    stream.nextByteOffset = endByteOffset;
    stream.nextFrameOffset = endFrameOffset;
    stream.nextSampleOffset = endSampleOffset;

    return {
      type: 'audio_chunk',
      alignment: {
        ...identity,
        audioStreamID: stream.id,
        audioChunkID,
      },
      audio,
    };
  }

  decorateWithStream(event, stream, additions = {}) {
    return {
      ...event,
      alignment: {
        ...(event.alignment || {}),
        audioStreamID: stream.id,
        ...additions,
      },
    };
  }
}
