import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __dialogueTestHooks,
  createVoiceRemoteSessionRuntimeAdapter,
  generateReply,
  resolveProcessingConfig,
} from '../server/dialogue.js';

function successfulExecFile(_bin, _args, _options, callback) {
  const child = { kill() {} };
  queueMicrotask(() => callback(null, '{}', ''));
  return child;
}

function sessionFromDescriptor(descriptor, route) {
  return {
    sessionID: descriptor.sessionID,
    routeID: route.routeID,
    runtime: route.runtime,
    runState: descriptor.runState,
    agent: {
      id: route.agentID,
      sessionKey: descriptor.sessionKey,
      runtimeSessionID: descriptor.sessionID,
    },
  };
}

test.beforeEach(() => {
  __dialogueTestHooks.resetSessionStateForTest();
  __dialogueTestHooks.resetCallGatewayForTest();
  __dialogueTestHooks.setExecFileForTest(successfulExecFile);
});

test.afterEach(() => {
  __dialogueTestHooks.resetSessionStateForTest();
  __dialogueTestHooks.resetCallGatewayForTest();
  __dialogueTestHooks.resetExecFileForTest();
});

test('attach, resume, and new preserve explicit session semantics', () => {
  const attached = resolveProcessingConfig({
    agent: 'default',
    sessionToken: 'phone-session',
    sessionMode: 'attach',
  });
  const attachedAgain = resolveProcessingConfig({
    agent: 'default',
    sessionToken: 'phone-session',
    sessionMode: 'attach',
  });
  const resumed = resolveProcessingConfig({
    agent: 'default',
    sessionToken: 'phone-session',
    sessionMode: 'resume',
    resumeSessionId: 'known-openclaw-session',
  });
  const fresh = resolveProcessingConfig({
    agent: 'default',
    sessionToken: 'phone-session',
    sessionMode: 'new',
  });

  assert.equal(attached.sessionId, attachedAgain.sessionId);
  assert.equal(attached.sessionMode, 'attach');
  assert.equal(attached.sessionContinuity, 'attach-or-create');
  assert.equal(resumed.sessionId, 'known-openclaw-session');
  assert.equal(resumed.sessionMode, 'resume');
  assert.equal(resumed.sessionContinuity, 'resume-or-create');
  assert.equal(fresh.sessionMode, 'new');
  assert.equal(fresh.sessionContinuity, 'new');
  assert.notEqual(fresh.sessionId, attached.sessionId);
  assert.ok(fresh.sessionId.length <= 64);
});

test('aborting an accepted OpenClaw turn sends chat.abort with the accepted run identity', async () => {
  const calls = [];
  __dialogueTestHooks.setCallGatewayForTest((options) => {
    calls.push({ method: options.method, params: options.params });
    if (options.method === 'chat.abort') {
      return Promise.resolve({ aborted: true, runIds: [options.params.runId] });
    }

    assert.equal(options.method, 'agent');
    options.onAccepted?.({
      status: 'accepted',
      runId: 'gateway-run-123',
      sessionKey: 'agent:default:voice-test',
    });
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', async () => {
        try {
          await options.onSignalAbort?.((method, params) => {
            calls.push({ method, params });
            return Promise.resolve({ aborted: true, runIds: [params.runId] });
          });
        } finally {
          reject(new Error('transport aborted'));
        }
      }, { once: true });
    });
  });

  const controller = new AbortController();
  const reply = generateReply('Check my calendar', {
    signal: controller.signal,
    requestId: 'voiceclaw-request-123',
    processing: {
      agent: 'default',
      sessionToken: 'test',
      sessionMode: 'attach',
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();

  await assert.rejects(reply, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'UPSTREAM_CANCELLED');
    assert.equal(error.cancelled, true);
    assert.equal(error.runId, 'gateway-run-123');
    return true;
  });
  assert.ok(calls.some((call) => call.method === 'chat.abort'
    && call.params.runId === 'gateway-run-123'));
});

