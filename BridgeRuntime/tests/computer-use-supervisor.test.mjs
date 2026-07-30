import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  ComputerUseSupervisor,
  ComputerUseSupervisorError,
  probeComputerUseRuntime,
} from '../server/computer-use-supervisor.js';

class FakeHelperProcess extends EventEmitter {
  constructor(server, pid) {
    super();
    this.server = server;
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.stderr = new PassThrough();
  }

  kill(signal = 'SIGTERM') {
    if (this.signalCode || this.exitCode !== null) return false;
    this.signalCode = signal;
    this.server.close(() => queueMicrotask(() => this.emit('exit', null, signal)));
    return true;
  }

  finishCleanly() {
    if (this.signalCode || this.exitCode !== null) return;
    this.exitCode = 0;
    this.server.close(() => queueMicrotask(() => this.emit('exit', 0, null)));
  }
}

function fakeRuntime() {
  return {
    available: true,
    source: 'test-runtime',
    appPath: '/test/Codex Computer Use.app',
    helperPath: '/test/SkyComputerUseService',
    clientPath: '/test/SkyComputerUseClient',
    wrapperPath: '/test/computer-use-client.mjs',
  };
}

function helperSpawner() {
  const children = [];
  const spawnProcess = (_path, _arguments, options) => {
    const socketPath = options.env.SKY_CUA_SERVICE_NATIVE_PIPE_PATH;
    const server = createServer();
    const child = new FakeHelperProcess(server, 40_000 + children.length);
    children.push(child);
    server.once('error', (error) => child.emit('error', error));
    server.listen(socketPath);
    return child;
  };
  return { children, spawnProcess };
}

async function createSupervisor(t, {
  runtimeProbe = async () => ({
    ready: true,
    serverName: 'Computer Use',
    serverVersion: 'test',
    protocolVersion: 'test',
    nativeProbe: 'list_apps',
  }),
} = {}) {
  const privateRoot = await mkdtemp(join(tmpdir(), 'voiceclaw-cua-test-'));
  const spawner = helperSpawner();
  const supervisor = new ComputerUseSupervisor({
    privateRoot,
    spawnProcess: spawner.spawnProcess,
    runtimeDiscovery: async () => fakeRuntime(),
    runtimeValidator: async (runtime) => runtime,
    runtimeProbe,
    startTimeoutMs: 2_000,
    probeTimeoutMs: 500,
  });
  t.after(async () => {
    await supervisor.stop('');
    await rm(privateRoot, { recursive: true, force: true });
  });
  return { privateRoot, spawner, supervisor };
}

test('a task lease starts the private socket, then the Codex thread performs the authenticated probe', async (t) => {
  let probes = 0;
  let probeSocketPath = '';
  const { supervisor, spawner } = await createSupervisor(t, {
    runtimeProbe: async ({ socketPath }) => {
      probes += 1;
      probeSocketPath = socketPath;
      return {
        ready: true,
        serverName: 'Computer Use',
        serverVersion: 'test',
        protocolVersion: 'test',
        nativeProbe: 'list_apps',
      };
    },
  });

  await supervisor.ensureReady({ requestID: 'manual-warm' });
  assert.equal(probes, 0);
  const lease = await supervisor.acquire({ requestID: 'task-1' });
  assert.equal(probes, 0, 'a standalone process cannot authenticate the native probe');
  assert.equal(supervisor.snapshot().socketReady, true);
  assert.equal(supervisor.snapshot().ready, false);
  await supervisor.verifyAuthenticated({
    client: {},
    threadID: 'thread-1',
    requestID: 'task-1',
  });
  assert.equal(probes, 1);
  assert.equal(probeSocketPath, supervisor.snapshot().privateSocketPath);
  assert.equal(supervisor.snapshot().ready, true);
  assert.equal(supervisor.snapshot().activeLeases, 1);
  lease.release();
  lease.release();
  assert.equal(supervisor.snapshot().activeLeases, 0);
  assert.equal(spawner.children.length, 1);
});

test('a retryable probe does not restart the helper underneath a dispatched task', async (t) => {
  let probes = 0;
  const { supervisor, spawner } = await createSupervisor(t, {
    runtimeProbe: async () => {
      probes += 1;
      if (probes === 1) {
        return {
          ready: true,
          serverName: 'Computer Use',
          serverVersion: 'test',
          protocolVersion: 'test',
          nativeProbe: 'list_apps',
        };
      }
      throw new ComputerUseSupervisorError(
        'computer_use_unavailable',
        'Synthetic failure while another task is dispatched.',
        { retryable: true },
      );
    },
  });

  const activeLease = await supervisor.acquire({ requestID: 'active-task' });
  await supervisor.verifyAuthenticated({
    client: {},
    threadID: 'thread-active',
    requestID: 'active-task',
  });
  activeLease.markDispatched();

  const waitingLease = await supervisor.acquire({ requestID: 'waiting-task' });
  await assert.rejects(
    supervisor.verifyAuthenticated({
      client: {},
      threadID: 'thread-waiting',
      requestID: 'waiting-task',
    }),
    (error) => error.code === 'computer_use_recovery_deferred',
  );
  assert.equal(spawner.children.length, 1);
  assert.equal(spawner.children[0].signalCode, null);
  assert.equal(supervisor.snapshot().dispatchedLeases, 1);
  assert.equal(supervisor.snapshot().state, 'degraded');

  waitingLease.release();
  activeLease.release();
});

