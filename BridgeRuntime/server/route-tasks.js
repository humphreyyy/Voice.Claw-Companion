import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { INPUT_ATTACHMENTS_PER_TASK_LIMIT, InputAttachmentError } from './input-attachments.js';

export const ROUTE_TASK_SCHEMA_VERSION = 1;
export const ROUTE_TASK_STATES = Object.freeze([
  'draft',
  'queued',
  'running',
  'awaitingApproval',
  'waitingForUser',
  'completing',
  'completed',
  'completedWithArtifactWarning',
  'failed',
  'cancelled',
]);

const TERMINAL_STATES = new Set(['completed', 'completedWithArtifactWarning', 'failed', 'cancelled']);
const DEFAULT_STATE_PATH = join(
  homedir(),
  'Library',
  'Application Support',
  'VoiceClaw Realtime Companion',
  'route-tasks.json',
);
const DEFAULT_MAX_TASKS = 1_000;
const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_TASK_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function deferredValue() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function waitForSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(signal.reason || new Error('cancelled'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error('cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function trimmed(value, field, maximum = 64 * 1024, { required = true } = {}) {
  const result = String(value ?? '').trim();
  if (required && !result) throw new RouteTaskError('invalid_request', `${field} is required.`, 422);
  if (result.length > maximum) throw new RouteTaskError('invalid_request', `${field} is too long.`, 422);
  return result;
}

function normalizeRuntime(value) {
  const runtime = trimmed(value, 'target.runtime', 32).toLowerCase();
  if (!['openclaw', 'hermes', 'codex', 'direct'].includes(runtime)) {
    throw new RouteTaskError('unsupported_runtime', `Unsupported task runtime: ${runtime}`, 422);
  }
  return runtime;
}

function normalizeDelivery(value) {
  const delivery = String(value || 'speakConciseResult').trim();
  const supported = new Set([
    'speakConciseResult',
    'showFullText',
    'returnArtifact',
    'runtimeDelivery',
  ]);
  if (!supported.has(delivery)) {
    throw new RouteTaskError('invalid_delivery', `Unsupported result delivery: ${delivery}`, 422);
  }
  return delivery;
}

function normalizeTarget(input = {}) {
  const runtime = normalizeRuntime(input.runtime);
  const route = trimmed(input.route || runtime, 'target.route', 128);
  const agentID = trimmed(
    input.agentID || input.agentId || (runtime === 'codex' ? 'codex' : 'main'),
    'target.agentID',
    256,
  );
  return {
    runtime,
    route,
    agentID,
    remoteSessionID: trimmed(input.remoteSessionID || input.remoteSessionId, 'target.remoteSessionID', 512, { required: false }) || null,
    sessionKey: trimmed(input.sessionKey, 'target.sessionKey', 512, { required: false }) || null,
    sessionMode: ['new', 'resume', 'attach'].includes(String(input.sessionMode || '').toLowerCase())
      ? String(input.sessionMode).toLowerCase()
      : 'attach',
    model: trimmed(input.model, 'target.model', 256, { required: false }) || null,
    reasoning: trimmed(input.reasoning || input.reasoningEffort, 'target.reasoning', 64, { required: false }) || null,
  };
}

function normalizeAttachmentIDs(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > INPUT_ATTACHMENTS_PER_TASK_LIMIT) {
    throw new RouteTaskError('task_attachment_limit', `A task may have at most ${INPUT_ATTACHMENTS_PER_TASK_LIMIT} input attachments.`, 413);
  }
  const result = value.map((item) => trimmed(item, 'request.attachmentIDs[]', 128));
  if (new Set(result).size !== result.length) {
    throw new RouteTaskError('duplicate_attachment_id', 'request.attachmentIDs must not contain duplicates.', 422);
  }
  return result;
}

function isSafeSessionAdmissionRetry(error) {
  const code = String(error?.code || '').trim().toLowerCase();
  const message = String(error?.message || error || '').trim().toLowerCase();
  return code === 'label_already_in_use'
    || code === 'session_label_conflict'
    || message.includes('label already in use');
}

function publicTask(task) {
  return clone({
    schemaVersion: ROUTE_TASK_SCHEMA_VERSION,
    taskID: task.taskID,
    originVoiceConversationID: task.originVoiceConversationID,
    originTurnID: task.originTurnID,
    target: task.target,
    request: task.request,
    state: task.state,
    stateVersion: task.stateVersion,
    progress: task.progress,
    result: task.result,
    artifactIDs: task.artifactIDs,
    runtime: task.runtime,
    error: task.error,
    timestamps: task.timestamps,
  });
}

function initialState() {
  return { schemaVersion: ROUTE_TASK_SCHEMA_VERSION, tasks: {}, receipts: {} };
}

export class RouteTaskError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'RouteTaskError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class RouteTaskService {
  constructor({
    statePath = process.env.VOICECLAW_ROUTE_TASKS_PATH || DEFAULT_STATE_PATH,
    remoteSessionService = null,
    codexBridge = null,
    directTurn = null,
    artifactInbox = null,
    inputAttachmentStore = null,
    computerUseSupervisor = null,
    now = () => Date.now(),
    maxTasks = DEFAULT_MAX_TASKS,
    maxEventsPerTask = DEFAULT_MAX_EVENTS,
    retentionMs = DEFAULT_TASK_RETENTION_MS,
  } = {}) {
    this.statePath = statePath;
    this.remoteSessionService = remoteSessionService;
    this.codexBridge = codexBridge;
    this.directTurn = directTurn;
    this.artifactInbox = artifactInbox;
    this.inputAttachmentStore = inputAttachmentStore;
    this.computerUseSupervisor = computerUseSupervisor;
    this.now = now;
    this.maxTasks = Math.max(10, Number(maxTasks) || DEFAULT_MAX_TASKS);
    this.maxEventsPerTask = Math.max(20, Number(maxEventsPerTask) || DEFAULT_MAX_EVENTS);
    this.retentionMs = Math.max(60_000, Number(retentionMs) || DEFAULT_TASK_RETENTION_MS);
    this.state = null;
    this.tail = Promise.resolve();
    this.active = new Map();
    this.steeringHandoffs = new Map();
    this.subscribers = new Map();
    this.inputAttachmentStore?.prune?.().catch((error) => {
      console.error('[route-tasks] input attachment prune failed:', error?.message || error);
    });
  }

  async create(input = {}) {
    const idempotencyKey = trimmed(
      input.idempotencyKey || input.requestID || input.requestId || randomUUID(),
      'idempotencyKey',
      256,
    );
    const target = normalizeTarget(input.target || {});
    const requestText = trimmed(input.request?.fullText || input.request?.text || input.text, 'request.fullText');
    const summary = trimmed(
      input.request?.summary || requestText.slice(0, 240),
      'request.summary',
      512,
    );
    const attachmentIDs = normalizeAttachmentIDs(input.request?.attachmentIDs);
    const requestedDelivery = normalizeDelivery(input.request?.delivery);
    const artifactReturnRequested = input.request?.artifactReturnRequested === true
      || requestedDelivery === 'returnArtifact';
    const computerUseRequested = input.request?.computerUseRequested === true
      || input.request?.requiresComputerUse === true;
    const delivery = artifactReturnRequested ? 'returnArtifact' : requestedDelivery;
    const providedTaskID = String(input.taskID || input.taskId || '').trim();
    if (attachmentIDs.length && !providedTaskID) {
      throw new RouteTaskError('preallocated_task_id_required', 'Upload input attachments under a preallocated task ID, then create the task with that same taskID.', 422);
    }
    const taskID = trimmed(providedTaskID || randomUUID(), 'taskID', 256);
    const fingerprint = JSON.stringify({
      target,
      requestText,
      summary,
      attachmentIDs,
      delivery,
      artifactReturnRequested,
      computerUseRequested,
      taskID: providedTaskID ? taskID : null,
    });
    const result = await this.#exclusive(async () => {
      const state = await this.#load();
      const receipt = state.receipts[idempotencyKey];
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) {
          throw new RouteTaskError('idempotency_conflict', 'The idempotency key was already used for a different task.', 409);
        }
        const existing = state.tasks[receipt.taskID];
        if (!existing) throw new RouteTaskError('receipt_orphaned', 'The retained task receipt is unavailable.', 410);
        return { task: publicTask(existing), idempotentReplay: true, launch: false };
      }

      this.#prune(state);
      if (Object.keys(state.tasks).length >= this.maxTasks) {
        throw new RouteTaskError('task_capacity_reached', 'The Companion task history is full.', 507);
      }
      if (state.tasks[taskID]) throw new RouteTaskError('task_exists', 'A task with this ID already exists.', 409);
      await this.#resolveInputAttachments(taskID, attachmentIDs);
      const timestamp = this.now();
      const task = {
        schemaVersion: ROUTE_TASK_SCHEMA_VERSION,
        taskID,
        originVoiceConversationID: trimmed(input.originVoiceConversationID, 'originVoiceConversationID', 256, { required: false }) || null,
        originTurnID: trimmed(input.originTurnID, 'originTurnID', 256, { required: false }) || null,
        target,
        request: {
          summary,
          fullText: requestText,
          attachmentIDs,
          artifactReturnRequested,
          computerUseRequested,
          delivery,
        },
        state: 'queued',
        stateVersion: 0,
        progress: { summary: 'Waiting for the selected runtime.', updatedAt: timestamp },
        result: null,
        artifactIDs: [],
        runtime: { sessionID: null, sessionKey: null, runID: null },
        error: null,
        timestamps: { createdAt: timestamp, updatedAt: timestamp, startedAt: null, completedAt: null },
        events: [],
        nextEventCursor: 1,
      };
      this.#appendEvent(task, 'task.queued', { summary });
      state.tasks[taskID] = task;
      state.receipts[idempotencyKey] = { taskID, fingerprint, createdAt: timestamp };
      await this.#persist(state);
      return { task: publicTask(task), idempotentReplay: false, launch: true };
    });
    if (result.launch) this.#launch(result.task.taskID);
    return { task: result.task, idempotentReplay: result.idempotentReplay };
  }

  async list(input = {}) {
    return this.#exclusive(async () => {
      const state = await this.#load();
      this.#prune(state);
      const runtime = String(input.runtime || '').trim().toLowerCase();
      const states = Array.isArray(input.states) ? new Set(input.states.map(String)) : null;
      const limit = Math.max(1, Math.min(500, Number(input.limit) || 100));
      const tasks = Object.values(state.tasks)
        .filter((task) => !runtime || task.target.runtime === runtime)
        .filter((task) => !states || states.has(task.state))
        .sort((a, b) => b.timestamps.updatedAt - a.timestamps.updatedAt)
        .slice(0, limit)
        .map(publicTask);
      await this.#persist(state);
      return { tasks, listedAt: this.now() };
    });
  }

  async get(taskID) {
    return this.#exclusive(async () => {
      const state = await this.#load();
      return publicTask(this.#requireTask(state, taskID));
    });
  }

  async events({ taskID, after = 0 } = {}) {
    return this.#exclusive(async () => {
      const state = await this.#load();
      const task = this.#requireTask(state, taskID);
      return {
        task: publicTask(task),
        events: clone(task.events.filter((event) => event.cursor > Number(after || 0))),
      };
    });
  }

  async openEventFeed({ taskID, after = 0 } = {}) {
    const buffered = [];
    let liveListener = null;
    const unsubscribe = this.#subscribe(taskID, (event) => {
      if (liveListener) liveListener(event);
      else buffered.push(event);
    });
    try {
      const snapshot = await this.events({ taskID, after });
      const snapshotCursor = snapshot.events.reduce(
        (maximum, event) => Math.max(maximum, Number(event.cursor) || 0),
        Number(after) || 0,
      );
      return {
        ...snapshot,
        subscribe: (listener) => {
          liveListener = listener;
          for (const event of buffered) {
            if (Number(event.cursor) > snapshotCursor) listener(clone(event));
          }
          buffered.length = 0;
          return unsubscribe;
        },
      };
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  async steer({ taskID, text, requestID = randomUUID() } = {}) {
    const message = trimmed(text, 'text', 16 * 1024);
    const task = await this.get(taskID);
    if (TERMINAL_STATES.has(task.state)) {
      throw new RouteTaskError('task_not_steerable', 'The task has already finished.', 409);
    }
    if (task.target.runtime === 'codex') {
      throw new RouteTaskError('steer_unsupported', 'Codex tasks accept a follow-up after the current turn completes.', 409);
    }
    if (!this.remoteSessionService || !task.runtime.sessionID) {
      throw new RouteTaskError('task_not_steerable', 'The task has no steerable runtime session.', 409);
    }
    const prior = this.steeringHandoffs.get(taskID);
    const handoff = {
      generation: Number(prior?.generation || 0) + 1,
      ready: deferredValue(),
    };
    this.steeringHandoffs.set(taskID, handoff);
    try {
      const result = await this.remoteSessionService.steer({
        sessionID: task.runtime.sessionID,
        text: message,
        requestID,
      });
      await this.#update(taskID, 'task.steered', { progress: `Added follow-up: ${message.slice(0, 160)}` }, (draft) => {
        draft.runtime.runID = result.runID || draft.runtime.runID;
      });
      handoff.ready.resolve({ result });
      return { task: await this.get(taskID), steered: true };
    } catch (error) {
      handoff.ready.resolve({ error });
      if (this.steeringHandoffs.get(taskID) === handoff) {
        this.steeringHandoffs.delete(taskID);
      }
      throw error;
    }
  }

  async cancel({ taskID, requestID = randomUUID() } = {}) {
    const task = await this.get(taskID);
    if (TERMINAL_STATES.has(task.state)) return { task, cancelled: false };
    const controller = this.active.get(taskID);
    if (controller && !controller.signal.aborted) controller.abort(new Error('Task cancelled by user.'));
    if (task.target.runtime !== 'codex' && task.runtime.sessionID && this.remoteSessionService) {
      await this.remoteSessionService.stop({ sessionID: task.runtime.sessionID, requestID }).catch(() => null);
    }
    await this.#update(taskID, 'task.cancelled', { state: 'cancelled', progress: 'Cancelled.' }, (draft) => {
      draft.timestamps.completedAt = this.now();
    });
    return { task: await this.get(taskID), cancelled: true };
  }

  async reconcile() {
    const active = (await this.list({ states: ['queued', 'running', 'awaitingApproval', 'waitingForUser', 'completing'], limit: 500 })).tasks;
    const outcomes = [];
    for (const task of active) {
      if (this.active.has(task.taskID)) {
        outcomes.push({ taskID: task.taskID, state: task.state, ownedByCurrentProcess: true });
        continue;
      }
      if (task.state === 'queued') {
        this.#launch(task.taskID);
        outcomes.push({ taskID: task.taskID, state: 'queued', relaunched: true });
        continue;
      }
      const recoveredArtifacts = await this.#recoverArtifacts(task);
      if (recoveredArtifacts.artifacts.length) {
        await this.#completeRecoveredTask(task, {
          reply: 'The requested file was recovered from the VoiceClaw Realtime Companion Artifact Inbox after reconnect.',
          ...recoveredArtifacts,
        });
        outcomes.push({ taskID: task.taskID, state: recoveredArtifacts.warning ? 'completedWithArtifactWarning' : 'completed', recoveredArtifacts: recoveredArtifacts.artifacts.length });
        continue;
      }
      if (task.target.runtime === 'codex' || !task.runtime.sessionID || !this.remoteSessionService) {
        await this.#markRecoveryNeedsAttention(
          task.taskID,
          'The Companion restarted before it received a durable terminal result. The runtime identity is preserved, but the outcome could not be confirmed automatically.',
        );
        outcomes.push({ taskID: task.taskID, state: 'waitingForUser', outcomeUnknown: true });
        continue;
      }
      try {
        const observed = await this.remoteSessionService.observe({ sessionID: task.runtime.sessionID });
        const runState = observed.session?.runState;
        if (runState === 'running' || runState === 'starting') {
          await this.#update(task.taskID, 'task.reconciled', { progress: 'The runtime task is still running after Companion reconnect.' });
          outcomes.push({ taskID: task.taskID, state: 'running' });
        } else if (runState === 'completed') {
          const reply = await this.#recoverRemoteReply(task);
          await this.#completeRecoveredTask(task, {
            reply: reply || 'The runtime completed after Companion reconnect, but did not expose a recoverable reply preview.',
            ...recoveredArtifacts,
          });
          outcomes.push({ taskID: task.taskID, state: recoveredArtifacts.warning ? 'completedWithArtifactWarning' : 'completed', recoveredReply: Boolean(reply) });
        } else if (runState === 'failed' || runState === 'cancelled') {
          await this.#fail(task.taskID, `runtime_${runState}`, `The runtime reported that the recovered task ${runState}.`);
          outcomes.push({ taskID: task.taskID, state: runState === 'cancelled' ? 'cancelled' : 'failed' });
        } else {
          await this.#markRecoveryNeedsAttention(
            task.taskID,
            'The runtime no longer reports this task as active, but its final outcome is not yet recoverable. Retry only after confirming the prior work did not complete.',
          );
          outcomes.push({ taskID: task.taskID, state: 'waitingForUser', outcomeUnknown: true });
        }
      } catch (error) {
        await this.#markRecoveryNeedsAttention(
          task.taskID,
          `The Companion could not reconcile the preserved runtime session: ${String(error?.message || error)}`,
        );
        outcomes.push({ taskID: task.taskID, state: 'waitingForUser', reconciliationError: true });
      }
    }
    return { tasks: outcomes };
  }

  async #recoverArtifacts(task) {
    if (!this.artifactInbox || !task.request.artifactReturnRequested) {
      return { artifacts: [], warning: null };
    }
    let warning = null;
    try {
      await this.artifactInbox.scanTask(task.taskID);
    } catch (error) {
      warning = String(error?.message || error);
    }
    try {
      const listed = await this.artifactInbox.list({ taskID: task.taskID });
      return { artifacts: listed.artifacts || [], warning };
    } catch (error) {
      return {
        artifacts: [],
        warning: warning || String(error?.message || error),
      };
    }
  }

  async #recoverRemoteReply(task) {
    if (!this.remoteSessionService?.events || !task.runtime.sessionID) return '';
    try {
      const result = await this.remoteSessionService.events({
        sessionID: task.runtime.sessionID,
        after: 0,
      });
      const completion = [...(result.events || [])].reverse().find((event) => (
        event?.type === 'message.complete' && String(event?.data?.preview || '').trim()
      ));
      return String(completion?.data?.preview || '').trim();
    } catch {
      return '';
    }
  }

  async #completeRecoveredTask(task, { reply, artifacts = [], warning = null } = {}) {
    const state = warning ? 'completedWithArtifactWarning' : 'completed';
    await this.#update(task.taskID, warning ? 'task.completed_with_artifact_warning' : 'task.completed', {
      state,
      progress: warning
        ? 'Recovered after reconnect with an Artifact Inbox warning.'
        : 'Recovered after Companion reconnect.',
    }, (draft) => {
      draft.result = {
        text: String(reply || 'The task completed after Companion reconnect.'),
        source: draft.target.runtime,
        artifactWarning: warning,
      };
      draft.artifactIDs = artifacts.map((artifact) => artifact.artifactID);
      draft.error = null;
      draft.timestamps.completedAt = this.now();
    });
  }

  async #markRecoveryNeedsAttention(taskID, message) {
    await this.#update(taskID, 'task.recovery_needs_attention', {
      state: 'waitingForUser',
      progress: 'Outcome needs confirmation after Companion reconnect.',
    }, (draft) => {
      draft.error = {
        code: 'recovery_outcome_unknown',
        message: String(message || 'The task outcome could not be confirmed.').slice(0, 2_048),
      };
    });
  }

  #launch(taskID) {
    if (this.active.has(taskID)) return;
    const controller = new AbortController();
    this.active.set(taskID, controller);
    queueMicrotask(() => {
      this.#execute(taskID, controller.signal)
        .catch((error) => this.#fail(taskID, error?.code || 'task_failed', String(error?.message || error)))
        .finally(() => {
          this.active.delete(taskID);
          this.steeringHandoffs.delete(taskID);
        });
    });
  }

  async #followSteeredRun(taskID, supersededError, signal) {
    let handoff = this.steeringHandoffs.get(taskID);
    if (!handoff) throw supersededError;
    await this.#update(taskID, 'runtime.superseded', {
      progress: 'The follow-up replaced the original runtime run; waiting for its result.',
    });
    while (handoff) {
      if (signal.aborted) throw signal.reason || new Error('cancelled');
      const generation = handoff.generation;
      const registered = await waitForSignal(handoff.ready.promise, signal);
      if (registered.error) throw registered.error;
      const completion = registered.result?.completion;
      if (!completion || typeof completion.then !== 'function') {
        throw supersededError;
      }
      let result;
      try {
        result = await waitForSignal(completion, signal);
      } catch (error) {
        const latest = this.steeringHandoffs.get(taskID);
        if (latest && latest.generation > generation) {
          handoff = latest;
          continue;
        }
        throw error;
      }
      const latest = this.steeringHandoffs.get(taskID);
      if (latest && latest.generation > generation) {
        handoff = latest;
        continue;
      }
      return {
        ...result,
        runID: result?.runID || registered.result.runID || null,
      };
    }
    throw supersededError;
  }

  async #execute(taskID, signal) {
    let task = await this.get(taskID);
    if (TERMINAL_STATES.has(task.state)) return;
    const inputAttachments = await this.#resolveInputAttachments(taskID, task.request.attachmentIDs);
    await this.#update(taskID, 'task.running', { state: 'running', progress: `Running with ${task.target.runtime}.` }, (draft) => {
      draft.timestamps.startedAt ||= this.now();
    });
    task = await this.get(taskID);
    if (signal.aborted) throw signal.reason || new Error('cancelled');

    let result;
    let dispatchText = task.request.fullText;
    if (inputAttachments.length) {
      dispatchText = `${dispatchText}\n\n${this.inputAttachmentStore.instruction(inputAttachments, task.request.summary)}`;
      await this.#update(taskID, 'input_attachments.resolved', {
        progress: `${inputAttachments.length} verified input attachment${inputAttachments.length === 1 ? '' : 's'} ready.`,
      });
    }
    if (task.request.artifactReturnRequested && this.artifactInbox) {
      const prepared = await this.artifactInbox.prepareTask(taskID);
      dispatchText = `${dispatchText}\n\n${prepared.instruction}`;
      await this.#update(taskID, 'artifact.drop_prepared', {
        progress: 'A protected Companion return-file directory is ready.',
      });
    }
    if (task.target.runtime === 'codex') {
      if (!this.codexBridge) throw new RouteTaskError('runtime_unavailable', 'Codex app-server is unavailable.', 503);
      let computerUseLease = null;
      let beforeTurn = null;
      if (task.request.computerUseRequested) {
        if (!this.computerUseSupervisor) {
          throw new RouteTaskError(
            'computer_use_unavailable',
            'This Companion runtime cannot prepare private computer control for the Codex task.',
            503,
          );
        }
        await this.#update(taskID, 'computer_use.preparing', {
          progress: 'Preparing computer control.',
        });
        try {
          computerUseLease = await this.computerUseSupervisor.acquire({
            requestID: task.taskID,
          });
        } catch (error) {
          throw new RouteTaskError(
            error?.code || 'computer_use_unavailable',
            error?.message || 'Computer control could not become ready.',
            error?.statusCode || 503,
            error?.details || null,
          );
        }
        beforeTurn = async ({ client, threadID }) => {
          try {
            await this.computerUseSupervisor.verifyAuthenticated({
              client,
              threadID,
              requestID: task.taskID,
            });
          } catch (error) {
            throw new RouteTaskError(
              error?.code || 'computer_use_unavailable',
              error?.message || 'Computer control could not become ready.',
              error?.statusCode || 503,
              error?.details || null,
            );
          }
          await this.#update(taskID, 'computer_use.ready', {
            progress: 'Computer control ready.',
          });
          computerUseLease.markDispatched?.();
        };
      }
      try {
        result = await this.codexBridge.runTurn({
          sessionKey: task.target.sessionKey || task.target.remoteSessionID || `voiceclaw-task:${task.taskID}`,
          sessionMode: task.target.sessionMode === 'new' ? 'new' : 'attach',
          text: dispatchText,
          model: task.target.model || '',
          reasoningEffort: task.target.reasoning || '',
          beforeTurn,
          signal,
          allowContextOverflowReplay: !task.request.computerUseRequested,
          onTurnStarted: async ({ threadID, turnID }) => {
            await this.#update(taskID, 'runtime.accepted', {
              progress: 'Codex accepted the task.',
            }, (draft) => {
              draft.runtime.sessionKey = task.target.sessionKey
                || task.target.remoteSessionID
                || `voiceclaw-task:${task.taskID}`;
              draft.runtime.sessionID = threadID;
              draft.runtime.runID = turnID;
            });
          },
        });
      } finally {
        computerUseLease?.release();
      }
      await this.#update(taskID, 'runtime.completed', { progress: 'Codex returned a result.' }, (draft) => {
        draft.runtime.sessionKey = result.sessionKey || draft.runtime.sessionKey;
        draft.runtime.sessionID = result.threadID || draft.runtime.sessionID;
        draft.runtime.runID = result.turnID || draft.runtime.runID;
      });
    } else if (task.target.runtime === 'direct') {
      if (typeof this.directTurn !== 'function') throw new RouteTaskError('runtime_unavailable', 'The selected direct model is unavailable.', 503);
      result = await this.directTurn({ ...task, request: { ...task.request, fullText: dispatchText } }, { signal });
    } else {
      if (!this.remoteSessionService) throw new RouteTaskError('runtime_unavailable', 'The remote session service is unavailable.', 503);
      let session;
      if (task.target.remoteSessionID || task.target.sessionKey) {
        session = (await this.remoteSessionService.attach({
          ...(task.target.remoteSessionID ? { sessionID: task.target.remoteSessionID } : {}),
          ...(task.target.sessionKey ? { sessionKey: task.target.sessionKey } : {}),
        })).session;
      } else {
        const operation = task.target.sessionMode === 'new'
          ? this.remoteSessionService.startNewAgentSession.bind(this.remoteSessionService)
          : this.remoteSessionService.start.bind(this.remoteSessionService);
        try {
          session = (await operation({
            runtime: task.target.runtime,
            routeID: task.target.route,
            agentID: task.target.agentID,
            requestID: `${task.taskID}:session`,
          })).session;
        } catch (error) {
          if (!isSafeSessionAdmissionRetry(error)) throw error;
          await this.#update(taskID, 'runtime.session_retry', {
            progress: `${task.target.runtime} rejected a stale session label; retrying once with a new session identity.`,
          });
          session = (await this.remoteSessionService.startNewAgentSession({
            runtime: task.target.runtime,
            routeID: task.target.route,
            agentID: task.target.agentID,
            requestID: `${task.taskID}:session:retry-1`,
          })).session;
        }
      }
      await this.#update(taskID, 'runtime.session', { progress: `${task.target.runtime} session ready.` }, (draft) => {
        draft.runtime.sessionID = session.sessionID;
        draft.runtime.sessionKey = session.agent?.sessionKey || null;
        draft.target.remoteSessionID = session.sessionID;
        draft.target.sessionKey = session.agent?.sessionKey || null;
      });
      try {
        result = await this.remoteSessionService.runTurn({
          sessionID: session.sessionID,
          sessionKey: session.agent?.sessionKey,
          runtime: session.runtime,
          agentID: session.agent?.id,
          routeID: session.routeID,
          text: dispatchText,
          requestID: `${task.taskID}:turn`,
          processing: {
            runtime: task.target.runtime,
            model: task.target.model || undefined,
            thinking: task.target.reasoning || undefined,
          },
          signal,
        });
      } catch (error) {
        if (error?.code !== 'run_superseded') throw error;
        result = await this.#followSteeredRun(taskID, error, signal);
      }
      await this.#update(taskID, 'runtime.completed', { progress: `${task.target.runtime} returned a result.` }, (draft) => {
        draft.runtime.runID = result.runID || null;
      });
    }

    if (signal.aborted) throw signal.reason || new Error('cancelled');
    const reply = trimmed(result?.reply || result?.text || result?.outputText || 'The task completed.', 'result.text', 512 * 1024);
    await this.#update(taskID, 'task.completing', { state: 'completing', progress: 'Saving the task result.' });
    let artifacts = [];
    let artifactWarning = null;
    if (task.request.artifactReturnRequested && this.artifactInbox) {
      try {
        const admitted = await this.artifactInbox.scanTask(taskID);
        artifacts = admitted.artifacts || [];
        if (!artifacts.length) {
          artifactWarning = 'The runtime completed without placing a requested file in the VoiceClaw return directory.';
        }
      } catch (error) {
        artifactWarning = String(error?.message || error);
      }
    }
    await this.#update(taskID, artifactWarning ? 'task.completed_with_artifact_warning' : 'task.completed', {
      state: artifactWarning ? 'completedWithArtifactWarning' : 'completed',
      progress: artifactWarning ? 'Task completed, but a requested file could not be admitted.' : 'Completed.',
    }, (draft) => {
      draft.result = { text: reply, source: draft.target.runtime, artifactWarning };
      draft.artifactIDs = artifacts.map((artifact) => artifact.artifactID);
      draft.timestamps.completedAt = this.now();
    });
  }

  async #fail(taskID, code, message) {
    try {
      const current = await this.get(taskID);
      if (TERMINAL_STATES.has(current.state)) return current;
      const cancelled = code === 'task_cancelled' || /cancel/i.test(message);
      await this.#update(taskID, cancelled ? 'task.cancelled' : 'task.failed', {
        state: cancelled ? 'cancelled' : 'failed',
        progress: cancelled ? 'Cancelled.' : 'Failed.',
      }, (task) => {
        task.error = { code, message: String(message || 'Task failed.').slice(0, 2_048) };
        task.timestamps.completedAt = this.now();
      });
      return await this.get(taskID);
    } catch {
      return null;
    }
  }

  async #update(taskID, eventType, change = {}, mutate = null) {
    const updated = await this.#exclusive(async () => {
      const state = await this.#load();
      const task = this.#requireTask(state, taskID);
      if (change.state) task.state = change.state;
      if (change.progress) task.progress = { summary: change.progress, updatedAt: this.now() };
      mutate?.(task);
      task.timestamps.updatedAt = this.now();
      const event = this.#appendEvent(task, eventType, {
        state: task.state,
        summary: task.progress.summary,
      });
      await this.#persist(state);
      this.#publish(taskID, event);
      return publicTask(task);
    });
    if (TERMINAL_STATES.has(updated.state) && this.inputAttachmentStore) {
      await this.inputAttachmentStore.cleanupTask(taskID).catch((error) => {
        console.error(`[route-tasks] input attachment cleanup failed task=${taskID}:`, error?.message || error);
      });
    }
    return updated;
  }

  async #resolveInputAttachments(taskID, attachmentIDs) {
    if (!attachmentIDs?.length) return [];
    if (!this.inputAttachmentStore) {
      throw new RouteTaskError('input_attachments_unavailable', 'This Companion runtime does not support task input attachments.', 503);
    }
    try {
      return await this.inputAttachmentStore.resolve(taskID, attachmentIDs);
    } catch (error) {
      if (error instanceof InputAttachmentError) {
        throw new RouteTaskError(error.code, error.message, error.status, error.details);
      }
      throw error;
    }
  }

  #appendEvent(task, type, data = {}) {
    task.stateVersion += 1;
    const event = {
      cursor: task.nextEventCursor++,
      type,
      taskID: task.taskID,
      stateVersion: task.stateVersion,
      at: this.now(),
      data: clone(data),
    };
    task.events.push(event);
    if (task.events.length > this.maxEventsPerTask) {
      task.events.splice(0, task.events.length - this.maxEventsPerTask);
    }
    return event;
  }

  #subscribe(taskID, listener) {
    const listeners = this.subscribers.get(taskID) || new Set();
    listeners.add(listener);
    this.subscribers.set(taskID, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.subscribers.delete(taskID);
    };
  }

  #publish(taskID, event) {
    for (const listener of this.subscribers.get(taskID) || []) {
      try { listener(clone(event)); } catch {}
    }
  }

  #requireTask(state, taskID) {
    const key = trimmed(taskID, 'taskID', 256);
    const task = state.tasks[key];
    if (!task) throw new RouteTaskError('unknown_task', 'The route task was not found.', 404);
    return task;
  }

  #prune(state) {
    const cutoff = this.now() - this.retentionMs;
    const ordered = Object.values(state.tasks).sort((a, b) => b.timestamps.updatedAt - a.timestamps.updatedAt);
    const keep = new Set(ordered
      .filter((task, index) => !TERMINAL_STATES.has(task.state) || task.timestamps.updatedAt >= cutoff || index < this.maxTasks)
      .slice(0, this.maxTasks)
      .map((task) => task.taskID));
    for (const taskID of Object.keys(state.tasks)) if (!keep.has(taskID)) delete state.tasks[taskID];
    for (const [key, receipt] of Object.entries(state.receipts)) if (!state.tasks[receipt.taskID]) delete state.receipts[key];
  }

  async #load() {
    if (this.state) return this.state;
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (parsed?.schemaVersion !== ROUTE_TASK_SCHEMA_VERSION) {
        throw new RouteTaskError(
          'unsupported_state_schema',
          `The retained route-task store uses schema ${String(parsed?.schemaVersion ?? 'unknown')}; this Companion supports schema ${ROUTE_TASK_SCHEMA_VERSION}. The existing file was preserved and will not be overwritten.`,
          503,
          {
            statePath: this.statePath,
            foundSchemaVersion: parsed?.schemaVersion ?? null,
            supportedSchemaVersion: ROUTE_TASK_SCHEMA_VERSION,
          },
        );
      }
      if (!parsed.tasks || typeof parsed.tasks !== 'object' || Array.isArray(parsed.tasks)
          || !parsed.receipts || typeof parsed.receipts !== 'object' || Array.isArray(parsed.receipts)) {
        throw new RouteTaskError(
          'invalid_state_store',
          'The retained route-task store is malformed. The existing file was preserved and will not be overwritten.',
          503,
          { statePath: this.statePath },
        );
      }
      this.state = parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.state = initialState();
    }
    return this.state;
  }

  async #persist(state) {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.statePath);
    this.state = state;
  }

  #exclusive(operation) {
    const run = this.tail.then(operation, operation);
    this.tail = run.catch(() => {});
    return run;
  }
}