test('OpenClaw adapter starts and runs with gateway-issued session and run identities', async () => {
  const calls = [];
  const route = { routeID: 'openclaw-bridge', runtime: 'openclaw', agentID: 'main' };
  __dialogueTestHooks.setCallGatewayForTest((options) => {
    calls.push(options);
    if (options.method === 'sessions.create') {
      return Promise.resolve({
        ok: true,
        key: 'agent:main:dashboard:gateway-key',
        sessionId: 'gateway-session-id',
        entry: {
          sessionStartedAt: 1_800_000_000_000,
          updatedAt: 1_800_000_000_100,
        },
      });
    }
    if (options.method === 'agent') {
      assert.equal(options.params.sessionKey, 'agent:main:dashboard:gateway-key');
      assert.equal(options.params.sessionId, 'gateway-session-id');
      assert.equal(options.params.agentId, 'main');
      options.onAccepted?.({
        status: 'accepted',
        runId: 'gateway-accepted-run-id',
        sessionKey: 'agent:main:dashboard:gateway-key',
      });
      return Promise.resolve({
        result: {
          payloads: [{ text: 'Bound OpenClaw reply' }],
          meta: { agentMeta: { model: 'test-model' } },
        },
      });
    }
    throw new Error(`unexpected OpenClaw method: ${options.method}`);
  });

  const adapter = createVoiceRemoteSessionRuntimeAdapter();
  const descriptor = await adapter.startSession(route);
  assert.equal(descriptor.sessionID, 'gateway-session-id');
  assert.equal(descriptor.sessionKey, 'agent:main:dashboard:gateway-key');
  assert.equal(descriptor.binding.runtimeSessionID, 'gateway-session-id');

  let acceptedIdentity;
  const result = await adapter.runTurn({
    session: sessionFromDescriptor(descriptor, route),
    binding: descriptor.binding,
    text: 'Use the canonical runtime session.',
    processing: { thinking: 'minimal' },
    requestID: 'openclaw-bound-request',
    signal: new AbortController().signal,
    onRunStarted(identity) {
      acceptedIdentity = identity;
    },
    async onEvent() {},
  });

  assert.equal(acceptedIdentity.runID, 'gateway-accepted-run-id');
  assert.equal(result.runID, 'gateway-accepted-run-id');
  assert.equal(result.reply, 'Bound OpenClaw reply');
  assert.equal(result.sessionID, 'gateway-session-id');
  assert.equal(result.sessionKey, 'agent:main:dashboard:gateway-key');
  assert.equal(calls.filter((call) => call.method === 'sessions.create').length, 1);
  assert.equal(calls.filter((call) => call.method === 'agent').length, 1);
});

test('OpenClaw adapter rejects an accepted key different from the runtime binding', async () => {
  const route = { routeID: 'openclaw-bridge', runtime: 'openclaw', agentID: 'main' };
  __dialogueTestHooks.setCallGatewayForTest((options) => {
    if (options.method === 'sessions.create') {
      return Promise.resolve({
        ok: true,
        key: 'agent:main:dashboard:bound-key',
        sessionId: 'bound-session-id',
        entry: { updatedAt: Date.now() },
      });
    }
    assert.equal(options.method, 'agent');
    options.onAccepted?.({
      status: 'accepted',
      runId: 'gateway-mismatch-run',
      sessionKey: 'agent:main:dashboard:different-key',
    });
    return Promise.resolve({
      result: {
        payloads: [{ text: 'Reply under the wrong key' }],
        meta: { agentMeta: { model: 'test-model' } },
      },
    });
  });
  const adapter = createVoiceRemoteSessionRuntimeAdapter();
  const descriptor = await adapter.startSession(route);
  await assert.rejects(adapter.runTurn({
    session: sessionFromDescriptor(descriptor, route),
    binding: descriptor.binding,
    text: 'Do not accept another key.',
    processing: { thinking: 'minimal' },
    requestID: 'openclaw-mismatch-request',
    signal: new AbortController().signal,
    async onRunStarted() {},
    async onEvent() {},
  }), /instead of the bound key/);
});

