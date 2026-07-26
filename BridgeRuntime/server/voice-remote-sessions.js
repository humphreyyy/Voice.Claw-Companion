import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const VOICE_REMOTE_SESSION_SCHEMA_VERSION = 2;
export const VOICE_REMOTE_SESSION_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

const DEFAULT_STATE_PATH = join(
  homedir(),
  'Library',
  'Application Support',
  'VoiceClaw Companion',
  'voice-remote-sessions.json',
);
const DEFAULT_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_MAX_RECEIPTS = 2048;
const DEFAULT_MAX_EVENTS_PER_SESSION = 256;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RUNTIMES = new Set(['openclaw', 'hermes']);
const SESSION_STATES = new Set(['attached', 'detached', 'ended']);
const RUN_STATES = new Set(['idle', 'starting', 'running', 'completed', 'failed', 'cancelled', 'unknown']);
const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled']);

export class VoiceRemoteSessionError extends Error {
  constructor(code, message, status = 400, details = undefined, retryable = false) {
    super(message);
    this.name = 'VoiceRemoteSessionError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryable = retryable === true;
  }
}

function runtimeErrorDetails(error, extras = {}) {
  const nested = error?.details && typeof error.details === 'object' && !Array.isArray(error.details)
    ? cloneValue(error.details)
    : {};
  return {
    ...nested,
    ...extras,
    subsystem: String(error?.subsystem || nested.subsystem || 'remote-runtime').slice(0, 128),
    cause: String(error?.message || error || 'Runtime request failed.').slice(0, 512),
  };
}

function voiceRemoteRuntimeError(error, {
  fallbackCode,
  fallbackMessage,
  runtime = '',
} = {}) {
  const runtimeCode = String(error?.code || '').trim();
  const code = /^[a-z][a-z0-9_]{1,127}$/.test(runtimeCode) ? runtimeCode : fallbackCode;
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 503;
  const retryable = error?.retryable === true;
  return new VoiceRemoteSessionError(
    code,
    code === fallbackCode ? fallbackMessage : String(error?.message || fallbackMessage).slice(0, 512),
    status,
    runtimeErrorDetails(error, { runtime }),
    retryable,
  );
}

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function requiredString(value, field, maxLength = 512) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maxLength || /[\r\n\0]/.test(normalized)) {
    throw new VoiceRemoteSessionError(
      'invalid_request',
      `${field} must be a non-empty value of at most ${maxLength} characters.`,
      422,
      { field },
    );
  }
  return normalized;
}

function requiredText(value, field, maxLength = 64 * 1024) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\0')) {
    throw new VoiceRemoteSessionError(
      'invalid_request',
      `${field} must be non-empty text of at most ${maxLength} characters.`,
      422,
      { field },
    );
  }
  return normalized;
}

function optionalString(value, field, maxLength = 512) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return requiredString(value, field, maxLength);
}

function normalizeIdentifier(value, field) {
  const normalized = String(value ?? '').trim();
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new VoiceRemoteSessionError(
      'invalid_request',
      `${field} must be a non-empty identifier of at most 256 characters.`,
      422,
      { field },
    );
  }
  return normalized;
}

function normalizeRuntime(value) {
  const runtime = String(value ?? '').trim().toLowerCase();
  if (!RUNTIMES.has(runtime)) {
    throw new VoiceRemoteSessionError(
      'unsupported_runtime',
      'runtime must be openclaw or hermes.',
      422,
      { field: 'runtime' },
    );
  }
  return runtime;
}

function normalizeCounter(value, field, { allowZero = false } = {}) {
  const normalized = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(normalized) || normalized < minimum) {
    throw new VoiceRemoteSessionError(
      'invalid_request',
      `${field} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer.`,
      422,
      { field },
    );
  }
  return normalized;
}

