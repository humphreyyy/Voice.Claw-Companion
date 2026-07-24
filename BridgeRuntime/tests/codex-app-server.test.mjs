import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  attachCodexRealtimeRelaySocket,
  CodexAppServerBridge,
  CodexAppServerClient,
} from '../server/codex-app-server.js';

class FakeCodexProcess extends EventEmitter {
  constructor(onMessage) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    let buffered = '';
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk) => {
      buffered += String(chunk || '');
      while (buffered.includes('\n')) {
        const index = buffered.indexOf('\n');
        const line = buffered.slice(0, index).trim();
        buffered = buffered.slice(index + 1);
        if (!line) continue;
        onMessage(JSON.parse(line), (message) => this.send(message));
      }
    });
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill(signal = 'SIGTERM') {
    if (this.killed) return;
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, signal));
  }
}

class FakeRelaySocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closeCode = null;
  }

  send(data, options = undefined) {
    this.sent.push({ data, options });
  }

  close(code = 1000) {
    this.closeCode = code;
    this.readyState = 3;
    this.emit('close', code);
  }
}

function createFakeCodexServer({ realtimeError = '', contextOverflowOnce = false } = {}) {
  const calls = [];
  const spawnOptions = [];
  let threadStarts = 0;
  let threadResumes = 0;
  let turnSequence = 0;
  let compactions = 0;
  let shouldOverflow = contextOverflowOnce;
  let process = null;
  const spawnProcess = (_binary, _args, options) => {
    spawnOptions.push(options);
    process = new FakeCodexProcess((message, send) => {
      calls.push(message);
      if (message.method === 'initialized') return;
      if (message.method === 'initialize') {
        send({
          id: message.id,
          result: {
            userAgent: 'codex_cli_rs/0.145.0 (VoiceClaw test)',
            codexHome: '/tmp/codex-home',
            platformFamily: 'unix',
            platformOs: 'macos',
          },
        });
        return;
      }
      if (message.method === 'account/read') {
        send({
          id: message.id,
          result: {
            account: { type: 'chatgpt', email: 'test@example.invalid', planType: 'pro' },
            requiresOpenaiAuth: true,
          },
        });
        return;
      }
      if (message.method === 'experimentalFeature/list') {
        send({
          id: message.id,
          result: {
            data: [{
              name: 'realtime_conversation',
              stage: 'underDevelopment',
              enabled: true,
              defaultEnabled: false,
              displayName: null,
              description: null,
              announcement: null,
            }],
            nextCursor: null,
          },
        });
        return;
      }
      if (message.method === 'thread/start') {
        threadStarts += 1;
        send({ id: message.id, result: { thread: { id: 'thread-voiceclaw-1' } } });
        return;
      }
      if (message.method === 'thread/resume') {
        threadResumes += 1;
        send({ id: message.id, result: { thread: { id: message.params.threadId } } });
        return;
      }
      if (message.method === 'thread/compact/start') {
        compactions += 1;
        send({ id: message.id, result: {} });
        queueMicrotask(() => {
          send({ method: 'thread/compacted', params: { threadId: message.params.threadId } });
        });
        return;
      }
      if (message.method === 'turn/start') {
        turnSequence += 1;
        const turnID = `turn-${turnSequence}`;
        send({ id: message.id, result: { turn: { id: turnID, status: 'inProgress', items: [] } } });
        queueMicrotask(() => {
          if (shouldOverflow) {
            shouldOverflow = false;
            send({
              method: 'turn/completed',
              params: {
                threadId: message.params.threadId,
                turn: {
                  id: turnID,
                  status: 'failed',
                  items: [],
                  error: {
                    message: 'Context overflow: prompt too large for the model.',
                    codexErrorInfo: 'context_window_exceeded',
                  },
                },
              },
            });
            return;
          }
          send({
            method: 'item/agentMessage/delta',
            params: {
              threadId: message.params.threadId,
              turnId: turnID,
              itemId: `message-${turnSequence}`,
              delta: `reply-${turnSequence}`,
            },
          });
          send({
            method: 'item/completed',
            params: {
              threadId: message.params.threadId,
              turnId: turnID,
              item: { type: 'agentMessage', id: `message-${turnSequence}`, text: `reply-${turnSequence}` },
            },
          });
          send({
            method: 'turn/completed',
            params: {
              threadId: message.params.threadId,
              turn: { id: turnID, status: 'completed', items: [], error: null },
            },
          });
        });
        return;
      }
      if (message.method === 'thread/realtime/start') {
        send({ id: message.id, result: {} });
        queueMicrotask(() => {
          const currentRealtimeError = typeof realtimeError === 'function'
            ? realtimeError(message.params)
            : realtimeError;
          if (currentRealtimeError) {
            send({
              method: 'thread/realtime/error',
              params: { threadId: message.params.threadId, message: currentRealtimeError },
            });
          } else if (message.params.transport?.type === 'webrtc') {
            send({
              method: 'thread/realtime/sdp',
              params: { threadId: message.params.threadId, sdp: 'v=0\r\no=fake-answer\r\n' },
            });
          } else {
            send({
              method: 'thread/realtime/started',
              params: {
                threadId: message.params.threadId,
                realtimeSessionId: 'realtime-session-1',
                version: message.params.version || 'v3',
              },
            });
          }
        });
        return;
      }
      if (message.method.startsWith('thread/realtime/')) {
        send({ id: message.id, result: {} });
        return;
      }
      send({ id: message.id, error: { code: -32601, message: `Unhandled test method: ${message.method}` } });
    });
    return process;
  };
  return {
    spawnProcess,
    spawnOptions,
    calls,
    get threadStarts() { return threadStarts; },
    get threadResumes() { return threadResumes; },
    get compactions() { return compactions; },
    get process() { return process; },
  };
}

