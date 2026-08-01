import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import test from 'node:test';

import { InputAttachmentError, InputAttachmentStore } from '../server/input-attachments.js';
import { RouteTaskError, RouteTaskService } from '../server/route-tasks.js';

async function waitFor(check, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for route task.');
}

function mockRemoteSessionService({
  delayed = false,
  observedState = 'running',
  recoveredReply = '',
} = {}) {
  const turns = [];
  const stops = [];
  let release;
  const gate = delayed ? new Promise((resolve) => { release = resolve; }) : null;
  return {
    turns,
    stops,
    release: () => release?.(),
    async start({ runtime, routeID, agentID }) {
      return {
        session: {
          sessionID: `${runtime}-session-${agentID}`,
          runtime,
          routeID,
          runState: 'idle',
          agent: { id: agentID, sessionKey: `${runtime}:${routeID}:${agentID}` },
        },
      };
    },
    async startNewAgentSession(input) { return this.start(input); },
    async attach({ sessionID, sessionKey, runtime }) {
      return {
        session: {
          sessionID: sessionID || `${runtime}-attached-session`,
          runtime,
          runState: 'idle',
          agent: { id: 'main', sessionKey: sessionKey || `key:${sessionID}` },
        },
      };
    },
    async runTurn(input) {
      turns.push(input);
      if (gate) await gate;
      if (input.signal?.aborted) throw input.signal.reason;
      return {
        reply: `Result from ${input.processing.runtime}: ${input.text}`,
        runID: `run-${turns.length}`,
      };
    },
    async steer({ sessionID, text }) { return { runID: `steered-${sessionID}-${text.length}` }; },
    async stop(input) { stops.push(input); return { stopped: true }; },
    async observe({ sessionID }) { return { session: { sessionID, runState: observedState } }; },
    async events() {
      return {
        events: recoveredReply
          ? [{ type: 'message.complete', data: { preview: recoveredReply } }]
          : [],
      };
    },
  };
}

async function uploadInput(store, taskID, attachmentID, body = Buffer.from(`input for ${taskID}`)) {
  return store.upload({
    taskID,
    attachmentID,
    name: `${attachmentID}.txt`,
    contentType: 'text/plain',
    contentLength: body.length,
    byteCount: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    stream: Readable.from([body]),
  });
}

test('durable task creation is idempotent and does not alter selected-route state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-tasks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = mockRemoteSessionService();
  const statePath = join(directory, 'route-tasks.json');
  const service = new RouteTaskService({ statePath, remoteSessionService: remote });
  const input = {
    idempotencyKey: 'one-request',
    originVoiceConversationID: 'voice-conversation-1',
    target: { runtime: 'hermes', route: 'hermes.bridge', agentID: 'main' },
    request: { summary: 'Check deployment', fullText: 'Check the deployment.' },
  };
  const first = await service.create(input);
  const second = await service.create(input);
  assert.equal(second.idempotentReplay, true);
  assert.equal(first.task.taskID, second.task.taskID);
  const completed = await waitFor(async () => {
    const task = await service.get(first.task.taskID);
    return task.state === 'completed' ? task : null;
  });
  assert.equal(completed.originVoiceConversationID, 'voice-conversation-1');
  assert.equal(completed.target.runtime, 'hermes');
  assert.match(completed.result.text, /Result from hermes/);
  assert.equal(remote.turns.length, 1);
  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(persisted.tasks[first.task.taskID].state, 'completed');
});

test('idempotency keys reject payload drift', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-tasks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new RouteTaskService({ statePath: join(directory, 'state.json'), remoteSessionService: mockRemoteSessionService() });
  const created = await service.create({ idempotencyKey: 'same', target: { runtime: 'openclaw', route: 'openclaw.bridge' }, text: 'first' });
  await assert.rejects(
    service.create({ idempotencyKey: 'same', target: { runtime: 'openclaw', route: 'openclaw.bridge' }, text: 'different' }),
    (error) => error instanceof RouteTaskError && error.code === 'idempotency_conflict',
  );
  await waitFor(async () => (await service.get(created.task.taskID)).state === 'completed');
});

test('different runtimes execute concurrently and remain independently visible', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-tasks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = mockRemoteSessionService({ delayed: true });
  const service = new RouteTaskService({ statePath: join(directory, 'state.json'), remoteSessionService: remote });
  const first = await service.create({ target: { runtime: 'openclaw', route: 'openclaw.bridge', agentID: 'julian' }, text: 'one' });
  const second = await service.create({ target: { runtime: 'hermes', route: 'hermes.bridge', agentID: 'hermes' }, text: 'two' });
  await waitFor(async () => (await service.list({ states: ['running'] })).tasks.length === 2);
  assert.notEqual(first.task.taskID, second.task.taskID);
  remote.release();
  await waitFor(async () => (await service.list({ states: ['completed'] })).tasks.length === 2);
  assert.equal(remote.turns.length, 2);
});