function normalizeTimestamp(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.floor(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
}

function normalizeRequestID(value) {
  return normalizeIdentifier(value, 'requestID');
}

function normalizeRoute(input = {}) {
  return {
    routeID: normalizeIdentifier(input.routeID, 'routeID'),
    runtime: normalizeRuntime(input.runtime),
    agentID: normalizeIdentifier(input.agentID, 'agentID'),
  };
}

function normalizeAgentIdentity(input = {}) {
  return {
    id: normalizeIdentifier(input.id, 'agent.id'),
    sessionKey: requiredString(input.sessionKey, 'agent.sessionKey'),
    runtimeSessionID: requiredString(input.runtimeSessionID, 'agent.runtimeSessionID'),
  };
}

function normalizeExpectation(input = {}) {
  const expected = input.expected && typeof input.expected === 'object' ? input.expected : input;
  const agent = expected.agent && typeof expected.agent === 'object'
    ? {
        ...(expected.agent.id ? { id: normalizeIdentifier(expected.agent.id, 'expected.agent.id') } : {}),
        ...(expected.agent.sessionKey ? { sessionKey: requiredString(expected.agent.sessionKey, 'expected.agent.sessionKey') } : {}),
        ...(expected.agent.runtimeSessionID ? { runtimeSessionID: requiredString(expected.agent.runtimeSessionID, 'expected.agent.runtimeSessionID') } : {}),
      }
    : null;
  return {
    sessionID: requiredString(expected.sessionID, 'expected.sessionID'),
    ...(expected.runID !== undefined ? { runID: optionalString(expected.runID, 'expected.runID') } : {}),
    ...(expected.generation !== undefined ? { generation: normalizeCounter(expected.generation, 'expected.generation') } : {}),
    ...(expected.observationCursor !== undefined
      ? { observationCursor: normalizeCounter(expected.observationCursor, 'expected.observationCursor') }
      : {}),
    ...(expected.routeID ? { routeID: normalizeIdentifier(expected.routeID, 'expected.routeID') } : {}),
    ...(expected.runtime ? { runtime: normalizeRuntime(expected.runtime) } : {}),
    ...(agent ? { agent } : {}),
  };
}

function emptyState(now) {
  return {
    schemaVersion: VOICE_REMOTE_SESSION_SCHEMA_VERSION,
    updatedAt: now,
    sessions: {},
    receipts: {},
  };
}

function storageKey(runtime, agentID, sessionID) {
  return createHash('sha256')
    .update(`voiceclaw-runtime-session-v2\0${runtime}\0${agentID}\0${sessionID}`)
    .digest('hex');
}

function normalizeBinding(input = {}, route = {}, descriptor = {}) {
  const runtime = normalizeRuntime(input.runtime ?? route.runtime);
  const routeID = normalizeIdentifier(input.routeID ?? route.routeID, 'binding.routeID');
  const agentID = normalizeIdentifier(input.agentID ?? route.agentID, 'binding.agentID');
  const runtimeSessionID = requiredString(
    input.runtimeSessionID ?? descriptor.sessionID,
    'binding.runtimeSessionID',
  );
  const canonicalSessionKey = requiredString(
    input.canonicalSessionKey ?? descriptor.sessionKey,
    'binding.canonicalSessionKey',
  );
  return {
    runtime,
    routeID,
    agentID,
    canonicalSessionKey,
    runtimeSessionID,
    dialogueSessionID: requiredString(
      input.dialogueSessionID ?? input.liveSessionID ?? runtimeSessionID,
      'binding.dialogueSessionID',
    ),
    ...(input.liveSessionID ? { liveSessionID: requiredString(input.liveSessionID, 'binding.liveSessionID') } : {}),
    ...(input.label ? { label: requiredString(input.label, 'binding.label', 256) } : {}),
  };
}

function normalizeRuntimeDescriptor(input = {}, route, now) {
  const sessionID = requiredString(
    input.sessionID ?? input.sessionId ?? input.runtimeSessionID,
    'runtime.sessionID',
  );
  const sessionKey = requiredString(
    input.sessionKey ?? input.canonicalSessionKey,
    'runtime.sessionKey',
  );
  const descriptor = {
    sessionID,
    sessionKey,
    createdAt: normalizeTimestamp(input.createdAt ?? input.startedAt, now),
    updatedAt: normalizeTimestamp(input.updatedAt ?? input.lastActivityAt ?? input.startedAt, now),
    state: SESSION_STATES.has(input.state) ? input.state : 'detached',
    runID: optionalString(input.runID ?? input.runId, 'runtime.runID'),
    runState: RUN_STATES.has(input.runState) ? input.runState : 'idle',
  };
  descriptor.binding = normalizeBinding(input.binding || input, route, descriptor);
  if (descriptor.binding.runtimeSessionID !== sessionID) {
    throw new VoiceRemoteSessionError(
      'runtime_identity_mismatch',
      'The runtime returned different persisted and bound session identifiers.',
      500,
    );
  }
  if (descriptor.binding.canonicalSessionKey !== sessionKey) {
    throw new VoiceRemoteSessionError(
      'runtime_identity_mismatch',
      'The runtime returned different canonical session keys.',
      500,
    );
  }
  return descriptor;
}

function publicSession(session) {
  const { events: _events, ...value } = session;
  return cloneValue({ ...value, eventCursor: session.observationCursor });
}

function safeEventData(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowedStrings = [
    'status', 'state', 'reason', 'name', 'tool', 'preview', 'error',
    'previousRunID', 'newRunID', 'previousSessionID', 'newSessionID',
  ];
  const result = {};
  for (const field of allowedStrings) {
    if (value[field] !== undefined && value[field] !== null) {
      result[field] = String(value[field]).slice(0, 1024);
    }
  }
  for (const field of ['stopped', 'accepted', 'reused']) {
    if (typeof value[field] === 'boolean') result[field] = value[field];
  }
  return result;
}

function receiptID(requestID, action) {
  return createHash('sha256')
    .update(`voice-remote-session-receipt-v2\0${requestID}\0${action}`)
    .digest('hex');
}

function assertStoredSession(session) {
  if (!session || typeof session !== 'object') throw new Error('stored session is not an object');
  requiredString(session.sessionID, 'session.sessionID');
  optionalString(session.runID, 'session.runID');
  normalizeCounter(session.generation, 'session.generation');
  normalizeCounter(session.observationCursor, 'session.observationCursor');
  normalizeCounter(session.voiceGeneration, 'session.voiceGeneration');
  normalizeCounter(session.agentGeneration, 'session.agentGeneration');
  normalizeIdentifier(session.routeID, 'session.routeID');
  normalizeRuntime(session.runtime);
  const agent = normalizeAgentIdentity(session.agent);
  const binding = normalizeBinding(session.binding, {
    routeID: session.routeID,
    runtime: session.runtime,
    agentID: agent.id,
  }, {
    sessionID: session.sessionID,
    sessionKey: agent.sessionKey,
  });
  if (agent.runtimeSessionID !== session.sessionID
      || binding.runtimeSessionID !== session.sessionID
      || binding.canonicalSessionKey !== agent.sessionKey) {
    throw new Error('stored runtime identity is inconsistent');
  }
  if (!SESSION_STATES.has(session.state)) throw new Error(`unsupported stored session state: ${session.state}`);
  if (!RUN_STATES.has(session.runState)) throw new Error(`unsupported stored run state: ${session.runState}`);
  const timestamps = session.timestamps;
  if (!timestamps || typeof timestamps !== 'object') throw new Error('stored timestamps are missing');
  for (const field of ['createdAt', 'updatedAt', 'lastActivityAt', 'attachedAt']) {
    if (!Number.isFinite(timestamps[field])) throw new Error(`stored timestamp ${field} is invalid`);
  }
  for (const field of ['detachedAt', 'endedAt', 'voiceRestartedAt']) {
    if (timestamps[field] !== null && !Number.isFinite(timestamps[field])) {
      throw new Error(`stored timestamp ${field} is invalid`);
    }
  }
  if (!Array.isArray(session.events)) throw new Error('stored events are missing');
}

async function writeJSONAtomically(path, value) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, path);
    try {
      const directoryHandle = await open(directory, 'r');
      await directoryHandle.sync();
      await directoryHandle.close();
    } catch {
      // The file fsync and atomic rename are the portable durability baseline.
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
  }
}

export class VoiceRemoteSessionService {
  constructor({
    statePath = process.env.VOICECLAW_VOICE_REMOTE_SESSIONS_PATH || DEFAULT_STATE_PATH,
    now = () => Date.now(),
    runtimeAdapter = null,
    recentWindowMs = VOICE_REMOTE_SESSION_RECENT_WINDOW_MS,
    sessionRetentionMs = DEFAULT_SESSION_RETENTION_MS,
    receiptRetentionMs = DEFAULT_RECEIPT_RETENTION_MS,
    maxSessions = DEFAULT_MAX_SESSIONS,
    maxReceipts = DEFAULT_MAX_RECEIPTS,
    maxEventsPerSession = DEFAULT_MAX_EVENTS_PER_SESSION,
  } = {}) {
    this.statePath = statePath;
    this.now = now;
    this.runtimeAdapter = runtimeAdapter;
    this.recentWindowMs = Math.max(1, Number(recentWindowMs) || VOICE_REMOTE_SESSION_RECENT_WINDOW_MS);
    this.sessionRetentionMs = Math.max(this.recentWindowMs, Number(sessionRetentionMs) || DEFAULT_SESSION_RETENTION_MS);
    this.receiptRetentionMs = Math.max(1, Number(receiptRetentionMs) || DEFAULT_RECEIPT_RETENTION_MS);
    this.maxSessions = Math.max(1, Math.floor(Number(maxSessions) || DEFAULT_MAX_SESSIONS));
    this.maxReceipts = Math.max(1, Math.floor(Number(maxReceipts) || DEFAULT_MAX_RECEIPTS));
    this.maxEventsPerSession = Math.max(8, Math.floor(Number(maxEventsPerSession) || DEFAULT_MAX_EVENTS_PER_SESSION));
    this._state = null;
    this._tail = Promise.resolve();
    this._activeTurns = new Map();
    this._subscribers = new Map();
  }

  async discover(input = {}) {
    const route = normalizeRoute(input);
    return this._exclusive(async () => {
      const current = await this._load();
      const next = cloneValue(current);
      const now = this._now();
      const discovered = await this._discoverRuntimeSessions(route, now);
      for (const descriptor of discovered) this._upsertDiscovered(next, route, descriptor, now);
      this._prune(next, now);
      const sessions = this._recentSessions(next, route, now);
      await this._persist(current, next);
      return { sessions: sessions.map(publicSession), discoveredAt: now };
    });
  }

  async lookupRecent(input = {}) {
    const result = await this.discover(input);
    if (!result.sessions.length) {
      throw new VoiceRemoteSessionError(
        'no_recent_session',
        'No matching runtime session was active within the last 24 hours.',
        404,
      );
    }
    return { session: result.sessions[0], lookedUpAt: result.discoveredAt };
  }

