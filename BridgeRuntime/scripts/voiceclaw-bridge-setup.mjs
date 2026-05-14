#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const HOME = process.env.HOME || '';
const CONFIG_DIR = join(HOME, '.voiceclaw');
const CONFIG_FILE = join(CONFIG_DIR, 'bridge.json');
const LAUNCH_AGENT_LABEL = 'ai.voiceclaw.bridge';
const LAUNCH_AGENT_FILE = join(HOME, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);

function parseArgs(argv) {
  const options = {
    installLaunchAgent: false,
    start: false,
    configureTailscale: false,
    jsonOnly: false,
    reset: false,
    port: 3191,
    openClawInstallPath: join(HOME, '.openclaw'),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--install-launch-agent' || arg === '--install') options.installLaunchAgent = true;
    else if (arg === '--start') options.start = true;
    else if (arg === '--configure-tailscale' || arg === '--tailscale') options.configureTailscale = true;
    else if (arg === '--json') options.jsonOnly = true;
    else if (arg === '--reset') options.reset = true;
    else if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
    else if (arg === '--openclaw-path') options.openClawInstallPath = argv[++index] || options.openClawInstallPath;
    else if (arg.startsWith('--openclaw-path=')) options.openClawInstallPath = arg.slice('--openclaw-path='.length);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    throw new Error(`Invalid port: ${options.port}. Choose a port from 1024 to 65535.`);
  }

  return options;
}

function printHelp() {
  console.log(`VoiceClaw Bridge setup

Usage:
  node scripts/voiceclaw-bridge-setup.mjs [options]

Options:
  --install-launch-agent     Install ~/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist
  --start                    Start or restart the launch agent after installing it
  --configure-tailscale      Run tailscale serve for the configured bridge port
  --reset                    Stop Voice.Claw LaunchAgent and remove Voice.Claw bridge config
  --json                     Print only the iPhone setup JSON
  --port 3191                Bridge/Tailscale HTTPS port
  --openclaw-path PATH       OpenClaw install/config folder, usually ~/.openclaw

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

  throw new Error('Tailscale CLI was not found. Install Tailscale, sign in, then reopen Voice.Claw Companion.');
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
  await mkdir(join(HOME, 'Library', 'LaunchAgents'), { recursive: true });
  await mkdir(logDir, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>server/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(PROJECT_ROOT)}</string>
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

async function resetBridgeState() {
  const target = `gui/${process.getuid()}`;
  await execFileAsync('launchctl', ['bootout', target, LAUNCH_AGENT_FILE]).catch(() => {});
  await rm(LAUNCH_AGENT_FILE, { force: true }).catch(() => {});
  await rm(CONFIG_FILE, { force: true }).catch(() => {});
}

function buildPairingPayload(config) {
  return {
    VoiceClawSetupVersion: 1,
    TailscaleBaseURL: config.tailscaleBaseURL,
    BridgePath: '/realtime/openclaw-turn',
    OpenClawInstallPath: config.openClawInstallPath,
    OpenClawGatewayToken: config.gatewayToken,
    RouteMode: 'openclaw-bridge',
    RealtimeModel: 'gpt-realtime-2',
  };
}

function printSummary(config, pairingPayload, actions) {
  console.log('VoiceClaw Bridge setup ready.');
  console.log(`Config: ${CONFIG_FILE}`);
  console.log(`LaunchAgent: ${LAUNCH_AGENT_FILE}`);
  console.log(`Bridge URL: ${config.tailscaleBaseURL || '(Tailscale DNS unavailable)'}`);
  console.log(`OpenClaw path: ${config.openClawInstallPath}`);
  console.log(`Token: ${config.gatewayToken ? 'generated' : 'missing'}`);
  for (const action of actions) console.log(`- ${action}`);
  console.log('\nPaste this setup JSON into VoiceClaw Settings, or show it as a QR code from the Mac companion:\n');
  console.log(JSON.stringify(pairingPayload, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.reset) {
    await resetBridgeState();
    if (options.jsonOnly) {
      console.log(JSON.stringify({ ok: true, reset: true }, null, 2));
    } else {
      console.log('Voice.Claw bridge state reset. Tailscale, OpenClaw, and Node.js were not modified.');
    }
    return;
  }

  const existing = await readBridgeConfig();
  const dnsName = await detectTailscaleDNSName();
  const port = options.port || existing.port || 3191;
  const openClawInstallPath = normalizeInstallPath(options.openClawInstallPath || existing.openClawInstallPath);
  validateOpenClawInstallPath(openClawInstallPath);
  const config = {
    port,
    openClawInstallPath,
    gatewayToken: existing.gatewayToken || generateToken(),
    tailscaleDNSName: dnsName || existing.tailscaleDNSName || '',
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