test('injects the current Companion OpenAI key into Codex app-server and restarts after key rotation', async () => {
  const server = createFakeCodexServer();
  let currentKey = 'sk-test-first';
  const client = new CodexAppServerClient({
    codexPath: '/test/bin/codex',
    spawnProcess: server.spawnProcess,
    environment: { PATH: '/test/bin' },
    environmentProvider: () => ({ OPENAI_API_KEY: currentKey }),
    clientVersion: '0.1.test',
    requestTimeoutMs: 1_000,
  });

  await client.start();
  assert.equal(server.spawnOptions.length, 1);
  assert.equal(server.spawnOptions[0].env.OPENAI_API_KEY, 'sk-test-first');

  await client.start();
  assert.equal(server.spawnOptions.length, 1, 'unchanged credentials must reuse the ready app-server');

  currentKey = 'sk-test-second';
  await client.start();
  assert.equal(server.spawnOptions.length, 2, 'rotated credentials must restart the app-server');
  assert.equal(server.spawnOptions[1].env.OPENAI_API_KEY, 'sk-test-second');
  client.stop();
});

function createClient(server) {
  return new CodexAppServerClient({
    codexPath: '/test/bin/codex',
    spawnProcess: server.spawnProcess,
    clientVersion: '0.1.test',
    requestTimeoutMs: 1_000,
    turnTimeoutMs: 1_000,
    realtimeTimeoutMs: 1_000,
  });
}

test('initializes with VoiceClaw identity and reports capability without claiming backend admission', async () => {
  const server = createFakeCodexServer();
  const client = createClient(server);
  const status = await client.status();

  const initialize = server.calls.find((call) => call.method === 'initialize');
  assert.equal(initialize.params.clientInfo.name, 'voiceclaw_companion');
  assert.equal(initialize.params.clientInfo.title, 'VoiceClaw Companion');
  assert.equal(initialize.params.capabilities.experimentalApi, true);
  assert.equal(initialize.params.capabilities.requestAttestation, undefined);
  assert.ok(server.calls.some((call) => call.method === 'initialized'));
  assert.deepEqual(status.account, {
    signedIn: true,
    type: 'chatgpt',
    planType: 'pro',
    requiresOpenaiAuth: true,
  });
  assert.equal(status.realtime.localFeatureEnabled, true);
  assert.equal(status.realtime.backendAdmission, 'unverified');
  assert.equal(status.realtime.available, false);
  client.stop();
});

