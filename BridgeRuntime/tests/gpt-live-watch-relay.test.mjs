import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import WebSocket from 'ws';
import {
  attachGPTLiveWatchRelaySocket,
  createChatGPTLiveCall,
  createIPv4FirstLookup,
  GPTLiveWatchRelaySessionRegistry,
  requestChatGPTLiveAdmission,
} from '../server/gpt-live-watch-relay.js';
import {
  GPTLiveWatchPeer,
  providerPcmToWatchPcm,
  WatchAudioPacketCoalescer,
  watchPcmToProviderPcm,
} from '../server/gpt-live-watch-peer.js';
import { GPTLiveWatchNativePeer } from '../server/gpt-live-watch-native-peer.js';

class FakeWatchSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent = [];
  closes = [];

  send(payload) {
    this.sent.push(String(payload));
  }

  close(code, reason) {
    this.closes.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
  }

  terminate() {
    this.readyState = WebSocket.CLOSED;
  }
}

function fakePeerHarness() {
  let callbacks;
  const peer = {
    answers: [],
    audio: [],
    audioMetadata: [],
    controls: [],
    closed: false,
    async createOffer() { return 'watch-offer-sdp'; },
    async applyAnswer(answer) { this.answers.push(answer); },
    sendAudio(audio, metadata = {}) {
      this.audio.push(Buffer.from(audio));
      this.audioMetadata.push(metadata);
    },
    sendControl(payload) { this.controls.push(String(payload)); },
    close() { this.closed = true; },
  };
  return {
    peer,
    get callbacks() { return callbacks; },
    createPeer: async (options) => {
      callbacks = options.callbacks;
      return peer;
    },
  };
}

function emitJSON(ws, payload) {
  ws.emit('message', Buffer.from(JSON.stringify(payload)), false);
}

test('Watch relay waits for session.update, then admits OAuth and flushes only the newest 200 ms of audio', async () => {
  const ws = new FakeWatchSocket();
  const harness = fakePeerHarness();
  const calls = [];
  let oauthResolutions = 0;
  const session = attachGPTLiveWatchRelaySocket({
    ws,
    req: {
      url: '/realtime/gpt-live/watch-relay?model=gpt-live-1-codex',
      headers: {
        'x-voiceclaw-app-version': '1.4.73',
        'x-voiceclaw-app-build': '202608030101',
      },
    },
    resolveOAuthBearer: async () => {
      oauthResolutions += 1;
      return 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC10ZXN0In19.signature';
    },
    createPeer: harness.createPeer,
    createCall: async (request) => {
      calls.push(request);
      return 'provider-answer-sdp';
    },
    logger: { info() {}, warn() {} },
  });

  const pcmFrames = Array.from({ length: 12 }, (_, index) => Buffer.alloc(960, index + 1));
  for (const frame of pcmFrames) {
    emitJSON(ws, { type: 'input_audio.append', audio: frame.toString('base64') });
  }
  const expectedNewestAudio = Buffer.concat(pcmFrames.slice(-10));
  emitJSON(ws, { type: 'delegation.context.append', delegation_item_id: 'pending' });
  assert.equal(oauthResolutions, 0);
  assert.equal(harness.peer.audio.length, 0);

  const update = {
    type: 'session.update',
    session: {
      instructions: 'Watch instructions',
      audio: { output: { voice: 'ember' } },
      delegation: { type: 'client' },
    },
  };
  emitJSON(ws, update);
  await session.startPromise;

  assert.equal(oauthResolutions, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'gpt-live-1-codex');
  assert.equal(calls[0].offerSDP, 'watch-offer-sdp');
  assert.equal(calls[0].session.instructions, 'Watch instructions');
  assert.equal(calls[0].userAgent, 'VoiceClaw-Realtime-iOS/1.4.73 (202608030101)');
  assert.deepEqual(harness.peer.answers, ['provider-answer-sdp']);
  assert.deepEqual(Buffer.concat(harness.peer.audio), expectedNewestAudio);
  assert.equal(harness.peer.audioMetadata.every((value) => value.sampleRate === 24_000), true);
  assert.equal(harness.peer.audioMetadata.every((value) => value.channelCount === 1), true);
  assert.deepEqual(
    harness.peer.controls.map((value) => JSON.parse(value).type),
    ['delegation.context.append'],
  );

  harness.callbacks.onControlReady();
  assert.equal(ws.sent.some((value) => JSON.parse(value).type === 'session.started'), false);
  harness.callbacks.onControl(JSON.stringify({
    type: 'session.started',
    session: { id: 'provider-session-1', model: 'gpt-live-1-codex' },
  }));
  const started = ws.sent.map((value) => JSON.parse(value)).find((value) => value.type === 'session.started');
  assert.ok(started);
  assert.equal(started.session.id, 'provider-session-1');

  harness.callbacks.onAudio(Buffer.from([3, 0]));
  harness.callbacks.onControl(JSON.stringify({ type: 'turn.done', turn: { role: 'assistant', transcript: 'Done' } }));
  const sent = ws.sent.map((value) => JSON.parse(value));
  assert.equal(sent.some((value) => value.type === 'output_audio.delta'), true);
  assert.equal(sent.some((value) => value.type === 'turn.done'), true);

  session.close('test-complete');
  assert.equal(harness.peer.closed, true);
});

