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
  CODEX_REALTIME_V3_DEFAULTS,
  codexAppServerNegotiation,
  normalizeCodexRealtimeWebRTCOptions,
} from '../server/codex-app-server.js';
import {
  compareCodexVersions,
  selectCodexAppServerExecutable,
} from '../server/bin-paths.js';

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

function createFakeCodexServer({
  realtimeError = '',
  realtimeStopError = '',
  contextOverflowOnce = false,
  initializeResult = null,
  featureListError = '',
  accountType = 'chatgpt',
} = {}) {
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
          result: initializeResult || {
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
            account: { type: accountType, email: 'test@example.invalid', planType: 'pro' },
            requiresOpenaiAuth: true,
          },
        });
        return;
      }
      if (message.method === 'experimentalFeature/list') {
        if (featureListError) {
          send({ id: message.id, error: { code: -32601, message: featureListError } });
          return;
        }
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
      if (message.method === 'thread/realtime/stop' && realtimeStopError) {
        send({ id: message.id, error: { code: -32000, message: realtimeStopError } });
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

test('prefers the verified newer ChatGPT-bundled Codex while honoring an explicit override', () => {
  const versions = new Map([
    ['/test/path/codex', '0.145.0'],
    ['/Applications/ChatGPT.app/Contents/Resources/codex', '0.146.0-alpha.3.1'],
  ]);
  const selected = selectCodexAppServerExecutable({
    explicitPath: '',
    pathCandidate: '/test/path/codex',
    bundledCandidate: '/Applications/ChatGPT.app/Contents/Resources/codex',
    executableCheck: (candidate) => versions.has(candidate),
    versionReader: (candidate) => versions.get(candidate) || null,
  });
  assert.equal(selected.path, '/Applications/ChatGPT.app/Contents/Resources/codex');
  assert.equal(selected.source, 'chatgpt-bundled');
  assert.equal(selected.verifiedV3Build, true);
  assert.equal(selected.reason, 'newer-verified-gpt-live-bundle');
  assert.equal(compareCodexVersions('0.146.0', '0.146.0-alpha.3.1'), 1);

  const overridden = selectCodexAppServerExecutable({
    explicitPath: '/operator/codex',
    executableCheck: () => false,
    versionReader: () => '0.145.0',
  });
  assert.equal(overridden.path, '/operator/codex');
  assert.equal(overridden.source, 'explicit');
  assert.equal(overridden.reason, 'operator-override');
});

test('normalizes the exact GPT Live V3 defaults and rejects unsupported V3 modes', () => {
  assert.deepEqual(normalizeCodexRealtimeWebRTCOptions({}), {
    ...CODEX_REALTIME_V3_DEFAULTS,
    flushTranscriptTailOnSessionEnd: undefined,
    codexResponseItemPrefix: undefined,
    includeStartupContext: undefined,
    initialItems: undefined,
    prompt: undefined,
    realtimeSessionId: undefined,
  });
  assert.throws(
    () => normalizeCodexRealtimeWebRTCOptions({ version: 'v3', outputModality: 'text' }),
    (error) => error.code === 'CODEX_REALTIME_V3_AUDIO_REQUIRED',
  );
  assert.throws(
    () => normalizeCodexRealtimeWebRTCOptions({
      version: 'v2',
      initialItems: [{ role: 'user', text: 'not supported' }],
    }),
    /supported only by V3/,
  );
});

test('initializes with VoiceClaw identity and reports capability without claiming backend admission', async () => {
  const server = createFakeCodexServer();
  const client = createClient(server);
  const status = await client.status();

  const initialize = server.calls.find((call) => call.method === 'initialize');
  assert.equal(initialize.params.clientInfo.name, 'voiceclaw_companion');
  assert.equal(initialize.params.clientInfo.title, 'VoiceClaw Realtime Companion');
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
  assert.deepEqual(status.appServer, {
    version: '0.145.0',
    protocolVersion: null,
    negotiation: 'server-version',
    compatible: true,
  });
  client.stop();
});

test('negotiates explicit and legacy Codex app-server initialize shapes', async () => {
  const server = createFakeCodexServer({
    initializeResult: {
      protocolVersion: '2026-07-01',
      serverInfo: {
        version: '0.146.0',
        userAgent: 'codex_cli_rs/0.146.0',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    },
  });
  const client = createClient(server);
  const status = await client.status();
  assert.deepEqual(status.appServer, {
    version: '0.146.0',
    protocolVersion: '2026-07-01',
    negotiation: 'explicit-protocol',
    compatible: true,
  });
  client.stop();

  assert.deepEqual(codexAppServerNegotiation({ codexHome: '/legacy' }), {
    mode: 'legacy-unversioned',
    compatible: true,
    appServerVersion: null,
    protocolVersion: null,
    userAgent: '',
    platformFamily: '',
    platformOs: '',
  });
});

test('legacy app-server without experimental feature listing remains usable', async () => {
  const server = createFakeCodexServer({ featureListError: 'Method not found' });
  const client = createClient(server);
  const status = await client.status();
  assert.equal(status.state, 'ready');
  assert.equal(status.account.signedIn, true);
  assert.equal(status.realtime.featureListAvailable, false);
  assert.match(status.realtime.featureListError, /Method not found/);
  assert.equal(status.realtime.localFeaturePresent, false);
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
  assert.equal(negotiation.threadID, 'thread-voiceclaw-1');
  assert.equal(negotiation.sessionKey, 'realtime-session');
  assert.equal(negotiation.version, 'v3');
  assert.equal(negotiation.model, 'gpt-live-1-codex');
  assert.equal(negotiation.voice, 'ember');
  assert.match(negotiation.lifecycleID, /^[0-9a-f-]{36}$/);
  assert.equal(start.params.transport.sdp, 'v=0\r\no=fake-offer\r\n');
  assert.equal(start.params.outputModality, 'audio');
  assert.equal(start.params.clientManagedHandoffs, false);
  assert.equal(start.params.codexResponsesAsItems, false);
  assert.equal(start.params.codexResponseHandoffMode, 'bemTags');
  assert.equal(start.params.flushTranscriptTailOnSessionEnd, undefined);
  assert.equal(start.params.model, 'gpt-live-1-codex');
  assert.equal(start.params.voice, 'ember');
  const threadStart = server.calls.find((call) => call.method === 'thread/start');
  assert.equal(threadStart.params.model, undefined, 'the GPT Live model must not be used as the Codex thread model');
  assert.equal(after.realtime.backendAdmission, 'verified');
  assert.equal(after.realtime.available, true);
  assert.equal(after.realtimeLifecycle.active.lifecycleID, negotiation.lifecycleID);
  bridge.stop();
});

test('forwards every generated V3 WebRTC field with exact names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voiceclaw-codex-v3-fields-'));
  const server = createFakeCodexServer();
  const bridge = new CodexAppServerBridge({
    client: createClient(server),
    statePath: join(root, 'sessions.json'),
    workspacePath: join(root, 'workspace'),
  });

  await bridge.startRealtimeWebRTC({
    sessionKey: 'v3-fields',
    sdp: 'v=0\r\no=full-v3-offer\r\n',
    version: 'v3',
    model: 'gpt-live-1-codex',
    voice: 'ember',
    outputModality: 'audio',
    clientManagedHandoffs: true,
    flushTranscriptTailOnSessionEnd: true,
    codexResponsesAsItems: true,
    codexResponseItemPrefix: '[codex] ',
    codexResponseHandoffMode: 'commentary',
    includeStartupContext: false,
    initialItems: [
      { role: 'developer', text: 'Stay concise.' },
      { role: 'user', text: 'Continue the route handoff.' },
    ],
    prompt: 'Use the supplied session context.',
    realtimeSessionId: 'realtime-resume-1',
  });

  const start = server.calls.find((call) => call.method === 'thread/realtime/start');
  assert.deepEqual(start.params, {
    threadId: 'thread-voiceclaw-1',
    outputModality: 'audio',
    version: 'v3',
    model: 'gpt-live-1-codex',
    voice: 'ember',
    transport: { type: 'webrtc', sdp: 'v=0\r\no=full-v3-offer\r\n' },
    clientManagedHandoffs: true,
    flushTranscriptTailOnSessionEnd: true,
    codexResponsesAsItems: true,
    codexResponseItemPrefix: '[codex] ',
    codexResponseHandoffMode: 'commentary',
    includeStartupContext: false,
    initialItems: [
      { role: 'developer', text: 'Stay concise.' },
      { role: 'user', text: 'Continue the route handoff.' },
    ],
    prompt: 'Use the supplied session context.',
    realtimeSessionId: 'realtime-resume-1',
  });
  bridge.stop();
});

