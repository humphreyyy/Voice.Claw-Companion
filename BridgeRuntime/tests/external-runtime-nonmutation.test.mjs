import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = async (path) => await readFile(new URL(path, import.meta.url), 'utf8');

test('OAuth import and refresh never mutate OpenClaw auth stores', async () => {
  const auth = await source('../server/realtime-auth.js');
  for (const forbidden of [
    /writeFile\(candidate\.storePath/,
    /runSqliteScript/,
    /update\s+auth_profile_store/i,
    /resolveProviderAuthProfileApiKey/,
    /provider-auth\.js/,
  ]) {
    assert.doesNotMatch(auth, forbidden);
  }
  assert.match(auth, /persistOpenAIChatGPTOAuthBridgeConfig\(refreshed\)/);
  assert.match(auth, /OpenClaw stores are import sources only/);
});

test('dependency installation writes VoiceClaw-owned models, not OpenClaw installation data', async () => {
  const setup = await source('../scripts/voiceclaw-bridge-setup.mjs');
  const whisperInstall = setup.slice(
    setup.indexOf("item.id === 'whisper-model-small'"),
    setup.indexOf("item.id === 'ollama'"),
  );
  assert.match(whisperInstall, /VOICECLAW_MODEL_DIR/);
  assert.doesNotMatch(whisperInstall, /\.openclaw/);
});

test('Companion source contains no configuration CLI mutation for external agent runtimes', async () => {
  const dialogue = await source('../server/dialogue.js');
  const codex = await source('../server/codex-app-server.js');

  assert.match(dialogue, /runOpenclawTurn\(\[\s*'agent'/);
  assert.doesNotMatch(
    dialogue,
    /runOpenclawTurn\(\[\s*['"](?:config|update|install|uninstall|models?\s+auth)['"]/i,
  );
  assert.match(dialogue, /const args = \[\s*'chat'/);
  assert.doesNotMatch(
    dialogue,
    /execFileRunner\(HERMES_BIN,\s*\[\s*['"](?:config|update|install|uninstall)['"]/i,
  );
  assert.match(codex, /codexAppServerSpawnArguments\(environment\)/);
  assert.match(codex, /argumentsList\.push\('app-server', '--stdio'\)/);
  assert.match(
    codex,
    /mcp_servers\.node_repl\.env\.SKY_CUA_NATIVE_PIPE_PATH=/,
    'a per-process -c override may bind VoiceClaw node_repl without writing Codex config',
  );
  assert.match(
    codex,
    /mcp_servers\.node_repl\.env\.SKY_CUA_SERVICE_NATIVE_PIPE_PATH=/,
    'released Computer Use clients may read the service-name alias from node_repl',
  );
  assert.doesNotMatch(
    codex,
    /spawnProcess\(this\.codexPath,\s*\[\s*['"](?:config|update|install|uninstall)['"]/i,
  );

  for (const file of [dialogue, codex]) {
    assert.doesNotMatch(file, /writeFile(?:Sync)?\([^\n]*(?:OPENCLAW|HERMES|CODEX)/i);
    assert.doesNotMatch(file, /rm(?:Sync)?\([^\n]*(?:OPENCLAW|HERMES|CODEX)/i);
  }
});
