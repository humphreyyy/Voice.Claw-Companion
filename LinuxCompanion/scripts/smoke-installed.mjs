import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error(`Missing ${name}.`);
  }
  return process.argv[index + 1];
}

function command(executable, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0 || allowFailure) {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      } else {
        reject(new Error(`${executable} exited with code ${code}: ${stderr}`));
      }
    });
  });
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(port) {
  const deadline = Date.now() + 20_000;
  let lastError = new Error('Packaged bridge did not become healthy.');
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        return await response.json();
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError;
}

const executable = argument('--executable');
const serviceEntry = argument('--service-entry');
const smokeRoot = await mkdtemp(join(tmpdir(), 'voiceclaw-installed-smoke-'));
const unitName = `voiceclaw-companion-smoke-${process.pid}-${randomUUID().slice(0, 8)}`;

try {
  const port = await reservePort();
  const configFile = join(smokeRoot, 'bridge.json');
  const dataDir = join(smokeRoot, 'data');
  const cacheDir = join(smokeRoot, 'cache');
  await writeFile(configFile, `${JSON.stringify({
    port,
    gatewayToken: randomBytes(32).toString('base64url'),
    openClawInstallPath: join(homedir(), '.openclaw'),
    openClawAgentName: 'main',
    realtimeAuthMode: 'openclaw-oauth',
    realtimeAuthFallbackToAPIKey: false,
    openAIAPIKey: '',
    tailscaleDNSName: '',
    tailscaleBaseURL: '',
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(configFile, 0o600);

  await command('systemd-run', [
    '--user',
    `--unit=${unitName}`,
    '--collect',
    '--property=Type=simple',
    '--setenv=ELECTRON_RUN_AS_NODE=1',
    `--setenv=VOICECLAW_CONFIG_PATH=${configFile}`,
    `--setenv=VOICECLAW_APP_SUPPORT_DIR=${dataDir}`,
    `--setenv=VOICECLAW_CACHE_DIR=${cacheDir}`,
    executable,
    serviceEntry,
  ]);

  const health = await waitForHealth(port);
  if (health.ok !== true || health.port !== port) {
    throw new Error('Packaged bridge health response is invalid.');
  }
  if (health.runtime?.product !== 'VoiceClaw Companion') {
    throw new Error('Packaged bridge product identity is invalid.');
  }
  if (!/^[a-f0-9]{64}$/.test(String(health.runtime?.runtimeHash || ''))) {
    throw new Error('Packaged bridge runtime hash is invalid.');
  }
  console.log(JSON.stringify({
    ok: true,
    port,
    product: health.runtime.product,
    runtimeHash: health.runtime.runtimeHash,
  }));
} finally {
  await command(
    'systemctl',
    ['--user', 'stop', `${unitName}.service`],
    { allowFailure: true },
  );
  await command(
    'systemctl',
    ['--user', 'reset-failed', `${unitName}.service`],
    { allowFailure: true },
  );
  await rm(smokeRoot, { recursive: true, force: true });
}
