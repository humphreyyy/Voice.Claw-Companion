import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveVoiceClawPaths({
  platform = process.platform,
  home = homedir(),
  env = process.env,
} = {}) {
  const linuxDataRoot = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const linuxCacheRoot = env.XDG_CACHE_HOME || join(home, '.cache');
  const darwinAppSupport = join(
    home,
    'Library',
    'Application Support',
    'VoiceClaw Companion',
  );
  const darwinRealtimeAppSupport = join(
    home,
    'Library',
    'Application Support',
    'VoiceClaw Realtime Companion',
  );
  const appSupportDir = env.VOICECLAW_APP_SUPPORT_DIR
    || (platform === 'darwin'
      ? darwinAppSupport
      : join(linuxDataRoot, 'voiceclaw-companion'));
  const realtimeAppSupportDir = env.VOICECLAW_APP_SUPPORT_DIR
    || (platform === 'darwin'
      ? darwinRealtimeAppSupport
      : appSupportDir);
  const cacheDir = env.VOICECLAW_CACHE_DIR
    || (platform === 'darwin'
      ? darwinAppSupport
      : join(linuxCacheRoot, 'voiceclaw-companion'));
  const modelsDir = env.VOICECLAW_MODEL_DIR
    || join(realtimeAppSupportDir, 'Models');

  return Object.freeze({
    appSupportDir,
    realtimeAppSupportDir,
    cacheDir,
    artifactInboxDir: join(realtimeAppSupportDir, 'Artifact Inbox'),
    inputAttachmentsDir: join(realtimeAppSupportDir, 'Input Attachments'),
    routeTasksStatePath: join(realtimeAppSupportDir, 'route-tasks.json'),
    voiceRemoteSessionsStatePath: join(appSupportDir, 'voice-remote-sessions.json'),
    logsDir: join(appSupportDir, 'logs'),
    modelsDir,
    piperModelsDir: join(modelsDir, 'piper'),
  });
}

export const PLATFORM_PATHS = resolveVoiceClawPaths();