test('Watch relay rejects binary and malformed frames before allocating a provider peer', () => {
  const ws = new FakeWatchSocket();
  let allocations = 0;
  attachGPTLiveWatchRelaySocket({
    ws,
    req: { url: '/realtime/gpt-live/watch-relay' },
    resolveOAuthBearer: async () => 'unused',
    createPeer: async () => { allocations += 1; throw new Error('must not allocate'); },
    logger: { info() {}, warn() {} },
  });
  ws.emit('message', Buffer.from([1, 2]), true);
  assert.equal(allocations, 0);
  assert.equal(JSON.parse(ws.sent[0]).error.code, 'WATCH_LIVE_BINARY_UNSUPPORTED');
  assert.equal(ws.readyState, WebSocket.CLOSED);
});

test('Watch relay closes with a typed error when provider admission fails', async () => {
  const ws = new FakeWatchSocket();
  const harness = fakePeerHarness();
  const session = attachGPTLiveWatchRelaySocket({
    ws,
    req: { url: '/realtime/gpt-live/watch-relay' },
    resolveOAuthBearer: async () => 'oauth-token',
    createPeer: harness.createPeer,
    createCall: async () => { throw new Error('admission rejected'); },
    logger: { info() {}, warn() {} },
  });
  emitJSON(ws, { type: 'session.update', session: {} });
  await session.startPromise;
  assert.equal(JSON.parse(ws.sent.at(-1)).error.code, 'GPT_LIVE_COMPANION_RELAY_FAILED');
  assert.equal(harness.peer.closed, true);
  assert.equal(ws.readyState, WebSocket.CLOSED);
});

test('ChatGPT OAuth call uses the admitted account and never substitutes an API key', async () => {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' },
  })).toString('base64url');
  const accessToken = `header.${payload}.signature`;
  const requests = [];
  const answer = await createChatGPTLiveCall({
    accessToken,
    admissionRequest: async (request) => {
      requests.push(request);
      return { body: 'provider-answer', ok: true, status: 200 };
    },
    model: 'gpt-live-1-boulder-alpha',
    offerSDP: 'offer',
    requestID: 'request-1',
    session: { instructions: 'hello', audio: { output: { voice: 'ember' } } },
    signal: new AbortController().signal,
    userAgent: 'VoiceClaw-Realtime-iOS/1.4.73 (202608030101)',
  });
  assert.equal(answer, 'provider-answer');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.Authorization, `Bearer ${accessToken}`);
  assert.equal(requests[0].headers['ChatGPT-Account-ID'], 'acct-123');
  assert.equal(requests[0].headers['OpenAI-Alpha'], 'quicksilver=v2');
  assert.equal(requests[0].headers.originator, 'voiceclaw_realtime_ios');
  assert.equal(requests[0].headers['session-id'], 'request-1');
  assert.equal(requests[0].headers['thread-id'], 'request-1');
  assert.equal(requests[0].headers['x-session-id'], undefined);
  assert.equal(requests[0].headers['User-Agent'], 'VoiceClaw-Realtime-iOS/1.4.73 (202608030101)');
  assert.equal(requests[0].headers['Content-Length'], String(Buffer.byteLength(requests[0].body)));
  const body = JSON.parse(requests[0].body);
  assert.equal(body.sdp, 'offer');
  assert.equal(body.session.model, 'gpt-live-1-boulder-alpha');
  assert.equal(body.session.audio.output.voice, 'ember');
  assert.equal(body.session.delegation.type, 'client');
});

test('OAuth admission lookup orders IPv4 first while retaining IPv6 fallback', async () => {
  let observedOptions;
  const lookup = createIPv4FirstLookup((hostname, options, callback) => {
    assert.equal(hostname, 'chatgpt.com');
    observedOptions = options;
    callback(null, [
      { address: '2001:db8::10', family: 6 },
      { address: '192.0.2.10', family: 4 },
      { address: '2001:db8::11', family: 6 },
      { address: '192.0.2.11', family: 4 },
    ]);
  });

  const addresses = await new Promise((resolve, reject) => {
    lookup('chatgpt.com', { all: true }, (error, values) => {
      if (error) reject(error);
      else resolve(values);
    });
  });

  assert.equal(observedOptions.all, true);
  assert.equal(observedOptions.verbatim, true);
  assert.deepEqual(addresses, [
    { address: '192.0.2.10', family: 4 },
    { address: '192.0.2.11', family: 4 },
    { address: '2001:db8::10', family: 6 },
    { address: '2001:db8::11', family: 6 },
  ]);
});

function admissionRequestHarness({ responseBody = 'provider-answer', statusCode = 200 } = {}) {
  const calls = [];
  const requestImpl = (url, options, onResponse) => {
    const request = new EventEmitter();
    request.end = (body) => {
      calls.push({ body, options, url });
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.destroy = () => {};
      onResponse(response);
      queueMicrotask(() => {
        response.emit('data', Buffer.from(responseBody));
        response.emit('end');
      });
    };
    return request;
  };
  return { calls, requestImpl };
}

