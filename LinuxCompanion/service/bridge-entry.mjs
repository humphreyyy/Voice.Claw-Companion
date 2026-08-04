import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function requiredAbsolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || CONTROL_CHARACTER.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

export function environmentFromConfig(config, paths) {
  const port = Number(config?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Bridge port is invalid.');
  }
  if (typeof config?.gatewayToken !== 'string' || !TOKEN_PATTERN.test(config.gatewayToken)) {
    throw new Error('Bridge gateway token is invalid.');
  }
  const openClawInstallPath = requiredAbsolutePath(
    config?.openClawInstallPath,
    'OpenClaw install path',
  );
  const agent = typeof config?.openClawAgentName === 'string'
    ? config.openClawAgentName.trim()
    : '';
  if (agent.length === 0 || agent.length > 128 || CONTROL_CHARACTER.test(agent)) {
    throw new Error('OpenClaw agent is invalid.');
  }

  const configFile = requiredAbsolutePath(paths?.configFile, 'Config path');
  const dataDir = requiredAbsolutePath(paths?.dataDir, 'Data path');
  const cacheDir = requiredAbsolutePath(paths?.cacheDir, 'Cache path');

  return {
    VB_PORT: String(port),
    VB_BIND_HOST: '127.0.0.1',
    VB_BASE_PATH: typeof config?.basePath === 'string' ? config.basePath : '',
    VOICECLAW_BRIDGE_TOKEN: config.gatewayToken,
    VOICECLAW_CONFIG_PATH: configFile,
    VOICECLAW_CONFIG: configFile,
    VOICECLAW_APP_SUPPORT_DIR: dataDir,
    VOICECLAW_CACHE_DIR: cacheDir,
    REALTIME_LOG_DIR: join(dataDir, 'logs'),
    OPENCLAW_CONFIG: join(openClawInstallPath, 'openclaw.json'),
    OPENCLAW_INSTALL_PATH: openClawInstallPath,
    INTERCOM_AGENT: agent,
    OPENCLAW_AGENT: agent,
    VOICECLAW_POWERHOUSE_BOOT_PREWARM: 'false',
    COMPANION_VOICE_QWEN_PREWARM: 'false',
    COMPANION_VOICE_TTS_PREWARM: 'false',
    COMPANION_VOICE_HF_PREWARM: 'false',
    COMPANION_VOICE_HF_KEEPHOT: 'false',
  };
}

async function startBridge() {
  const configFile = requiredAbsolutePath(
    process.env.VOICECLAW_CONFIG_PATH,
    'Config path',
  );
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const home = homedir();
  const dataDir = process.env.VOICECLAW_APP_SUPPORT_DIR
    || join(home, '.local', 'share', 'voiceclaw-companion');
  const cacheDir = process.env.VOICECLAW_CACHE_DIR
    || join(home, '.cache', 'voiceclaw-companion');
  Object.assign(process.env, environmentFromConfig(config, {
    configFile,
    dataDir,
    cacheDir,
    home,
  }));

  const preferredPath = [
    join(home, '.local', 'bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  process.env.PATH = [...preferredPath, process.env.PATH || '']
    .filter(Boolean)
    .join(':');

  await import('../BridgeRuntime/server/index.js');
}

const invokedModule = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedModule) {
  startBridge().catch((error) => {
    console.error(`[voiceclaw-service] ${error instanceof Error ? error.message : 'Bridge startup failed.'}`);
    process.exitCode = 1;
  });
}