  async start(input = {}) {
    const route = normalizeRoute(input);
    return this._mutate('start', input, { route }, async (state, now) => {
      const discovered = await this._discoverRuntimeSessions(route, now);
      for (const descriptor of discovered) this._upsertDiscovered(state, route, descriptor, now);
      const recent = this._recentSessions(state, route, now)[0];
      if (recent) {
        const attached = await this._attachRuntimeSession(recent);
        this._applyBinding(recent, attached?.binding);
        recent.voiceGeneration += 1;
        this._transition(recent, now, 'voice.attached', {
          state: 'attached',
          attachedAt: now,
          detachedAt: null,
        }, { reused: true });
        return { session: publicSession(recent), reused: true };
      }
      const session = await this._createRuntimeSession(state, route, now);
      return { session: publicSession(session), reused: false };
    });
  }

  async startNew(input = {}) {
    return this.startNewAgentSession(input);
  }

  async startNewAgentSession(input = {}) {
    const route = normalizeRoute(input);
    return this._mutate('start_new_agent', input, { route }, async (state, now) => {
      const session = await this._createRuntimeSession(state, route, now);
      return { session: publicSession(session), reused: false };
    });
  }

  async attach(input = {}) {
    const expected = normalizeExpectation(input);
    return this._mutate('resume', input, { expected }, async (state, now) => {
      const session = this._requireFreshSession(state, expected);
      this._requireResumable(session, now);
      const attached = await this._attachRuntimeSession(session);
      this._applyBinding(session, attached?.binding);
      session.voiceGeneration += 1;
      this._transition(session, now, 'voice.attached', {
        state: 'attached',
        attachedAt: now,
        detachedAt: null,
      });
      return { session: publicSession(session) };
    });
  }

  async restartVoiceSession(input = {}) {
    const expected = normalizeExpectation(input);
    return this._mutate('restart_voice', input, { expected }, async (state, now) => {
      const session = this._requireFreshSession(state, expected);
      this._requireResumable(session, now);
      const restarted = await this._requireRuntimeAdapter().restartVoiceSession({
        session: publicSession(session),
        binding: cloneValue(session.binding),
      });
      this._applyBinding(session, restarted?.binding);
      session.voiceGeneration += 1;
      this._transition(session, now, 'voice.restarted', {
        state: 'attached',
        attachedAt: now,
        detachedAt: null,
        voiceRestartedAt: now,
      });
      return { session: publicSession(session), agentSessionRestarted: false };
    });
  }

  async restartAgentSession(input = {}) {
    const expected = normalizeExpectation(input);
    return this._mutate('restart_agent', input, { expected }, async (state, now) => {
      const previous = this._requireEndableSession(state, expected);
      await this._stopActiveForLifecycle(previous, 'agent-session restart');
      await this._requireRuntimeAdapter().endSession({
        session: publicSession(previous),
        binding: cloneValue(previous.binding),
        reason: 'agent-session restart',
      });
      this._transition(previous, now, 'agent.ended', {
        state: 'ended',
        runState: previous.runState === 'running' || previous.runState === 'starting'
          ? 'cancelled'
          : previous.runState,
        endedAt: now,
      });
      const route = {
        routeID: previous.routeID,
        runtime: previous.runtime,
        agentID: previous.agent.id,
      };
      const next = await this._createRuntimeSession(state, route, now, previous.agentGeneration + 1);
      this._appendEvent(next, now, 'agent.restarted', {
        previousSessionID: previous.sessionID,
        newSessionID: next.sessionID,
      });
      return {
        session: publicSession(next),
        previousSession: publicSession(previous),
        agentSessionRestarted: true,
      };
    });
  }

  async continueCurrent(input = {}) {
    const expected = normalizeExpectation(input);
    return this._mutate('continue', input, { expected }, async (state, now) => {
      const session = this._requireFreshSession(state, expected);
      if (session.state !== 'attached') {
        throw new VoiceRemoteSessionError(
          'invalid_state',
          'Only an attached voice binding can continue; resume it first.',
          409,
          { state: session.state },
        );
      }
      this._transition(session, now, 'voice.continued', { state: 'attached' });
      return { session: publicSession(session) };
    });
  }

  async detach(input = {}) {
    const expected = normalizeExpectation(input);
    return this._mutate('detach', input, { expected }, async (state, now) => {
      const session = this._requireFreshSession(state, expected);
      if (session.state !== 'attached') {
        throw new VoiceRemoteSessionError(
          'invalid_state',
          'Only an attached voice binding can be detached.',
          409,
          { state: session.state },
        );
      }
      await this._requireRuntimeAdapter().detachSession({
        session: publicSession(session),
        binding: cloneValue(session.binding),
      });
      this._transition(session, now, 'voice.detached', {
        state: 'detached',
        detachedAt: now,
      });
      return { session: publicSession(session) };
    });
  }

  async end(input = {}) {
    const expected = normalizeExpectation(input);
    return this._mutate('end', input, { expected }, async (state, now) => {
      const session = this._requireEndableSession(state, expected);
      await this._stopActiveForLifecycle(session, 'agent session ended');
      await this._requireRuntimeAdapter().endSession({
        session: publicSession(session),
        binding: cloneValue(session.binding),
        reason: 'voiceclaw_end',
      });
      this._transition(session, now, 'agent.ended', {
        state: 'ended',
        runState: session.runState === 'running' || session.runState === 'starting'
          ? 'cancelled'
          : session.runState,
        endedAt: now,
      });
      return { session: publicSession(session) };
    });
  }

  async findBySessionKey(sessionKey) {
    const key = String(sessionKey || '').trim();
    if (!key) return null;
    return this._exclusive(async () => {
      const state = await this._load();
      const session = this._sessionForSelector(state, { sessionKey: key });
      return session ? publicSession(session) : null;
    });
  }

  async observe(input = {}) {
    const expected = normalizeExpectation(input);
    return this._exclusive(async () => {
      const current = await this._load();
      const next = cloneValue(current);
      // A run ID is mutable lifecycle state. Observers holding the prior run ID
      // must be able to catch up to a newly accepted or steered runtime run.
      const observationIdentity = { ...expected };
      delete observationIdentity.runID;
      const session = this._requireIdentity(next, observationIdentity);
      this._assertObservationNotAhead(session, expected);
      const observed = await this._requireRuntimeAdapter().observeSession({
        session: publicSession(session),
        binding: cloneValue(session.binding),
        runID: session.runID,
      });
      const now = this._now();
      if (observed?.binding) this._applyBinding(session, observed.binding);
      const observedRunID = optionalString(observed?.runID ?? observed?.runId, 'runtime.runID');
      const observedRunState = RUN_STATES.has(observed?.runState) ? observed.runState : null;
      if ((observedRunID && observedRunID !== session.runID)
          || (observedRunState && observedRunState !== session.runState)) {
        if (observedRunID) session.runID = observedRunID;
        this._transition(session, now, 'run.observed', {
          runState: observedRunState || session.runState,
        }, { status: observedRunState || session.runState });
      }
      await this._persist(current, next);
      return {
        session: publicSession(session),
        changed: expected.observationCursor !== undefined
          ? expected.observationCursor < session.observationCursor
          : false,
        observedAt: now,
      };
    });
  }

  async events(input = {}) {
    const selector = input.expected ? normalizeExpectation(input) : {
      sessionID: requiredString(input.sessionID, 'sessionID'),
      ...(input.runtime ? { runtime: normalizeRuntime(input.runtime) } : {}),
    };
    const after = input.after === undefined ? 0 : normalizeCounter(input.after, 'after', { allowZero: true });
    return this._exclusive(async () => {
      const state = await this._load();
      const session = this._sessionForSelector(state, selector);
      if (!session) throw new VoiceRemoteSessionError('unknown_session', 'The runtime session was not found.', 404);
      return {
        session: publicSession(session),
        events: cloneValue(session.events.filter((event) => event.cursor > after)),
      };
    });
  }

