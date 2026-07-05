#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants, existsSync, readFileSync } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import JSON5 from 'json5';
import { getHFRealtimeStatus, installHFRealtimeRuntime } from '../server/hf-realtime-sidecar.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const HOME = process.env.HOME || '';
const CONFIG_DIR = join(HOME, '.voiceclaw');
const CONFIG_FILE = join(CONFIG_DIR, 'bridge.json');
const LAUNCH_AGENT_LABEL = 'ai.voiceclaw.bridge';
const LAUNCH_AGENT_FILE = join(HOME, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
const DEFAULT_BRIDGE_PORT = 12321;
const DEFAULT_OPENCLAW_AGENT_NAME = 'main';
const DEFAULT_QWEN_MODEL = process.env.COMPANION_VOICE_QWEN_MODEL || 'qwen3.5:2b';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const RUNTIME_PATH = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(':');

function parseArgs(argv) {
  const options = {
    installLaunchAgent: false,
    start: false,
    configureTailscale: false,
    jsonOnly: false,
    reset: false,
    resetTailscalePort: false,
    diagnose: false,
    suggestPort: false,
    installCompanionVoiceDependencies: false,
    port: null,
    openClawInstallPath: null,
    openClawAgentName: null,
    realtimeAuthMode: null,
    realtimeAuthFallbackToAPIKey: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--install-launch-agent' || arg === '--install') options.installLaunchAgent = true;
    else if (arg === '--start') options.start = true;
    else if (arg === '--configure-tailscale' || arg === '--tailscale') options.configureTailscale = true;
    else if (arg === '--json') options.jsonOnly = true;
    else if (arg === '--reset') options.reset = true;
    else if (arg === '--reset-tailscale-port') options.resetTailscalePort = true;
    else if (arg === '--diagnose') options.diagnose = true;
    else if (arg === '--suggest-port') options.suggestPort = true;
    else if (arg === '--install-companion-voice-deps') options.installCompanionVoiceDependencies = true;
    else if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
    else if (arg === '--openclaw-path') options.openClawInstallPath = argv[++index] || options.openClawInstallPath;
    else if (arg.startsWith('--openclaw-path=')) options.openClawInstallPath = arg.slice('--openclaw-path='.length);
    else if (arg === '--openclaw-agent') options.openClawAgentName = normalizeOpenClawAgentName(argv[++index]);
    else if (arg.startsWith('--openclaw-agent=')) options.openClawAgentName = normalizeOpenClawAgentName(arg.slice('--openclaw-agent='.length));
    else if (arg === '--realtime-auth-mode') options.realtimeAuthMode = normalizeRealtimeAuthMode(argv[++index]);
    else if (arg.startsWith('--realtime-auth-mode=')) options.realtimeAuthMode = normalizeRealtimeAuthMode(arg.slice('--realtime-auth-mode='.length));
    else if (arg === '--realtime-auth-fallback-to-api-key') options.realtimeAuthFallbackToAPIKey = true;
    else if (arg === '--no-realtime-auth-fallback-to-api-key') options.realtimeAuthFallbackToAPIKey = false;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (options.port !== null && (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535)) {
    throw new Error(`Invalid port: ${options.port}. Choose a port from 1024 to 65535.`);
  }

  return options;
}

function printHelp() {
  console.log(`VoiceClaw Companion setup

Usage:
  node scripts/voiceclaw-bridge-setup.mjs [options]

Options:
  --install-launch-agent     Install ~/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist
  --start                    Start or restart the launch agent after installing it
  --configure-tailscale      Run tailscale serve for the configured bridge port
  --reset                    Stop VoiceClaw's LaunchAgent and remove VoiceClaw companion config
  --reset-tailscale-port     With --reset, also remove the selected Tailscale Serve port only if it is safely identified as Voice.Claw
  --diagnose                 Print read-only local bridge and Tailscale Serve diagnostics
  --suggest-port             Print a fresh unused test port without changing system state
  --install-companion-voice-deps
                             Install missing Companion Realtime Voice dependencies after app confirmation
  --json                     Print only the phone setup JSON
  --port 12321               Bridge/Tailscale HTTPS port
  --openclaw-path PATH       OpenClaw install/config folder, usually ~/.openclaw
  --openclaw-agent NAME      OpenClaw agent id, usually the configured OpenClaw default
  --realtime-auth-mode MODE   api-key or openclaw-oauth
  --realtime-auth-fallback-to-api-key / --no-realtime-auth-fallback-to-api-key

Recommended first run:
  node scripts/voiceclaw-bridge-setup.mjs --install --start --tailscale
`);
}

async function readBridgeConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function writeBridgeConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function generateToken() {
  return randomBytes(32).toString('base64url');
}

function normalizeInstallPath(value) {
  return String(value || '').trim().replace(/\/+$/g, '') || join(HOME, '.openclaw');
}

function normalizeRealtimeAuthMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'openclaw-oauth' || normalized === 'oauth' || normalized === 'openclaw'
    ? 'openclaw-oauth'
    : 'api-key';
}

function normalizeOpenClawAgentName(value) {
  const trimmed = String(value || '').trim();
  return trimmed || DEFAULT_OPENCLAW_AGENT_NAME;
}

function normalizeOpenClawAgentID(value) {
  return String(value || '').trim().toLowerCase();
}

function parseOpenClawConfig(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON5.parse(raw);
  }
}

function configuredOpenClawAgentIDs(parsed) {
  const ids = [];
  const aliases = [];
  const list = Array.isArray(parsed?.agents?.list) ? parsed.agents.list : null;
  if (list) {
    for (const entry of list) {
      if (entry?.id) ids.push(String(entry.id));
      if (entry?.name && entry.name !== entry?.id) aliases.push(String(entry.name));
    }
    return { ids, aliases, source: 'agents.list' };
  }

  const legacyAgents = parsed?.agents || parsed?.agent || parsed?.profiles || {};
  if (Array.isArray(legacyAgents)) {
    for (const entry of legacyAgents) {
      if (entry?.id) ids.push(String(entry.id));
      else if (entry?.name) ids.push(String(entry.name));
    }
    return { ids, aliases, source: 'legacy-array' };
  }
  if (legacyAgents && typeof legacyAgents === 'object') {
    return { ids: Object.keys(legacyAgents), aliases, source: 'legacy-map' };
  }
  return { ids, aliases, source: 'none' };
}