test('periodic reconciliation never invalidates work owned by the current Companion process', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-reconcile-active-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = mockRemoteSessionService({ delayed: true });
  const service = new RouteTaskService({
    statePath: join(directory, 'state.json'),
    remoteSessionService: remote,
  });
  const created = await service.create({
    target: { runtime: 'openclaw', route: 'openclaw.bridge', agentID: 'julian' },
    text: 'Keep working while reconciliation runs.',
  });
  await waitFor(async () => (await service.get(created.task.taskID)).state === 'running');

  const result = await service.reconcile();
  assert.deepEqual(result.tasks, [{
    taskID: created.task.taskID,
    state: 'running',
    ownedByCurrentProcess: true,
  }]);
  assert.equal((await service.get(created.task.taskID)).state, 'running');

  remote.release();
  await waitFor(async () => (await service.get(created.task.taskID)).state === 'completed');
});

test('restart reconciliation recovers the persisted runtime reply instead of inventing a generic result', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-reconcile-reply-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'state.json');
  const original = new RouteTaskService({
    statePath,
    remoteSessionService: mockRemoteSessionService({ delayed: true }),
  });
  const created = await original.create({
    target: { runtime: 'openclaw', route: 'openclaw.bridge', agentID: 'julian' },
    text: 'Finish this after a Companion reconnect.',
  });
  await waitFor(async () => (await original.get(created.task.taskID)).runtime.sessionID);

  const recovered = new RouteTaskService({
    statePath,
    remoteSessionService: mockRemoteSessionService({
      observedState: 'completed',
      recoveredReply: 'Recovered OpenClaw result.',
    }),
  });
  const result = await recovered.reconcile();
  assert.equal(result.tasks[0].recoveredReply, true);
  const task = await recovered.get(created.task.taskID);
  assert.equal(task.state, 'completed');
  assert.equal(task.result.text, 'Recovered OpenClaw result.');
});

test('unknown route-task schemas fail closed without overwriting retained state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-schema-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'state.json');
  const retained = JSON.stringify({
    schemaVersion: 999,
    tasks: { retained: { future: true } },
    receipts: {},
  }, null, 2);
  await writeFile(statePath, `${retained}\n`);
  const service = new RouteTaskService({ statePath });

  await assert.rejects(
    service.list(),
    (error) => error instanceof RouteTaskError && error.code === 'unsupported_state_schema',
  );
  assert.equal(await readFile(statePath, 'utf8'), `${retained}\n`);
});

test('schema 1 tasks without runtime provenance still decode without claiming an actual runtime', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-legacy-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'state.json');
  await writeFile(statePath, `${JSON.stringify({
    schemaVersion: 1,
    tasks: {
      legacy: {
        schemaVersion: 1,
        taskID: 'legacy',
        target: { runtime: 'hermes' },
        request: { fullText: 'Legacy task.' },
        state: 'completed',
        stateVersion: 1,
        progress: { summary: 'Completed.', updatedAt: 1 },
        result: { text: 'Legacy result.', source: 'hermes' },
        artifactIDs: [],
        runtime: { sessionID: 'legacy-session', sessionKey: 'legacy-key', runID: 'legacy-run' },
        error: null,
        timestamps: { createdAt: 1, updatedAt: 1, startedAt: 1, completedAt: 1 },
        events: [],
        nextEventCursor: 1,
      },
    },
    receipts: {},
  }, null, 2)}\n`);

  const task = await new RouteTaskService({ statePath }).get('legacy');
  assert.equal(task.runtime.requestedRuntime, 'hermes');
  assert.equal(task.runtime.actualRuntime, null);
  assert.equal(task.runtime.sessionID, 'legacy-session');
  assert.equal(task.result.text, 'Legacy result.');
});

test('direct tasks fail unavailable without invoking the remote session service', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-direct-unavailable-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let remoteCalls = 0;
  const remoteSessionService = new Proxy({}, {
    get() {
      return async () => { remoteCalls += 1; throw new Error('Direct must not reach a remote runtime.'); };
    },
  });
  const service = new RouteTaskService({
    statePath: join(directory, 'state.json'),
    remoteSessionService,
  });
  const created = await service.create({
    target: { runtime: 'direct', route: 'gpt55-direct', agentID: 'direct' },
    text: 'Use only the direct runtime.',
  });
  const failed = await waitFor(async () => {
    const task = await service.get(created.task.taskID);
    return task.state === 'failed' ? task : null;
  });

  assert.equal(remoteCalls, 0);
  assert.equal(failed.error.code, 'runtime_unavailable');
  assert.match(failed.error.message, /no direct runtime callback is configured/i);
  assert.equal(failed.runtime.requestedRuntime, 'direct');
  assert.equal(failed.runtime.actualRuntime, null);
});