test('OAuth admission uses one POST with socket-level IPv4-first fallback and no IPv4-only pin', async () => {
  const harness = admissionRequestHarness();
  const dnsCalls = [];
  const result = await requestChatGPTLiveAdmission({
    body: '{"sdp":"offer"}',
    headers: { Authorization: 'Bearer redacted' },
    lookupImpl: (hostname, options, callback) => {
      dnsCalls.push({ hostname, options });
      callback(null, [
        { address: '2001:db8::20', family: 6 },
        { address: '192.0.2.20', family: 4 },
      ]);
    },
    requestImpl: harness.requestImpl,
  });

  assert.deepEqual(result, { body: 'provider-answer', ok: true, status: 200 });
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].body, '{"sdp":"offer"}');
  assert.equal(harness.calls[0].options.autoSelectFamily, true);
  assert.equal(harness.calls[0].options.autoSelectFamilyAttemptTimeout, 250);
  assert.equal(harness.calls[0].options.family, undefined);

  const resolved = await new Promise((resolve, reject) => {
    harness.calls[0].options.lookup('chatgpt.com', { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
  assert.equal(dnsCalls.length, 1);
  assert.deepEqual(resolved, [
    { address: '192.0.2.20', family: 4 },
    { address: '2001:db8::20', family: 6 },
  ]);
});

test('OAuth admission never starts a second POST after connect timeout or HTTP response', async () => {
  let timeoutRequests = 0;
  await assert.rejects(
    requestChatGPTLiveAdmission({
      body: 'offer',
      headers: {},
      requestImpl: () => {
        timeoutRequests += 1;
        const request = new EventEmitter();
        request.end = () => queueMicrotask(() => {
          const error = new Error('Connect Timeout Error');
          error.code = 'UND_ERR_CONNECT_TIMEOUT';
          request.emit('error', error);
        });
        return request;
      },
    }),
    { code: 'UND_ERR_CONNECT_TIMEOUT' },
  );
  assert.equal(timeoutRequests, 1);

  const rejected = admissionRequestHarness({ responseBody: 'forbidden', statusCode: 403 });
  const response = await requestChatGPTLiveAdmission({
    body: 'offer',
    headers: {},
    requestImpl: rejected.requestImpl,
  });
  assert.deepEqual(response, { body: 'forbidden', ok: false, status: 403 });
  assert.equal(rejected.calls.length, 1);
});

test('provider rejection and accepted-SDP application failure never retry admission or replace the peer', async () => {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' },
  })).toString('base64url');
  let rejectedAdmissions = 0;
  await assert.rejects(
    createChatGPTLiveCall({
      accessToken: `header.${payload}.signature`,
      admissionRequest: async () => {
        rejectedAdmissions += 1;
        return { body: 'provider rejected', ok: false, status: 401 };
      },
      model: 'gpt-live-1-boulder-alpha',
      offerSDP: 'offer',
      requestID: 'request-rejected',
      session: {},
    }),
    /HTTP 401: provider rejected/,
  );
  assert.equal(rejectedAdmissions, 1);

  const ws = new FakeWatchSocket();
  const harness = fakePeerHarness();
  let peerAllocations = 0;
  let acceptedAdmissions = 0;
  harness.peer.applyAnswer = async () => { throw new Error('local SDP application failed'); };
  const session = attachGPTLiveWatchRelaySocket({
    ws,
    req: { url: '/realtime/gpt-live/watch-relay' },
    resolveOAuthBearer: async () => 'oauth-token',
    createPeer: async (options) => {
      peerAllocations += 1;
      return harness.createPeer(options);
    },
    createCall: async () => {
      acceptedAdmissions += 1;
      return 'provider-answer-sdp';
    },
    logger: { info() {}, warn() {} },
  });
  emitJSON(ws, { type: 'session.update', session: {} });
  await session.startPromise;
  assert.equal(acceptedAdmissions, 1);
  assert.equal(peerAllocations, 1);
  assert.equal(harness.peer.closed, true);
  assert.equal(ws.readyState, WebSocket.CLOSED);
});

test('Companion PCM helpers preserve the supplied sample cadence without resampling', () => {
  const source = Buffer.alloc(480 * 2);
  for (let index = 0; index < 480; index += 1) source.writeInt16LE(index - 240, index * 2);
  const provider = watchPcmToProviderPcm(source);
  assert.equal(provider.length, 480);
  const roundTrip = providerPcmToWatchPcm(provider);
  assert.equal(roundTrip.length, source.length);
  assert.deepEqual(roundTrip, source);
});

test('worker boundary preserves audio sample-rate and channel metadata in both directions', () => {
  const child = new EventEmitter();
  const sent = [];
  const received = [];
  child.connected = true;
  child.exitCode = 0;
  child.signalCode = null;
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.send = (message, callback) => {
    sent.push(message);
    callback?.();
  };
  child.kill = () => {};
  const peer = new GPTLiveWatchPeer({
    child,
    callbacks: {
      onAudio(packet) { received.push(packet); },
      onControl() {},
    },
  });

  peer.sendAudio(Buffer.from([1, 0, 2, 0]), { sampleRate: 44_100, channelCount: 1 });
  assert.equal(sent[0].type, 'audio');
  assert.equal(sent[0].sampleRate, 44_100);
  assert.equal(sent[0].channelCount, 1);
  assert.deepEqual(Buffer.from(sent[0].audio), Buffer.from([1, 0, 2, 0]));

  child.emit('message', {
    type: 'event',
    event: 'audio',
    audio: Buffer.from([3, 0, 4, 0]),
    sampleRate: 32_000,
    channelCount: 2,
  });
  assert.equal(received[0].sampleRate, 32_000);
  assert.equal(received[0].channelCount, 2);
  assert.deepEqual(received[0].audio, Buffer.from([3, 0, 4, 0]));
  peer.close();
});

test('provider audio is coalesced into 20 ms Watch packets without stranding a final 10 ms packet', async () => {
  const packets = [];
  const coalescer = new WatchAudioPacketCoalescer({
    onPacket: (packet) => packets.push(packet),
    targetBytes: 960,
  });
  coalescer.push(Buffer.alloc(480, 1));
  assert.equal(packets.length, 0);
  coalescer.push(Buffer.alloc(480, 2));
  assert.equal(packets.length, 1);
  assert.equal(packets[0].length, 960);

  coalescer.push(Buffer.alloc(480, 3));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(packets.length, 2);
  assert.equal(packets[1].length, 480);
  coalescer.close();
});

