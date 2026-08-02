import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import {
  attachGPTLiveWatchRelaySocket,
  createChatGPTLiveCall,
} from '../server/gpt-live-watch-relay.js';
import {
  providerPcmToWatchPcm,
  watchPcmToProviderPcm,
} from '../server/gpt-live-watch-peer.js';

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
    controls: [],
    closed: false,
    async createOffer() { return 'watch-offer-sdp'; },
    async applyAnswer(answer) { this.answers.push(answer); },
    sendAudio(audio) { this.audio.push(Buffer.from(audio)); },
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

test('Watch relay waits for session.update, then admits OAuth and flushes bounded audio and control', async () => {
  const ws = new FakeWatchSocket();
  const harness = fakePeerHarness();
  const calls = [];
  let oauthResolutions = 0;
  const session = attachGPTLiveWatchRelaySocket({
    ws,
    req: { url: '/realtime/gpt-live/watch-relay?model=gpt-live-1-codex' },
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
    sessionTTLMS: 60_000,
  });

  const pcm = Buffer.from([1, 0, 2, 0]);
  emitJSON(ws, { type: 'input_audio.append', audio: pcm.toString('base64') });
  emitJSON(ws, { type: 'delegation.context.append', delegation_item_id: 'pending' });
  assert.equal(oauthResolutions, 0);
  assert.equal(harness.peer.audio.length, 0);

  const update = {
    type: 'session.update',
    session: {
      instructions: 'Watch instructions',
      audio: { output: { voice: 'marin' } },
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
  assert.deepEqual(harness.peer.answers, ['provider-answer-sdp']);
  assert.deepEqual(harness.peer.audio, [pcm]);
  assert.deepEqual(
    harness.peer.controls.map((value) => JSON.parse(value).type),
    ['session.update', 'delegation.context.append'],
  );

  harness.callbacks.onAudio(Buffer.from([3, 0]));
  harness.callbacks.onControl(JSON.stringify({ type: 'turn.done', turn: { role: 'assistant', transcript: 'Done' } }));
  const sent = ws.sent.map((value) => JSON.parse(value));
  assert.equal(sent[0].type, 'output_audio.delta');
  assert.equal(sent[1].type, 'turn.done');

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
    sessionTTLMS: 60_000,
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
    sessionTTLMS: 60_000,
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
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response('provider-answer', { status: 200 });
    },
    model: 'gpt-live-1-boulder-alpha',
    offerSDP: 'offer',
    requestID: 'request-1',
    session: { instructions: 'hello', audio: { output: { voice: 'marin' } } },
    signal: new AbortController().signal,
  });
  assert.equal(answer, 'provider-answer');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${accessToken}`);
  assert.equal(requests[0].init.headers['ChatGPT-Account-ID'], 'acct-123');
  assert.equal(requests[0].init.headers['OpenAI-Alpha'], 'quicksilver=v2');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.sdp, 'offer');
  assert.equal(body.session.model, 'gpt-live-1-boulder-alpha');
  assert.equal(body.session.delegation.type, 'client');
});

test('24 kHz mono and 48 kHz stereo conversion preserves exact duration and bounded samples', () => {
  const source = Buffer.alloc(480 * 2);
  for (let index = 0; index < 480; index += 1) source.writeInt16LE(index - 240, index * 2);
  const provider = watchPcmToProviderPcm(source);
  assert.equal(provider.length, 960 * 2);
  const roundTrip = providerPcmToWatchPcm(provider);
  assert.equal(roundTrip.length, source.length);
  assert.ok(Math.abs(roundTrip.readInt16LE(0) - source.readInt16LE(0)) <= 1);
});