  async openEventFeed(input = {}) {
    const after = input.after === undefined ? 0 : normalizeCounter(input.after, 'after', { allowZero: true });
    return this._exclusive(async () => {
      const state = await this._load();
      const session = this._sessionForSelector(state, {
        sessionID: requiredString(input.sessionID, 'sessionID'),
        ...(input.runtime ? { runtime: normalizeRuntime(input.runtime) } : {}),
        ...(input.sessionKey ? { sessionKey: requiredString(input.sessionKey, 'sessionKey') } : {}),
      });
      if (!session) throw new VoiceRemoteSessionError('unknown_session', 'The runtime session was not found.', 404);
      const key = storageKey(session.runtime, session.agent.id, session.sessionID);
      return {
        session: publicSession(session),
        events: cloneValue(session.events.filter((event) => event.cursor > after)),
        subscribe: (listener) => this._subscribe(key, listener),
      };
    });
  }

  async steer(input = {}) {
    const text = requiredText(input.text, 'text', 16 * 1024);
    const requestID = normalizeRequestID(input.requestID || input.requestId);
    return this._exclusive(async () => {
      const current = await this._load();
      const next = cloneValue(current);
      const session = this._sessionForSelector(next, {
        ...(input.sessionID ? { sessionID: requiredString(input.sessionID, 'sessionID') } : {}),
        ...(input.sessionKey ? { sessionKey: requiredString(input.sessionKey, 'sessionKey') } : {}),
      });
      if (!session) throw new VoiceRemoteSessionError('unknown_session', 'The runtime session was not found.', 404);
      if (!session.runID || !['starting', 'running'].includes(session.runState)) {
        throw new VoiceRemoteSessionError('no_active_run', 'The runtime session has no active run to steer.', 409);
      }
      const result = await this._requireRuntimeAdapter().steerRun({
        session: publicSession(session),
        binding: cloneValue(session.binding),
        runID: session.runID,
        text,
        requestID,
      });
      if (result?.accepted === false) {
        throw new VoiceRemoteSessionError('steer_rejected', 'The runtime rejected the steering update.', 409);
      }
      if (result?.binding) this._applyBinding(session, result.binding);
      const nextRunID = optionalString(result?.runID ?? result?.runId, 'runtime.runID') || session.runID;
      const previousRunID = session.runID;
      session.runID = nextRunID;
      const active = this._activeTurns.get(storageKey(session.runtime, session.agent.id, session.sessionID));
      if (active) {
        active.runID = nextRunID;
        active.steered = nextRunID !== previousRunID;
      }
      this._transition(session, this._now(), 'run.steered', { runState: 'running' }, {
        accepted: true,
        previousRunID,
        newRunID: nextRunID,
      });
      await this._persist(current, next);
      if (result?.completion && typeof result.completion.then === 'function') {
        const key = storageKey(session.runtime, session.agent.id, session.sessionID);
        Promise.resolve(result.completion).then(
          (completion) => this._finishSteeredRun(key, nextRunID, 'completed', completion),
          (error) => this._finishSteeredRun(
            key,
            nextRunID,
            error?.name === 'AbortError' || error?.cancelled === true ? 'cancelled' : 'failed',
            null,
            error,
          ),
        ).catch(() => {});
      }
      return { ok: true, steered: true, runID: nextRunID, session: publicSession(session) };
    });
  }

  async stop(input = {}) {
    const requestID = normalizeRequestID(input.requestID || input.requestId);
    return this._exclusive(async () => {
      const current = await this._load();
      const next = cloneValue(current);
      const session = this._sessionForSelector(next, {
        ...(input.sessionID ? { sessionID: requiredString(input.sessionID, 'sessionID') } : {}),
        ...(input.sessionKey ? { sessionKey: requiredString(input.sessionKey, 'sessionKey') } : {}),
      });
      if (!session) throw new VoiceRemoteSessionError('unknown_session', 'The runtime session was not found.', 404);
      const key = storageKey(session.runtime, session.agent.id, session.sessionID);
      const active = this._activeTurns.get(key);
      if (!active && !['starting', 'running'].includes(session.runState)) {
        return { ok: true, stopped: false, session: publicSession(session) };
      }
      const runID = session.runID || active?.runID || null;
      const result = await this._requireRuntimeAdapter().stopRun({
        session: publicSession(session),
        binding: cloneValue(session.binding),
        runID,
        requestID,
      });
      if (result?.stopped === false) {
        throw new VoiceRemoteSessionError('stop_not_confirmed', 'The runtime did not confirm that the run stopped.', 409);
      }
      if (result?.binding) this._applyBinding(session, result.binding);
      if (active && !active.controller.signal.aborted) {
        const error = new VoiceRemoteSessionError('run_stopped', 'The runtime run was stopped.', 409);
        error.name = 'AbortError';
        error.cancelled = true;
        error.runtimeStopConfirmed = true;
        active.controller.abort(error);
      }
      this._transition(session, this._now(), 'run.stopped', { runState: 'cancelled' }, {
        stopped: true,
        reason: result?.reason || 'requested',
      });
      await this._persist(current, next);
      return { ok: true, stopped: true, runID, session: publicSession(session) };
    });
  }

