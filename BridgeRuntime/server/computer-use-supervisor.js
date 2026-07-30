import { execFile, spawn } from 'node:child_process';
import {
  access,
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const OPENAI_TEAM_ID = '2DC432GLL2';
const HELPER_IDENTIFIER = 'com.openai.sky.CUAService';
const DEFAULT_START_TIMEOUT_MS = 45_000;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_PRIVATE_ROOT = join(
  tmpdir(),
  `voiceclaw-cua-${typeof process.getuid === 'function' ? process.getuid() : 'user'}-${process.pid}`,
);

function errorText(error) {
  return String(error?.message || error || '').trim();
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function executablePair(appPath) {
  const app = resolve(String(appPath || ''));
  return {
    appPath: app,
    helperPath: join(app, 'Contents', 'MacOS', 'SkyComputerUseService'),
    clientPath: join(
      app,
      'Contents',
      'SharedSupport',
      'SkyComputerUseClient.app',
      'Contents',
      'MacOS',
      'SkyComputerUseClient',
    ),
  };
}

async function isExecutable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isReadableFile(path) {
  try {
    await access(path, fsConstants.R_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function discoverComputerUseWrapper({
  codexPath = '',
  codeHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
} = {}) {
  const candidates = [];
  const selectedCodexPath = String(codexPath || '').trim()
    ? resolve(String(codexPath))
    : '';
  const chatGPTResourcesSuffix = join('Contents', 'Resources', 'codex');
  if (selectedCodexPath.endsWith(chatGPTResourcesSuffix)) {
    candidates.push(join(
      dirname(selectedCodexPath),
      'plugins',
      'openai-bundled',
      'plugins',
      'computer-use',
      'scripts',
      'computer-use-client.mjs',
    ));
  }

  const cacheRoot = join(
    resolve(codeHome),
    'plugins',
    'cache',
    'openai-bundled',
    'computer-use',
  );
  try {
    const versions = (await readdir(cacheRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const version of versions) {
      candidates.push(join(cacheRoot, version, 'scripts', 'computer-use-client.mjs'));
    }
  } catch {}

  for (const candidate of candidates) {
    if (await isReadableFile(candidate)) return await realpath(candidate);
  }
  return '';
}

export async function discoverComputerUseRuntime({
  codexPath = '',
  codeHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
  explicitAppPath = process.env.VOICECLAW_CUA_APP_PATH || '',
} = {}) {
  const candidates = [];
  if (String(explicitAppPath || '').trim()) {
    candidates.push({ ...executablePair(explicitAppPath), source: 'operator-override' });
  }

  const selectedCodexPath = resolve(String(codexPath || ''));
  const chatGPTResourcesSuffix = join('Contents', 'Resources', 'codex');
  if (selectedCodexPath.endsWith(chatGPTResourcesSuffix)) {
    const resources = dirname(selectedCodexPath);
    candidates.push({
      ...executablePair(join(
        resources,
        'cua_node',
        'lib',
        'node_modules',
        '@oai',
        'sky',
        'Codex Computer Use.app',
      )),
      source: 'selected-chatgpt-codex',
    });
  }

  candidates.push({
    ...executablePair(join(codeHome, 'computer-use', 'Codex Computer Use.app')),
    source: 'codex-home',
  });

  const wrapperPath = await discoverComputerUseWrapper({ codexPath, codeHome });
  for (const candidate of candidates) {
    if (await isExecutable(candidate.helperPath)) {
      return Object.freeze({ ...candidate, wrapperPath, available: true });
    }
  }
  return Object.freeze({
    available: false,
    source: 'not-found',
    appPath: '',
    helperPath: '',
    clientPath: '',
    wrapperPath,
  });
}

async function signedIdentity(executablePath) {
  await execFileAsync('/usr/bin/codesign', ['--verify', '--strict', executablePath], {
    timeout: 10_000,
    maxBuffer: 1_048_576,
  });
  const { stderr = '' } = await execFileAsync(
    '/usr/bin/codesign',
    ['-dv', '--verbose=4', executablePath],
    { timeout: 10_000, maxBuffer: 1_048_576 },
  );
  const metadata = String(stderr || '');
  return {
    teamID: metadata.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || '',
    identifier: metadata.match(/^Identifier=(.+)$/m)?.[1]?.trim() || '',
  };
}

export async function validateComputerUseRuntime(runtime) {
  if (!runtime?.available) {
    throw new ComputerUseSupervisorError(
      'computer_use_runtime_missing',
      'The signed Computer Use runtime was not found beside the selected Codex installation.',
      { retryable: false },
    );
  }
  const helper = await signedIdentity(runtime.helperPath);
  if (helper.teamID !== OPENAI_TEAM_ID || helper.identifier !== HELPER_IDENTIFIER) {
    throw new ComputerUseSupervisorError(
      'computer_use_helper_untrusted',
      'The discovered Computer Use helper does not have the expected OpenAI signature.',
      { retryable: false },
    );
  }
  if (!runtime.wrapperPath || !await isReadableFile(runtime.wrapperPath)) {
    throw new ComputerUseSupervisorError(
      'computer_use_wrapper_missing',
      'The trusted Computer Use wrapper was not found in the selected ChatGPT/Codex installation or Codex plugin cache.',
      { retryable: false },
    );
  }
  return Object.freeze({
    ...runtime,
    wrapperPath: await realpath(runtime.wrapperPath),
  });
}

function classifyProbeFailure(error) {
  const message = errorText(error);
  const normalized = message.toLowerCase();
  if (/-10008|-10009|-10014/.test(message)
      || normalized.includes('accessibility')
      || normalized.includes('screen recording')
      || normalized.includes('permission')) {
    return new ComputerUseSupervisorError(
      'computer_use_permission_required',
      'Computer control needs macOS Accessibility and Screen Recording permission for the signed Computer Use helper.',
      { retryable: false, cause: message },
    );
  }
  if (/-10013/.test(message) || normalized.includes('incompatible')) {
    return new ComputerUseSupervisorError(
      'computer_use_protocol_incompatible',
      'The installed Computer Use helper and client use incompatible protocol versions.',
      { retryable: false, cause: message },
    );
  }
  if (/-10000/.test(message) || normalized.includes('not authenticated')) {
    return new ComputerUseSupervisorError(
      'computer_use_client_unauthenticated',
      'The Computer Use helper rejected the client identity.',
      { retryable: false, cause: message },
    );
  }
  return new ComputerUseSupervisorError(
    'computer_use_unavailable',
    message || 'The private Computer Use runtime did not become ready.',
    { retryable: true, cause: message },
  );
}

async function terminateChild(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill(signal);
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    sleep(1_000),
  ]);
  if (child.exitCode === null && !child.signalCode) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise((resolvePromise) => child.once('exit', resolvePromise)),
      sleep(1_000),
    ]);
  }
}

/**
 * Probe inside the actual Codex thread so app-server supplies the authenticated
 * turn metadata required by the signed helper. list_apps forces a real native
 * pipe and protocol handshake without mutating another application.
 */
export async function probeComputerUseRuntime({
  client,
  threadID,
  wrapperPath,
  socketPath,
  helperGeneration,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  try {
    if (!client || !String(threadID || '').trim()) {
      throw new Error('An active Codex app-server thread is required.');
    }
    const expectedSocketPath = String(socketPath || '').trim();
    if (!expectedSocketPath) {
      throw new Error('The expected private Computer Use socket is required.');
    }
    const expectedHelperGeneration = Number(helperGeneration);
    if (!Number.isInteger(expectedHelperGeneration) || expectedHelperGeneration < 1) {
      throw new Error('The expected private Computer Use helper generation is required.');
    }
    const expectedRuntimeIdentity = `${expectedSocketPath}#${expectedHelperGeneration}`;
    // node_repl redacts environment values from untrusted call source. The
    // signed wrapper receives the config-bound pipe and is recreated whenever
    // this Companion-owned helper identity changes.
    const callTool = typeof client.callMCPTool === 'function'
      ? client.callMCPTool.bind(client)
      : async (input) => await client.request('mcpServer/tool/call', {
          server: input.server,
          threadId: input.threadID,
          tool: input.tool,
          arguments: input.arguments,
        }, { timeoutMs: input.timeoutMs });
    const result = await callTool({
      server: 'node_repl',
      threadID: String(threadID).trim(),
      tool: 'js',
      arguments: {
        code: [
          `var voiceClawComputerUseRuntimeIdentity = ${JSON.stringify(expectedRuntimeIdentity)};`,
          'var voiceClawComputerUseRuntimeKey = Symbol.for("openai.computer-use.runtime");',
          'var voiceClawComputerUseIdentityKey = Symbol.for("voiceclaw.computer-use.runtime-identity");',
          'if (Reflect.get(globalThis, voiceClawComputerUseIdentityKey) !== voiceClawComputerUseRuntimeIdentity) { Reflect.deleteProperty(globalThis, voiceClawComputerUseRuntimeKey); Reflect.deleteProperty(globalThis, "sky"); Reflect.set(globalThis, voiceClawComputerUseIdentityKey, voiceClawComputerUseRuntimeIdentity); }',
          `var voiceClawComputerUseWrapper = await import(${JSON.stringify(wrapperPath)});`,
          'var voiceClawSky = await voiceClawComputerUseWrapper.setupComputerUseRuntime({ globals: globalThis });',
          'var voiceClawApps = await voiceClawSky.list_apps();',
          'nodeRepl.write(JSON.stringify({ count: voiceClawApps.length, hasTextEdit: voiceClawApps.some((app) => String(app?.id || "").includes("TextEdit")), runtimeIdentity: voiceClawComputerUseRuntimeIdentity }));',
        ].join(' '),
        timeout_ms: timeoutMs,
        title: 'Verify VoiceClaw computer control',
      },
      timeoutMs: timeoutMs + 15_000,
    });
    const detail = Array.isArray(result?.content)
      ? result.content.map((item) => item?.text || '').filter(Boolean).join('\n').trim()
      : '';
    if (result?.isError) {
      throw new Error(detail || 'The authenticated Computer Use readiness call failed.');
    }
    const probe = JSON.parse(detail);
    if (!Number.isInteger(probe?.count) || probe.count < 1) {
      throw new Error('The authenticated Computer Use readiness call returned no applications.');
    }
    if (probe.runtimeIdentity !== expectedRuntimeIdentity) {
      throw new Error('The authenticated Computer Use readiness call returned a different private runtime identity.');
    }
    return {
      ready: true,
      serverName: 'Codex app-server node_repl',
      serverVersion: '',
      protocolVersion: 'mcpServer/tool/call',
      nativeProbe: 'node_repl/list_apps',
      applicationCount: probe.count,
      textEditVisible: probe.hasTextEdit === true,
      pipePath: expectedSocketPath,
      helperGeneration: expectedHelperGeneration,
    };
  } catch (error) {
    throw classifyProbeFailure(error);
  }
}

export class ComputerUseSupervisorError extends Error {
  constructor(code, message, {
    retryable = false,
    cause = '',
    statusCode = 503,
  } = {}) {
    super(message);
    this.name = 'ComputerUseSupervisorError';
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
    this.details = cause ? { cause } : null;
  }
}

export class ComputerUseSupervisor {
  constructor({
    codexPath = '',
    privateRoot = process.env.VOICECLAW_CUA_PRIVATE_ROOT || DEFAULT_PRIVATE_ROOT,
    socketName = 'computeruse.sock',
    spawnProcess = spawn,
    runtimeDiscovery = discoverComputerUseRuntime,
    runtimeValidator = validateComputerUseRuntime,
    runtimeProbe = probeComputerUseRuntime,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    now = () => Date.now(),
  } = {}) {
    this.codexPath = codexPath;
    this.privateRoot = resolve(privateRoot);
    this.socketPath = join(this.privateRoot, socketName);
    this.spawnProcess = spawnProcess;
    this.runtimeDiscovery = runtimeDiscovery;
    this.runtimeValidator = runtimeValidator;
    this.runtimeProbe = runtimeProbe;
    this.startTimeoutMs = startTimeoutMs;
    this.probeTimeoutMs = probeTimeoutMs;
    this.now = now;
    this.runtime = null;
    this.validated = false;
    this.child = null;
    this.childSpawnError = null;
    this.startPromise = null;
    this.verificationLock = Promise.resolve();
    this.leaseCount = 0;
    this.dispatchedLeaseCount = 0;
    this.generation = 0;
    this.lastProbe = null;
    this.lastError = null;
    this.state = 'idle';
  }

  environment() {
    return {
      SKY_CUA_NATIVE_PIPE_PATH: this.socketPath,
    };
  }

  snapshot() {
    const helperRunning = !!this.child
      && this.child.exitCode === null
      && !this.child.signalCode;
    return {
      state: this.state,
      ready: this.state === 'ready',
      socketReady: helperRunning
        && ['socket_ready', 'probing', 'ready'].includes(this.state),
      privateSocketPath: this.socketPath,
      helperPath: this.runtime?.helperPath || '',
      wrapperPath: this.runtime?.wrapperPath || '',
      runtimeSource: this.runtime?.source || '',
      helperPID: helperRunning ? this.child.pid : null,
      helperOwnedByCompanion: helperRunning,
      activeLeases: this.leaseCount,
      dispatchedLeases: this.dispatchedLeaseCount,
      generation: this.generation,
      serverName: this.lastProbe?.serverName || '',
      serverVersion: this.lastProbe?.serverVersion || '',
      protocolVersion: this.lastProbe?.protocolVersion || '',
      lastProbeAt: this.lastProbe?.at || null,
      error: this.lastError
        ? {
            code: this.lastError.code || 'computer_use_unavailable',
            message: this.lastError.message,
            retryable: this.lastError.retryable === true,
          }
        : null,
    };
  }

  async ensureReady({ requestID = '', forceSocketCheck = false } = {}) {
    const helperRunning = !!this.child
      && this.child.exitCode === null
      && !this.child.signalCode;
    if (helperRunning
        && ['socket_ready', 'ready'].includes(this.state)
        && !forceSocketCheck) {
      return this.snapshot();
    }
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.#prepare({ requestID });
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async acquire({ requestID = '' } = {}) {
    await this.ensureReady({ requestID, forceSocketCheck: true });
    this.leaseCount += 1;
    let released = false;
    let dispatched = false;
    return {
      status: this.snapshot(),
      markDispatched: () => {
        if (released || dispatched) return;
        dispatched = true;
        this.dispatchedLeaseCount += 1;
      },
      release: () => {
        if (released) return;
        released = true;
        if (dispatched) {
          this.dispatchedLeaseCount = Math.max(0, this.dispatchedLeaseCount - 1);
        }
        this.leaseCount = Math.max(0, this.leaseCount - 1);
      },
    };
  }

  async verifyAuthenticated({
    client,
    threadID,
    requestID = '',
  } = {}) {
    const previous = this.verificationLock;
    const current = previous
      .catch(() => {})
      .then(() => this.#verifyAuthenticated({ client, threadID, requestID }));
    this.verificationLock = current;
    try {
      return await current;
    } finally {
      if (this.verificationLock === current) this.verificationLock = Promise.resolve();
    }
  }

  async #verifyAuthenticated({
    client,
    threadID,
    requestID = '',
  } = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.ensureReady({ requestID, forceSocketCheck: true });
        this.state = 'probing';
        const result = await this.runtimeProbe({
          client,
          threadID,
          wrapperPath: this.runtime.wrapperPath,
          socketPath: this.socketPath,
          helperGeneration: this.generation,
          timeoutMs: this.probeTimeoutMs,
        });
        this.lastProbe = { ...result, at: this.now() };
        this.lastError = null;
        this.state = 'ready';
        return this.snapshot();
      } catch (error) {
        lastError = error instanceof ComputerUseSupervisorError
          ? error
          : classifyProbeFailure(error);
        if (lastError.retryable === false || attempt === 2) break;
        if (this.dispatchedLeaseCount > 0) {
          lastError = new ComputerUseSupervisorError(
            'computer_use_recovery_deferred',
            'Computer control recovery was deferred because another dispatched Codex task is still using the private helper.',
            { retryable: true, cause: lastError.message },
          );
          break;
        }
        await this.#stopOwnedChild('authenticated-pre-dispatch-repair');
        await this.#removeOwnedSocketArtifacts();
        this.state = 'preparing';
        await sleep(250);
      }
    }
    const failure = lastError || new ComputerUseSupervisorError(
      'computer_use_unavailable',
      'Computer control could not complete its authenticated readiness check.',
      { retryable: true },
    );
    this.lastError = failure;
    this.state = this.dispatchedLeaseCount > 0
      ? 'degraded'
      : failure.code === 'computer_use_permission_required'
        ? 'needs_permission'
        : 'failed';
    throw failure;
  }

  async stop(reason = 'shutdown') {
    this.state = 'stopping';
    const child = this.child;
    this.child = null;
    this.childSpawnError = null;
    await terminateChild(child);
    await this.#removeOwnedSocketArtifacts();
    this.state = 'idle';
    this.lastError = reason ? {
      code: 'computer_use_stopped',
      message: `Computer control stopped: ${reason}.`,
      retryable: true,
    } : null;
  }

  async #prepare({ requestID }) {
    this.state = 'preparing';
    this.lastError = null;
    try {
      await this.#preparePrivateRoot();
      await this.#resolveRuntime();

      const socketState = await this.#socketState();
      const helperRunning = !!this.child
        && this.child.exitCode === null
        && !this.child.signalCode;
      if (socketState === 'socket' && helperRunning) {
        this.state = this.lastProbe ? 'ready' : 'socket_ready';
        return this.snapshot();
      }
      if (socketState !== 'missing') {
        await this.#removeOwnedSocketArtifacts();
      }

      let lastError;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          await this.#launchHelper();
          await this.#waitForSocket();
          this.state = 'socket_ready';
          return this.snapshot();
        } catch (error) {
          lastError = error instanceof ComputerUseSupervisorError
            ? error
            : classifyProbeFailure(error);
          if (lastError.retryable === false || attempt === 2) throw lastError;
          await this.#stopOwnedChild('pre-dispatch-repair');
          await this.#removeOwnedSocketArtifacts();
          await sleep(250);
        }
      }
      throw lastError || new Error(`Computer Use could not start for ${requestID}.`);
    } catch (error) {
      const failure = error instanceof ComputerUseSupervisorError
        ? error
        : classifyProbeFailure(error);
      this.lastError = failure;
      this.state = failure.code === 'computer_use_permission_required'
        ? 'needs_permission'
        : 'failed';
      throw failure;
    }
  }

  async #resolveRuntime() {
    if (!this.runtime) {
      this.runtime = await this.runtimeDiscovery({ codexPath: this.codexPath });
    }
    if (!this.validated) {
      this.runtime = await this.runtimeValidator(this.runtime);
      this.validated = true;
    }
  }

  async #preparePrivateRoot() {
    await mkdir(this.privateRoot, { recursive: true, mode: 0o700 });
    await chmod(this.privateRoot, 0o700);
    const metadata = await stat(this.privateRoot);
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new ComputerUseSupervisorError(
        'computer_use_private_root_owner',
        'The VoiceClaw private Computer Use directory has an unexpected owner.',
        { retryable: false },
      );
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new ComputerUseSupervisorError(
        'computer_use_private_root_permissions',
        'The VoiceClaw private Computer Use directory is not private to this user.',
        { retryable: false },
      );
    }
  }

  async #socketState() {
    try {
      const metadata = await lstat(this.socketPath);
      return metadata.isSocket() ? 'socket' : 'other';
    } catch {
      return 'missing';
    }
  }

  async #launchHelper() {
    if (this.child?.exitCode === null && !this.child.signalCode) return;
    const child = this.spawnProcess(this.runtime.helperPath, [], {
      env: {
        ...process.env,
        SKY_CUA_SERVICE_NATIVE_PIPE_PATH: this.socketPath,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child = child;
    this.childSpawnError = null;
    this.generation += 1;
    let stderrTail = '';
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (chunk) => {
      stderrTail = `${stderrTail}${String(chunk || '')}`.slice(-16_384);
    });
    child.once('error', (error) => {
      if (this.child === child) this.childSpawnError = error;
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.childSpawnError = null;
      if (this.state === 'stopping' || this.state === 'idle') return;
      if (code === 0 && this.leaseCount === 0) {
        this.lastProbe = null;
        this.lastError = null;
        this.state = 'idle';
        this.#removeOwnedSocketArtifacts().catch(() => {});
        return;
      }
      this.lastError = new ComputerUseSupervisorError(
        'computer_use_helper_exited',
        `The private Computer Use helper exited${code !== null ? ` with code ${code}` : signal ? ` after ${signal}` : ''}${stderrTail ? `: ${stderrTail}` : '.'}`,
        { retryable: true },
      );
      this.state = 'failed';
      if (this.leaseCount > 0 && this.dispatchedLeaseCount === 0) {
        queueMicrotask(() => {
          this.ensureReady({ requestID: 'active-lease-recovery' }).catch(() => {});
        });
      }
    });
  }

  async #waitForSocket() {
    const deadline = this.now() + this.startTimeoutMs;
    while (this.now() < deadline) {
      if (this.childSpawnError) {
        throw new ComputerUseSupervisorError(
          'computer_use_helper_launch_failed',
          `The private Computer Use helper could not launch: ${errorText(this.childSpawnError)}`,
          { retryable: true },
        );
      }
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) {
        throw new ComputerUseSupervisorError(
          'computer_use_helper_exited',
          `The private Computer Use helper exited with code ${this.child.exitCode}.`,
          { retryable: true },
        );
      }
      if (await this.#socketState() === 'socket') {
        await sleep(350);
        return;
      }
      await sleep(100);
    }
    throw new ComputerUseSupervisorError(
      'computer_use_socket_timeout',
      'The private Computer Use socket did not appear before timeout.',
      { retryable: true },
    );
  }

  async #stopOwnedChild(reason) {
    const child = this.child;
    this.child = null;
    this.childSpawnError = null;
    await terminateChild(child);
    if (reason) {
      this.lastError = new ComputerUseSupervisorError(
        'computer_use_restarting',
        `Computer control is restarting after ${reason}.`,
        { retryable: true },
      );
    }
  }

  async #removeOwnedSocketArtifacts() {
    const paths = [this.socketPath, `${this.socketPath}.lock`];
    for (const path of paths) {
      try {
        await unlink(path);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}