test('a direct callback without an explicit direct runtime report fails unavailable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-direct-unverified-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new RouteTaskService({
    statePath: join(directory, 'state.json'),
    directTurn: async () => ({ reply: 'Unverified direct result.' }),
  });
  const created = await service.create({
    target: { runtime: 'direct', route: 'gpt55-direct', agentID: 'direct' },
    text: 'Require explicit runtime identity.',
  });
  const failed = await waitFor(async () => {
    const task = await service.get(created.task.taskID);
    return task.state === 'failed' ? task : null;
  });

  assert.equal(failed.error.code, 'runtime_unavailable');
  assert.match(failed.error.message, /did not explicitly report runtime=direct/i);
  assert.deepEqual(failed.error.details, {
    requestedRuntime: 'direct',
    actualRuntime: null,
  });
  assert.equal(failed.runtime.actualRuntime, null);
});

test('direct tasks require an explicit matching runtime report and reject substitution', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-direct-mismatch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let remoteCalls = 0;
  const service = new RouteTaskService({
    statePath: join(directory, 'state.json'),
    remoteSessionService: {
      async start() { remoteCalls += 1; throw new Error('Direct must not start a remote session.'); },
      async runTurn() { remoteCalls += 1; throw new Error('Direct must not run a remote turn.'); },
    },
    directTurn: async () => ({ reply: 'OpenClaw result mislabeled as direct.', runtime: 'openclaw' }),
  });
  const created = await service.create({
    target: { runtime: 'direct', route: 'gpt55-direct', agentID: 'direct' },
    text: 'Do not substitute runtimes.',
  });
  const failed = await waitFor(async () => {
    const task = await service.get(created.task.taskID);
    return task.state === 'failed' ? task : null;
  });

  assert.equal(remoteCalls, 0);
  assert.equal(failed.error.code, 'runtime_mismatch');
  assert.deepEqual(failed.error.details, {
    requestedRuntime: 'direct',
    actualRuntime: 'openclaw',
  });
  assert.equal(failed.runtime.requestedRuntime, 'direct');
  assert.equal(failed.runtime.actualRuntime, 'openclaw');
  const events = (await service.events({ taskID: created.task.taskID })).events;
  assert.ok(events.some((event) => event.type === 'runtime.mismatch'
    && event.data.requestedRuntime === 'direct'
    && event.data.actualRuntime === 'openclaw'));
});

test('OpenClaw, Hermes, Codex, and genuine direct callbacks preserve exact runtime provenance', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-runtime-provenance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new RouteTaskService({
    statePath: join(directory, 'state.json'),
    remoteSessionService: mockRemoteSessionService(),
    codexBridge: {
      async runTurn(input) {
        return { reply: 'Codex result.', threadID: 'codex-thread', turnID: 'codex-turn', sessionKey: input.sessionKey };
      },
    },
    directTurn: async () => ({ reply: 'Direct result.', runtime: 'direct' }),
  });
  const targets = [
    { runtime: 'openclaw', route: 'openclaw-bridge', agentID: 'main' },
    { runtime: 'hermes', route: 'hermes-bridge', agentID: 'hermes' },
    { runtime: 'codex', route: 'codex', agentID: 'codex' },
    { runtime: 'direct', route: 'gpt55-direct', agentID: 'direct' },
  ];
  const created = await Promise.all(targets.map((target) => service.create({
    target,
    text: `Run with ${target.runtime}.`,
  })));

  for (let index = 0; index < targets.length; index += 1) {
    const expected = targets[index].runtime;
    const task = await waitFor(async () => {
      const current = await service.get(created[index].task.taskID);
      return current.state === 'completed' ? current : null;
    });
    assert.equal(task.target.runtime, expected);
    assert.equal(task.runtime.requestedRuntime, expected);
    assert.equal(task.runtime.actualRuntime, expected);
    assert.equal(task.result.source, expected);
    assert.equal(task.result.requestedRuntime, expected);
    assert.equal(task.result.actualRuntime, expected);
    const events = (await service.events({ taskID: task.taskID })).events;
    assert.ok(events.some((event) => event.data.actualRuntime === expected));
    assert.equal(events.every((event) => event.data.requestedRuntime === expected), true);
  }
});

test('cancelling one task stops only its bound runtime session', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-tasks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = mockRemoteSessionService({ delayed: true });
  const service = new RouteTaskService({ statePath: join(directory, 'state.json'), remoteSessionService: remote });
  const created = await service.create({ target: { runtime: 'openclaw', route: 'openclaw.bridge', agentID: 'main' }, text: 'long task' });
  await waitFor(async () => (await service.get(created.task.taskID)).runtime.sessionID);
  const result = await service.cancel({ taskID: created.task.taskID, requestID: 'cancel-1' });
  assert.equal(result.task.state, 'cancelled');
  assert.equal(remote.stops.length, 1);
  remote.release();
});