async function resolveNodePath() {
  const candidates = [
    process.execPath,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  const { stdout } = await execFileAsync('/usr/bin/env', ['which', 'node']);
  const resolved = stdout.trim();
  if (!resolved) throw new Error('Node.js was not found.');
  return resolved;
}

async function resolveOptionalExecutable(name, explicitPath = '') {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  if (!String(name || '').includes('/')) {
    for (const dir of RUNTIME_PATH.split(':')) {
      candidates.push(join(dir, name));
    }
  } else {
    candidates.push(name);
  }
  for (const candidate of candidates) {
    try {
      await execFileAsync('/usr/bin/test', ['-x', candidate], { timeout: 2000 });
      return candidate;
    } catch {}
  }
  try {
    const { stdout } = await execFileAsync('/usr/bin/env', ['which', name], {
      timeout: 3000,
      env: { ...process.env, PATH: RUNTIME_PATH },
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function runCommand(executable, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(executable, args, {
    timeout: options.timeoutMs || 20 * 60 * 1000,
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
    env: { ...process.env, PATH: RUNTIME_PATH, ...(options.env || {}) },
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

function httpJSON(urlString, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const client = url.protocol === 'https:' ? null : http;
    if (!client) {
      reject(new Error(`Unsupported URL scheme ${url.protocol}`));
      return;
    }
    const request = client.get({
      hostname: url.hostname,
      port: url.port || 80,
      path: `${url.pathname}${url.search}`,
      timeout: timeoutMs,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body || '{}'));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('timeout'));
    });
    request.on('error', reject);
  });
}

function hasOpenAITtsKey(openClawInstallPath) {
  try {
    const cfg = JSON.parse(readFileSync(join(openClawInstallPath, 'openclaw.json'), 'utf8'));
    return !!cfg?.messages?.tts?.providers?.openai?.apiKey;
  } catch {
    return false;
  }
}

async function resolveTailscalePath() {
  const candidates = [
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  try {
    const { stdout } = await execFileAsync('/usr/bin/env', ['which', 'tailscale']);
    const resolved = stdout.trim();
    if (resolved) return resolved;
  } catch {}

  throw new Error('Tailscale CLI was not found. Install Tailscale, sign in, then reopen VoiceClaw Companion.');
}

async function detectTailscaleDNSName() {
  try {
    const tailscalePath = await resolveTailscalePath();
    const { stdout } = await execFileAsync(tailscalePath, ['status', '--json'], { timeout: 5000 });
    const status = JSON.parse(stdout);
    const dnsName = String(status?.Self?.DNSName || '').replace(/\.$/, '');
    return dnsName || '';
  } catch {
    return '';
  }
}

async function configureTailscaleServe(port) {
  const tailscalePath = await resolveTailscalePath();
  await execFileAsync(tailscalePath, [
    'serve',
    '--yes',
    '--bg',
    '--https',
    String(port),
    `http://127.0.0.1:${port}`,
  ], { timeout: 15000 });
}

async function readTailscaleServeStatus() {
  const tailscalePath = await resolveTailscalePath();
  const { stdout } = await execFileAsync(tailscalePath, ['serve', 'status', '--json'], { timeout: 5000 });
  return JSON.parse(stdout || '{}');
}

function describeServeMapping(status, port, localState = 'unknown') {
  const selectedPort = String(port);
  const expectedProxy = `http://127.0.0.1:${selectedPort}`;
  const web = status?.Web && typeof status.Web === 'object' ? status.Web : {};
  const webEntry = Object.entries(web).find(([hostPort]) => String(hostPort).endsWith(`:${selectedPort}`));

  if (!webEntry) {
    return {
      state: 'no_mapping',
      summary: `No Tailscale Serve mapping was found for HTTPS port ${selectedPort}.`,
      canClearSafely: false,
    };
  }

  const [hostPort, service] = webEntry;
  const handlers = service?.Handlers && typeof service.Handlers === 'object' ? service.Handlers : {};
  const handlerEntries = Object.entries(handlers);
  const rootProxy = handlers['/']?.Proxy || '';
  const onlyRootHandler = handlerEntries.length === 1 && Boolean(handlers['/']);
  const canClearSafely = onlyRootHandler && rootProxy === expectedProxy;

  if (canClearSafely && localState !== 'running') {
    return {
      state: 'stale_voiceclaw_mapping',
      summary: `Stale Voice.Claw mapping: ${hostPort} still forwards to ${expectedProxy}, but the local bridge is not running.`,
      canClearSafely: true,
      hostPort,
      proxy: rootProxy,
    };
  }

  if (canClearSafely) {
    return {
      state: 'voiceclaw_mapping',
      summary: `Active Voice.Claw mapping: ${hostPort} forwards to ${expectedProxy}.`,
      canClearSafely: true,
      hostPort,
      proxy: rootProxy,
    };
  }

  const handlerSummary = handlerEntries
    .map(([pathName, handler]) => `${pathName} -> ${handler?.Proxy || handler?.Path || handler?.Text || 'non-proxy handler'}`)
    .join('; ');

  return {
    state: 'occupied_by_other_mapping',
    summary: `HTTPS port ${selectedPort} already has a Tailscale Serve mapping, but it does not look like Voice.Claw. Voice.Claw will not remove it. Current mapping: ${hostPort} ${handlerSummary || '(no handlers listed)'}.`,
    canClearSafely: false,
    hostPort,
    proxy: rootProxy,
  };
}

async function removeVoiceClawTailscaleServe(port) {
  const status = await readTailscaleServeStatus();
  const mapping = describeServeMapping(status, port);
  if (mapping.state === 'no_mapping') return mapping;
  if (!mapping.canClearSafely) {
    throw new Error(mapping.summary);
  }

  const tailscalePath = await resolveTailscalePath();
  await execFileAsync(tailscalePath, [
    'serve',
    '--yes',
    '--bg',
    '--https',
    String(port),
    'off',
  ], { timeout: 15000 });

  return {
    ...mapping,
    removed: true,
    summary: `Removed Voice.Claw's Tailscale Serve mapping for HTTPS port ${port}.`,
  };
}

async function checkLocalBridge(port) {
  return new Promise((resolve) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/healthz',
      timeout: 3000,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          resolve({
            state: 'http_error',
            summary: `Local bridge answered with HTTP ${response.statusCode}.`,
          });
          return;
        }

        try {
          const parsed = JSON.parse(body || '{}');
          if (parsed.ok === true) {
            const authRequired = parsed.auth?.required === true;
            resolve({
              state: 'running',
              summary: `Running on localhost:${port}, ${authRequired ? 'auth on' : 'auth off'}.`,
              authRequired,
            });
            return;
          }
        } catch {}

        resolve({
          state: 'unexpected_response',
          summary: `Something is listening on localhost:${port}, but it is not returning the expected Voice.Claw health check.`,
        });
      });
    });

    request.on('timeout', () => {
      request.destroy();
      resolve({
        state: 'timeout',
        summary: `Timed out checking localhost:${port}.`,
      });
    });
    request.on('error', () => {
      resolve({
        state: 'not_running',
        summary: `No local bridge is running on localhost:${port}.`,
      });
    });
  });
}

