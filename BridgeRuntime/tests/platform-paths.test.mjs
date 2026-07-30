import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveVoiceClawPaths,
} from '../server/platform-paths.js';

test('Linux uses XDG roots for all VoiceClaw bulk state', () => {
  const paths = resolveVoiceClawPaths({
    platform: 'linux',
    home: '/home/tester',
    env: {
      XDG_DATA_HOME: '/data',
      XDG_CACHE_HOME: '/cache',
    },
  });

  assert.equal(paths.appSupportDir, '/data/voiceclaw-companion');
  assert.equal(paths.realtimeAppSupportDir, '/data/voiceclaw-companion');
  assert.equal(paths.cacheDir, '/cache/voiceclaw-companion');
  assert.equal(paths.artifactInboxDir, '/data/voiceclaw-companion/Artifact Inbox');
  assert.equal(paths.inputAttachmentsDir, '/data/voiceclaw-companion/Input Attachments');
  assert.equal(paths.routeTasksStatePath, '/data/voiceclaw-companion/route-tasks.json');
  assert.equal(paths.voiceRemoteSessionsStatePath, '/data/voiceclaw-companion/voice-remote-sessions.json');
  assert.equal(paths.logsDir, '/data/voiceclaw-companion/logs');
  assert.equal(paths.modelsDir, '/data/voiceclaw-companion/Models');
});

test('Darwin retains both historical Application Support roots', () => {
  const paths = resolveVoiceClawPaths({
    platform: 'darwin',
    home: '/Users/tester',
    env: {},
  });

  assert.equal(
    paths.appSupportDir,
    '/Users/tester/Library/Application Support/VoiceClaw Companion',
  );
  assert.equal(
    paths.realtimeAppSupportDir,
    '/Users/tester/Library/Application Support/VoiceClaw Realtime Companion',
  );
  assert.equal(
    paths.artifactInboxDir,
    '/Users/tester/Library/Application Support/VoiceClaw Realtime Companion/Artifact Inbox',
  );
  assert.equal(
    paths.voiceRemoteSessionsStatePath,
    '/Users/tester/Library/Application Support/VoiceClaw Companion/voice-remote-sessions.json',
  );
});

test('explicit VoiceClaw roots override platform defaults', () => {
  const paths = resolveVoiceClawPaths({
    platform: 'linux',
    home: '/home/tester',
    env: {
      VOICECLAW_APP_SUPPORT_DIR: '/owned/data',
      VOICECLAW_CACHE_DIR: '/owned/cache',
      VOICECLAW_MODEL_DIR: '/owned/models',
    },
  });

  assert.equal(paths.appSupportDir, '/owned/data');
  assert.equal(paths.realtimeAppSupportDir, '/owned/data');
  assert.equal(paths.cacheDir, '/owned/cache');
  assert.equal(paths.modelsDir, '/owned/models');
});