  async runTurn(input = {}) {
    const selector = {
      ...(input.sessionID ? { sessionID: requiredString(input.sessionID, 'sessionID') } : {}),
      ...(input.sessionKey ? { sessionKey: requiredString(input.sessionKey, 'sessionKey') } : {}),
    };
    if (!selector.sessionID && !selector.sessionKey) {
      throw new VoiceRemoteSessionError('invalid_request', 'A runtime session ID or canonical session key is required.', 422);
    }
    const text = requiredText(input.text, 'text', 64 * 1024);
    const requestID = requiredString(input.requestID || input.requestId || randomUUID(), 'requestID', 256);
    const controller = new AbortController();
    const upstreamSignal = input.signal || null;
    const onAbort = () => {
      if (!controller.signal.aborted) {
        const reason = upstreamSignal?.reason instanceof Error
          ? upstreamSignal.reason
          : new VoiceRemoteSessionError('turn_cancelled', 'The runtime turn was cancelled.', 409);
        controller.abort(reason);
      }
    };
    if (upstreamSignal?.aborted) onAbort();
    else upstreamSignal?.addEventListener?.('abort', onAbort, { once: true });

    const operationID = randomUUID();
    let runtimeRunID = null;
    let admitted;
    try {
      admitted = await this._exclusive(async () => {
        const current = await this._load();
        const next = cloneValue(current);
        const session = this._sessionForSelector(next, selector);
        if (!session) throw new VoiceRemoteSessionError('unknown_session', 'The runtime session was not found.', 404);
        if (session.state === 'ended') throw new VoiceRemoteSessionError('session_ended', 'The runtime session has ended.', 410);
        if (session.state !== 'attached') {
          throw new VoiceRemoteSessionError('invalid_state', 'The voice binding must be attached before a turn can run.', 409);
        }
        const requestedRuntime = String(input.processing?.runtime || input.processing?.agentRuntime || '').trim().toLowerCase();
        if (requestedRuntime && requestedRuntime !== session.runtime) {
          throw new VoiceRemoteSessionError('identity_mismatch', 'The requested runtime does not match the bound session.', 409);
        }
        const key = storageKey(session.runtime, session.agent.id, session.sessionID);
        if (this._activeTurns.has(key)) {
          throw new VoiceRemoteSessionError('run_in_progress', 'The runtime session already has an active run.', 409);
        }
        session.runID = null;
        this._transition(session, this._now(), 'run.starting', { runState: 'starting' });
        this._activeTurns.set(key, { operationID, requestID, controller, runID: null });
        await this._persist(current, next);
        return { key, session: publicSession(session), binding: cloneValue(session.binding) };
      });

      const onRunStarted = async (identity = {}) => {
        const runID = requiredString(identity.runID ?? identity.runId, 'runtime.runID');
        runtimeRunID = runID;
        await this._markRunStarted(admitted.key, operationID, runID, identity.binding);
      };
      const onEvent = async (event = {}) => {
        await this._recordRuntimeEvent(admitted.key, operationID, event);
      };
      if (controller.signal.aborted) throw controller.signal.reason || new Error('aborted');
      const result = await this._requireRuntimeAdapter().runTurn({
        session: admitted.session,
        binding: admitted.binding,
        text,
        processing: input.processing || {},
        signal: controller.signal,
        timeoutMs: input.timeoutMs,
        requestID,
        onRunStarted,
        onEvent,
      });
      const resultRunID = requiredString(result?.runID ?? result?.runId, 'runtime.runID');
      const active = this._activeTurns.get(admitted.key);
      if (!active && runtimeRunID) {
        const error = new VoiceRemoteSessionError(
          'run_superseded',
          'The original runtime run was superseded by a steering run.',
          409,
        );
        error.name = 'AbortError';
        error.cancelled = true;
        throw error;
      }
      if (!active?.runID) await onRunStarted({ runID: resultRunID, binding: result?.binding });
      else if (active.runID !== resultRunID) {
        const error = new VoiceRemoteSessionError(
          active.steered ? 'run_superseded' : 'runtime_identity_mismatch',
          active.steered
            ? 'The original runtime run was superseded by a steering run.'
            : 'The runtime completed a different run than the one it started.',
          active.steered ? 409 : 500,
          { expectedRunID: active.runID, returnedRunID: resultRunID },
        );
        if (active.steered) {
          error.name = 'AbortError';
          error.cancelled = true;
        }
        throw error;
      }
      if (String(result?.sessionID ?? result?.runtimeSessionID ?? admitted.session.sessionID) !== admitted.session.sessionID
          || String(result?.sessionKey || admitted.session.agent.sessionKey) !== admitted.session.agent.sessionKey) {
        throw new VoiceRemoteSessionError(
          'runtime_identity_mismatch',
          'The runtime completed the turn under a different session identity.',
          500,
        );
      }
      const completed = await this._finishRun(
        admitted.key,
        operationID,
        'completed',
        result?.binding,
        resultRunID,
      );
      if (completed.runID !== resultRunID) {
        const error = new VoiceRemoteSessionError(
          'run_superseded',
          'The original runtime run was superseded by a steering run.',
          409,
          { activeRunID: completed.runID, returnedRunID: resultRunID },
        );
        error.name = 'AbortError';
        error.cancelled = true;
        throw error;
      }
      return { ...result, runID: resultRunID, sessionID: completed.sessionID, session: completed };
    } catch (error) {
      if (admitted) {
        const cancelled = controller.signal.aborted || error?.name === 'AbortError' || error?.cancelled === true;
        const failed = await this._finishRun(
          admitted.key,
          operationID,
          cancelled ? 'cancelled' : 'failed',
          null,
          runtimeRunID,
        ).catch(() => null);
        if (failed) {
          try { error.remoteSession = failed; } catch {}
        }
      }
      throw error;
    } finally {
      upstreamSignal?.removeEventListener?.('abort', onAbort);
      if (admitted) {
        const active = this._activeTurns.get(admitted.key);
        if (active?.operationID === operationID && !active.steered) {
          this._activeTurns.delete(admitted.key);
        }
      }
    }
  }

  async _createRuntimeSession(state, route, now, agentGeneration = 1) {
    this._ensureSessionCapacity(state, now);
    let raw;
    try {
      raw = await this._requireRuntimeAdapter().startSession({ ...route });
    } catch (error) {
      throw voiceRemoteRuntimeError(error, {
        fallbackCode: 'runtime_start_failed',
        fallbackMessage: `The ${route.runtime} runtime could not start a session.`,
        runtime: route.runtime,
      });
    }
    const descriptor = normalizeRuntimeDescriptor({ ...raw, state: 'attached' }, route, now);
    const key = storageKey(route.runtime, route.agentID, descriptor.sessionID);
    if (state.sessions[key] && state.sessions[key].state !== 'ended') {
      throw new VoiceRemoteSessionError('runtime_identity_collision', 'The runtime reused an active session identifier.', 500);
    }
    const session = {
      sessionID: descriptor.sessionID,
      runID: descriptor.runID,
      generation: 0,
      observationCursor: 0,
      voiceGeneration: 1,
      agentGeneration,
      routeID: route.routeID,
      runtime: route.runtime,
      agent: {
        id: route.agentID,
        sessionKey: descriptor.sessionKey,
        runtimeSessionID: descriptor.sessionID,
      },
      binding: descriptor.binding,
      timestamps: {
        createdAt: descriptor.createdAt,
        updatedAt: now,
        lastActivityAt: Math.max(descriptor.updatedAt, now),
        attachedAt: now,
        detachedAt: null,
        endedAt: null,
        voiceRestartedAt: null,
      },
      state: 'attached',
      runState: descriptor.runState,
      events: [],
    };
    this._appendEvent(session, now, 'agent.started');
    state.sessions[key] = session;
    return session;
  }

  async _discoverRuntimeSessions(route, now) {
    let values;
    try {
      values = await this._requireRuntimeAdapter().discoverSessions({
        ...route,
        activeSince: now - this.recentWindowMs,
        recentWindowMs: this.recentWindowMs,
      });
    } catch (error) {
      throw voiceRemoteRuntimeError(error, {
        fallbackCode: 'runtime_discovery_failed',
        fallbackMessage: `The ${route.runtime} runtime could not discover recent sessions.`,
        runtime: route.runtime,
      });
    }
    if (!Array.isArray(values)) {
      throw new VoiceRemoteSessionError('invalid_runtime_response', 'Runtime session discovery did not return a list.', 500);
    }
    return values.map((value) => normalizeRuntimeDescriptor(value, route, now));
  }

  _upsertDiscovered(state, route, descriptor, now) {
    const key = storageKey(route.runtime, route.agentID, descriptor.sessionID);
    const existing = state.sessions[key];
    if (existing) {
      if (existing.agent.sessionKey !== descriptor.sessionKey) {
        throw new VoiceRemoteSessionError('runtime_identity_mismatch', 'The runtime changed a canonical session key.', 500);
      }
      existing.binding = descriptor.binding;
      existing.timestamps.createdAt = Math.min(existing.timestamps.createdAt, descriptor.createdAt);
      existing.timestamps.lastActivityAt = Math.max(existing.timestamps.lastActivityAt, descriptor.updatedAt);
      existing.timestamps.updatedAt = Math.max(existing.timestamps.updatedAt, descriptor.updatedAt);
      if (existing.state !== 'ended' && descriptor.state === 'ended') existing.state = 'ended';
      if (descriptor.runID) existing.runID = descriptor.runID;
      if (descriptor.runState !== 'idle') existing.runState = descriptor.runState;
      return existing;
    }
    const session = {
      sessionID: descriptor.sessionID,
      runID: descriptor.runID,
      generation: 0,
      observationCursor: 0,
      voiceGeneration: 1,
      agentGeneration: 1,
      routeID: route.routeID,
      runtime: route.runtime,
      agent: { id: route.agentID, sessionKey: descriptor.sessionKey, runtimeSessionID: descriptor.sessionID },
      binding: descriptor.binding,
      timestamps: {
        createdAt: descriptor.createdAt,
        updatedAt: descriptor.updatedAt,
        lastActivityAt: descriptor.updatedAt,
        attachedAt: descriptor.updatedAt,
        detachedAt: descriptor.updatedAt,
        endedAt: descriptor.state === 'ended' ? descriptor.updatedAt : null,
        voiceRestartedAt: null,
      },
      state: descriptor.state === 'attached' ? 'detached' : descriptor.state,
      runState: descriptor.runState,
      events: [],
    };
    this._appendEvent(session, now, 'agent.discovered');
    state.sessions[key] = session;
    return session;
  }