test('20 ms Watch packets are delivered to libwebrtc as two immediate 10 ms frames', () => {
  const providerFrames = [];
  const peer = new GPTLiveWatchNativePeer({
    audioSource: { onData(frame) { providerFrames.push(frame.samples); } },
    audioTrack: { stop() {} },
    callbacks: { onAudio() {}, onControl() {}, onConnectionState() {} },
    dataChannel: { close() {}, readyState: 'connecting', send() {} },
    peer: { close() {}, connectionState: 'new' },
    RTCAudioSink: class {},
  });
  peer.connected = true;
  peer.sendAudio(Buffer.alloc(1_920, 1));
  assert.equal(peer.pendingAudio.length, 0);
  assert.equal(providerFrames.length, 2);
  assert.equal(providerFrames[0].some((sample) => sample !== 0), true);

  peer.sendAudio(Buffer.alloc(480, 2));
  assert.equal(providerFrames.length, 2);
  peer.sendAudio(Buffer.alloc(480, 2));
  assert.equal(peer.pendingAudio.length, 0);
  assert.equal(providerFrames.length, 3);
  assert.equal(providerFrames[2].some((sample) => sample !== 0), true);
  peer.close();
});

test('runtime audio queue reports accurate backlog, age, high-water, and drop diagnostics', () => {
  const diagnostics = [];
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const peer = new GPTLiveWatchNativePeer({
      audioSource: { onData() {} },
      audioTrack: { stop() {} },
      callbacks: {
        onAudio() {},
        onControl() {},
        onQueueDiagnostics(value) { diagnostics.push(value); },
      },
      dataChannel: { close() {}, readyState: 'connecting', send() {} },
      peer: { close() {}, connectionState: 'new' },
      RTCAudioSink: class {},
    });

    peer.sendAudio(Buffer.alloc(192_000, 1), { sampleRate: 48_000, channelCount: 1 });
    now += 1_000;
    peer.sendAudio(Buffer.alloc(192_000, 2), { sampleRate: 48_000, channelCount: 1 });
    peer.noteAudioQueueDiagnostics(true);
    let latest = diagnostics.at(-1);
    assert.equal(latest.currentBytes, 19_200);
    assert.equal(latest.currentDurationSeconds, 0.2);
    assert.equal(latest.oldestAgeMS, 0);
    assert.equal(latest.highWaterBytes, 19_200);
    assert.equal(latest.highWaterDurationSeconds, 0.2);
    assert.equal(latest.maxQueueAgeMS, 0);
    assert.equal(latest.droppedBytes, 364_800);
    assert.equal(latest.droppedDurationSeconds, 3.8);

    peer.connected = true;
    peer.flushPendingAudio();
    peer.sendAudio(Buffer.alloc(480, 3), { sampleRate: 48_000, channelCount: 1 });
    now += 250;
    peer.noteAudioQueueDiagnostics(true);
    latest = diagnostics.at(-1);
    assert.equal(latest.currentBytes, 480);
    assert.equal(latest.currentDurationSeconds, 0.005);
    assert.equal(latest.oldestAgeMS, 250);
    assert.equal(latest.maxQueueAgeMS, 250);
    peer.close();
  } finally {
    Date.now = originalNow;
  }
});

test('relay preserves actual Watch input and provider output audio metadata', async () => {
  const ws = new FakeWatchSocket();
  const harness = fakePeerHarness();
  const session = attachGPTLiveWatchRelaySocket({
    ws,
    req: { url: '/realtime/gpt-live/watch-relay' },
    resolveOAuthBearer: async () => 'oauth-token',
    createPeer: harness.createPeer,
    createCall: async () => 'provider-answer-sdp',
    logger: { info() {}, warn() {} },
  });
  emitJSON(ws, { type: 'session.update', session: {} });
  await session.startPromise;

  emitJSON(ws, {
    type: 'input_audio.append',
    audio: Buffer.from([1, 0, 2, 0]).toString('base64'),
    sample_rate: 48_000,
    channels: 1,
  });
  assert.deepEqual(harness.peer.audioMetadata.at(-1), { sampleRate: 48_000, channelCount: 1 });

  harness.callbacks.onAudio({
    audio: Buffer.from([3, 0, 4, 0]),
    sampleRate: 32_000,
    channelCount: 2,
  });
  const output = ws.sent.map((value) => JSON.parse(value)).at(-1);
  assert.equal(output.type, 'output_audio.delta');
  assert.equal(output.sample_rate, 32_000);
  assert.equal(output.channels, 2);
  session.close('test-complete');
});