async function readJSON(req, maximum = 1_048_576) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maximum) throw new RouteTaskError('request_too_large', 'The route-task request is too large.', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('not object');
    return result;
  } catch {
    throw new RouteTaskError('invalid_json', 'The route-task request must be a JSON object.', 400);
  }
}

function sendJSON(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function sendSSE(res, event) {
  res.write(`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function createRouteTaskHTTPHandler({ service, basePath = '', artifactInbox = null } = {}) {
  if (!service) throw new Error('Route task service is required.');
  const normalizedBasePath = basePath ? `/${String(basePath).replace(/^\/+|\/+$/g, '')}` : '';
  const prefix = `${normalizedBasePath}/realtime/tasks`;
  return {
    service,
    async handle(req, res, urlPath) {
      if (urlPath !== prefix && !urlPath.startsWith(`${prefix}/`)) return false;
      try {
        const suffix = urlPath.slice(prefix.length).replace(/^\//, '');
        const parts = suffix ? suffix.split('/').map(decodeURIComponent) : [];
        if (!parts.length) {
          if (req.method === 'GET') {
            const url = new URL(req.url, 'http://localhost');
            const states = url.searchParams.getAll('state');
            sendJSON(res, 200, { ok: true, ...(await service.list({ runtime: url.searchParams.get('runtime'), states, limit: url.searchParams.get('limit') })) });
            return true;
          }
          if (req.method === 'POST') {
            sendJSON(res, 202, { ok: true, ...(await service.create(await readJSON(req))) });
            return true;
          }
        }
        const [taskID, operation] = parts;
        if (!taskID) throw new RouteTaskError('unknown_route', 'Unknown route-task endpoint.', 404);
        if (!operation && req.method === 'GET') {
          sendJSON(res, 200, { ok: true, task: await service.get(taskID) });
          return true;
        }
        if (operation === 'events' && req.method === 'GET') {
          const url = new URL(req.url, 'http://localhost');
          const feed = await service.openEventFeed({ taskID, after: url.searchParams.get('after') || req.headers['last-event-id'] || 0 });
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.write(`event: task\ndata: ${JSON.stringify(feed.task)}\n\n`);
          for (const event of feed.events) sendSSE(res, event);
          const unsubscribe = feed.subscribe((event) => sendSSE(res, event));
          const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15_000);
          keepalive.unref?.();
          const cleanup = () => { clearInterval(keepalive); unsubscribe(); };
          req.once('close', cleanup);
          res.once('close', cleanup);
          return true;
        }
        if (operation === 'steer' && req.method === 'POST') {
          sendJSON(res, 200, { ok: true, ...(await service.steer({ taskID, ...(await readJSON(req)) })) });
          return true;
        }
        if (operation === 'cancel' && req.method === 'POST') {
          sendJSON(res, 200, { ok: true, ...(await service.cancel({ taskID, ...(await readJSON(req)) })) });
          return true;
        }
        if (operation === 'artifacts' && req.method === 'GET' && artifactInbox) {
          sendJSON(res, 200, { ok: true, ...(await artifactInbox.list({ taskID })) });
          return true;
        }
        throw new RouteTaskError('unknown_route', 'Unknown route-task endpoint.', 404);
      } catch (error) {
        const failure = error instanceof RouteTaskError
          ? error
          : new RouteTaskError('route_task_internal_error', 'The Companion could not complete the route-task request.', 500);
        if (!(error instanceof RouteTaskError)) console.error('[route-tasks]', error?.stack || error);
        if (!res.headersSent) sendJSON(res, failure.status, { ok: false, error: { code: failure.code, message: failure.message, ...(failure.details ? { details: failure.details } : {}) } });
        else res.end();
      }
      return true;
    },
  };
}