  _recentSessions(state, route, now) {
    const cutoff = now - this.recentWindowMs;
    return Object.values(state.sessions)
      .filter((candidate) => candidate.routeID === route.routeID
        && candidate.runtime === route.runtime
        && candidate.agent.id === route.agentID
        && candidate.state !== 'ended'
        && candidate.timestamps.lastActivityAt >= cutoff)
      .sort((left, right) => right.timestamps.lastActivityAt - left.timestamps.lastActivityAt
        || right.observationCursor - left.observationCursor);
  }

  async _attachRuntimeSession(session) {
    return this._requireRuntimeAdapter().attachSession({
      session: publicSession(session),
      binding: cloneValue(session.binding),
    });
  }

  _applyBinding(session, value) {
    if (!value) return;
    const binding = normalizeBinding(value, {
      routeID: session.routeID,
      runtime: session.runtime,
      agentID: session.agent.id,
    }, {
      sessionID: session.sessionID,
      sessionKey: session.agent.sessionKey,
    });
    if (binding.runtimeSessionID !== session.sessionID
        || binding.canonicalSessionKey !== session.agent.sessionKey) {
      throw new VoiceRemoteSessionError('runtime_identity_mismatch', 'The runtime attempted to replace the bound session identity.', 500);
    }
    session.binding = binding;
  }

  async _stopActiveForLifecycle(session, reason) {
    const key = storageKey(session.runtime, session.agent.id, session.sessionID);
    const active = this._activeTurns.get(key);
    if (!active && !['starting', 'running'].includes(session.runState)) return;
    const result = await this._requireRuntimeAdapter().stopRun({
      session: publicSession(session),
      binding: cloneValue(session.binding),
      runID: session.runID || active?.runID || null,
      requestID: `lifecycle-${randomUUID()}`,
      reason,
    });
    if (result?.stopped === false) {
      throw new VoiceRemoteSessionError('stop_not_confirmed', 'The runtime did not confirm that active work stopped.', 409);
    }
    if (active && !active.controller.signal.aborted) {
      const error = new VoiceRemoteSessionError('session_ended', reason, 410);
      error.name = 'AbortError';
      error.cancelled = true;
      error.runtimeStopConfirmed = true;
      active.controller.abort(error);
    }
  }

  async _markRunStarted(key, operationID, runID, binding = null) {
    return this._exclusive(async () => {
      const current = await this._load();
      const next = cloneValue(current);
      const session = next.sessions[key];
      const active = this._activeTurns.get(key);
      if (!session || !active || active.operationID !== operationID) {
        throw new VoiceRemoteSessionError('stale_run_start', 'A stale runtime run attempted to start.', 409);
      }
      if (binding) this._applyBinding(session, binding);
      session.runID = runID;
      active.runID = runID;
      this._transition(session, this._now(), 'run.started', { runState: 'running' });
      await this._persist(current, next);
      return publicSession(session);
    });
  }

  async _recordRuntimeEvent(key, operationID, event = {}) {
    return this._exclusive(async () => {
      const current = await this._load();
      const next = cloneValue(current);
      const session = next.sessions[key];
      const active = this._activeTurns.get(key);
      if (!session || !active || active.operationID !== operationID) return null;
      const type = String(event.type || event.event || 'run.event').trim().replace(/[^a-zA-Z0-9._-]+/g, '.').slice(0, 96) || 'run.event';
      this._appendEvent(session, this._now(), type, event.data || event);
      await this._persist(current, next);
      return publicSession(session);
    });
  }

  async _finishRun(key, operationID, runState, binding = null, expectedRunID = null) {
    return this._exclusive(async () => {
      const current = await this._load();
      const next = cloneValue(current);
      const session = next.sessions[key];
      if (!session) throw new VoiceRemoteSessionError('unknown_session', 'The runtime session no longer exists.', 404);
      const active = this._activeTurns.get(key);
      if (active && active.operationID !== operationID) {
        throw new VoiceRemoteSessionError('stale_run_completion', 'A stale runtime run attempted to complete.', 409);
      }
      if (binding) this._applyBinding(session, binding);
      if (expectedRunID && session.runID !== expectedRunID) return publicSession(session);
      if (session.state !== 'ended'
          && session.runState !== runState
          && !(session.runState === 'cancelled' && runState === 'failed')) {
        this._transition(session, this._now(), `run.${runState}`, { runState });
      }
      await this._persist(current, next);
      return publicSession(session);
    });
  }

  async _finishSteeredRun(key, runID, runState, result = null, error = null) {
    return this._exclusive(async () => {
      const current = await this._load();
      const next = cloneValue(current);
      const session = next.sessions[key];
      if (!session || session.runID !== runID || session.state === 'ended') return null;
      if (result?.binding) this._applyBinding(session, result.binding);
      if (result?.reply) {
        this._appendEvent(session, this._now(), 'message.complete', {
          preview: String(result.reply).slice(0, 1024),
          status: runState,
        });
      }
      if (session.runState !== runState
          && !(session.runState === 'cancelled' && runState !== 'cancelled')) {
        this._transition(session, this._now(), `run.${runState}`, { runState }, {
          status: runState,
          ...(error ? { error: String(error.message || error).slice(0, 1024) } : {}),
        });
      }
      const active = this._activeTurns.get(key);
      if (active?.runID === runID && active.steered) this._activeTurns.delete(key);
      await this._persist(current, next);
      return publicSession(session);
    });
  }

  _transition(session, now, eventType, changes = {}, eventData = {}) {
    if (Object.hasOwn(changes, 'state')) session.state = changes.state;
    if (Object.hasOwn(changes, 'runState')) session.runState = changes.runState;
    if (Object.hasOwn(changes, 'attachedAt')) session.timestamps.attachedAt = changes.attachedAt;
    if (Object.hasOwn(changes, 'detachedAt')) session.timestamps.detachedAt = changes.detachedAt;
    if (Object.hasOwn(changes, 'endedAt')) session.timestamps.endedAt = changes.endedAt;
    if (Object.hasOwn(changes, 'voiceRestartedAt')) session.timestamps.voiceRestartedAt = changes.voiceRestartedAt;
    session.timestamps.updatedAt = now;
    session.timestamps.lastActivityAt = now;
    this._appendEvent(session, now, eventType, eventData);
    return session;
  }

  _appendEvent(session, now, type, data = {}) {
    if (session.generation >= Number.MAX_SAFE_INTEGER
        || session.observationCursor >= Number.MAX_SAFE_INTEGER) {
      throw new VoiceRemoteSessionError('counter_exhausted', 'The runtime session event cursor is exhausted.', 409);
    }
    session.generation += 1;
    session.observationCursor += 1;
    session.events.push({
      cursor: session.observationCursor,
      type,
      at: now,
      runtime: session.runtime,
      sessionID: session.sessionID,
      runID: session.runID,
      data: safeEventData(data),
    });
    if (session.events.length > this.maxEventsPerSession) {
      session.events.splice(0, session.events.length - this.maxEventsPerSession);
    }
  }