test('Companion creates and cleanly tears down the libwebrtc GPT Live SDP shape', () => {
  const script = `
    import { GPTLiveWatchPeer } from './server/gpt-live-watch-peer.js';
    const peer = await GPTLiveWatchPeer.create({
      callbacks: { onAudio() {}, onControl() {}, onControlReady() {}, onError(error) { throw error; } },
    });
    const offer = await peer.createOffer();
    const result = {
      audio: /m=audio /.test(offer),
      sendrecv: /a=sendrecv/.test(offer),
      opus: /a=rtpmap:111 opus\\/48000\\/2/i.test(offer),
      application: /m=application /.test(offer),
      sctp: /a=sctp-port:/.test(offer),
    };
    peer.close();
    console.log(JSON.stringify(result));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    audio: true,
    sendrecv: true,
    opus: true,
    application: true,
    sctp: true,
  });
});

test('native libwebrtc data channel opens, exchanges control traffic, and stays open', () => {
  const script = `
    import wrtcImport from '@roamhq/wrtc';
    const wrtc = wrtcImport.default || wrtcImport;
    const offerer = new wrtc.RTCPeerConnection();
    const answerer = new wrtc.RTCPeerConnection();
    offerer.onicecandidate = ({ candidate }) => candidate && answerer.addIceCandidate(candidate);
    answerer.onicecandidate = ({ candidate }) => candidate && offerer.addIceCandidate(candidate);
    const local = offerer.createDataChannel('oai-events', { ordered: true });
    const received = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('libwebrtc loopback timed out')), 5000);
      answerer.ondatachannel = ({ channel }) => {
        channel.onmessage = ({ data }) => channel.send('ack:' + data);
      };
      local.onmessage = ({ data }) => {
        clearTimeout(timeout);
        resolve(data);
      };
    });
    const opened = new Promise((resolve) => { local.onopen = resolve; });
    const offer = await offerer.createOffer();
    await offerer.setLocalDescription(offer);
    await answerer.setRemoteDescription(offer);
    const answer = await answerer.createAnswer();
    await answerer.setLocalDescription(answer);
    await offerer.setRemoteDescription(answer);
    await opened;
    local.send('probe');
    const reply = await received;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const result = { reply, state: local.readyState };
    local.close();
    offerer.close();
    answerer.close();
    console.log(JSON.stringify(result));
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { reply: 'ack:probe', state: 'open' });
});

test('retained Watch relay reattaches to the same provider peer without replaying detached audio', async () => {
  const registry = new GPTLiveWatchRelaySessionRegistry({
    detachedRetentionMS: 60_000,
    logger: { info() {}, warn() {} },
  });
  const harness = fakePeerHarness();
  let peerAllocations = 0;
  const makeOptions = (ws) => ({
    ws,
    req: {
      url: '/realtime/gpt-live/watch-relay?model=gpt-live-1-codex',
      headers: {
        'x-voiceclaw-live-relay-session': 'relay-session-0001',
      },
    },
    clientIdentity: 'authenticated-client-1',
    resolveOAuthBearer: async () => 'oauth-token',
    createPeer: async (options) => {
      peerAllocations += 1;
      return harness.createPeer(options);
    },
    createCall: async () => 'provider-answer-sdp',
    logger: { info() {}, warn() {} },
  });

  const firstSocket = new FakeWatchSocket();
  const firstSession = registry.attach(makeOptions(firstSocket));
  emitJSON(firstSocket, { type: 'session.update', session: {} });
  await firstSession.startPromise;
  assert.equal(peerAllocations, 1);

  firstSocket.readyState = WebSocket.CLOSED;
  firstSocket.emit('close');
  harness.callbacks.onAudio(Buffer.from([3, 0]));
  assert.equal(firstSocket.sent.some((value) => JSON.parse(value).type === 'output_audio.delta'), false);
  assert.equal(harness.peer.closed, false);

  const secondSocket = new FakeWatchSocket();
  const retainedSession = registry.attach(makeOptions(secondSocket));
  assert.equal(retainedSession, firstSession);
  assert.equal(peerAllocations, 1);
  harness.callbacks.onAudio(Buffer.from([4, 0]));
  assert.equal(secondSocket.sent.some((value) => JSON.parse(value).type === 'output_audio.delta'), true);
  registry.closeAll('test-complete');
});

test('retained Watch relay does not report resumed until provider media is actually connected', async () => {
  const registry = new GPTLiveWatchRelaySessionRegistry({
    detachedRetentionMS: 60_000,
    logger: { info() {}, warn() {} },
  });
  const harness = fakePeerHarness();
  const makeOptions = (ws) => ({
    ws,
    req: {
      url: '/realtime/gpt-live/watch-relay?model=gpt-live-1-codex',
      headers: { 'x-voiceclaw-live-relay-session': 'relay-session-readiness' },
    },
    clientIdentity: 'authenticated-readiness-client',
    resolveOAuthBearer: async () => 'oauth-token',
    createPeer: harness.createPeer,
    createCall: async () => 'provider-answer-sdp',
    logger: { info() {}, warn() {} },
  });

  const firstSocket = new FakeWatchSocket();
  const session = registry.attach(makeOptions(firstSocket));
  emitJSON(firstSocket, { type: 'session.update', session: {} });
  await session.startPromise;
  harness.callbacks.onControl(JSON.stringify({
    type: 'session.started',
    session: { id: 'provider-readiness-session' },
  }));
  firstSocket.readyState = WebSocket.CLOSED;
  firstSocket.emit('close');

  const secondSocket = new FakeWatchSocket();
  registry.attach(makeOptions(secondSocket));
  const reattachEvents = secondSocket.sent.map((value) => JSON.parse(value));
  assert.equal(reattachEvents[0].type, 'session.started');
  assert.deepEqual(reattachEvents[1], {
    type: 'transport.interrupted',
    transport: 'provider-webrtc-media',
    media: 'connecting',
    control: 'active',
    message: 'GPT Live retained provider media is still connecting. End and restart if it does not resume.',
  });
  assert.equal(reattachEvents.some((event) => event.type === 'transport.resumed'), false);

  harness.callbacks.onConnectionState('connected');
  assert.deepEqual(JSON.parse(secondSocket.sent.at(-1)), {
    type: 'transport.resumed',
    transport: 'provider-webrtc-media',
    media: 'active',
    control: 'active',
  });
  registry.closeAll('test-complete');
});