test('runs serialized text turns on one durable Codex thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voiceclaw-codex-test-'));
  const server = createFakeCodexServer();
  const client = createClient(server);
  const bridge = new CodexAppServerBridge({
    client,
    statePath: join(root, 'sessions.json'),
    workspacePath: join(root, 'workspace'),
  });

  const first = await bridge.runTurn({ sessionKey: 'phone-live', text: 'first' });
  const second = await bridge.runTurn({ sessionKey: 'phone-live', text: 'second' });

  assert.equal(first.threadID, 'thread-voiceclaw-1');
  assert.equal(first.text, 'reply-1');
  assert.equal(second.threadID, 'thread-voiceclaw-1');
  assert.equal(second.text, 'reply-2');
  assert.equal(server.threadStarts, 1);
  assert.equal(server.threadResumes, 0);
  const start = server.calls.find((call) => call.method === 'thread/start');
  assert.equal(start.params.approvalPolicy, 'never');
  assert.equal(start.params.sandbox, 'workspace-write');
  assert.equal(start.params.serviceName, 'voiceclaw_companion');
  const turns = server.calls.filter((call) => call.method === 'turn/start');
  assert.deepEqual(turns[0].params.input, [{ type: 'text', text: 'first', text_elements: [] }]);
  bridge.stop();
});

test('compacts and retries one Codex turn after a context overflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voiceclaw-codex-compact-'));
  const server = createFakeCodexServer({ contextOverflowOnce: true });
  const bridge = new CodexAppServerBridge({
    client: createClient(server),
    statePath: join(root, 'sessions.json'),
    workspacePath: join(root, 'workspace'),
  });

  const result = await bridge.runTurn({ sessionKey: 'overflow-session', text: 'retry me' });

  assert.equal(result.threadID, 'thread-voiceclaw-1');
  assert.equal(result.text, 'reply-2');
  assert.equal(result.recoveredByCompaction, true);
  assert.equal(server.threadStarts, 1);
  assert.equal(server.compactions, 1);
  assert.equal(server.calls.filter((call) => call.method === 'turn/start').length, 2);
  bridge.stop();
});

test('resumes a persisted thread after the app-server process restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voiceclaw-codex-resume-'));
  const statePath = join(root, 'sessions.json');
  const workspacePath = join(root, 'workspace');

  const firstServer = createFakeCodexServer();
  const firstBridge = new CodexAppServerBridge({
    client: createClient(firstServer),
    statePath,
    workspacePath,
  });
  await firstBridge.runTurn({ sessionKey: 'durable-session', text: 'first' });
  firstBridge.stop();

  const secondServer = createFakeCodexServer();
  const secondBridge = new CodexAppServerBridge({
    client: createClient(secondServer),
    statePath,
    workspacePath,
  });
  const resumed = await secondBridge.runTurn({ sessionKey: 'durable-session', text: 'second' });

  assert.equal(resumed.threadID, 'thread-voiceclaw-1');
  assert.equal(secondServer.threadStarts, 0);
  assert.equal(secondServer.threadResumes, 1);
  secondBridge.stop();
});

test('marks experimental realtime available only after receiving a real SDP answer event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voiceclaw-codex-realtime-'));
  const server = createFakeCodexServer();
  const client = createClient(server);
  const bridge = new CodexAppServerBridge({
    client,
    statePath: join(root, 'sessions.json'),
    workspacePath: join(root, 'workspace'),
  });

  const before = await bridge.status();
  assert.equal(before.realtime.available, false);
  const negotiation = await bridge.startRealtimeWebRTC({
    sessionKey: 'realtime-session',
    sdp: 'v=0\r\no=fake-offer\r\n',
  });
  const after = await bridge.status();
  const start = server.calls.find((call) => call.method === 'thread/realtime/start');

  assert.equal(negotiation.sdp, 'v=0\r\no=fake-answer\r\n');
  assert.equal(start.params.transport.sdp, 'v=0\r\no=fake-offer\r\n');
  assert.equal(after.realtime.backendAdmission, 'verified');
  assert.equal(after.realtime.available, true);
  bridge.stop();
});