  _sessionForSelector(state, selector = {}) {
    const sessionID = String(selector.sessionID || '').trim();
    const sessionKey = String(selector.sessionKey || '').trim();
    const runtime = String(selector.runtime || '').trim().toLowerCase();
    const matches = Object.values(state.sessions).filter((session) => {
      if (sessionID && session.sessionID !== sessionID) return false;
      if (sessionKey && session.agent.sessionKey !== sessionKey) return false;
      if (runtime && session.runtime !== runtime) return false;
      return !!(sessionID || sessionKey);
    });
    if (matches.length > 1) {
      throw new VoiceRemoteSessionError('ambiguous_session', 'The supplied runtime session selector is ambiguous.', 409);
    }
    return matches[0] || null;
  }

  _requireIdentity(state, expected) {
    // Resolve the runtime-owned session first, then report which asserted
    // identity field differs. Filtering by an asserted field here would turn a
    // real mismatch into the less useful "unknown session" response.
    const session = this._sessionForSelector(state, { sessionID: expected.sessionID });
    if (!session) throw new VoiceRemoteSessionError('unknown_session', 'The runtime session was not found.', 404);
    const mismatch = expected.runID !== undefined && session.runID !== expected.runID ? 'runID'
      : expected.routeID && session.routeID !== expected.routeID ? 'routeID'
        : expected.runtime && session.runtime !== expected.runtime ? 'runtime'
          : expected.agent?.id && session.agent.id !== expected.agent.id ? 'agent.id'
            : expected.agent?.sessionKey && session.agent.sessionKey !== expected.agent.sessionKey ? 'agent.sessionKey'
              : expected.agent?.runtimeSessionID && session.agent.runtimeSessionID !== expected.agent.runtimeSessionID ? 'agent.runtimeSessionID'
                : null;
    if (mismatch) {
      throw new VoiceRemoteSessionError(
        'identity_mismatch',
        `The supplied ${mismatch} does not match the runtime-owned session identity.`,
        409,
        { field: mismatch },
      );
    }
    return session;
  }

  _requireFreshSession(state, expected) {
    const session = this._requireIdentity(state, expected);
    if (session.state === 'ended') throw new VoiceRemoteSessionError('session_ended', 'The runtime session has ended.', 410);
    if (expected.generation !== undefined && session.generation !== expected.generation) {
      throw new VoiceRemoteSessionError('stale_generation', 'The supplied generation is stale.', 409, {
        serverGeneration: session.generation,
        receivedGeneration: expected.generation,
      });
    }
    if (expected.observationCursor !== undefined && session.observationCursor !== expected.observationCursor) {
      throw new VoiceRemoteSessionError('stale_cursor', 'The supplied observation cursor is stale.', 409, {
        serverCursor: session.observationCursor,
        receivedCursor: expected.observationCursor,
      });
    }
    return session;
  }

  _requireEndableSession(state, expected) {
    const session = this._requireIdentity(state, expected);
    if (session.state === 'ended') throw new VoiceRemoteSessionError('session_ended', 'The runtime session has ended.', 410);
    this._assertObservationNotAhead(session, expected);
    return session;
  }

  _assertObservationNotAhead(session, expected) {
    if (expected.generation !== undefined && expected.generation > session.generation) {
      throw new VoiceRemoteSessionError('generation_ahead', 'The supplied generation is ahead of the server cursor.', 409);
    }
    if (expected.observationCursor !== undefined && expected.observationCursor > session.observationCursor) {
      throw new VoiceRemoteSessionError('cursor_ahead', 'The supplied observation cursor is ahead of the server cursor.', 409);
    }
  }

  _requireResumable(session, now) {
    if (now - session.timestamps.lastActivityAt > this.recentWindowMs) {
      throw new VoiceRemoteSessionError('session_expired', 'The runtime session is older than the 24-hour reuse window.', 410);
    }
  }

  _requireRuntimeAdapter() {
    const adapter = this.runtimeAdapter;
    const required = [
      'discoverSessions', 'startSession', 'attachSession', 'restartVoiceSession',
      'detachSession', 'endSession', 'runTurn', 'steerRun', 'stopRun', 'observeSession',
    ];
    if (!adapter || required.some((name) => typeof adapter[name] !== 'function')) {
      throw new VoiceRemoteSessionError('runtime_adapter_unavailable', 'The remote-session runtime adapter is unavailable.', 503);
    }
    return adapter;
  }

  async _mutate(action, input, fingerprintPayload, operation) {
    const requestID = normalizeRequestID(input.requestID || input.requestId);
    const requestFingerprint = fingerprint({ action, ...fingerprintPayload });
    return this._exclusive(async () => {
      const current = await this._load();
      const existing = current.receipts[requestID];
      if (existing) {
        if (existing.action !== action || existing.fingerprint !== requestFingerprint) {
          throw new VoiceRemoteSessionError('idempotency_conflict', 'requestID was already committed for a different lifecycle request.', 409);
        }
        return { ...cloneValue(existing.result), idempotentReplay: true };
      }
      const now = this._now();
      const next = cloneValue(current);
      this._prune(next, now);
      const operationResult = await operation(next, now);
      const primarySession = operationResult.session;
      const receipt = {
        receiptID: receiptID(requestID, action),
        requestID,
        action,
        sessionID: primarySession.sessionID,
        runID: primarySession.runID,
        generation: primarySession.generation,
        observationCursor: primarySession.observationCursor,
        committedAt: now,
      };
      const result = { ...operationResult, receipt };
      next.receipts[requestID] = {
        requestID,
        action,
        fingerprint: requestFingerprint,
        committedAt: now,
        result,
      };
      this._prune(next, now, requestID);
      next.updatedAt = now;
      await this._persist(current, next);
      return { ...cloneValue(result), idempotentReplay: false };
    });
  }

  _ensureSessionCapacity(state, now) {
    this._prune(state, now);
    if (Object.keys(state.sessions).length < this.maxSessions) return;
    const evictable = Object.entries(state.sessions)
      .filter(([, session]) => session.state !== 'attached' && !this._activeTurns.has(storageKey(session.runtime, session.agent.id, session.sessionID)))
      .sort(([, left], [, right]) => left.timestamps.lastActivityAt - right.timestamps.lastActivityAt);
    while (Object.keys(state.sessions).length >= this.maxSessions && evictable.length) {
      delete state.sessions[evictable.shift()[0]];
    }
    if (Object.keys(state.sessions).length >= this.maxSessions) {
      throw new VoiceRemoteSessionError('session_capacity_exceeded', 'The Companion has reached its remote-session capacity.', 503);
    }
  }

  _prune(state, now, protectedRequestID = '') {
    for (const [key, session] of Object.entries(state.sessions)) {
      const age = now - session.timestamps.lastActivityAt;
      if ((session.state === 'ended' || session.state === 'detached')
          && age > this.sessionRetentionMs
          && !this._activeTurns.has(key)) {
        delete state.sessions[key];
      }
    }
    for (const receipt of Object.values(state.receipts)) {
      if (now - receipt.committedAt > this.receiptRetentionMs) delete state.receipts[receipt.requestID];
    }
    const receipts = Object.values(state.receipts).sort((left, right) => {
      if (left.requestID === protectedRequestID) return -1;
      if (right.requestID === protectedRequestID) return 1;
      return right.committedAt - left.committedAt || left.requestID.localeCompare(right.requestID);
    });
    for (const receipt of receipts.slice(this.maxReceipts)) delete state.receipts[receipt.requestID];
  }