test('Codex tasks use durable session keys without pretending to be remote sessions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-tasks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const turns = [];
  const codexBridge = {
    async runTurn(input) {
      turns.push(input);
      return { reply: 'Codex result', sessionKey: input.sessionKey, threadID: 'thread-123', turnID: 'turn-123' };
    },
  };
  const service = new RouteTaskService({ statePath: join(directory, 'state.json'), codexBridge });
  const created = await service.create({
    target: { runtime: 'codex', route: 'codex', sessionKey: 'voiceclaw-codex-project' },
    text: 'Inspect the workspace.',
  });
  const completed = await waitFor(async () => {
    const task = await service.get(created.task.taskID);
    return task.state === 'completed' ? task : null;
  });
  assert.equal(turns[0].sessionKey, 'voiceclaw-codex-project');
  assert.equal(completed.runtime.sessionID, 'thread-123');
  assert.equal(completed.result.text, 'Codex result');
});

test('Codex computer-capable tasks gate dispatch on one supervised lease', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-computer-use-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  let releases = 0;
  const computerUseSupervisor = {
    async acquire(input) {
      calls.push(input);
      return {
        markDispatched() {
          calls.push({ leaseDispatched: true });
        },
        release() {
          releases += 1;
        },
      };
    },
    async verifyAuthenticated(input) {
      calls.push({
        probeThreadID: input.threadID,
        probeRequestID: input.requestID,
      });
      return { ready: true };
    },
  };
  const codexBridge = {
    async runTurn(input) {
      await input.beforeTurn?.({
        client: { kind: 'fake-codex-client' },
        threadID: 'thread-computer-use',
        sessionKey: input.sessionKey,
      });
      await input.onTurnStarted?.({
        threadID: 'thread-computer-use',
        turnID: 'turn-computer-use',
      });
      calls.push({
        turn: input.text,
        allowContextOverflowReplay: input.allowContextOverflowReplay,
      });
      return {
        reply: 'Computer action completed.',
        sessionKey: input.sessionKey,
        threadID: 'thread-computer-use',
        turnID: 'turn-computer-use',
      };
    },
  };
  const service = new RouteTaskService({
    statePath: join(directory, 'route-tasks.json'),
    codexBridge,
    computerUseSupervisor,
  });
  const created = await service.create({
    target: { runtime: 'codex', route: 'codex' },
    request: {
      summary: 'Open TextEdit',
      fullText: 'Open TextEdit on the Mac.',
      computerUseRequested: true,
    },
  });
  const completed = await waitFor(async () => {
    const task = await service.get(created.task.taskID);
    return task.state === 'completed' ? task : null;
  });

  assert.equal(calls[0].requestID, created.task.taskID);
  assert.equal(calls[1].probeThreadID, 'thread-computer-use');
  assert.equal(calls[1].probeRequestID, created.task.taskID);
  assert.equal(calls[2].leaseDispatched, true);
  assert.match(calls[3].turn, /Open TextEdit/);
  assert.equal(calls[3].allowContextOverflowReplay, false);
  assert.equal(releases, 1);
  assert.equal(completed.request.computerUseRequested, true);
  const events = (await service.events({ taskID: created.task.taskID })).events;
  assert.ok(events.some((event) => event.type === 'computer_use.preparing'));
  assert.ok(events.some((event) => event.type === 'computer_use.ready'));
  assert.ok(events.some((event) => event.type === 'runtime.accepted'));
});

test('cancelling a Codex task aborts the in-flight turn signal', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-codex-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let observedSignal = null;
  let releaseTurn;
  const turnGate = new Promise((resolvePromise) => { releaseTurn = resolvePromise; });
  const codexBridge = {
    async runTurn(input) {
      observedSignal = input.signal;
      await input.onTurnStarted?.({
        threadID: 'thread-cancel',
        turnID: 'turn-cancel',
      });
      await turnGate;
      if (input.signal.aborted) throw input.signal.reason;
      return {
        reply: 'Unexpected completion.',
        sessionKey: input.sessionKey,
        threadID: 'thread-cancel',
        turnID: 'turn-cancel',
      };
    },
  };
  const service = new RouteTaskService({
    statePath: join(directory, 'route-tasks.json'),
    codexBridge,
  });
  const created = await service.create({
    target: { runtime: 'codex', route: 'codex' },
    text: 'Keep working.',
  });
  await waitFor(async () => (await service.get(created.task.taskID)).runtime.runID);

  const cancelled = await service.cancel({
    taskID: created.task.taskID,
    requestID: 'cancel-codex',
  });
  assert.equal(cancelled.task.state, 'cancelled');
  assert.equal(observedSignal.aborted, true);
  releaseTurn();
});