test('OpenClaw adapter discovers, attaches, steers, observes, stops, and archives via session RPCs', async () => {
  const route = { routeID: 'openclaw-bridge', runtime: 'openclaw', agentID: 'main' };
  const calls = [];
  let activeRunID = 'gateway-run-original';
  let resolveSteeredRun;
  const steeredRun = new Promise((resolve) => { resolveSteeredRun = resolve; });
  __dialogueTestHooks.setCallGatewayForTest((options) => {
    calls.push(options);
    switch (options.method) {
      case 'sessions.list':
        return Promise.resolve({
          sessions: [{
            key: 'agent:main:dashboard:discover-key',
            sessionId: 'gateway-discovered-session',
            label: 'voiceclaw:openclaw-bridge',
            sessionStartedAt: 1_800_000_000_000,
            updatedAt: 1_800_000_000_500,
            hasActiveRun: !!activeRunID,
            activeRunIds: activeRunID ? [activeRunID] : [],
          }],
        });
      case 'sessions.resolve':
        return Promise.resolve({ ok: true, key: options.params.key });
      case 'sessions.steer':
        queueMicrotask(() => options.onAccepted?.({
          status: 'accepted',
          runId: 'gateway-run-steered',
          sessionKey: options.params.key,
        }));
        return steeredRun;
      case 'sessions.abort':
        activeRunID = '';
        return Promise.resolve({
          ok: true,
          abortedRunId: options.params.runId,
          status: 'aborted',
        });
      case 'sessions.patch':
        return Promise.resolve({ ok: true, key: options.params.key });
      default:
        throw new Error(`unexpected OpenClaw method: ${options.method}`);
    }
  });

  const adapter = createVoiceRemoteSessionRuntimeAdapter();
  const discovered = await adapter.discoverSessions({
    ...route,
    activeSince: 1_799_999_000_000,
    recentWindowMs: 24 * 60 * 60 * 1000,
  });
  assert.equal(discovered[0].sessionID, 'gateway-discovered-session');
  assert.equal(discovered[0].runID, 'gateway-run-original');
  const session = sessionFromDescriptor(discovered[0], route);
  await adapter.attachSession({ session, binding: discovered[0].binding });

  const steering = await adapter.steerRun({
    session,
    binding: discovered[0].binding,
    runID: 'gateway-run-original',
    text: 'Correct the active work.',
    requestID: 'gateway-steer-request',
  });
  assert.equal(steering.runID, 'gateway-run-steered');
  resolveSteeredRun({
    runId: 'gateway-run-steered',
    result: { payloads: [{ text: 'Steered final reply' }] },
  });
  assert.equal((await steering.completion).reply, 'Steered final reply');

  const observed = await adapter.observeSession({
    session: { ...session, runState: 'running' },
    binding: discovered[0].binding,
    runID: 'gateway-run-original',
  });
  assert.equal(observed.runState, 'running');
  const stopped = await adapter.stopRun({
    session,
    binding: discovered[0].binding,
    runID: 'gateway-run-original',
    requestID: 'gateway-stop-request',
  });
  assert.equal(stopped.stopped, true);
  await adapter.endSession({ session, binding: discovered[0].binding });

  assert.deepEqual(
    calls.map((call) => call.method),
    ['sessions.list', 'sessions.resolve', 'sessions.steer', 'sessions.list', 'sessions.abort', 'sessions.patch'],
  );
  assert.equal(calls.at(-1).params.archived, true);
});

class FakeHermesGateway {
  constructor() {
    this.calls = [];
    this.listeners = new Map();
    this.active = [];
  }