test('represents V3 WebSocket as a distinct transport with app-server audio methods', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voiceclaw-codex-websocket-'));
  const server = createFakeCodexServer();
  const client = createClient(server);
  const bridge = new CodexAppServerBridge({
    client,
    statePath: join(root, 'sessions.json'),
    workspacePath: join(root, 'workspace'),
  });

  const started = await bridge.startRealtimeWebSocket({ sessionKey: 'websocket-session' });
  await client.appendRealtimeAudio({
    threadID: started.threadID,
    data: Buffer.alloc(640).toString('base64'),
    sampleRate: 16_000,
    numChannels: 1,
    samplesPerChannel: 320,
  });
  const status = await bridge.status();

  assert.equal(started.transport, 'websocket');
  assert.equal(started.version, 'v3');
  assert.equal(started.realtimeSessionID, 'realtime-session-1');
  assert.equal(status.realtime.protocols.v3.name, 'Frameless Bidi');
  assert.equal(status.realtime.protocols.v3.backendAdmission, 'verified');
  assert.equal(status.realtime.protocols.v2.backendAdmission, 'unverified');
  assert.equal(status.realtime.transports.websocket.backendAdmission, 'verified');
  assert.equal(status.realtime.transports.webrtc.backendAdmission, 'unverified');
  const audio = server.calls.find((call) => call.method === 'thread/realtime/appendAudio');
  assert.equal(audio.params.audio.sampleRate, 16_000);
  assert.equal(audio.params.audio.numChannels, 1);
  assert.equal(audio.params.audio.samplesPerChannel, 320);
  bridge.stop();
});

test('keeps successful Realtime Voice V2 admission distinct from Frameless Bidi V3', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voiceclaw-codex-v2-'));
  const server = createFakeCodexServer();
  const bridge = new CodexAppServerBridge({
    client: createClient(server),
    statePath: join(root, 'sessions.json'),
    workspacePath: join(root, 'workspace'),
  });

  const started = await bridge.startRealtimeWebSocket({
    sessionKey: 'v2-session',
    version: 'v2',
    model: 'gpt-realtime-2.1-mini',
    voice: 'marin',
    allowAPIKeyAuth: true,
  });
  const status = await bridge.status();
  const start = server.calls.find((call) => call.method === 'thread/realtime/start');

  assert.equal(started.version, 'v2');
  assert.equal(started.model, 'gpt-realtime-2.1-mini');
  assert.equal(started.voice, 'marin');
  assert.equal(start.params.voice, 'marin');
  assert.equal(status.realtime.protocols.v2.backendAdmission, 'verified');
  assert.equal(status.realtime.protocols.v3.backendAdmission, 'unverified');
  assert.equal(status.realtime.transports.websocket.lastVersion, 'v2');
  assert.equal(status.realtime.transports.websocket.lastModel, 'gpt-realtime-2.1-mini');
  assert.equal(status.realtime.transports.websocket.lastVoice, 'marin');
  bridge.stop();
});

test('relays the verified V2 media path without presenting it as V3', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voiceclaw-codex-relay-'));
  const server = createFakeCodexServer();
  const bridge = new CodexAppServerBridge({
    client: createClient(server),
    statePath: join(root, 'sessions.json'),
    workspacePath: join(root, 'workspace'),
  });
  const ws = new FakeRelaySocket();
  const relay = attachCodexRealtimeRelaySocket({ ws, bridge });

  ws.emit('message', Buffer.from(JSON.stringify({
    type: 'start',
    sessionKey: 'relay-session',
    version: 'v2',
    model: 'gpt-realtime-2.1-mini',
    voice: 'marin',
    allowAPIKeyAuth: true,
    inputAudio: { encoding: 'pcm_s16le', sampleRate: 16_000, numChannels: 1 },
  })), false);
  await relay.whenIdle();

  const started = ws.sent
    .filter(({ data }) => typeof data === 'string')
    .map(({ data }) => JSON.parse(data))
    .find((event) => event.type === 'started');
  assert.equal(started.protocol, 'v2');
  assert.equal(started.transport, 'codex-app-server-websocket');
  assert.equal(started.model, 'gpt-realtime-2.1-mini');

  const input = Buffer.alloc(640, 1);
  ws.emit('message', input, true);
  await relay.whenIdle();
  const appended = server.calls.find((call) => call.method === 'thread/realtime/appendAudio');
  assert.equal(appended.params.audio.sampleRate, 16_000);
  assert.equal(appended.params.audio.numChannels, 1);
  assert.equal(appended.params.audio.samplesPerChannel, 320);

  const output = Buffer.alloc(960, 2);
  server.process.send({
    method: 'thread/realtime/outputAudio/delta',
    params: {
      threadId: 'thread-voiceclaw-1',
      audio: {
        data: output.toString('base64'),
        sampleRate: 24_000,
        numChannels: 1,
        samplesPerChannel: 480,
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const outputMetadata = ws.sent
    .filter(({ data }) => typeof data === 'string')
    .map(({ data }) => JSON.parse(data))
    .find((event) => event.type === 'output_audio');
  const outputFrame = ws.sent.find(({ data, options }) => Buffer.isBuffer(data) && options?.binary);
  assert.equal(outputMetadata.sampleRate, 24_000);
  assert.deepEqual(outputFrame.data, output);

  relay.close();
  bridge.stop();
});

test('rejects V3 on the verified V2 relay instead of silently downgrading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voiceclaw-codex-relay-v3-'));
  const server = createFakeCodexServer();
  const bridge = new CodexAppServerBridge({
    client: createClient(server),
    statePath: join(root, 'sessions.json'),
    workspacePath: join(root, 'workspace'),
  });
  const ws = new FakeRelaySocket();
  const relay = attachCodexRealtimeRelaySocket({ ws, bridge });

  ws.emit('message', Buffer.from(JSON.stringify({
    type: 'start',
    version: 'v3',
    allowAPIKeyAuth: true,
  })), false);
  await relay.whenIdle();
  const error = ws.sent
    .filter(({ data }) => typeof data === 'string')
    .map(({ data }) => JSON.parse(data))
    .find((event) => event.type === 'error');
  assert.equal(error.code, 'CODEX_REALTIME_VERSION_NOT_ADMITTED');
  assert.match(error.message, /V3 requires separate backend admission/);
  assert.equal(server.calls.some((call) => call.method === 'thread/realtime/start'), false);

  relay.close();
  bridge.stop();
});