test('requires a Codex-managed ChatGPT login before attempting GPT Live V3 admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voiceclaw-codex-v3-auth-'));
  const server = createFakeCodexServer({ accountType: 'apiKey' });
  const bridge = new CodexAppServerBridge({
    client: createClient(server),
    statePath: join(root, 'sessions.json'),
    workspacePath: join(root, 'workspace'),
  });

  await assert.rejects(
    bridge.startRealtimeWebRTC({
      sessionKey: 'v3-auth',
      sdp: 'v=0\r\no=v3-auth-offer\r\n',
    }),
    (error) => error.code === 'CODEX_REALTIME_CHATGPT_LOGIN_REQUIRED',
  );
  assert.equal(server.calls.some((call) => call.method === 'thread/realtime/start'), false);
  const status = await bridge.status();
  assert.equal(status.realtime.protocols.v3.backendAdmission, 'rejected');
  bridge.stop();
});

test('a locally rejected V3 start does not preempt an active V2 lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voiceclaw-codex-v3-preflight-'));
  const server = createFakeCodexServer({ accountType: 'apiKey' });
  const bridge = new CodexAppServerBridge({
    client: createClient(server),
    statePath: join(root, 'sessions.json'),
    workspacePath: join(root, 'workspace'),
  });

  const v2 = await bridge.startRealtimeWebSocket({
    sessionKey: 'working-v2',
    version: 'v2',
    model: 'gpt-realtime-2.1-mini',
    voice: 'marin',
    leaseOwnerID: 'v2-owner',
  });
  await assert.rejects(
    bridge.startRealtimeWebRTC({
      sessionKey: 'blocked-v3',
      sdp: 'v=0\r\no=blocked-v3-offer\r\n',
    }),
    (error) => error.code === 'CODEX_REALTIME_CHATGPT_LOGIN_REQUIRED',
  );

  const status = await bridge.status();
  assert.equal(status.realtimeLifecycle.active.lifecycleID, 'v2-owner');
  assert.equal(status.realtimeLifecycle.active.threadID, v2.threadID);
  assert.equal(status.realtimeLifecycle.active.transport, 'websocket');
  assert.equal(
    server.calls.filter((call) => call.method === 'thread/realtime/stop').length,
    0,
  );
  bridge.stop();
});

