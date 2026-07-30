import assert from 'node:assert/strict';
import test from 'node:test';

import { environmentFromConfig } from './bridge-entry.mjs';

test('maps protected bridge config into the existing runtime environment', () => {
  assert.deepEqual(environmentFromConfig({
    port: 12321,
    gatewayToken: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    openClawInstallPath: '/home/tester/.openclaw',
    openClawAgentName: 'main',
  }, {
    configFile: '/home/tester/.voiceclaw/bridge.json',
    dataDir: '/home/tester/.local/share/voiceclaw-companion',
    cacheDir: '/home/tester/.cache/voiceclaw-companion',
    home: '/home/tester',
  }), {
    VB_PORT: '12321',
    VB_BIND_HOST: '127.0.0.1',
    VOICECLAW_BRIDGE_TOKEN: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    VOICECLAW_CONFIG_PATH: '/home/tester/.voiceclaw/bridge.json',
    VOICECLAW_CONFIG: '/home/tester/.voiceclaw/bridge.json',
    VOICECLAW_APP_SUPPORT_DIR: '/home/tester/.local/share/voiceclaw-companion',
    VOICECLAW_CACHE_DIR: '/home/tester/.cache/voiceclaw-companion',
    REALTIME_LOG_DIR: '/home/tester/.local/share/voiceclaw-companion/logs',
    OPENCLAW_CONFIG: '/home/tester/.openclaw/openclaw.json',
    OPENCLAW_INSTALL_PATH: '/home/tester/.openclaw',
    INTERCOM_AGENT: 'main',
    OPENCLAW_AGENT: 'main',
    VOICECLAW_POWERHOUSE_BOOT_PREWARM: 'false',
    COMPANION_VOICE_QWEN_PREWARM: 'false',
    COMPANION_VOICE_TTS_PREWARM: 'false',
    COMPANION_VOICE_HF_PREWARM: 'false',
    COMPANION_VOICE_HF_KEEPHOT: 'false',
  });
});