async function pathAccessible(path, mode = constants.R_OK) {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

function statusItem({ id, label, state, summary, detail = '', action = '', path = '', installable = false }) {
  return {
    id,
    label,
    state,
    summary,
    detail,
    action,
    path,
    installable,
  };
}

async function checkLaunchAgentAccess(local = {}) {
  const launchAgentsDir = join(HOME, 'Library', 'LaunchAgents');
  const dirWritable = await pathAccessible(launchAgentsDir, constants.W_OK).catch(() => false);
  const plistExists = existsSync(LAUNCH_AGENT_FILE);
  let loaded = false;
  let printSummary = '';
  try {
    const target = `gui/${process.getuid()}/${LAUNCH_AGENT_LABEL}`;
    const { stdout } = await execFileAsync('launchctl', ['print', target], { timeout: 5000, maxBuffer: 256 * 1024 });
    loaded = true;
    printSummary = stdout.split('\n').slice(0, 12).join('\n');
  } catch (error) {
    printSummary = error?.message || String(error);
  }

  return {
    dirWritable,
    plistExists,
    loaded,
    summary: loaded
      ? `LaunchAgent ${LAUNCH_AGENT_LABEL} is loaded.`
      : `${plistExists ? 'LaunchAgent plist exists' : 'LaunchAgent plist is not installed'}, but launchctl does not report it loaded.`,
    detail: printSummary,
    localBridgeRunning: local?.state === 'running',
  };
}

async function checkOpenClawAccess(openClawInstallPath, openClawAgentName = DEFAULT_OPENCLAW_AGENT_NAME) {
  const openClawConfigPath = join(openClawInstallPath, 'openclaw.json');
  const configReadable = await pathAccessible(openClawConfigPath, constants.R_OK);
  let jsonReadable = false;
  let agentConfigured = false;
  let summary = configReadable
    ? `OpenClaw config is readable at ${openClawConfigPath}.`
    : `OpenClaw config is not readable at ${openClawConfigPath}.`;

  if (configReadable) {
    try {
      const parsed = parseOpenClawConfig(await readFile(openClawConfigPath, 'utf8'));
      jsonReadable = true;
      const agentConfig = configuredOpenClawAgentIDs(parsed);
      const normalizedSelected = normalizeOpenClawAgentID(openClawAgentName);
      const normalizedIDs = new Set(agentConfig.ids.map(normalizeOpenClawAgentID).filter(Boolean));
      const normalizedAliases = new Set(agentConfig.aliases.map(normalizeOpenClawAgentID).filter(Boolean));
      agentConfigured = normalizedIDs.size === 0
        || normalizedIDs.has(normalizedSelected)
        || normalizedAliases.has(normalizedSelected);
      summary = agentConfigured
        ? `OpenClaw config is readable; selected agent ${openClawAgentName} is configured.`
        : `OpenClaw config is readable, but selected agent ${openClawAgentName} was not found in configured agent ids${agentConfig.ids.length ? ` (${agentConfig.ids.join(', ')})` : ''}.`;
    } catch (error) {
      summary = `OpenClaw config exists but could not be parsed: ${error?.message || String(error)}`;
    }
  }

  return {
    configPath: openClawConfigPath,
    configReadable,
    jsonReadable,
    agentConfigured,
    summary,
  };
}

async function checkHermesAccess() {
  const hermesBin = process.env.HERMES_BIN || await resolveOptionalExecutable('hermes', '');
  const hermesHome = String(process.env.HERMES_HOME || join(HOME, '.hermes')).trim();
  const homeWritable = await pathAccessible(hermesHome, constants.W_OK);
  let commandSummary = hermesBin ? `Hermes command found at ${hermesBin}.` : 'Hermes command was not found in PATH or HERMES_BIN.';
  if (hermesBin) {
    try {
      await execFileAsync(hermesBin, ['--help'], { timeout: 5000, maxBuffer: 256 * 1024, env: { ...process.env, PATH: RUNTIME_PATH } });
    } catch (error) {
      commandSummary = `Hermes command exists but --help did not complete cleanly: ${error?.message || String(error)}`;
    }
  }

  return {
    bin: hermesBin || '',
    home: hermesHome,
    homeWritable,
    summary: `${commandSummary} Hermes home ${homeWritable ? 'is writable' : 'is not writable'} at ${hermesHome}.`,
  };
}

async function checkNetworkAccess(port, tailscale = {}) {
  const githubReachable = await new Promise((resolve) => {
    const request = http.get({
      hostname: 'api.github.com',
      path: '/',
      timeout: 4000,
      headers: { 'User-Agent': 'VoiceClawCompanion' },
    }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });

  const hfReachable = await new Promise((resolve) => {
    const request = http.get({
      hostname: 'huggingface.co',
      path: '/',
      timeout: 4000,
      headers: { 'User-Agent': 'VoiceClawCompanion' },
    }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });

  return {
    githubReachable,
    hfReachable,
    tailscaleReady: tailscale?.state === 'voiceclaw_mapping',
    summary: `Local port ${port}; GitHub ${githubReachable ? 'reachable' : 'not reachable'}; Hugging Face ${hfReachable ? 'reachable' : 'not reachable'}; Tailscale ${tailscale?.state || 'unknown'}.`,
  };
}

async function buildAccessDiagnostics({ port, local, tailscale, openClawInstallPath, openClawAgentName, companionVoice }) {
  const launchAgent = await checkLaunchAgentAccess(local);
  const openClaw = await checkOpenClawAccess(openClawInstallPath, openClawAgentName);
  const hermes = await checkHermesAccess();
  const network = await checkNetworkAccess(port, tailscale);
  const voiceclawDirWritable = await pathAccessible(CONFIG_DIR, constants.W_OK).catch(() => false);
  const logsDir = join(CONFIG_DIR, 'logs');
  const logsWritable = await pathAccessible(logsDir, constants.W_OK).catch(() => false);
  const hfCache = join(HOME, '.cache', 'huggingface', 'hub');
  const hfCacheWritable = await pathAccessible(hfCache, constants.W_OK).catch(() => false);

  const items = [
    statusItem({
      id: 'voiceclaw-config',
      label: 'VoiceClaw local data',
      state: voiceclawDirWritable ? 'ready' : 'needs_action',
      summary: voiceclawDirWritable ? `Writable at ${CONFIG_DIR}.` : `Not writable at ${CONFIG_DIR}.`,
      path: CONFIG_DIR,
      action: 'Open VoiceClaw Data',
    }),
    statusItem({
      id: 'voiceclaw-logs',
      label: 'VoiceClaw logs',
      state: logsWritable ? 'ready' : 'needs_action',
      summary: logsWritable ? `Writable at ${logsDir}.` : `Not writable at ${logsDir}.`,
      path: logsDir,
      action: 'Open VoiceClaw Data',
    }),
    statusItem({
      id: 'launch-agent',
      label: 'Bridge LaunchAgent',
      state: launchAgent.loaded && launchAgent.localBridgeRunning ? 'ready' : (launchAgent.dirWritable ? 'needs_action' : 'blocked'),
      summary: launchAgent.summary,
      detail: launchAgent.detail,
      path: LAUNCH_AGENT_FILE,
      action: 'Install and Start Bridge',
    }),
    statusItem({
      id: 'mac-login-item',
      label: 'App login item',
      state: 'manual',
      summary: 'The Companion can register itself to open at login, but macOS may still require approval in Login Items.',
      action: 'Open Login Items',
    }),
    statusItem({
      id: 'local-bridge',
      label: 'Local bridge',
      state: local?.state === 'running' ? 'ready' : 'needs_action',
      summary: local?.summary || 'Local bridge has not been checked.',
      action: 'Install and Start Bridge',
    }),
    statusItem({
      id: 'tailscale-serve',
      label: 'Tailscale private bridge',
      state: tailscale?.state === 'voiceclaw_mapping' ? 'ready' : 'needs_action',
      summary: tailscale?.summary || 'Tailscale Serve has not been checked.',
      action: 'Open Tailscale',
    }),
    statusItem({
      id: 'openclaw-config',
      label: 'OpenClaw folder',
      state: openClaw.configReadable && openClaw.jsonReadable && openClaw.agentConfigured ? 'ready' : 'needs_action',
      summary: openClaw.summary,
      path: openClaw.configPath,
      action: 'Choose OpenClaw Folder',
    }),
    statusItem({
      id: 'hermes-runtime',
      label: 'Hermes Agent runtime',
      state: hermes.bin && hermes.homeWritable ? 'ready' : 'manual',
      summary: hermes.summary,
      path: hermes.home,
      action: 'Open Hermes Home',
    }),
    statusItem({
      id: 'hf-runtime',
      label: 'HF speech-to-speech runtime',
      state: companionVoice?.state === 'ready' ? 'ready' : 'needs_action',
      summary: companionVoice?.summary || 'HF speech-to-speech runtime has not been checked.',
      action: companionVoice?.state === 'ready' ? 'Verify Everything' : 'Install Voice Dependencies',
      installable: companionVoice?.state !== 'ready',
    }),
    statusItem({
      id: 'hf-cache',
      label: 'HF model cache',
      state: hfCacheWritable ? 'ready' : 'needs_action',
      summary: hfCacheWritable ? `Writable at ${hfCache}.` : `Not writable at ${hfCache}; model downloads may fail.`,
      path: hfCache,
      action: 'Open HF Model Cache',
    }),
    statusItem({
      id: 'network-downloads',
      label: 'Installer network access',
      state: network.githubReachable && network.hfReachable ? 'ready' : 'needs_action',
      summary: network.summary,
      action: 'Verify Everything',
    }),
    statusItem({
      id: 'protected-files',
      label: 'Protected file access',
      state: 'manual',
      summary: 'If an OpenClaw or Hermes task needs Desktop, Documents, Downloads, or broad project folders, grant Files and Folders or Full Disk Access before the task starts.',
      action: 'Open Files and Folders',
    }),
    statusItem({
      id: 'microphone',
      label: 'Microphone access',
      state: 'manual',
      summary: 'Grant microphone access up front if you use local Mac audio diagnostics or future Mac-side voice capture. iPhone voice sessions still stream the phone microphone through the bridge.',
      action: 'Open Microphone Settings',
    }),
  ];

  const readyCount = items.filter((item) => item.state === 'ready').length;
  const manualCount = items.filter((item) => item.state === 'manual').length;
  const blockedCount = items.filter((item) => item.state === 'blocked' || item.state === 'needs_action').length;
  return {
    state: blockedCount === 0 ? 'ready' : 'needs_action',
    summary: `${readyCount}/${items.length} access checks are ready; ${blockedCount} need action and ${manualCount} may require manual macOS approval.`,
    items,
    launchAgent,
    openClaw,
    hermes,
    network,
  };
}

function collectTailscalePorts(status) {
  const ports = new Set();
  for (const port of Object.keys(status?.TCP || {})) {
    const numeric = Number(port);
    if (Number.isInteger(numeric)) ports.add(numeric);
  }
  for (const hostPort of Object.keys(status?.Web || {})) {
    const match = String(hostPort).match(/:(\d+)$/);
    if (match) ports.add(Number(match[1]));
  }
  return ports;
}

async function isLocalPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function suggestFreshPort() {
  let tailscalePorts = new Set();
  try {
    tailscalePorts = collectTailscalePorts(await readTailscaleServeStatus());
  } catch {}

  const min = 10000;
  const max = 49151;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const port = min + Math.floor(Math.random() * (max - min + 1));
    if (tailscalePorts.has(port)) continue;
    if (await isLocalPortAvailable(port)) return port;
  }

  for (let port = min; port <= max; port += 1) {
    if (tailscalePorts.has(port)) continue;
    if (await isLocalPortAvailable(port)) return port;
  }

  throw new Error('Could not find an unused local test port.');
}

async function checkCompanionVoiceDependencies(openClawInstallPath) {
  const hfRealtime = await getHFRealtimeStatus().catch((error) => ({
    state: 'error',
    summary: `HF speech-to-speech runtime check failed: ${error?.message || String(error)}`,
    installPlan: {
      needed: true,
      installable: true,
      items: [{
        id: 'hf-speech-to-speech-runtime',
        label: 'HF speech-to-speech runtime',
        detail: 'Installs the OpenAI Realtime-compatible Hugging Face VAD -> STT -> LLM -> TTS pipeline.',
        installable: true,
        command: 'install HF speech-to-speech runtime',
      }],
    },
  }));
  const hfReady = hfRealtime.state === 'ready';
  const ffmpegPath = await resolveOptionalExecutable('ffmpeg', process.env.FFMPEG_BIN || '');
  const whisperPath = await resolveOptionalExecutable('whisper-cli', process.env.WHISPER_CLI || '');
  const whisperSmallModel = join(HOME, '.openclaw', 'models', 'ggml-small.bin');
  const whisperMediumModel = join(HOME, '.openclaw', 'models', 'ggml-medium.bin');
  const configuredWhisperModel = process.env.WHISPER_MODEL || '';
  const whisperModelPath = configuredWhisperModel
    || (existsSync(whisperSmallModel) ? whisperSmallModel : whisperMediumModel);
  const whisperModelReady = existsSync(whisperModelPath);
  const sttReady = !!ffmpegPath && !!whisperPath && whisperModelReady;

  let ollamaState = 'not_reachable';
  let ollamaSummary = `Ollama is not reachable at ${OLLAMA_BASE_URL}. Install/open Ollama and run: ollama pull ${DEFAULT_QWEN_MODEL}.`;
  let qwenReady = false;
  try {
    const tags = await httpJSON(`${OLLAMA_BASE_URL.replace(/\/+$/g, '')}/api/tags`, { timeoutMs: 3500 });
    const models = Array.isArray(tags?.models) ? tags.models : [];
    const names = models.flatMap((model) => [model?.name, model?.model]).filter(Boolean);
    qwenReady = names.some((name) => name === DEFAULT_QWEN_MODEL || name === `${DEFAULT_QWEN_MODEL}:latest`);
    ollamaState = qwenReady ? 'ready' : 'missing_model';
    ollamaSummary = qwenReady
      ? `Ollama is running and ${DEFAULT_QWEN_MODEL} is installed.`
      : `Ollama is running, but ${DEFAULT_QWEN_MODEL} is not installed. Run: ollama pull ${DEFAULT_QWEN_MODEL}.`;
  } catch {}

  const piperRyanModel = join(HOME, '.openclaw', 'models', 'piper', 'en_US-ryan-high.onnx');
  const piperLibriModel = join(HOME, '.openclaw', 'models', 'piper', 'en_US-libritts-high.onnx');
  const sayPath = await resolveOptionalExecutable('say', process.env.SAY_BIN || '');
  const brewPath = await resolveOptionalExecutable('brew', process.env.BREW_BIN || '');
  const ollamaPath = await resolveOptionalExecutable('ollama', process.env.OLLAMA_BIN || '');
  const ttsReady = hasOpenAITtsKey(openClawInstallPath) || existsSync(piperRyanModel) || existsSync(piperLibriModel) || !!sayPath;
  const missing = [];
  if (!hfReady) missing.push('HF speech-to-speech runtime');
  const legacyMissing = [];
  if (!ffmpegPath) legacyMissing.push('ffmpeg');
  if (!whisperPath) legacyMissing.push('whisper-cli');
  if (!whisperModelReady) legacyMissing.push(`Whisper model at ${whisperModelPath}`);
  if (!qwenReady) legacyMissing.push(DEFAULT_QWEN_MODEL);
  if (!ttsReady) legacyMissing.push('TTS voice: OpenAI TTS key, Piper model, or macOS say');

  const result = {
    state: hfReady ? 'ready' : 'needs_setup',
    summary: hfReady
      ? `Companion Realtime Voice is ready: HF speech-to-speech runtime and selected STT profile${hfRealtime?.sttProfileLabel ? ` (${hfRealtime.sttProfileLabel})` : ''} are ready.`
      : `Companion Realtime Voice needs setup: ${missing.join(', ')}.`,
    hfRealtime,
    legacy: {
      state: sttReady && qwenReady && ttsReady ? 'ready' : 'needs_setup',
      summary: sttReady && qwenReady && ttsReady
        ? `Legacy Companion turn upload path is ready: STT, ${DEFAULT_QWEN_MODEL}, and TTS are available.`
        : `Legacy Companion turn upload path needs setup: ${legacyMissing.join(', ')}. ${ollamaSummary}`,
    },
    stt: {
      ready: sttReady,
      ffmpeg: ffmpegPath || '',
      whisperCli: whisperPath || '',
      whisperModel: whisperModelReady ? whisperModelPath : '',
      missingWhisperModel: whisperModelReady ? '' : whisperModelPath,
    },
    middleBrain: {
      defaultMode: 'qwen3.5-2b',
      qwenModel: DEFAULT_QWEN_MODEL,
      ollamaBaseURL: OLLAMA_BASE_URL,
      ollamaState,
      ready: qwenReady,
      summary: ollamaSummary,
    },
    tts: {
      ready: ttsReady,
      openaiConfigured: hasOpenAITtsKey(openClawInstallPath),
      piperRyanModel: existsSync(piperRyanModel) ? piperRyanModel : '',
      piperLibriModel: existsSync(piperLibriModel) ? piperLibriModel : '',
      say: sayPath || '',
    },
  };
  result.installPlan = buildCompanionVoiceInstallPlan({
    hfRealtime,
    ffmpegPath,
    whisperPath,
    whisperModelReady,
    whisperModelPath,
    qwenReady,
    ollamaPath,
    ollamaState,
    ttsReady,
    brewPath,
  });
  return result;
}

function buildCompanionVoiceInstallPlan({
  hfRealtime,
  ffmpegPath,
  whisperPath,
  whisperModelReady,
  whisperModelPath,
  qwenReady,
  ollamaPath,
  ollamaState,
  ttsReady,
  brewPath,
}) {
  const items = [];
  const brewAvailable = !!brewPath;
  if (hfRealtime?.state !== 'ready') {
    const hfItems = Array.isArray(hfRealtime?.installPlan?.items) ? hfRealtime.installPlan.items : [];
    if (hfItems.length) {
      items.push(...hfItems);
    } else {
      items.push({
        id: 'hf-speech-to-speech-runtime',
        label: 'HF speech-to-speech runtime',
        detail: 'Installs the OpenAI Realtime-compatible Hugging Face VAD -> STT -> LLM -> TTS pipeline.',
        installable: true,
        command: 'install HF speech-to-speech runtime',
      });
    }
  }
  const hfInstallableCount = items.filter((item) => item.installable).length;
  return {
    needed: items.length > 0,
    brewAvailable,
    installableCount: hfInstallableCount,
    summary: items.length
      ? `${items.length} Companion Realtime Voice dependency item${items.length === 1 ? '' : 's'} need attention; ${hfInstallableCount} can be installed automatically.`
      : 'No Companion Realtime Voice dependencies need installation.',
    items,
  };
}

async function downloadFile(url, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await runCommand('/usr/bin/curl', ['-L', '--fail', '--retry', '3', '--output', destination, url], {
    timeoutMs: 30 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function waitForOllama(timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await httpJSON(`${OLLAMA_BASE_URL.replace(/\/+$/g, '')}/api/tags`, { timeoutMs: 1500 });
      return true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 750));
    }
  }
  return false;
}

async function ensureOllamaReachable(brewPath = '') {
  if (await waitForOllama(2500)) return true;
  if (brewPath) {
    await runCommand(brewPath, ['services', 'start', 'ollama'], { timeoutMs: 60_000 }).catch(() => {});
    if (await waitForOllama(12_000)) return true;
  }
  if (existsSync('/Applications/Ollama.app')) {
    await runCommand('/usr/bin/open', ['-a', 'Ollama'], { timeoutMs: 10_000 }).catch(() => {});
    if (await waitForOllama(12_000)) return true;
  }
  return false;
}

async function installCompanionVoiceDependencies(openClawInstallPath) {
  const before = await checkCompanionVoiceDependencies(openClawInstallPath);
  const items = before.installPlan?.items || [];
  const installed = [];
  const skipped = [];
  const failures = [];
  let brewPath = await resolveOptionalExecutable('brew', process.env.BREW_BIN || '');

  for (const item of items) {
    if (!item.installable) {
      skipped.push({ id: item.id, label: item.label, reason: 'not_installable' });
      continue;
    }
    try {
      if (item.id === 'hf-speech-to-speech-runtime'
          || item.id === 'stt-parakeet-tdt'
          || item.id === 'tts-qwen3'
          || item.id === 'middle-qwen35-2b-local'
          || item.id === 'middle-qwen3-local') {
        await installHFRealtimeRuntime();
      } else if (item.id === 'ffmpeg') {
        if (!brewPath) throw new Error('Homebrew is required to install ffmpeg automatically.');
        await runCommand(brewPath, ['install', 'ffmpeg']);
      } else if (item.id === 'whisper-cli') {
        if (!brewPath) throw new Error('Homebrew is required to install whisper-cpp automatically.');
        await runCommand(brewPath, ['install', 'whisper-cpp']);
      } else if (item.id === 'whisper-model-small') {
        await downloadFile(
          'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
          join(HOME, '.openclaw', 'models', 'ggml-small.bin')
        );
      } else if (item.id === 'ollama') {
        if (!brewPath) throw new Error('Homebrew is required to install Ollama automatically.');
        await runCommand(brewPath, ['install', 'ollama']);
        await ensureOllamaReachable(brewPath);
        brewPath = await resolveOptionalExecutable('brew', process.env.BREW_BIN || '');
      } else if (item.id === 'qwen3.5-2b') {
        let ollamaPath = await resolveOptionalExecutable('ollama', process.env.OLLAMA_BIN || '');
        if (!ollamaPath && brewPath) {
          await runCommand(brewPath, ['install', 'ollama']);
          ollamaPath = await resolveOptionalExecutable('ollama', process.env.OLLAMA_BIN || '');
        }
        if (!ollamaPath) throw new Error('Ollama is required before pulling the local Companion Realtime Voice LLM model.');
        const reachable = await ensureOllamaReachable(brewPath);
        if (!reachable) throw new Error(`Ollama is installed, but ${OLLAMA_BASE_URL} did not become reachable.`);
        await runCommand(ollamaPath, ['pull', DEFAULT_QWEN_MODEL], { timeoutMs: 60 * 60 * 1000 });
      }
      installed.push({ id: item.id, label: item.label });
    } catch (error) {
      failures.push({ id: item.id, label: item.label, error: error?.message || String(error) });
    }
  }

  const diagnostics = await checkCompanionVoiceDependencies(openClawInstallPath);
  return {
    ok: failures.length === 0,
    installed,
    skipped,
    failures,
    diagnostics,
  };
}

async function diagnoseBridge(port) {
  const existing = await readBridgeConfig();
  const openClawInstallPath = normalizeInstallPath(existing.openClawInstallPath);
  const openClawAgentName = normalizeOpenClawAgentName(existing.openClawAgentName || existing.openClawAgent || DEFAULT_OPENCLAW_AGENT_NAME);
  const local = await checkLocalBridge(port);
  let tailscale;

  try {
    tailscale = describeServeMapping(await readTailscaleServeStatus(), port, local.state);
  } catch (error) {
    tailscale = {
      state: 'not_available',
      summary: `Tailscale Serve status is not available. Install Tailscale, sign in, and enable HTTPS certificates if setup asks for them. Detail: ${error?.message || String(error)}`,
      canClearSafely: false,
    };
  }

  let suggestedAction = 'Click Install and Start to install the bridge and configure Tailscale Serve for this port.';
  if (local.state === 'running' && tailscale.state === 'voiceclaw_mapping') {
    suggestedAction = 'This port is ready. Pair the phone with the current QR code or setup link.';
  } else if (local.state !== 'running' && tailscale.state === 'stale_voiceclaw_mapping') {
    suggestedAction = 'This is a stale network mapping. Click Install and Start to reuse it, or use Reset App + Tailscale Mapping to remove it before testing first-run setup.';
  } else if (local.state === 'running' && tailscale.state === 'no_mapping') {
    suggestedAction = 'The bridge is running locally only. Click Install and Start to publish it through Tailscale Serve, then pair the phone again.';
  } else if (tailscale.state === 'occupied_by_other_mapping') {
    suggestedAction = 'Choose a different port or manually review this Tailscale Serve mapping outside Voice.Claw. The app will not remove mappings it cannot identify as its own.';
  }

  const companionVoice = await checkCompanionVoiceDependencies(openClawInstallPath);
  const access = await buildAccessDiagnostics({
    port,
    local,
    tailscale,
    openClawInstallPath,
    openClawAgentName,
    companionVoice,
  });

  return {
    port,
    savedConfigExists: existsSync(CONFIG_FILE),
    local,
    tailscale,
    companionVoice,
    access,
    suggestedAction,
  };
}

function validateOpenClawInstallPath(openClawInstallPath) {
  const openClawConfigPath = join(openClawInstallPath, 'openclaw.json');
  if (!existsSync(openClawConfigPath)) {
    throw new Error(`OpenClaw config was not found at ${openClawConfigPath}. Choose the folder that contains openclaw.json, usually ~/.openclaw.`);
  }
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function installLaunchAgent(config) {
  const nodePath = await resolveNodePath();
  const openClawConfigPath = join(config.openClawInstallPath, 'openclaw.json');
  const logDir = join(CONFIG_DIR, 'logs');
  const launchWorkingDir = join(CONFIG_DIR, 'runtime');
  const runtimeEntryPoint = join(PROJECT_ROOT, 'server', 'index.js');
  await mkdir(join(HOME, 'Library', 'LaunchAgents'), { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(launchWorkingDir, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(runtimeEntryPoint)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(launchWorkingDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>VB_PORT</key>
    <string>${xmlEscape(config.port)}</string>
    <key>VB_BIND_HOST</key>
    <string>127.0.0.1</string>
    <key>VOICECLAW_BRIDGE_TOKEN</key>
    <string>${xmlEscape(config.gatewayToken)}</string>
    <key>OPENCLAW_CONFIG</key>
    <string>${xmlEscape(openClawConfigPath)}</string>
    <key>OPENCLAW_INSTALL_PATH</key>
    <string>${xmlEscape(config.openClawInstallPath)}</string>
    <key>INTERCOM_AGENT</key>
    <string>${xmlEscape(config.openClawAgentName)}</string>
    <key>OPENCLAW_AGENT</key>
    <string>${xmlEscape(config.openClawAgentName)}</string>
    <key>REALTIME_LOG_DIR</key>
    <string>${xmlEscape(logDir)}</string>
    <key>PATH</key>
    <string>${xmlEscape(RUNTIME_PATH)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logDir, 'bridge.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logDir, 'bridge.err.log'))}</string>
</dict>
</plist>
`;

  await writeFile(LAUNCH_AGENT_FILE, plist, { mode: 0o600 });
}

async function startLaunchAgent() {
  const target = `gui/${process.getuid()}`;
  await execFileAsync('launchctl', ['bootout', target, LAUNCH_AGENT_FILE]).catch(() => {});
  await execFileAsync('launchctl', ['bootstrap', target, LAUNCH_AGENT_FILE], { timeout: 10000 });
  await execFileAsync('launchctl', ['kickstart', '-k', `${target}/${LAUNCH_AGENT_LABEL}`], { timeout: 10000 }).catch(() => {});
}

async function resetBridgeState({ resetTailscalePort = false, port } = {}) {
  const tailscaleReset = resetTailscalePort ? await removeVoiceClawTailscaleServe(port) : null;
  const target = `gui/${process.getuid()}`;
  await execFileAsync('launchctl', ['bootout', target, LAUNCH_AGENT_FILE]).catch(() => {});
  await rm(LAUNCH_AGENT_FILE, { force: true }).catch(() => {});
  await rm(CONFIG_FILE, { force: true }).catch(() => {});
  return { tailscaleReset };
}

function buildPairingPayload(config) {
  return {
    VoiceClawSetupVersion: 1,
    TailscaleBaseURL: config.tailscaleBaseURL,
    BridgePath: '/realtime/openclaw-turn',
    OpenClawInstallPath: config.openClawInstallPath,
    OpenClawAgent: config.openClawAgentName,
    OpenClawGatewayToken: config.gatewayToken,
    RouteMode: 'openclaw-bridge',
    RealtimeModel: 'gpt-realtime-2',
    RealtimeAuthMode: config.realtimeAuthMode,
    RealtimeAuthFallbackToAPIKey: config.realtimeAuthFallbackToAPIKey,
  };
}

function printSummary(config, pairingPayload, actions) {
  console.log('VoiceClaw Companion setup ready.');
  console.log(`Config: ${CONFIG_FILE}`);
  console.log(`LaunchAgent: ${LAUNCH_AGENT_FILE}`);
  console.log(`Bridge URL: ${config.tailscaleBaseURL || '(Tailscale DNS unavailable)'}`);
  console.log(`OpenClaw path: ${config.openClawInstallPath}`);
  console.log(`OpenClaw agent: ${config.openClawAgentName}`);
  console.log(`Token: ${config.gatewayToken ? 'generated' : 'missing'}`);
  for (const action of actions) console.log(`- ${action}`);
  console.log('\nPaste this setup JSON into VoiceClaw Settings, or show it as a QR code from the Mac companion:\n');
  console.log(JSON.stringify(pairingPayload, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.suggestPort) {
    const suggestedPort = await suggestFreshPort();
    console.log(JSON.stringify({ ok: true, suggestedPort }, null, 2));
    return;
  }

  if (options.diagnose) {
    const existing = await readBridgeConfig();
    const diagnostics = await diagnoseBridge(options.port || existing.port || DEFAULT_BRIDGE_PORT);
    console.log(JSON.stringify(diagnostics, null, 2));
    return;
  }

  if (options.installCompanionVoiceDependencies) {
    const existing = await readBridgeConfig();
    const openClawInstallPath = normalizeInstallPath(options.openClawInstallPath || existing.openClawInstallPath);
    const result = await installCompanionVoiceDependencies(openClawInstallPath);
    if (options.jsonOnly) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.diagnostics?.companionVoice?.summary || result.diagnostics?.summary || 'Companion Realtime Voice dependency install completed.');
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (options.reset) {
    const existing = await readBridgeConfig();
    const resetPort = options.port || existing.port || DEFAULT_BRIDGE_PORT;
    const result = await resetBridgeState({
      resetTailscalePort: options.resetTailscalePort,
      port: resetPort,
    });
    if (options.jsonOnly) {
      console.log(JSON.stringify({ ok: true, reset: true, ...result }, null, 2));
    } else {
      const suffix = result.tailscaleReset?.removed ? ` Removed Tailscale Serve port ${resetPort}.` : ' Tailscale, OpenClaw, and Node.js were not modified.';
      console.log(`VoiceClaw companion state reset.${suffix}`);
    }
    return;
  }

  const existing = await readBridgeConfig();
  const dnsName = await detectTailscaleDNSName();
  const port = options.port || existing.port || DEFAULT_BRIDGE_PORT;
  const openClawInstallPath = normalizeInstallPath(options.openClawInstallPath || existing.openClawInstallPath);
  const openClawAgentName = normalizeOpenClawAgentName(options.openClawAgentName || existing.openClawAgentName || existing.openClawAgent);
  validateOpenClawInstallPath(openClawInstallPath);
  const config = {
    port,
    openClawInstallPath,
    openClawAgentName,
    gatewayToken: existing.gatewayToken || generateToken(),
    tailscaleDNSName: dnsName || existing.tailscaleDNSName || '',
    realtimeAuthMode: normalizeRealtimeAuthMode(options.realtimeAuthMode || existing.realtimeAuthMode || 'openclaw-oauth'),
    realtimeAuthFallbackToAPIKey: options.realtimeAuthFallbackToAPIKey ?? existing.realtimeAuthFallbackToAPIKey ?? false,
    cerebrasAPIKey: existing.cerebrasAPIKey || '',
  };
  config.tailscaleBaseURL = config.tailscaleDNSName ? `https://${config.tailscaleDNSName}:${config.port}` : (existing.tailscaleBaseURL || '');

  await writeBridgeConfig(config);

  const actions = [];
  if (options.installLaunchAgent) {
    await installLaunchAgent(config);
    actions.push('Installed launch agent.');
  }
  if (options.start) {
    await startLaunchAgent();
    actions.push('Started launch agent.');
  }
  if (options.configureTailscale) {
    await configureTailscaleServe(config.port);
    actions.push(`Configured Tailscale Serve on HTTPS port ${config.port}.`);
  }

  const pairingPayload = buildPairingPayload(config);
  if (options.jsonOnly) {
    console.log(JSON.stringify(pairingPayload, null, 2));
    return;
  }

  printSummary(config, pairingPayload, actions);
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