test('makes WebRTC text retries and lifecycle stop idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voiceclaw-codex-v3-lifecycle-'));
  const server = createFakeCodexServer();
  const bridge = new CodexAppServerBridge({
    client: createClient(server),
    statePath: join(root, 'sessions.json'),
    workspacePath: join(root, 'workspace'),
  });

  const started = await bridge.startRealtimeWebRTC({
    sessionKey: 'ios-live',
    lifecycleID: 'ios-lifecycle-1',
    sdp: 'v=0\r\no=ios-offer-1\r\n',
  });
  const firstText = await bridge.appendRealtimeTextIdempotent({
    threadID: started.threadID,
    text: 'Typed composer message',
    role: 'user',
    requestID: 'ios-text-request-1',
  });
  const duplicateText = await bridge.appendRealtimeTextIdempotent({
    threadID: started.threadID,
    text: 'Typed composer message',
    role: 'user',
    requestID: 'ios-text-request-1',
  });
  assert.equal(firstText.duplicate, false);
  assert.equal(duplicateText.duplicate, true);
  assert.equal(
    server.calls.filter((call) => call.method === 'thread/realtime/appendText').length,
    1,
  );
  await assert.rejects(
    bridge.appendRealtimeTextIdempotent({
      threadID: started.threadID,
      text: 'Different payload',
      role: 'user',
      requestID: 'ios-text-request-1',
    }),
    (error) => error.code === 'CODEX_REALTIME_IDEMPOTENCY_CONFLICT',
  );
  await assert.rejects(
    bridge.appendRealtimeTextIdempotent({
      threadID: started.threadID,
      text: 'x'.repeat(64_001),
      role: 'user',
      requestID: 'oversized-text',
    }),
    /exceeds 64000 characters/,
  );

  const stopped = await bridge.stopRealtimeWebRTC({
    threadID: started.threadID,
    sessionKey: started.sessionKey,
  });
  const textRetryAfterStop = await bridge.appendRealtimeTextIdempotent({
    threadID: started.threadID,
    text: 'Typed composer message',
    role: 'user',
    requestID: 'ios-text-request-1',
  });
  const repeated = await bridge.stopRealtimeWebRTC({
    threadID: started.threadID,
    sessionKey: started.sessionKey,
  });
  assert.deepEqual(stopped, {
    stopped: true,
    alreadyStopped: false,
    stale: false,
    threadID: 'thread-voiceclaw-1',
    sessionKey: 'ios-live',
    lifecycleID: 'ios-lifecycle-1',
    status: 'stopped',
  });
  assert.equal(textRetryAfterStop.duplicate, true);
  assert.equal(repeated.stopped, false);
  assert.equal(repeated.alreadyStopped, true);
  assert.equal(
    server.calls.filter((call) => call.method === 'thread/realtime/stop').length,
    1,
  );

  const restarted = await bridge.startRealtimeWebRTC({
    sessionKey: 'ios-live',
    lifecycleID: 'ios-lifecycle-2',
    sdp: 'v=0\r\no=ios-offer-2\r\n',
  });
  const stale = await bridge.stopRealtimeWebRTC({
    threadID: restarted.threadID,
    sessionKey: restarted.sessionKey,
    lifecycleID: 'ios-lifecycle-1',
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.alreadyStopped, true);
  assert.equal(
    server.calls.filter((call) => call.method === 'thread/realtime/stop').length,
    1,
  );
  await bridge.stopRealtimeWebRTC({
    threadID: restarted.threadID,
    sessionKey: restarted.sessionKey,
  });
  assert.equal(
    server.calls.filter((call) => call.method === 'thread/realtime/stop').length,
    2,
  );
  bridge.stop();
});

test('treats an app-server already-stopped response as a successful idempotent stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voiceclaw-codex-v3-already-stopped-'));
  const server = createFakeCodexServer({ realtimeStopError: 'Realtime conversation is not running.' });
  const bridge = new CodexAppServerBridge({
    client: createClient(server),
    statePath: join(root, 'sessions.json'),
    workspacePath: join(root, 'workspace'),
  });
  const started = await bridge.startRealtimeWebRTC({
    sessionKey: 'already-stopped',
    sdp: 'v=0\r\no=already-stopped-offer\r\n',
  });

  const result = await bridge.stopRealtimeWebRTC({
    threadID: started.threadID,
    sessionKey: started.sessionKey,
  });
  assert.equal(result.stopped, false);
  assert.equal(result.alreadyStopped, true);
  assert.equal((await bridge.status()).realtimeLifecycle.active, null);
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