test('ordinary Codex work bypasses the Computer Use supervisor', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-no-computer-use-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let acquisitions = 0;
  const service = new RouteTaskService({
    statePath: join(directory, 'route-tasks.json'),
    computerUseSupervisor: {
      async acquire() {
        acquisitions += 1;
        throw new Error('Ordinary Codex work must not prepare Computer Use.');
      },
    },
    codexBridge: {
      async runTurn(input) {
        return {
          reply: 'Build fixed.',
          sessionKey: input.sessionKey,
          threadID: 'thread-code',
          turnID: 'turn-code',
        };
      },
    },
  });
  const created = await service.create({
    target: { runtime: 'codex', route: 'codex' },
    request: {
      summary: 'Fix the build',
      fullText: 'Inspect the repository and fix the Swift build.',
      computerUseRequested: false,
    },
  });
  await waitFor(async () => (await service.get(created.task.taskID)).state === 'completed');
  assert.equal(acquisitions, 0);
});

test('OpenClaw receives iOS-owned computer-interaction guidance while Hermes does not', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-guidance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = mockRemoteSessionService();
  const service = new RouteTaskService({
    statePath: join(directory, 'route-tasks.json'),
    remoteSessionService: remote,
  });
  const guidance = 'VoiceClaw computer-interaction preference: prefer verified Computer Use.';
  const openClaw = await service.create({
    target: { runtime: 'openclaw', route: 'openclaw-bridge', agentID: 'julian' },
    request: {
      summary: 'Open the desktop app',
      fullText: 'Open the desktop app.',
      computerInteraction: 'prefer',
      executionGuidance: guidance,
    },
  });
  const hermes = await service.create({
    target: { runtime: 'hermes', route: 'hermes-bridge', agentID: 'hermes' },
    request: {
      summary: 'Open the desktop app',
      fullText: 'Open the desktop app.',
      computerInteraction: 'prefer',
      executionGuidance: guidance,
    },
  });
  await waitFor(async () => (await service.get(openClaw.task.taskID)).state === 'completed');
  await waitFor(async () => (await service.get(hermes.task.taskID)).state === 'completed');

  const openClawTurn = remote.turns.find((turn) => turn.processing.runtime === 'openclaw');
  const hermesTurn = remote.turns.find((turn) => turn.processing.runtime === 'hermes');
  assert.match(openClawTurn.text, /prefer verified Computer Use/);
  assert.doesNotMatch(hermesTurn.text, /prefer verified Computer Use/);
  const persisted = await service.get(openClaw.task.taskID);
  assert.equal(persisted.request.computerInteraction, 'prefer');
  assert.equal(persisted.request.executionGuidance, guidance);
});

test('invalid computer-interaction preferences are rejected before task admission', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-guidance-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new RouteTaskService({
    statePath: join(directory, 'route-tasks.json'),
    remoteSessionService: mockRemoteSessionService(),
  });
  await assert.rejects(
    service.create({
      target: { runtime: 'openclaw', route: 'openclaw-bridge', agentID: 'julian' },
      request: {
        fullText: 'Open the desktop app.',
        computerInteraction: 'sometimes',
      },
    }),
    (error) => error instanceof RouteTaskError && error.code === 'invalid_computer_interaction',
  );
});

test('a runtime acknowledgement without a final result fails instead of inventing completion text', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-empty-result-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = mockRemoteSessionService();
  remote.runTurn = async (input) => {
    remote.turns.push(input);
    return { runID: 'empty-result-run', reply: '' };
  };
  const service = new RouteTaskService({
    statePath: join(directory, 'route-tasks.json'),
    remoteSessionService: remote,
  });
  const created = await service.create({
    target: { runtime: 'openclaw', route: 'openclaw-bridge', agentID: 'julian' },
    text: 'Return a real result.',
  });
  const failed = await waitFor(async () => {
    const task = await service.get(created.task.taskID);
    return task.state === 'failed' ? task : null;
  });
  assert.equal(failed.error.code, 'runtime_result_unavailable');
  assert.doesNotMatch(failed.error.message, /The task completed/);
});

test('event cursors and state versions increase monotonically', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-tasks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new RouteTaskService({ statePath: join(directory, 'state.json'), remoteSessionService: mockRemoteSessionService() });
  const created = await service.create({ target: { runtime: 'openclaw', route: 'openclaw.bridge' }, text: 'hello' });
  await waitFor(async () => (await service.get(created.task.taskID)).state === 'completed');
  const feed = await service.events({ taskID: created.task.taskID });
  assert.ok(feed.events.length >= 4);
  assert.deepEqual(feed.events.map((event) => event.cursor), [...feed.events.map((_, index) => index + 1)]);
  for (let index = 1; index < feed.events.length; index += 1) {
    assert.ok(feed.events[index].stateVersion > feed.events[index - 1].stateVersion);
  }
});

