import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  VOICE_REMOTE_SESSION_RECENT_WINDOW_MS,
  VOICE_REMOTE_SESSION_SCHEMA_VERSION,
  VoiceRemoteSessionService,
  createVoiceRemoteSessionHTTPHandler,
} from '../server/voice-remote-sessions.js';

const route = {
  routeID: 'voice-agent-route',
  runtime: 'openclaw',
  agentID: 'main',
};

function schema2StorageKey(runtime, agentID, sessionID) {
  return createHash('sha256')
    .update(`voiceclaw-runtime-session-v2\0${runtime}\0${agentID}\0${sessionID}`)
    .digest('hex');
}

function schema3StorageKey(runtime, agentID, sessionID) {
  return createHash('sha256')
    .update(`voiceclaw-runtime-session-v3\0${runtime}\0${agentID}\0${sessionID}`)
    .digest('hex');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createFakeRuntimeAdapter(now = () => Date.now()) {
  const calls = [];
  const sessions = new Map();
  let sessionSequence = 0;
  let runSequence = 0;
  const adapter = {
    calls,
    sessions,
    runImplementation: null,
    steerImplementation: null,
    stopImplementation: null,

    binding({ routeID, runtime, agentID, sessionID, liveSessionID = '' }) {
      const sessionKey = runtime === 'hermes'
        ? `hermes:${sessionID}`
        : `agent:${agentID}:dashboard:${sessionID}`;
      return {
        runtime,
        routeID,
        agentID,
        canonicalSessionKey: sessionKey,
        dialogueSessionID: liveSessionID || sessionID,
        runtimeSessionID: sessionID,
        ...(liveSessionID ? { liveSessionID } : {}),
        label: `voiceclaw:${routeID}`,
      };
    },

    seed({ routeID, runtime, agentID, sessionID, updatedAt = now(), createdAt = updatedAt }) {
      const binding = adapter.binding({ routeID, runtime, agentID, sessionID });
      const value = {
        routeID,
        runtime,
        agentID,
        sessionID,
        sessionKey: binding.canonicalSessionKey,
        createdAt,
        updatedAt,
        state: 'detached',
        runID: null,
        runState: 'idle',
        binding,
      };
      sessions.set(sessionID, value);
      return value;
    },

    async discoverSessions({ routeID, runtime, agentID, activeSince }) {
      calls.push({ action: 'discover', routeID, runtime, agentID, activeSince });
      return [...sessions.values()]
        .filter((value) => value.routeID === routeID
          && value.runtime === runtime
          && value.agentID === agentID
          && value.state !== 'ended'
          && value.updatedAt >= activeSince)
        .map((value) => structuredClone(value));
    },

    async startSession({ routeID, runtime, agentID }) {
      const sessionID = `${runtime}-runtime-session-${++sessionSequence}`;
      const value = adapter.seed({
        routeID,
        runtime,
        agentID,
        sessionID,
        updatedAt: now(),
      });
      value.state = 'attached';
      calls.push({ action: 'start', sessionID, sessionKey: value.sessionKey });
      return structuredClone(value);
    },

    async attachSession({ session, binding }) {
      calls.push({ action: 'attach', sessionID: session.sessionID, sessionKey: binding.canonicalSessionKey });
      return { binding };
    },

    async restartVoiceSession({ session, binding }) {
      calls.push({ action: 'restart_voice', sessionID: session.sessionID, sessionKey: binding.canonicalSessionKey });
      return { binding, agentSessionRestarted: false };
    },

    async detachSession({ session, binding }) {
      calls.push({ action: 'detach', sessionID: session.sessionID, sessionKey: binding.canonicalSessionKey });
      return { detached: true };
    },

    async endSession({ session, binding }) {
      calls.push({ action: 'end', sessionID: session.sessionID, sessionKey: binding.canonicalSessionKey });
      const stored = sessions.get(session.sessionID);
      if (stored) stored.state = 'ended';
      return { released: true };
    },

    async runTurn(args) {
      calls.push({ action: 'turn', sessionID: args.session.sessionID, requestID: args.requestID });
      if (adapter.runImplementation) return adapter.runImplementation(args);
      const runID = `${args.session.runtime}-runtime-run-${++runSequence}`;
      await args.onRunStarted({ runID, binding: args.binding });
      await args.onEvent({ type: 'message.delta', data: { preview: 'runtime output' } });
      return {
        reply: `${args.session.runtime} reply`,
        runID,
        sessionID: args.session.sessionID,
        sessionKey: args.binding.canonicalSessionKey,
        binding: args.binding,
      };
    },

    async steerRun(args) {
      calls.push({ action: 'steer', runID: args.runID, requestID: args.requestID, text: args.text });
      if (adapter.steerImplementation) return adapter.steerImplementation(args);
      return {
        accepted: true,
        runID: `${args.session.runtime}-runtime-run-${++runSequence}`,
        binding: args.binding,
      };
    },

    async stopRun(args) {
      calls.push({ action: 'stop', runID: args.runID, requestID: args.requestID });
      if (adapter.stopImplementation) return adapter.stopImplementation(args);
      return { stopped: true, reason: 'runtime-confirmed', binding: args.binding };
    },

    async observeSession({ session, binding, runID }) {
      calls.push({ action: 'observe', sessionID: session.sessionID, runID });
      return { runID, runState: session.runState, binding };
    },
  };
  return adapter;
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'voiceclaw-remote-sessions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, 'state', 'voice-remote-sessions.json');
  let currentTime = options.currentTime ?? 1_800_000_000_000;
  const runtimeAdapter = options.runtimeAdapter || createFakeRuntimeAdapter(() => currentTime);
  const service = new VoiceRemoteSessionService({
    statePath,
    now: () => currentTime,
    runtimeAdapter,
    ...(options.serviceOptions || {}),
  });
  return {
    root,
    statePath,
    runtimeAdapter,
    service,
    serviceOptions: {
      statePath,
      now: () => currentTime,
      runtimeAdapter,
      ...(options.serviceOptions || {}),
    },
    now: () => currentTime,
    advance(milliseconds) { currentTime += milliseconds; },
  };
}

function expected(session, overrides = {}) {
  return {
    sessionID: session.sessionID,
    runID: session.runID,
    generation: session.generation,
    observationCursor: session.observationCursor,
    routeID: session.routeID,
    runtime: session.runtime,
    agent: { ...session.agent },
    ...overrides,
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

async function eventually(operation, predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  do {
    value = await operation();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  assert.fail('condition did not become true before timeout');
}

test('start-new persists only the identity issued by the runtime', async (t) => {
  const context = await fixture(t);
  const result = await context.service.startNew({
    requestID: 'runtime-owned-start',
    ...route,
    gatewayToken: 'must-not-be-persisted',
    apiKey: 'also-must-not-be-persisted',
  });

  assert.equal(result.session.sessionID, 'openclaw-runtime-session-1');
  assert.equal(result.session.agent.runtimeSessionID, result.session.sessionID);
  assert.equal(result.session.agent.sessionKey, 'agent:main:dashboard:openclaw-runtime-session-1');
  assert.equal(result.session.runID, null);
  assert.equal(result.session.runState, 'idle');
  assert.equal(result.receipt.action, 'start_new_agent');
  assert.equal(result.receipt.runID, null);
  assert.equal(context.runtimeAdapter.calls.filter((call) => call.action === 'start').length, 1);

  const persisted = await readFile(context.statePath, 'utf8');
  assert.equal(persisted.includes('must-not-be-persisted'), false);
  assert.equal(persisted.includes('gatewayToken'), false);
  assert.equal(persisted.includes('apiKey'), false);
  assert.deepEqual(
    (await readdir(dirname(context.statePath))).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('start discovers and reuses a matching runtime session only within 24 hours', async (t) => {
  const accepted = await fixture(t);
  const first = await accepted.service.startNew({ requestID: 'accepted-new', ...route });
  accepted.advance(VOICE_REMOTE_SESSION_RECENT_WINDOW_MS);
  const reused = await accepted.service.start({ requestID: 'accepted-reuse', ...route });
  assert.equal(reused.reused, true);
  assert.equal(reused.session.sessionID, first.session.sessionID);
  assert.equal(
    accepted.runtimeAdapter.calls.filter((call) => call.action === 'start').length,
    1,
  );

  const expired = await fixture(t);
  const old = await expired.service.startNew({ requestID: 'expired-new', ...route });
  expired.advance(VOICE_REMOTE_SESSION_RECENT_WINDOW_MS + 1);
  const replacement = await expired.service.start({ requestID: 'expired-replacement', ...route });
  assert.equal(replacement.reused, false);
  assert.notEqual(replacement.session.sessionID, old.session.sessionID);
  assert.equal(
    expired.runtimeAdapter.calls.filter((call) => call.action === 'start').length,
    2,
  );
});

test('voice restart retains agent identity while agent restart replaces it', async (t) => {
  const context = await fixture(t);
  const started = await context.service.startNew({ requestID: 'restart-start', ...route });
  const voiceRestarted = await context.service.restartVoiceSession({
    requestID: 'restart-voice',
    expected: expected(started.session),
  });
  assert.equal(voiceRestarted.agentSessionRestarted, false);
  assert.equal(voiceRestarted.session.sessionID, started.session.sessionID);
  assert.equal(voiceRestarted.session.agent.sessionKey, started.session.agent.sessionKey);
  assert.equal(voiceRestarted.session.agentGeneration, started.session.agentGeneration);
  assert.equal(voiceRestarted.session.voiceGeneration, started.session.voiceGeneration + 1);

  const agentRestarted = await context.service.restartAgentSession({
    requestID: 'restart-agent',
    expected: expected(voiceRestarted.session),
  });
  assert.equal(agentRestarted.agentSessionRestarted, true);
  assert.notEqual(agentRestarted.session.sessionID, started.session.sessionID);
  assert.notEqual(agentRestarted.session.agent.sessionKey, started.session.agent.sessionKey);
  assert.equal(agentRestarted.session.agentGeneration, started.session.agentGeneration + 1);
  assert.equal(agentRestarted.previousSession.state, 'ended');
  assert.equal(
    context.runtimeAdapter.calls.filter((call) => call.action === 'restart_voice').length,
    1,
  );
  assert.equal(context.runtimeAdapter.calls.filter((call) => call.action === 'end').length, 1);
});

test('receipts and runtime identity survive process restart and replay idempotently', async (t) => {
  const context = await fixture(t);
  const request = { requestID: 'durable-start', ...route };
  const first = await context.service.startNew(request);
  const inProcessReplay = await context.service.startNew(request);
  assert.equal(inProcessReplay.idempotentReplay, true);
  assert.deepEqual(inProcessReplay.session, first.session);

  const relaunched = new VoiceRemoteSessionService(context.serviceOptions);
  const restartReplay = await relaunched.startNew(request);
  assert.equal(restartReplay.idempotentReplay, true);
  assert.deepEqual(restartReplay.session, first.session);
  assert.equal(
    context.runtimeAdapter.calls.filter((call) => call.action === 'start').length,
    1,
  );
  await expectCode(relaunched.startNew({ ...request, agentID: 'other-agent' }), 'idempotency_conflict');
});

test('identity and cursor checks reject a different runtime session lease', async (t) => {
  const context = await fixture(t);
  const started = await context.service.startNew({ requestID: 'identity-start', ...route });
  await expectCode(context.service.attach({
    requestID: 'identity-wrong-runtime',
    expected: expected(started.session, { runtime: 'hermes' }),
  }), 'identity_mismatch');
  await expectCode(context.service.continueCurrent({
    requestID: 'identity-wrong-run',
    expected: expected(started.session, { runID: 'runtime-run-that-never-existed' }),
  }), 'identity_mismatch');

  const continued = await context.service.continueCurrent({
    requestID: 'identity-continue',
    expected: expected(started.session),
  });
  await expectCode(context.service.attach({
    requestID: 'identity-stale-cursor',
    expected: expected(continued.session, {
      generation: started.session.generation,
      observationCursor: started.session.observationCursor,
    }),
  }), 'stale_generation');
});

test('a turn has no run ID until runtime acceptance and streams ordered live events', async (t) => {
  const context = await fixture(t);
  const started = await context.service.startNew({ requestID: 'turn-start', ...route });
  const entered = deferred();
  const accept = deferred();
  const accepted = deferred();
  const emit = deferred();
  const emitted = deferred();
  const finish = deferred();
  context.runtimeAdapter.runImplementation = async (args) => {
    entered.resolve(args);
    await accept.promise;
    await args.onRunStarted({ runID: 'openclaw-accepted-run-41', binding: args.binding });
    accepted.resolve();
    await emit.promise;
    await args.onEvent({ type: 'message.delta', data: { preview: 'live token' } });
    emitted.resolve();
    await finish.promise;
    return {
      reply: 'runtime-complete',
      runID: 'openclaw-accepted-run-41',
      sessionID: args.session.sessionID,
      sessionKey: args.binding.canonicalSessionKey,
      binding: args.binding,
    };
  };
  const turn = context.service.runTurn({
    sessionKey: started.session.agent.sessionKey,
    text: 'Run against the bound runtime.',
    requestID: 'turn-runtime-request',
    processing: { runtime: 'openclaw' },
  });
  await entered.promise;
  const starting = await context.service.observe({ expected: expected(started.session) });
  assert.equal(starting.session.runState, 'starting');
  assert.equal(starting.session.runID, null);

  accept.resolve();
  await accepted.promise;
  const running = await context.service.observe({ expected: expected(starting.session) });
  assert.equal(running.session.runState, 'running');
  assert.equal(running.session.runID, 'openclaw-accepted-run-41');

  const feed = await context.service.openEventFeed({
    sessionID: started.session.sessionID,
    after: running.session.observationCursor,
  });
  const liveEvent = new Promise((resolve) => {
    const unsubscribe = feed.subscribe((event) => {
      unsubscribe();
      resolve(event);
    });
  });
  emit.resolve();
  await emitted.promise;
  assert.equal((await liveEvent).type, 'message.delta');
  finish.resolve();

  const completed = await turn;
  assert.equal(completed.runID, 'openclaw-accepted-run-41');
  assert.equal(completed.session.runState, 'completed');
  const events = await context.service.events({
    sessionID: started.session.sessionID,
    after: 0,
  });
  assert.deepEqual(
    events.events.map((event) => event.type),
    ['agent.started', 'run.starting', 'run.started', 'message.delta', 'run.completed'],
  );
});

test('multiline prompt and steering text reach the runtime without identifier validation', async (t) => {
  const context = await fixture(t);
  const started = await context.service.startNew({ requestID: 'multiline-start', ...route });
  const prompt = 'First line.\n\nSecond line with details.';
  const steering = 'Correction one.\nCorrection two.';
  const runStarted = deferred();
  const finishRun = deferred();
  context.runtimeAdapter.runImplementation = async (args) => {
    assert.equal(args.text, prompt);
    await args.onRunStarted({ runID: 'multiline-run', binding: args.binding });
    runStarted.resolve();
    await finishRun.promise;
    return {
      reply: 'multiline complete',
      runID: 'multiline-run',
      sessionID: args.session.sessionID,
      sessionKey: args.binding.canonicalSessionKey,
      binding: args.binding,
    };
  };
  context.runtimeAdapter.steerImplementation = async (args) => ({
    accepted: true,
    runID: 'multiline-run',
    binding: args.binding,
  });

  const turn = context.service.runTurn({
    sessionKey: started.session.agent.sessionKey,
    text: prompt,
    requestID: 'multiline-turn',
    processing: { runtime: 'openclaw' },
  });
  await runStarted.promise;
  const steered = await context.service.steer({
    sessionID: started.session.sessionID,
    text: steering,
    requestID: 'multiline-steer',
  });
  finishRun.resolve();
  await turn;

  assert.equal(steered.steered, true);
  assert.equal(
    context.runtimeAdapter.calls.find((call) => call.action === 'steer').text,
    steering,
  );
});

test('steer adopts the replacement runtime run and stop confirms cancellation', async (t) => {
  const context = await fixture(t);
  const started = await context.service.startNew({ requestID: 'steer-start', ...route });
  const originalStarted = deferred();
  const originalFinish = deferred();
  const steerFinish = deferred();
  context.runtimeAdapter.runImplementation = async (args) => {
    await args.onRunStarted({ runID: 'runtime-run-original', binding: args.binding });
    originalStarted.resolve();
    await originalFinish.promise;
    return {
      reply: 'superseded reply',
      runID: 'runtime-run-original',
      sessionID: args.session.sessionID,
      sessionKey: args.binding.canonicalSessionKey,
      binding: args.binding,
    };
  };
  context.runtimeAdapter.steerImplementation = async (args) => ({
    accepted: true,
    runID: 'runtime-run-steered',
    binding: args.binding,
    completion: steerFinish.promise.then(() => ({
      runID: 'runtime-run-steered',
      reply: 'steered reply',
      binding: args.binding,
    })),
  });

  const originalTurn = context.service.runTurn({
    sessionKey: started.session.agent.sessionKey,
    text: 'Initial task',
    requestID: 'steer-original-request',
  });
  await originalStarted.promise;
  const steered = await context.service.steer({
    sessionKey: started.session.agent.sessionKey,
    text: 'Use this corrected direction.',
    requestID: 'steer-runtime-request',
  });
  assert.equal(steered.runID, 'runtime-run-steered');
  assert.equal(steered.session.runState, 'running');
  assert.equal(typeof steered.completion?.then, 'function');
  assert.equal(Object.keys(steered).includes('completion'), false);
  steerFinish.resolve();
  assert.equal((await steered.completion).reply, 'steered reply');
  const steeredComplete = await eventually(
    () => context.service.observe({ expected: expected(steered.session) }),
    (value) => value.session.runState === 'completed',
  );
  assert.equal(steeredComplete.session.runID, 'runtime-run-steered');
  originalFinish.resolve();
  await expectCode(originalTurn, 'run_superseded');

  const idleStop = await context.service.stop({
    sessionKey: started.session.agent.sessionKey,
    requestID: 'stop-completed-run',
  });
  assert.equal(idleStop.stopped, false);

  const stopSession = await context.service.startNew({ requestID: 'stop-session-start', ...route });
  const stopStarted = deferred();
  context.runtimeAdapter.runImplementation = async (args) => {
    await args.onRunStarted({ runID: 'runtime-run-to-stop', binding: args.binding });
    stopStarted.resolve();
    return new Promise((resolve, reject) => {
      const abort = () => reject(args.signal.reason || new Error('aborted'));
      if (args.signal.aborted) abort();
      else args.signal.addEventListener('abort', abort, { once: true });
    });
  };
  const stoppedTurn = context.service.runTurn({
    sessionKey: stopSession.session.agent.sessionKey,
    text: 'Keep running.',
    requestID: 'stop-active-turn',
  });
  await stopStarted.promise;
  const stopped = await context.service.stop({
    sessionKey: stopSession.session.agent.sessionKey,
    requestID: 'stop-runtime-request',
  });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.runID, 'runtime-run-to-stop');
  await assert.rejects(stoppedTurn, (error) => error.name === 'AbortError');
  const stoppedObservation = await context.service.observe({
    expected: expected(stopped.session),
  });
  assert.equal(stoppedObservation.session.runState, 'cancelled');
  const stopEvents = await context.service.events({
    sessionID: stopSession.session.sessionID,
    after: 0,
  });
  assert.equal(stopEvents.events.filter((event) => event.type === 'run.stopped').length, 1);
  assert.equal(stopEvents.events.filter((event) => event.type === 'run.cancelled').length, 0);
});

test('detach, attach, and end are explicit runtime lifecycle transitions', async (t) => {
  const context = await fixture(t);
  const started = await context.service.startNew({ requestID: 'lifecycle-start', ...route });
  const detached = await context.service.detach({
    requestID: 'lifecycle-detach',
    expected: expected(started.session),
  });
  assert.equal(detached.session.state, 'detached');
  await expectCode(context.service.runTurn({
    sessionKey: detached.session.agent.sessionKey,
    text: 'Must not run while detached.',
    requestID: 'detached-turn',
  }), 'invalid_state');

  const attached = await context.service.attach({
    requestID: 'lifecycle-attach',
    expected: expected(detached.session),
  });
  assert.equal(attached.session.state, 'attached');
  assert.equal(attached.session.sessionID, started.session.sessionID);
  const ended = await context.service.end({
    requestID: 'lifecycle-end',
    expected: expected(attached.session),
  });
  assert.equal(ended.session.state, 'ended');
  await expectCode(context.service.runTurn({
    sessionKey: ended.session.agent.sessionKey,
    text: 'Must not run after end.',
    requestID: 'ended-turn',
  }), 'session_ended');
  assert.deepEqual(
    context.runtimeAdapter.calls
      .filter((call) => ['detach', 'attach', 'end'].includes(call.action))
      .map((call) => call.action),
    ['detach', 'attach', 'end'],
  );
});

test('schema-2 Hermes aliases migrate into one canonical session without ending Hermes', async (t) => {
  const context = await fixture(t);
  const hermesRoute = {
    routeID: 'hermes-bridge',
    runtime: 'hermes',
    agentID: 'hermes',
  };
  const started = await context.service.startNew({
    requestID: 'hermes-migration-seed',
    ...hermesRoute,
  });
  const current = JSON.parse(await readFile(context.statePath, 'utf8'));
  const canonical = structuredClone(Object.values(current.sessions)[0]);
  const alias = structuredClone(canonical);
  alias.agent.id = 'hermes-bridge';
  alias.binding.agentID = 'hermes-bridge';
  alias.timestamps.updatedAt -= 100;
  alias.timestamps.lastActivityAt -= 100;

  await writeFile(context.statePath, JSON.stringify({
    ...current,
    schemaVersion: 2,
    sessions: {
      [schema2StorageKey('hermes', 'hermes-bridge', started.session.sessionID)]: alias,
      [schema2StorageKey('hermes', 'hermes', started.session.sessionID)]: canonical,
    },
  }));

  const relaunched = new VoiceRemoteSessionService(context.serviceOptions);
  const discovered = await relaunched.discover({
    ...hermesRoute,
    agentID: 'hermes-bridge',
  });
  assert.equal(discovered.sessions.length, 1);
  assert.equal(discovered.sessions[0].agent.id, 'hermes');
  assert.equal(discovered.sessions[0].binding.agentID, 'hermes');

  const turn = await relaunched.runTurn({
    sessionID: started.session.sessionID,
    sessionKey: started.session.agent.sessionKey,
    runtime: 'hermes',
    agentID: 'hermes-bridge',
    routeID: 'hermes-bridge',
    text: 'Confirm the migrated Hermes session remains usable.',
    requestID: 'hermes-migration-turn',
  });
  assert.equal(turn.reply, 'hermes reply');
  assert.equal(
    context.runtimeAdapter.calls.filter((call) => call.action === 'end').length,
    0,
  );

  const persisted = JSON.parse(await readFile(context.statePath, 'utf8'));
  assert.equal(persisted.schemaVersion, VOICE_REMOTE_SESSION_SCHEMA_VERSION);
  assert.equal(Object.keys(persisted.sessions).length, 1);
  assert.equal(Object.values(persisted.sessions)[0].agent.id, 'hermes');
});

test('Hermes route aliases are canonicalized before runtime discovery and creation', async (t) => {
  const context = await fixture(t);
  const started = await context.service.start({
    requestID: 'hermes-alias-start',
    routeID: 'hermes-public-tunnel',
    runtime: 'hermes',
    agentID: 'hermes-public-tunnel',
  });

  assert.equal(started.session.agent.id, 'hermes');
  assert.equal(started.session.binding.agentID, 'hermes');
  assert.equal(
    context.runtimeAdapter.calls.find((call) => call.action === 'discover')?.agentID,
    'hermes',
  );
});

test('schema-3 inherited OpenClaw agent names migrate to the one Hermes runtime identity', async (t) => {
  const context = await fixture(t);
  const started = await context.service.startNew({
    requestID: 'hermes-schema-3-seed',
    routeID: 'hermes-bridge',
    runtime: 'hermes',
    agentID: 'hermes',
  });
  const current = JSON.parse(await readFile(context.statePath, 'utf8'));
  const legacy = structuredClone(Object.values(current.sessions)[0]);
  legacy.agent.id = 'julian';
  legacy.binding.agentID = 'julian';

  await writeFile(context.statePath, JSON.stringify({
    ...current,
    schemaVersion: 3,
    sessions: {
      [schema3StorageKey('hermes', 'julian', started.session.sessionID)]: legacy,
    },
  }));

  const relaunched = new VoiceRemoteSessionService(context.serviceOptions);
  const discovered = await relaunched.discover({
    routeID: 'hermes-bridge',
    runtime: 'hermes',
    agentID: 'julian',
  });
  assert.equal(discovered.sessions.length, 1);
  assert.equal(discovered.sessions[0].agent.id, 'hermes');
  assert.equal(discovered.sessions[0].binding.agentID, 'hermes');

  const persisted = JSON.parse(await readFile(context.statePath, 'utf8'));
  assert.equal(persisted.schemaVersion, VOICE_REMOTE_SESSION_SCHEMA_VERSION);
  assert.equal(Object.values(persisted.sessions)[0].agent.id, 'hermes');
});

test('schema-1 synthetic identities are discarded and recovered by runtime discovery', async (t) => {
  const context = await fixture(t);
  await mkdir(dirname(context.statePath), { recursive: true });
  await writeFile(context.statePath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: context.now(),
    sessions: {
      synthetic: {
        sessionID: 'server-generated-uuid',
      },
    },
    receipts: {},
  }));
  context.runtimeAdapter.seed({
    ...route,
    sessionID: 'openclaw-runtime-recovered-session',
    updatedAt: context.now(),
  });

  const discovered = await context.service.discover(route);
  assert.deepEqual(discovered.sessions.map((session) => session.sessionID), [
    'openclaw-runtime-recovered-session',
  ]);
  const persisted = JSON.parse(await readFile(context.statePath, 'utf8'));
  assert.equal(persisted.schemaVersion, VOICE_REMOTE_SESSION_SCHEMA_VERSION);
  assert.equal(JSON.stringify(persisted).includes('server-generated-uuid'), false);
});

test('HTTP lifecycle routes expose discovery, restart, events, steer, and stop operations', async (t) => {
  const context = await fixture(t);
  const lifecycle = createVoiceRemoteSessionHTTPHandler({
    service: context.service,
    basePath: '/bridge',
  });
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (!await lifecycle.handle(req, res, path)) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const base = `http://127.0.0.1:${address.port}/bridge/realtime/voice-remote-sessions`;
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { response, body: await response.json() };
  };

  const started = await post('/start-new', { requestID: 'http-start', ...route });
  assert.equal(started.response.status, 200);
  assert.equal(started.body.session.sessionID, 'openclaw-runtime-session-1');
  const discovered = await post('/discover', route);
  assert.equal(discovered.body.sessions[0].sessionID, started.body.session.sessionID);
  const events = await post('/events', {
    sessionID: started.body.session.sessionID,
    after: 0,
  });
  assert.equal(events.body.events[0].type, 'agent.started');

  const eventController = new AbortController();
  const eventResponse = await fetch(
    `${base}/events?sessionID=${encodeURIComponent(started.body.session.sessionID)}&after=${started.body.session.observationCursor}`,
    { signal: eventController.signal },
  );
  assert.equal(eventResponse.status, 200);
  assert.match(eventResponse.headers.get('content-type') || '', /text\/event-stream/);
  const reader = eventResponse.body.getReader();
  const decoder = new TextDecoder();
  const nextLiveEvent = (async () => {
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE stream ended before the lifecycle event.');
      text += decoder.decode(value, { stream: true });
      if (text.includes('event: voice.restarted')) return text;
    }
  })();
  const restarted = await post('/restart-voice', {
    requestID: 'http-restart-voice',
    expected: expected(started.body.session),
  });
  assert.equal(restarted.body.agentSessionRestarted, false);
  assert.equal(restarted.body.session.sessionID, started.body.session.sessionID);
  assert.match(await nextLiveEvent, /"sessionID":"openclaw-runtime-session-1"/);
  await reader.cancel();
  eventController.abort();
});