test('provider media interruption is surfaced without replacing or closing the retained peer', async () => {
  const ws = new FakeWatchSocket();
  const harness = fakePeerHarness();
  const session = attachGPTLiveWatchRelaySocket({
    ws,
    req: { url: '/realtime/gpt-live/watch-relay' },
    resolveOAuthBearer: async () => 'oauth-token',
    createPeer: harness.createPeer,
    createCall: async () => 'provider-answer-sdp',
    logger: { info() {}, warn() {} },
  });
  emitJSON(ws, { type: 'session.update', session: {} });
  await session.startPromise;

  harness.callbacks.onConnectionState('disconnected');
  assert.equal(JSON.parse(ws.sent.at(-1)).type, 'transport.interrupted');
  assert.equal(harness.peer.closed, false);
  assert.equal(ws.readyState, WebSocket.OPEN);
  emitJSON(ws, { type: 'input_audio.append', audio: Buffer.from([9, 0]).toString('base64') });
  assert.equal(harness.peer.audio.length, 0);

  harness.callbacks.onConnectionState('connected');
  assert.equal(JSON.parse(ws.sent.at(-1)).type, 'transport.resumed');
  assert.equal(harness.peer.closed, false);
  emitJSON(ws, { type: 'input_audio.append', audio: Buffer.from([10, 0]).toString('base64') });
  assert.equal(harness.peer.audio.length, 1);
  session.close('test-complete');
});

test('provider control closure degrades control only while viable audio continues without peer replacement', async () => {
  const ws = new FakeWatchSocket();
  const harness = fakePeerHarness();
  let peerAllocations = 0;
  const session = attachGPTLiveWatchRelaySocket({
    ws,
    req: { url: '/realtime/gpt-live/watch-relay' },
    resolveOAuthBearer: async () => 'oauth-token',
    createPeer: async (options) => {
      peerAllocations += 1;
      return harness.createPeer(options);
    },
    createCall: async () => 'provider-answer-sdp',
    logger: { info() {}, warn() {} },
  });
  emitJSON(ws, { type: 'session.update', session: {} });
  await session.startPromise;
  harness.callbacks.onConnectionState('connected');
  harness.callbacks.onControlState('open');
  harness.callbacks.onControlReady();

  ws.sent = [];
  harness.callbacks.onControlState('closed');
  const degraded = ws.sent.map((value) => JSON.parse(value)).at(-1);
  assert.deepEqual(degraded, {
    type: 'transport.degraded',
    transport: 'provider-webrtc-control',
    media: 'active',
    control: 'closed',
    message: 'GPT Live relay control channel closed; viable audio remains active.',
  });
  assert.equal(peerAllocations, 1);
  assert.equal(harness.peer.closed, false);
  assert.equal(ws.readyState, WebSocket.OPEN);

  emitJSON(ws, { type: 'input_audio.append', audio: Buffer.from([11, 0]).toString('base64') });
  assert.deepEqual(harness.peer.audio, [Buffer.from([11, 0])]);
  harness.callbacks.onAudio(Buffer.from([12, 0]));
  assert.equal(ws.sent.map((value) => JSON.parse(value)).at(-1).type, 'output_audio.delta');
  assert.equal(peerAllocations, 1);

  harness.callbacks.onControlError(new Error('control transport unavailable'));
  const controlError = ws.sent.map((value) => JSON.parse(value)).at(-1);
  assert.equal(controlError.type, 'transport.degraded');
  assert.equal(controlError.media, 'active');
  assert.equal(controlError.control, 'error');
  assert.equal(controlError.message, 'control transport unavailable');
  assert.equal(harness.peer.closed, false);
  session.close('test-complete');
});

test('provider control closure after HTTP admission remains degraded even while SDP application is pending', async () => {
  const ws = new FakeWatchSocket();
  const harness = fakePeerHarness();
  let releaseAnswer;
  harness.peer.applyAnswer = () => new Promise((resolve) => { releaseAnswer = resolve; });
  const session = attachGPTLiveWatchRelaySocket({
    ws,
    req: { url: '/realtime/gpt-live/watch-relay' },
    resolveOAuthBearer: async () => 'oauth-token',
    createPeer: harness.createPeer,
    createCall: async () => 'provider-answer-sdp',
    logger: { info() {}, warn() {} },
  });
  emitJSON(ws, { type: 'session.update', session: {} });
  while (!releaseAnswer) await new Promise((resolve) => setImmediate(resolve));

  harness.callbacks.onControlState('closed');
  const degraded = JSON.parse(ws.sent.at(-1));
  assert.equal(degraded.type, 'transport.degraded');
  assert.equal(degraded.media, 'connecting');
  assert.equal(
    degraded.message,
    'GPT Live relay control channel closed; audio transport is still connecting.',
  );
  assert.equal(harness.peer.closed, false);
  assert.equal(ws.readyState, WebSocket.OPEN);

  releaseAnswer();
  await session.startPromise;
  session.close('test-complete');
});