test('verified input paths and task purpose reach OpenClaw, Hermes, Codex, and direct dispatch alike', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-inputs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputAttachmentStore = new InputAttachmentStore({ rootPath: join(directory, 'inputs') });
  const remote = mockRemoteSessionService();
  const codexTurns = [];
  const directTurns = [];
  const service = new RouteTaskService({
    statePath: join(directory, 'tasks.json'),
    inputAttachmentStore,
    remoteSessionService: remote,
    codexBridge: {
      async runTurn(input) {
        codexTurns.push(input);
        return { reply: 'Codex result', threadID: 'codex-thread', turnID: 'codex-turn' };
      },
    },
    directTurn: async (task) => {
      directTurns.push(task.request.fullText);
      return { reply: 'Direct result', runtime: 'direct' };
    },
  });

  const cases = [
    { runtime: 'openclaw', route: 'openclaw.bridge', agentID: 'main' },
    { runtime: 'hermes', route: 'hermes.bridge', agentID: 'hermes' },
    { runtime: 'codex', route: 'codex', agentID: 'codex' },
    { runtime: 'direct', route: 'gpt55-direct', agentID: 'direct' },
  ];
  const paths = new Map();
  for (const target of cases) {
    const taskID = `input-${target.runtime}`;
    const attachmentID = `file-${target.runtime}`;
    const metadata = await uploadInput(inputAttachmentStore, taskID, attachmentID);
    paths.set(target.runtime, metadata.path);
    await service.create({
      taskID,
      target,
      request: {
        summary: `Review the ${target.runtime} input`,
        fullText: `Inspect the attached file through ${target.runtime}.`,
        attachmentIDs: [attachmentID],
        delivery: 'showFullText',
      },
    });
  }

  await waitFor(async () => (await service.list({ states: ['completed'] })).tasks.length === 4);
  const dispatches = {
    openclaw: remote.turns.find((turn) => turn.processing.runtime === 'openclaw')?.text,
    hermes: remote.turns.find((turn) => turn.processing.runtime === 'hermes')?.text,
    codex: codexTurns[0]?.text,
    direct: directTurns[0],
  };
  for (const target of cases) {
    const text = dispatches[target.runtime];
    assert.match(text, /# Verified input attachments for this ordinary turn/);
    assert.ok(text.includes(JSON.stringify(paths.get(target.runtime))));
    assert.ok(text.includes(JSON.stringify(`Review the ${target.runtime} input`)));
    await assert.rejects(
      inputAttachmentStore.resolve(`input-${target.runtime}`, [`file-${target.runtime}`]),
      (error) => error instanceof InputAttachmentError && error.code === 'missing_attachment',
    );
  }
});

test('missing attachment IDs fail before dispatch instead of being silently ignored', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-inputs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = mockRemoteSessionService();
  const service = new RouteTaskService({
    statePath: join(directory, 'tasks.json'),
    inputAttachmentStore: new InputAttachmentStore({ rootPath: join(directory, 'inputs') }),
    remoteSessionService: remote,
  });
  await assert.rejects(
    service.create({
      taskID: 'missing-input-task',
      target: { runtime: 'openclaw', route: 'openclaw.bridge' },
      request: { fullText: 'Use the missing file.', attachmentIDs: ['missing-file'] },
    }),
    (error) => error instanceof RouteTaskError && error.code === 'missing_attachment',
  );
  assert.equal(remote.turns.length, 0);
});

test('idempotency fingerprint includes input attachment IDs and delivery', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-inputs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputAttachmentStore = new InputAttachmentStore({ rootPath: join(directory, 'inputs') });
  await uploadInput(inputAttachmentStore, 'fingerprint-task', 'file-a');
  await uploadInput(inputAttachmentStore, 'fingerprint-task', 'file-b');
  const remote = mockRemoteSessionService({ delayed: true });
  const service = new RouteTaskService({
    statePath: join(directory, 'tasks.json'),
    inputAttachmentStore,
    remoteSessionService: remote,
  });
  await service.create({
    taskID: 'fingerprint-task',
    idempotencyKey: 'fingerprint-key',
    target: { runtime: 'openclaw', route: 'openclaw.bridge' },
    request: { fullText: 'Use the file.', attachmentIDs: ['file-a'], delivery: 'showFullText' },
  });
  await assert.rejects(
    service.create({
      taskID: 'fingerprint-task',
      idempotencyKey: 'fingerprint-key',
      target: { runtime: 'openclaw', route: 'openclaw.bridge' },
      request: { fullText: 'Use the file.', attachmentIDs: ['file-b'], delivery: 'showFullText' },
    }),
    (error) => error instanceof RouteTaskError && error.code === 'idempotency_conflict',
  );
  await assert.rejects(
    service.create({
      taskID: 'fingerprint-task',
      idempotencyKey: 'fingerprint-key',
      target: { runtime: 'openclaw', route: 'openclaw.bridge' },
      request: { fullText: 'Use the file.', attachmentIDs: ['file-a'], delivery: 'runtimeDelivery' },
    }),
    (error) => error instanceof RouteTaskError && error.code === 'idempotency_conflict',
  );
  remote.release();
  await waitFor(async () => (await service.get('fingerprint-task')).state === 'completed');
});