  subscribe(sessionID, listener) {
    let listeners = this.listeners.get(sessionID);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(sessionID, listeners);
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  emit(sessionID, type, payload = undefined) {
    const params = {
      type,
      session_id: sessionID,
      ...(payload === undefined ? {} : { payload }),
    };
    for (const listener of this.listeners.get(sessionID) || []) listener(params);
  }

  async request(method, params, options = {}) {
    this.calls.push({ method, params, options });
    switch (method) {
      case 'session.create': {
        this.active = [{
          id: 'hermes-live-session',
          session_key: 'hermes-stored-session',
          status: 'idle',
        }];
        return {
          session_id: 'hermes-live-session',
          stored_session_id: 'hermes-stored-session',
        };
      }
      case 'session.active_list':
        return { sessions: structuredClone(this.active) };
      case 'session.resume':
        this.active = [{
          id: 'hermes-resumed-live-session',
          session_key: params.session_id,
          status: 'idle',
        }];
        return {
          session_id: 'hermes-resumed-live-session',
          session_key: params.session_id,
          resumed: params.session_id,
        };
      case 'prompt.submit':
        this.active[0].status = 'streaming';
        queueMicrotask(() => {
          this.emit(params.session_id, 'message.start');
          this.emit(params.session_id, 'message.delta', { text: 'Hermes ' });
          this.emit(params.session_id, 'tool.start', { name: 'calendar' });
          this.emit(params.session_id, 'tool.complete', { name: 'calendar', status: 'complete' });
          this.emit(params.session_id, 'message.complete', {
            text: 'Hermes runtime reply',
            status: 'complete',
          });
          this.active[0].status = 'idle';
        });
        return { status: 'streaming' };
      case 'session.steer':
        return { status: 'queued', text: params.text };
      case 'session.interrupt':
        if (this.active[0]) this.active[0].status = 'idle';
        return { status: 'interrupted' };
      case 'session.close':
        this.active = this.active.filter((row) => row.id !== params.session_id);
        return { closed: true };
      default:
        throw new Error(`unexpected Hermes method: ${method}`);
    }
  }
}

test('Hermes adapter uses stored/live IDs from its gateway and streams the acknowledged operation', async () => {
  const gateway = new FakeHermesGateway();
  const storeCalls = [];
  const store = {
    async create(sessionID, options) {
      storeCalls.push(['create', sessionID, options]);
      return sessionID;
    },
    async attach(sessionID) {
      storeCalls.push(['attach', sessionID]);
      return sessionID;
    },
    async end(sessionID) {
      storeCalls.push(['end', sessionID]);
      return sessionID;
    },
    async discover() {
      return [{
        id: 'hermes-stored-session',
        source: 'voiceclaw',
        title: 'voiceclaw:hermes-bridge',
        started_at: 1_800_000_000,
        last_active: 1_800_000_100,
      }];
    },
  };
  const route = { routeID: 'hermes-bridge', runtime: 'hermes', agentID: 'hermes' };
  const adapter = createVoiceRemoteSessionRuntimeAdapter({
    hermesGateway: gateway,
    hermesSessionStore: store,
  });
  const descriptor = await adapter.startSession(route);
  assert.equal(descriptor.sessionID, 'hermes-stored-session');
  assert.equal(descriptor.binding.liveSessionID, 'hermes-live-session');
  assert.equal(descriptor.sessionKey, 'hermes:hermes-stored-session');

  let acceptedIdentity;
  const events = [];
  const result = await adapter.runTurn({
    session: sessionFromDescriptor(descriptor, route),
    binding: descriptor.binding,
    text: 'Use the bound Hermes runtime.',
    processing: { runtime: 'hermes' },
    requestID: 'hermes-prompt-operation-77',
    signal: new AbortController().signal,
    onRunStarted(identity) {
      acceptedIdentity = identity;
    },
    onEvent(event) {
      events.push(event);
    },
  });
  assert.equal(acceptedIdentity.runID, 'hermes-prompt-operation-77');
  assert.equal(result.runID, 'hermes-prompt-operation-77');
  assert.equal(result.sessionID, 'hermes-stored-session');
  assert.equal(result.reply, 'Hermes runtime reply');
  assert.deepEqual(events.map((event) => event.type), [
    'message.start',
    'message.delta',
    'tool.start',
    'tool.complete',
    'message.complete',
  ]);

  const steered = await adapter.steerRun({
    session: sessionFromDescriptor(descriptor, route),
    binding: descriptor.binding,
    runID: result.runID,
    text: 'Use the corrected date.',
    requestID: 'hermes-steer-operation',
  });
  assert.equal(steered.accepted, true);
  assert.equal(steered.runID, result.runID);
  const stopped = await adapter.stopRun({
    session: sessionFromDescriptor(descriptor, route),
    binding: descriptor.binding,
    runID: result.runID,
    requestID: 'hermes-stop-operation',
  });
  assert.equal(stopped.stopped, true);

  const voiceRestart = await adapter.restartVoiceSession({
    session: sessionFromDescriptor(descriptor, route),
    binding: descriptor.binding,
  });
  assert.equal(voiceRestart.binding.runtimeSessionID, 'hermes-stored-session');
  assert.equal(voiceRestart.agentSessionRestarted, false);
  await adapter.endSession({
    session: sessionFromDescriptor(descriptor, route),
    binding: descriptor.binding,
  });
  assert.deepEqual(storeCalls.map((call) => call.slice(0, 2)), [
    ['create', 'hermes-stored-session'],
    ['end', 'hermes-stored-session'],
  ]);
  assert.ok(gateway.calls.some((call) => call.method === 'session.steer'));
  assert.ok(gateway.calls.some((call) => call.method === 'session.interrupt'));
  assert.ok(gateway.calls.some((call) => call.method === 'session.close'));
});

test('Hermes discovery resumes the persisted runtime ID instead of creating a replacement', async () => {
  const gateway = new FakeHermesGateway();
  gateway.active = [];
  const storeCalls = [];
  const store = {
    async create() {
      throw new Error('discovery must not create a session');
    },
    async attach(sessionID) {
      storeCalls.push(['attach', sessionID]);
      return sessionID;
    },
    async end() {},
    async discover() {
      return [{
        id: 'hermes-existing-session',
        source: 'voiceclaw',
        title: 'voiceclaw:hermes-bridge',
        started_at: 1_800_000_000,
        last_active: 1_800_000_050,
      }];
    },
  };
  const route = { routeID: 'hermes-bridge', runtime: 'hermes', agentID: 'hermes' };
  const adapter = createVoiceRemoteSessionRuntimeAdapter({
    hermesGateway: gateway,
    hermesSessionStore: store,
  });
  const discovered = await adapter.discoverSessions({
    ...route,
    activeSince: 1_799_999_000_000,
    recentWindowMs: 24 * 60 * 60 * 1000,
  });
  assert.equal(discovered[0].sessionID, 'hermes-existing-session');
  const attached = await adapter.attachSession({
    session: sessionFromDescriptor(discovered[0], route),
    binding: discovered[0].binding,
  });
  assert.equal(attached.binding.runtimeSessionID, 'hermes-existing-session');
  assert.equal(attached.binding.liveSessionID, 'hermes-resumed-live-session');
  assert.deepEqual(storeCalls, [['attach', 'hermes-existing-session']]);
  const resumeCall = gateway.calls.find((call) => call.method === 'session.resume');
  assert.equal(resumeCall.params.session_id, 'hermes-existing-session');
});