test('rejects Codex realtime relay start when the iPhone has not authorized API key use', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voiceclaw-codex-relay-auth-'));
  const server = createFakeCodexServer();
  const bridge = new CodexAppServerBridge({
    client: createClient(server),
    statePath: join(root, 'sessions.json'),
    workspacePath: join(root, 'workspace'),
  });
  const ws = new FakeRelaySocket();
  const relay = attachCodexRealtimeRelaySocket({ ws, bridge });

  ws.emit('message', Buffer.from(JSON.stringify({ type: 'start', version: 'v2' })), false);
  await relay.whenIdle();
  const error = ws.sent
    .filter(({ data }) => typeof data === 'string')
    .map(({ data }) => JSON.parse(data))
    .find((event) => event.type === 'error');
  assert.equal(error.code, 'CODEX_REALTIME_API_KEY_NOT_AUTHORIZED');
  assert.equal(server.calls.some((call) => call.method === 'thread/realtime/start'), false);

  relay.close();
  bridge.stop();
});

test('retains a verified V2 path after a later V3 admission rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voiceclaw-codex-mixed-admission-'));
  const server = createFakeCodexServer({
    realtimeError: (params) => params.version === 'v3' ? 'Voice session access denied.' : '',
  });
  const bridge = new CodexAppServerBridge({
    client: createClient(server),
    statePath: join(root, 'sessions.json'),
    workspacePath: join(root, 'workspace'),
  });

  await bridge.startRealtimeWebSocket({
    sessionKey: 'working-v2',
    version: 'v2',
    model: 'gpt-realtime-2.1-mini',
    voice: 'marin',
  });
  await assert.rejects(
    bridge.startRealtimeWebSocket({ sessionKey: 'blocked-v3', version: 'v3', voice: 'cove' }),
    /Voice session access denied/,
  );
  const status = await bridge.status();

  assert.equal(status.realtime.available, true);
  assert.equal(status.realtime.protocols.v2.backendAdmission, 'verified');
  assert.equal(status.realtime.protocols.v3.backendAdmission, 'rejected');
  assert.deepEqual(status.realtime.availablePaths.map((path) => `${path.transport}:${path.version}`), ['websocket:v2']);
  bridge.stop();
});

test('records a backend realtime rejection without exposing the engine as available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voiceclaw-codex-rejected-'));
  const server = createFakeCodexServer({ realtimeError: 'Realtime account admission is unavailable.' });
  const client = createClient(server);
  const bridge = new CodexAppServerBridge({
    client,
    statePath: join(root, 'sessions.json'),
    workspacePath: join(root, 'workspace'),
  });

  await assert.rejects(
    bridge.startRealtimeWebRTC({ sessionKey: 'rejected', sdp: 'v=0\r\no=fake-offer\r\n' }),
    /Realtime account admission is unavailable/,
  );
  const status = await bridge.status();
  assert.equal(status.realtime.backendAdmission, 'rejected');
  assert.equal(status.realtime.available, false);
  bridge.stop();
});