test('a stale fixed-label admission is retried once with a fresh remote session before dispatch', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const turns = [];
  const starts = [];
  const remote = {
    async start(input) {
      starts.push(['start', input.requestID]);
      const error = new Error('label already in use: voiceclaw:openclaw-bridge');
      error.code = 'session_label_conflict';
      throw error;
    },
    async startNewAgentSession(input) {
      starts.push(['startNew', input.requestID]);
      return {
        session: {
          sessionID: 'fresh-session',
          runtime: 'openclaw',
          runState: 'idle',
          agent: { id: input.agentID, sessionKey: 'agent:julian:fresh-session' },
        },
      };
    },
    async runTurn(input) {
      turns.push(input);
      return { reply: 'fresh result', runID: 'fresh-run' };
    },
  };
  const service = new RouteTaskService({
    statePath: join(directory, 'tasks.json'),
    remoteSessionService: remote,
  });
  const created = await service.create({
    target: { runtime: 'openclaw', route: 'openclaw-bridge', agentID: 'julian' },
    text: 'Open Spotify.',
  });
  const completed = await waitFor(async () => {
    const task = await service.get(created.task.taskID);
    return task.state === 'completed' ? task : null;
  });

  assert.deepEqual(starts, [
    ['start', `${created.task.taskID}:session`],
    ['startNew', `${created.task.taskID}:session:retry-1`],
  ]);
  assert.equal(turns.length, 1);
  assert.equal(completed.runtime.sessionID, 'fresh-session');
  assert.ok((await service.events({ taskID: created.task.taskID })).events
    .some((event) => event.type === 'runtime.session_retry'));
});

test('returnArtifact delivery is authoritative and missing output becomes a terminal file warning', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-artifact-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = mockRemoteSessionService();
  const artifactInbox = {
    async prepareTask(taskID) {
      return { instruction: `Copy the result into /voiceclaw/${taskID}.` };
    },
    async scanTask() {
      return { artifacts: [] };
    },
  };
  const service = new RouteTaskService({
    statePath: join(directory, 'tasks.json'),
    remoteSessionService: remote,
    artifactInbox,
  });
  const created = await service.create({
    target: { runtime: 'openclaw', route: 'openclaw-bridge', agentID: 'julian' },
    request: {
      fullText: 'Return the report.',
      delivery: 'returnArtifact',
    },
  });
  const completed = await waitFor(async () => {
    const task = await service.get(created.task.taskID);
    return task.state === 'completedWithArtifactWarning' ? task : null;
  });

  assert.equal(completed.request.artifactReturnRequested, true);
  assert.equal(completed.request.delivery, 'returnArtifact');
  assert.match(completed.result.artifactWarning, /without placing a requested file/i);
});

