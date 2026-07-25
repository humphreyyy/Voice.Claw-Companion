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

test('Hermes CLI output parsing removes the decorative reasoning frame and preserves the reply', () => {
  const parsed = __dialogueTestHooks.parseHermesChatOutput([
    '╭─ Reasoning ─╮',
    '│ internal planning text │',
    '╰─────────────╯',
    'Hermes response for the user.',
  ].join('\n'), 'session_id: hermes-session-123');

  assert.equal(parsed.sessionId, 'hermes-session-123');
  assert.equal(parsed.reply, 'Hermes response for the user.');
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

test('generic OpenClaw model identifiers never resolve to raw direct routes', () => {
  for (const model of [
    'gpt-5.5',
    'gpt-5.6-sol',
    'gpt56sol',
    'openai/gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.4',
    'gpt54',
    'gpt-5.3-codex',
  ]) {
    const resolved = resolveProcessingConfig({ agent: model, sessionToken: 'model-routing-test' });
    assert.equal(resolved.modelRun, false, `${model} unexpectedly selected a raw model-run route`);
    assert.notEqual(resolved.promptMode, 'none', `${model} unexpectedly disabled the OpenClaw prompt/tools`);
  }
});

test('explicit direct route identifiers preserve raw no-OpenClaw execution', () => {
  for (const route of [
    'gpt55-direct',
    'gpt54-direct',
    'gpt56-sol-direct',
    'gpt56-terra-direct',
    'gpt56-luna-direct',
  ]) {
    const resolved = resolveProcessingConfig({ agent: route, sessionToken: 'direct-routing-test' });
    assert.equal(resolved.route, route);
    assert.equal(resolved.modelRun, true, `${route} did not preserve raw model-run execution`);
    assert.equal(resolved.promptMode, 'none', `${route} unexpectedly enabled the OpenClaw prompt/tools`);
  }
});

test('OpenClaw gateway lookup prefers the package beside the configured CLI and retains legacy layouts', () => {
  const candidates = __dialogueTestHooks.openClawGatewayModuleCandidates({
    gatewayModule: '/explicit/call.runtime.js',
    installPath: '/configured/openclaw',
    binRealPath: '/current/openclaw/openclaw.mjs',
  });

  assert.deepEqual(candidates.slice(0, 5), [
    '/explicit/call.runtime.js',
    '/current/openclaw/dist/call.runtime.js',
    '/current/dist/call.runtime.js',
    '/configured/openclaw/dist/call.runtime.js',
    '/configured/openclaw/node_modules/openclaw/dist/call.runtime.js',
  ]);
});

test('OpenClaw session normalization accepts current, legacy, snake-case, and nested response fields', () => {
  const current = __dialogueTestHooks.normalizedOpenClawSessionRow({
    key: 'agent:julian:current',
    sessionId: 'current-session',
    activeRunIds: ['current-run'],
    hasActiveRun: true,
  });
  const legacy = __dialogueTestHooks.normalizedOpenClawSessionRow({
    canonicalSessionKey: 'agent:julian:legacy',
    sessionID: 'legacy-session',
    activeRunID: 'legacy-run',
  });
  const snakeCase = __dialogueTestHooks.normalizedOpenClawSessionRow({
    session_key: 'agent:julian:snake',
    session_id: 'snake-session',
    active_run_ids: ['snake-run'],
    has_active_run: true,
    session_started_at: 1_800_000_000,
    updated_at: 1_800_000_100,
  });

  assert.equal(current.sessionID, 'current-session');
  assert.equal(current.sessionKey, 'agent:julian:current');
  assert.deepEqual(current.activeRunIDs, ['current-run']);
  assert.equal(legacy.sessionID, 'legacy-session');
  assert.equal(legacy.sessionKey, 'agent:julian:legacy');
  assert.deepEqual(legacy.activeRunIDs, ['legacy-run']);
  assert.equal(legacy.hasActiveRun, true);
  assert.equal(snakeCase.sessionID, 'snake-session');
  assert.equal(snakeCase.sessionKey, 'agent:julian:snake');
  assert.deepEqual(snakeCase.activeRunIDs, ['snake-run']);
  assert.equal(snakeCase.createdAt, 1_800_000_000_000);
  assert.equal(snakeCase.updatedAt, 1_800_000_100_000);
  assert.deepEqual(
    __dialogueTestHooks.openClawSessionRows({ result: { items: [{ sessionID: 'nested' }] } }),
    [{ sessionID: 'nested' }],
  );
});

test('Hermes session normalization accepts old and new gateway/store schemas', () => {
  assert.deepEqual(
    __dialogueTestHooks.hermesSessionRows({ result: { items: [{ sessionId: 'live-modern' }] } }),
    [{ sessionId: 'live-modern' }],
  );

  const legacy = __dialogueTestHooks.normalizedHermesLiveSessionRow({
    id: 'live-legacy',
    session_key: 'stored-legacy',
    status: 'streaming',
  });
  const current = __dialogueTestHooks.normalizedHermesSessionResult({
    data: {
      sessionId: 'live-current',
      storedSessionId: 'stored-current',
      runState: 'running',
    },
  });
  const stored = __dialogueTestHooks.normalizedHermesStoredSessionRow({
    session: {
      sessionId: 'stored-current',
      startedAt: 1_800_000_000_000,
      updatedAt: '2027-01-15T08:01:00.000Z',
    },
  });

  assert.deepEqual(
    { live: legacy.liveSessionID, stored: legacy.storedSessionID, status: legacy.status },
    { live: 'live-legacy', stored: 'stored-legacy', status: 'streaming' },
  );
  assert.deepEqual(
    { live: current.liveSessionID, stored: current.storedSessionID, status: current.status },
    { live: 'live-current', stored: 'stored-current', status: 'running' },
  );
  assert.equal(stored.sessionID, 'stored-current');
  assert.equal(stored.createdAt, 1_800_000_000_000);
  assert.equal(stored.updatedAt, Date.parse('2027-01-15T08:01:00.000Z'));
});

test('OpenClaw context overflow detection is canonical and does not match ordinary discussion', () => {
  assert.equal(
    __dialogueTestHooks.isOpenClawContextOverflowReply(
      'Context overflow: prompt too large for the model. Try /new.',
    ),
    true,
  );
  assert.equal(
    __dialogueTestHooks.isOpenClawContextOverflowReply(
      '⚠️ Context overflow — this conversation is too large for the model.',
    ),
    true,
  );
  assert.equal(
    __dialogueTestHooks.isOpenClawContextOverflowReply(
      'I can investigate the context overflow issue in your app.',
    ),
    false,
  );
});

test('OpenClaw adapter compacts the bound session and retries once after canonical context overflow', async () => {
  const route = { routeID: 'openclaw-bridge', runtime: 'openclaw', agentID: 'main' };
  const calls = [];
  let agentAttempt = 0;
  __dialogueTestHooks.setCallGatewayForTest((options) => {
    calls.push({ method: options.method, params: options.params });
    if (options.method === 'sessions.create') {
      return Promise.resolve({
        ok: true,
        key: 'agent:main:dashboard:overflow-key',
        sessionId: 'overflow-session-id',
        entry: { updatedAt: Date.now() },
      });
    }
    if (options.method === 'sessions.compact') {
      assert.deepEqual(options.params, {
        key: 'agent:main:dashboard:overflow-key',
        agentId: 'main',
      });
      return Promise.resolve({
        ok: true,
        key: 'agent:main:dashboard:overflow-key',
        compacted: true,
      });
    }
    assert.equal(options.method, 'agent');
    agentAttempt += 1;
    options.onAccepted?.({
      status: 'accepted',
      runId: `overflow-run-${agentAttempt}`,
      sessionKey: 'agent:main:dashboard:overflow-key',
    });
    return Promise.resolve({
      result: {
        payloads: [{
          text: agentAttempt === 1
            ? 'Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session.'
            : 'The same OpenClaw session was compacted and the request completed.',
        }],
        meta: { agentMeta: { model: 'test-model' } },
      },
    });
  });

  const adapter = createVoiceRemoteSessionRuntimeAdapter();
  const descriptor = await adapter.startSession(route);
  const acceptedRuns = [];
  const result = await adapter.runTurn({
    session: sessionFromDescriptor(descriptor, route),
    binding: descriptor.binding,
    text: 'Run this in a fresh context if necessary.',
    processing: { thinking: 'minimal' },
    requestID: 'overflow-request',
    signal: new AbortController().signal,
    async onRunStarted(identity) { acceptedRuns.push(identity.runID); },
    async onEvent() {},
  });

  assert.equal(result.reply, 'The same OpenClaw session was compacted and the request completed.');
  assert.deepEqual(acceptedRuns, ['overflow-run-1', 'overflow-run-2']);
  assert.deepEqual(calls.map(({ method }) => method), [
    'sessions.create',
    'agent',
    'sessions.compact',
    'agent',
  ]);
  assert.equal(calls[3].params.idempotencyKey, 'overflow-request:post-compact');
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
  const createCall = gateway.calls.find((call) => call.method === 'session.create');
  assert.match(createCall.params.title, /^voiceclaw:hermes-bridge:[0-9a-f-]+$/i);
  assert.equal(storeCalls[0][2].title, createCall.params.title);

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
    async discover(options) {
      storeCalls.push(['discover', options]);
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
  assert.deepEqual(storeCalls[0], ['discover', {
    activeSince: 1_799_999_000_000,
    title: 'voiceclaw:hermes-bridge',
    titlePrefix: 'voiceclaw:hermes-bridge:',
    source: 'voiceclaw',
  }]);
  const attached = await adapter.attachSession({
    session: sessionFromDescriptor(discovered[0], route),
    binding: discovered[0].binding,
  });
  assert.equal(attached.binding.runtimeSessionID, 'hermes-existing-session');
  assert.equal(attached.binding.liveSessionID, 'hermes-resumed-live-session');
  assert.deepEqual(storeCalls.slice(1), [['attach', 'hermes-existing-session']]);
  const resumeCall = gateway.calls.find((call) => call.method === 'session.resume');
  assert.equal(resumeCall.params.session_id, 'hermes-existing-session');
});

test('Hermes session creation rolls back live and stored identities when persistence fails', async () => {
  const gateway = new FakeHermesGateway();
  const storeCalls = [];
  const store = {
    async create(sessionID, options) {
      storeCalls.push(['create', sessionID, options]);
      throw new Error('duplicate Hermes title');
    },
    async attach() {},
    async end(sessionID) {
      storeCalls.push(['end', sessionID]);
      return sessionID;
    },
    async discover() { return []; },
  };
  const adapter = createVoiceRemoteSessionRuntimeAdapter({
    hermesGateway: gateway,
    hermesSessionStore: store,
  });

  await assert.rejects(
    adapter.startSession({ routeID: 'hermes-bridge', runtime: 'hermes', agentID: 'hermes' }),
    /duplicate Hermes title/,
  );

  assert.deepEqual(storeCalls.map((call) => call.slice(0, 2)), [
    ['create', 'hermes-stored-session'],
    ['end', 'hermes-stored-session'],
  ]);
  assert.ok(gateway.calls.some((call) => (
    call.method === 'session.close' && call.params.session_id === 'hermes-live-session'
  )));
  assert.deepEqual(gateway.active, []);
});