test('closed provider control channel drops later controls instead of queueing or replaying them', () => {
  const sent = [];
  const dataChannel = {
    close() {},
    readyState: 'connecting',
    send(payload) { sent.push(String(payload)); },
  };
  const peer = new GPTLiveWatchNativePeer({
    audioSource: { onData() {} },
    audioTrack: { stop() {} },
    callbacks: { onAudio() {}, onControl() {}, onControlState() {} },
    dataChannel,
    peer: {
      close() {},
      connectionState: 'new',
    },
    RTCAudioSink: class {},
  });

  peer.sendControl('queued-before-open');
  dataChannel.readyState = 'open';
  peer.handleControlState('open');
  assert.deepEqual(sent, ['queued-before-open']);
  dataChannel.readyState = 'closed';
  peer.handleControlState('closed');
  peer.sendControl('must-not-replay');
  assert.deepEqual(sent, ['queued-before-open']);
  assert.deepEqual(peer.pendingControls, []);
  peer.close();
});

test('provider control queue is independent, bounded, and reports high-water and drops', () => {
  const sent = [];
  const diagnostics = [];
  const dataChannel = {
    close() {},
    readyState: 'connecting',
    send(payload) { sent.push(String(payload)); },
  };
  const peer = new GPTLiveWatchNativePeer({
    audioSource: { onData() {} },
    audioTrack: { stop() {} },
    callbacks: {
      onAudio() {},
      onControl() {},
      onQueueDiagnostics(value) { diagnostics.push(value); },
    },
    dataChannel,
    peer: { close() {}, connectionState: 'new' },
    RTCAudioSink: class {},
  });

  for (let index = 0; index < 35; index += 1) peer.sendControl(`control-${index}`);
  assert.deepEqual(diagnostics.at(-1), {
    lane: 'control',
    currentCount: 32,
    highWaterCount: 32,
    droppedCount: 3,
  });
  assert.equal(peer.pendingAudio.length, 0);

  dataChannel.readyState = 'open';
  peer.handleControlState('open');
  assert.equal(sent.length, 32);
  assert.equal(sent[0], 'control-3');
  assert.equal(sent.at(-1), 'control-34');
  peer.close();
});

test('provider peer keeps only the newest 200 ms of preconnection Watch audio', () => {
  const statePeer = {
    close() {},
    connectionState: 'new',
  };
  const peer = new GPTLiveWatchNativePeer({
    audioSource: { onData() {} },
    audioTrack: { stop() {} },
    callbacks: { onAudio() {}, onControl() {}, onConnectionState() {} },
    dataChannel: {
      close() {},
      readyState: 'connecting',
      send() {},
    },
    peer: statePeer,
    RTCAudioSink: class {},
  });

  const frames = Array.from({ length: 310 }, (_, index) => Buffer.alloc(960, index % 251));
  for (const frame of frames) peer.sendAudio(frame);
  assert.deepEqual(peer.pendingAudio, Buffer.concat(frames.slice(-20)));

  statePeer.connectionState = 'connected';
  statePeer.onconnectionstatechange();
  statePeer.connectionState = 'disconnected';
  statePeer.onconnectionstatechange();
  peer.sendAudio(Buffer.alloc(960, 99));
  assert.equal(peer.pendingAudio.length, 0);
  peer.close();
});

test('Watch relay has a dedicated non-terminal heartbeat and retains natural-close handling', async () => {
  const source = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');
  const connectionBlock = source.match(
    /gptLiveWatchRelayWss\.on\('connection',[\s\S]*?\n}\);/,
  )?.[0] || '';
  const heartbeatBlock = source.match(
    /const wsHeartbeatTimer = setInterval\([\s\S]*?COMPANION_VOICE_WS_HEARTBEAT_MS\);/,
  )?.[0] || '';
  const relayKeepaliveBlock = source.match(
    /const gptLiveWatchRelayKeepaliveTimer = setInterval\([\s\S]*?GPT_LIVE_WATCH_RELAY_KEEPALIVE_MS\);/,
  )?.[0] || '';
  const closeBlock = source.match(
    /gptLiveWatchRelayWss\.on\('close',[\s\S]*?\n}\);/,
  )?.[0] || '';

  assert.notEqual(connectionBlock, '');
  assert.match(connectionBlock, /isAlive/);
  assert.match(connectionBlock, /\bon\('pong'/);
  assert.notEqual(heartbeatBlock, '');
  assert.doesNotMatch(heartbeatBlock, /gptLiveWatchRelayWss\.clients/);
  assert.match(heartbeatBlock, /wss\.clients/);
  assert.match(heartbeatBlock, /codexRealtimeWss\.clients/);
  assert.notEqual(relayKeepaliveBlock, '');
  assert.match(relayKeepaliveBlock, /gptLiveWatchRelayWss\.clients/);
  assert.match(relayKeepaliveBlock, /\.ping\(\)/);
  assert.doesNotMatch(relayKeepaliveBlock, /\.terminate\(\)/);
  assert.match(closeBlock, /gptLiveWatchRelayRegistry\.closeAll/);
  assert.match(closeBlock, /clearInterval\(gptLiveWatchRelayKeepaliveTimer\)/);
});

test('Watch relay status probe is authenticated and bound to the authenticated client identity', async () => {
  const source = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');
  const authGate = source.indexOf('if (isProtectedBridgePath(urlPath) && !requireBridgeAuth(req, res))');
  const statusRoute = source.indexOf('urlPath === `${BASE_PATH}/realtime/gpt-live/watch-relay/status`');
  assert.ok(authGate >= 0, 'protected-path authentication gate is missing');
  assert.ok(statusRoute > authGate, 'relay status route must execute only after bridge authentication');

  const statusBlock = source.slice(statusRoute, source.indexOf('\n    }\n', statusRoute) + 7);
  assert.match(statusBlock, /authenticatedBridgeClientIdentityFromRequest\(req\)/);
  assert.match(statusBlock, /x-voiceclaw-live-relay-session/);
  assert.match(statusBlock, /Cache-Control': 'no-store/);
});