  async _load() {
    if (this._state) return this._state;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.statePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this._state = emptyState(this._now());
        return this._state;
      }
      throw new VoiceRemoteSessionError('persistence_unavailable', 'The remote-session state could not be read safely.', 500);
    }
    if (parsed?.schemaVersion === 1) {
      // Version 1 stored generated UUIDs as runtime identity. Runtime discovery
      // is the only safe migration because those UUIDs were never authoritative.
      this._state = emptyState(this._now());
      return this._state;
    }
    try {
      if (parsed?.schemaVersion !== VOICE_REMOTE_SESSION_SCHEMA_VERSION) throw new Error('unsupported schema');
      if (!parsed.sessions || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) throw new Error('sessions map missing');
      if (!parsed.receipts || typeof parsed.receipts !== 'object' || Array.isArray(parsed.receipts)) throw new Error('receipts map missing');
      for (const [key, session] of Object.entries(parsed.sessions)) {
        assertStoredSession(session);
        if (key !== storageKey(session.runtime, session.agent.id, session.sessionID)) throw new Error('session map key mismatch');
      }
    } catch {
      throw new VoiceRemoteSessionError('persistence_corrupt', 'The persisted remote-session state is invalid and was not overwritten.', 500);
    }
    this._prune(parsed, this._now());
    if (Object.keys(parsed.sessions).length > this.maxSessions) {
      throw new VoiceRemoteSessionError('persistence_capacity_exceeded', 'Persisted remote-session state exceeds the configured bound.', 500);
    }
    this._state = parsed;
    return this._state;
  }

  async _persist(previous, next) {
    const notifications = [];
    for (const [key, session] of Object.entries(next.sessions)) {
      const priorCursor = previous.sessions[key]?.observationCursor || 0;
      for (const event of session.events) {
        if (event.cursor > priorCursor) notifications.push({ key, event: cloneValue(event) });
      }
    }
    const changed = stableStringify(previous) !== stableStringify(next);
    if (changed) {
      next.updatedAt = Math.max(Number(next.updatedAt) || 0, this._now());
      await writeJSONAtomically(this.statePath, next);
      this._state = next;
    }
    for (const { key, event } of notifications) this._notify(key, event);
  }

  _subscribe(key, listener) {
    let listeners = this._subscribers.get(key);
    if (!listeners) {
      listeners = new Set();
      this._subscribers.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this._subscribers.delete(key);
    };
  }

  _notify(key, event) {
    for (const listener of this._subscribers.get(key) || []) {
      try { listener(cloneValue(event)); } catch {}
    }
  }

  _now() {
    const value = Number(this.now());
    if (!Number.isFinite(value) || value < 0) {
      throw new VoiceRemoteSessionError('invalid_clock', 'The remote-session clock is invalid.', 500);
    }
    return Math.floor(value);
  }

  async _exclusive(operation) {
    const previous = this._tail;
    let release;
    this._tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

async function readJSONRequest(req) {
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > MAX_REQUEST_BODY_BYTES) {
    throw new VoiceRemoteSessionError('request_too_large', 'Lifecycle request body is too large.', 413);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_REQUEST_BODY_BYTES) {
      throw new VoiceRemoteSessionError('request_too_large', 'Lifecycle request body is too large.', 413);
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new VoiceRemoteSessionError('invalid_json', 'Lifecycle request body must be a JSON object.', 400);
  }
}

function writeJSON(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function writeSSE(res, event) {
  const type = String(event.type || 'message').replace(/[^a-zA-Z0-9._-]+/g, '.');
  res.write(`id: ${event.cursor}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function createVoiceRemoteSessionHTTPHandler({
  service = new VoiceRemoteSessionService(),
  basePath = '',
} = {}) {
  const normalizedBasePath = basePath ? `/${String(basePath).replace(/^\/+|\/+$/g, '')}` : '';
  const prefix = `${normalizedBasePath}/realtime/voice-remote-sessions`;
  const operations = new Map([
    ['/discover', (body) => service.discover(body)],
    ['/recent', (body) => service.lookupRecent(body)],
    ['/start', (body) => service.start(body)],
    ['/start-new', (body) => service.startNewAgentSession(body)],
    ['/restart-voice', (body) => service.restartVoiceSession(body)],
    ['/restart-agent', (body) => service.restartAgentSession(body)],
    ['/resume', (body) => service.attach(body)],
    ['/attach', (body) => service.attach(body)],
    ['/continue', (body) => service.continueCurrent(body)],
    ['/observe', (body) => service.observe(body)],
    ['/events', (body) => service.events(body)],
    ['/steer', (body) => service.steer(body)],
    ['/stop', (body) => service.stop(body)],
    ['/detach', (body) => service.detach(body)],
    ['/end', (body) => service.end(body)],
  ]);

  return {
    service,
    async handle(req, res, urlPath) {
      if (urlPath !== prefix && !urlPath.startsWith(`${prefix}/`)) return false;
      const suffix = urlPath.slice(prefix.length) || '/';
      try {
        if (suffix === '/events' && req.method === 'GET') {
          const url = new URL(req.url, 'http://localhost');
          const feed = await service.openEventFeed({
            sessionID: url.searchParams.get('sessionID') || url.searchParams.get('sessionId'),
            runtime: url.searchParams.get('runtime') || undefined,
            sessionKey: url.searchParams.get('sessionKey') || undefined,
            after: url.searchParams.get('after') || req.headers['last-event-id'] || 0,
          });
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.write(`event: session\ndata: ${JSON.stringify(feed.session)}\n\n`);
          for (const event of feed.events) writeSSE(res, event);
          const unsubscribe = feed.subscribe((event) => writeSSE(res, event));
          const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15000);
          keepalive.unref?.();
          const cleanup = () => {
            clearInterval(keepalive);
            unsubscribe();
          };
          req.once('close', cleanup);
          res.once('close', cleanup);
          return true;
        }

        const operation = operations.get(suffix);
        if (!operation) {
          writeJSON(res, 404, { ok: false, error: { code: 'unknown_voice_remote_session_route', message: 'Unknown remote-session lifecycle route.' } });
          return true;
        }
        if (req.method !== 'POST') {
          writeJSON(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'Lifecycle routes require POST.' } }, { Allow: 'POST' });
          return true;
        }
        const result = await operation(await readJSONRequest(req));
        writeJSON(res, 200, { ok: true, ...result });
      } catch (error) {
        const lifecycleError = error instanceof VoiceRemoteSessionError
          ? error
          : (error?.code
              ? voiceRemoteRuntimeError(error, {
                  fallbackCode: 'lifecycle_internal_error',
                  fallbackMessage: 'The Companion could not complete the remote-session lifecycle request.',
                })
              : new VoiceRemoteSessionError('lifecycle_internal_error', 'The Companion could not complete the remote-session lifecycle request.', 500));
        if (!(error instanceof VoiceRemoteSessionError)) console.error('[voice-remote-sessions]', error?.stack || error);
        if (!res.headersSent) {
          writeJSON(res, lifecycleError.status, {
            ok: false,
            error: {
              code: lifecycleError.code,
              message: lifecycleError.message,
              retryable: lifecycleError.retryable,
              ...(lifecycleError.details ? { details: lifecycleError.details } : {}),
            },
          });
        } else {
          res.end();
        }
      }
      return true;
    },
  };
}