test('a retryable authenticated pre-dispatch probe failure replaces only the private helper once', async (t) => {
  let probes = 0;
  const { supervisor, spawner } = await createSupervisor(t, {
    runtimeProbe: async () => {
      probes += 1;
      if (probes === 1) {
        throw new ComputerUseSupervisorError(
          'computer_use_unavailable',
          'Synthetic stale private socket.',
          { retryable: true },
        );
      }
      return {
        ready: true,
        serverName: 'Computer Use',
        serverVersion: 'test',
        protocolVersion: 'test',
        nativeProbe: 'list_apps',
      };
    },
  });

  const lease = await supervisor.acquire({ requestID: 'task-retry' });
  const ready = await supervisor.verifyAuthenticated({
    client: {},
    threadID: 'thread-retry',
    requestID: 'task-retry',
  });
  assert.equal(ready.ready, true);
  assert.equal(probes, 2);
  assert.equal(spawner.children.length, 2);
  assert.ok(spawner.children[0].signalCode, 'only the first Companion-owned helper is repaired');
  assert.equal(spawner.children[1].signalCode, null);
  lease.release();
});

test('permission denial fails immediately without restart churn', async (t) => {
  const { supervisor, spawner } = await createSupervisor(t, {
    runtimeProbe: async () => {
      throw new ComputerUseSupervisorError(
        'computer_use_permission_required',
        'Accessibility permission is required.',
        { retryable: false },
      );
    },
  });

  const lease = await supervisor.acquire({ requestID: 'permission-test' });
  await assert.rejects(
    supervisor.verifyAuthenticated({
      client: {},
      threadID: 'thread-permission',
      requestID: 'permission-test',
    }),
    (error) => error.code === 'computer_use_permission_required',
  );
  assert.equal(spawner.children.length, 1);
  assert.equal(supervisor.snapshot().state, 'needs_permission');
  lease.release();
});

test('a stale non-socket artifact is removed before the private helper starts', async (t) => {
  const { privateRoot, supervisor } = await createSupervisor(t);
  await writeFile(join(privateRoot, 'computeruse.sock'), 'stale');

  const ready = await supervisor.ensureReady({ requestID: 'stale-file-test' });
  assert.equal(ready.socketReady, true);
  assert.equal(ready.ready, false);
});

test('an unleased helper clean idle exit remains available on demand instead of failing diagnostics', async (t) => {
  const { supervisor, spawner } = await createSupervisor(t);
  await supervisor.ensureReady({ requestID: 'idle-exit-test' });
  assert.equal(supervisor.snapshot().state, 'socket_ready');

  spawner.children[0].finishCleanly();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  const idle = supervisor.snapshot();
  assert.equal(idle.state, 'idle');
  assert.equal(idle.ready, false);
  assert.equal(idle.socketReady, false);
  assert.equal(idle.error, null);

  const restarted = await supervisor.ensureReady({ requestID: 'idle-restart-test' });
  assert.equal(restarted.state, 'socket_ready');
  assert.equal(spawner.children.length, 2);
});

test('the authenticated probe uses Codex app-server node_repl and parses list_apps', async () => {
  const calls = [];
  const result = await probeComputerUseRuntime({
    client: {
      async callMCPTool(input) {
        calls.push(input);
        return {
          isError: false,
          content: [{
            type: 'text',
            text: JSON.stringify({
              count: 7,
              hasTextEdit: true,
              runtimeIdentity: '/private/voiceclaw.sock#4',
            }),
          }],
        };
      },
    },
    threadID: 'thread-probe',
    wrapperPath: '/trusted/computer-use-client.mjs',
    socketPath: '/private/voiceclaw.sock',
    helperGeneration: 4,
    timeoutMs: 1_000,
  });
  assert.equal(result.ready, true);
  assert.equal(result.applicationCount, 7);
  assert.equal(calls[0].server, 'node_repl');
  assert.equal(calls[0].threadID, 'thread-probe');
  assert.equal(calls[0].tool, 'js');
  assert.match(calls[0].arguments.code, /computer-use-client\.mjs/);
  assert.match(calls[0].arguments.code, /list_apps/);
  assert.match(calls[0].arguments.code, /runtime-identity/);
  assert.match(calls[0].arguments.code, /voiceclaw\.sock#4/);
  assert.doesNotMatch(calls[0].arguments.code, /nodeRepl\?\.env/);
});