test('Watch relay defaults to ten-minute detached peer retention', () => {
  const registry = new GPTLiveWatchRelaySessionRegistry({ logger: { info() {}, warn() {} } });
  const socket = new FakeWatchSocket();
  const session = registry.attach({
    ws: socket,
    req: {
      url: '/realtime/gpt-live/watch-relay',
      headers: { 'x-voiceclaw-live-relay-session': 'relay-session-retention' },
    },
    clientIdentity: 'authenticated-retention-client',
    resolveOAuthBearer: async () => 'oauth-token',
    logger: { info() {}, warn() {} },
  });
  assert.equal(session.detachedRetentionMS, 10 * 60_000);
  assert.deepEqual(registry.status({
    clientIdentity: 'authenticated-retention-client',
    relaySessionID: 'relay-session-retention',
  }), {
    id: 'relay-session-retention',
    state: 'active',
    watchAttached: true,
    retained: true,
    retainedForMS: 10 * 60_000,
    provider: {
      admitted: false,
      media: 'connecting',
      control: 'connecting',
    },
  });
  socket.readyState = WebSocket.CLOSED;
  socket.emit('close');
  assert.notEqual(session.detachTTL, null);
  assert.equal(session.closed, false);
  const detachedStatus = registry.status({
    clientIdentity: 'authenticated-retention-client',
    relaySessionID: 'relay-session-retention',
  });
  assert.equal(detachedStatus.state, 'detached');
  assert.equal(detachedStatus.watchAttached, false);
  assert.ok(detachedStatus.retainedForMS > 0);
  assert.ok(detachedStatus.retainedForMS <= 10 * 60_000);
  registry.closeAll('test-complete');
});

test('older Watch clients without a relay-session header remain compatible without false retention', () => {
  const registry = new GPTLiveWatchRelaySessionRegistry({ logger: { info() {}, warn() {} } });
  const firstSocket = new FakeWatchSocket();
  const first = registry.attach({
    ws: firstSocket,
    req: { url: '/realtime/gpt-live/watch-relay' },
    clientIdentity: 'authenticated-legacy-client',
    resolveOAuthBearer: async () => 'oauth-token',
    logger: { info() {}, warn() {} },
  });
  assert.ok(first);

  const secondSocket = new FakeWatchSocket();
  const second = registry.attach({
    ws: secondSocket,
    req: { url: '/realtime/gpt-live/watch-relay' },
    clientIdentity: 'authenticated-legacy-client',
    resolveOAuthBearer: async () => 'oauth-token',
    logger: { info() {}, warn() {} },
  });
  assert.ok(second);
  assert.notEqual(second, first);
  assert.equal(first.closed, true);
  registry.closeAll('test-complete');
});

test('detached retained sessions expire without creating a replacement provider peer', async () => {
  const registry = new GPTLiveWatchRelaySessionRegistry({
    detachedRetentionMS: 10,
    logger: { info() {}, warn() {} },
  });
  const socket = new FakeWatchSocket();
  const options = {
    ws: socket,
    req: {
      url: '/realtime/gpt-live/watch-relay',
      headers: { 'x-voiceclaw-live-relay-session': 'relay-session-expiry' },
    },
    clientIdentity: 'authenticated-expiry-client',
    resolveOAuthBearer: async () => 'oauth-token',
    logger: { info() {}, warn() {} },
  };
  const session = registry.attach(options);
  socket.readyState = WebSocket.CLOSED;
  socket.emit('close');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(session.closed, true);
  assert.deepEqual(registry.status({
    clientIdentity: 'authenticated-expiry-client',
    relaySessionID: 'relay-session-expiry',
  }), {
    state: 'expired',
    id: 'relay-session-expiry',
  });

  const retrySocket = new FakeWatchSocket();
  const retry = registry.attach({ ...options, ws: retrySocket });
  assert.equal(retry, null);
  assert.equal(JSON.parse(retrySocket.sent[0]).error.code, 'WATCH_LIVE_RELAY_SESSION_EXPIRED');
  registry.closeAll('test-complete');
});

test('a new explicit Watch relay session retires the prior provider peer', async () => {
  const registry = new GPTLiveWatchRelaySessionRegistry({ logger: { info() {}, warn() {} } });
  const firstHarness = fakePeerHarness();
  const secondHarness = fakePeerHarness();
  let allocation = 0;
  const makeOptions = (ws, relaySessionID) => ({
    ws,
    req: {
      url: '/realtime/gpt-live/watch-relay',
      headers: { 'x-voiceclaw-live-relay-session': relaySessionID },
    },
    clientIdentity: 'authenticated-client-2',
    resolveOAuthBearer: async () => 'oauth-token',
    createPeer: async (options) => {
      allocation += 1;
      return allocation === 1
        ? firstHarness.createPeer(options)
        : secondHarness.createPeer(options);
    },
    createCall: async () => 'provider-answer-sdp',
    logger: { info() {}, warn() {} },
  });

  const firstSocket = new FakeWatchSocket();
  const first = registry.attach(makeOptions(firstSocket, 'relay-session-0002'));
  emitJSON(firstSocket, { type: 'session.update', session: {} });
  await first.startPromise;

  const secondSocket = new FakeWatchSocket();
  const second = registry.attach(makeOptions(secondSocket, 'relay-session-0003'));
  assert.notEqual(second, first);
  assert.equal(firstHarness.peer.closed, true);
  registry.closeAll('test-complete');
});