test('a steering replacement completes the original durable task instead of failing it as superseded', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-steer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let releaseOriginal;
  let resolveReplacement;
  let markTurnStarted;
  const originalGate = new Promise((resolve) => { releaseOriginal = resolve; });
  const replacement = new Promise((resolve) => { resolveReplacement = resolve; });
  const turnStarted = new Promise((resolve) => { markTurnStarted = resolve; });
  const remote = {
    async start({ runtime, routeID, agentID }) {
      return {
        session: {
          sessionID: `${runtime}-session-${agentID}`,
          runtime,
          runState: 'idle',
          agent: { id: agentID, sessionKey: `${runtime}:${routeID}:${agentID}` },
        },
      };
    },
    async runTurn() {
      markTurnStarted();
      await originalGate;
      const error = new Error('The original runtime run was superseded by a steering run.');
      error.code = 'run_superseded';
      error.name = 'AbortError';
      error.cancelled = true;
      throw error;
    },
    async steer() {
      return {
        runID: 'replacement-run',
        completion: replacement,
      };
    },
  };
  const service = new RouteTaskService({
    statePath: join(directory, 'tasks.json'),
    remoteSessionService: remote,
  });
  const created = await service.create({
    target: { runtime: 'openclaw', route: 'openclaw-bridge', agentID: 'julian' },
    text: 'Prepare the first version.',
  });
  await turnStarted;
  await service.steer({
    taskID: created.task.taskID,
    text: 'Use the corrected requirements.',
    requestID: 'steer-replacement',
  });
  const steered = await service.get(created.task.taskID);
  assert.equal(steered.lastEvent.type, 'task.steered');
  assert.match(steered.lastEvent.data.summary, /Added follow-up/);
  releaseOriginal();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const waiting = await service.get(created.task.taskID);
  assert.match(waiting.progress.summary, /replaced the original runtime run/);
  assert.equal(waiting.state, 'running');

  resolveReplacement({
    runID: 'replacement-run',
    reply: 'Completed with the corrected requirements.',
  });
  const completed = await waitFor(async () => {
    const task = await service.get(created.task.taskID);
    return task.state === 'completed' ? task : null;
  });
  assert.equal(completed.runtime.runID, 'replacement-run');
  assert.equal(completed.result.text, 'Completed with the corrected requirements.');
  const events = (await service.events({ taskID: created.task.taskID })).events;
  assert.ok(events.some((event) => event.type === 'task.steered'));
  assert.ok(events.some((event) => event.type === 'runtime.superseded'));
  assert.equal(events.some((event) => event.type === 'task.failed'), false);
});

test('cancelling a task while its steering replacement runs remains terminally cancelled', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-steer-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let releaseOriginal;
  let resolveReplacement;
  let markTurnStarted;
  const originalGate = new Promise((resolve) => { releaseOriginal = resolve; });
  const replacement = new Promise((resolve) => { resolveReplacement = resolve; });
  const turnStarted = new Promise((resolve) => { markTurnStarted = resolve; });
  const remote = {
    async start({ runtime, routeID, agentID }) {
      return {
        session: {
          sessionID: `${runtime}-session-${agentID}`,
          runtime,
          runState: 'idle',
          agent: { id: agentID, sessionKey: `${runtime}:${routeID}:${agentID}` },
        },
      };
    },
    async runTurn() {
      markTurnStarted();
      await originalGate;
      const error = new Error('The original runtime run was superseded by a steering run.');
      error.code = 'run_superseded';
      error.name = 'AbortError';
      error.cancelled = true;
      throw error;
    },
    async steer() {
      return { runID: 'replacement-run', completion: replacement };
    },
    async stop() {
      return { stopped: true };
    },
  };
  const service = new RouteTaskService({
    statePath: join(directory, 'tasks.json'),
    remoteSessionService: remote,
  });
  const created = await service.create({
    target: { runtime: 'openclaw', route: 'openclaw-bridge', agentID: 'julian' },
    text: 'Prepare a long-running report.',
  });
  await turnStarted;
  await service.steer({
    taskID: created.task.taskID,
    text: 'Use the corrected scope.',
    requestID: 'steer-before-cancel',
  });
  releaseOriginal();
  await waitFor(async () => {
    const events = (await service.events({ taskID: created.task.taskID })).events;
    return events.some((event) => event.type === 'runtime.superseded');
  });
  const cancelled = await service.cancel({
    taskID: created.task.taskID,
    requestID: 'cancel-steered-task',
  });
  assert.equal(cancelled.task.state, 'cancelled');
  resolveReplacement({ runID: 'replacement-run', reply: 'Too late.' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const retained = await service.get(created.task.taskID);
  assert.equal(retained.state, 'cancelled');
  assert.equal(retained.result, null);
});

test('event feed buffers an event committed after snapshot but before listener attachment', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceclaw-route-feed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = mockRemoteSessionService({ delayed: true });
  const service = new RouteTaskService({
    statePath: join(directory, 'tasks.json'),
    remoteSessionService: remote,
  });
  const created = await service.create({
    target: { runtime: 'openclaw', route: 'openclaw-bridge', agentID: 'julian' },
    text: 'Long running task.',
  });
  await waitFor(async () => (await service.get(created.task.taskID)).runtime.sessionID);
  const originalEvents = service.events.bind(service);
  service.events = async (input) => {
    const snapshot = await originalEvents(input);
    await service.steer({
      taskID: created.task.taskID,
      text: 'Use the corrected title.',
      requestID: 'feed-race-steer',
    });
    return snapshot;
  };

  const feed = await service.openEventFeed({ taskID: created.task.taskID, after: 0 });
  let bufferedEvent;
  const unsubscribe = feed.subscribe((event) => { bufferedEvent = event; });
  unsubscribe();
  assert.equal(bufferedEvent.type, 'task.steered');
  remote.release();
  await waitFor(async () => (await service.get(created.task.taskID)).state === 'completed');
});
