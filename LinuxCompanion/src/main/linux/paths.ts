import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LinuxOwnedPaths {
  configDir: string;
  configFile: string;
  systemdDir: string;
  unitFile: string;
  autostartDir: string;
  autostartFile: string;
  dataDir: string;
  cacheDir: string;
}

export interface LinuxPathOptions {
  home?: string;
  env?: Record<string, string | undefined>;
}

export function linuxPaths({
  home = homedir(),
  env = process.env,
}: LinuxPathOptions = {}): LinuxOwnedPaths {
  const xdgConfigHome = env.XDG_CONFIG_HOME || join(home, '.config');
  const xdgDataHome = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const xdgCacheHome = env.XDG_CACHE_HOME || join(home, '.cache');
  const configDir = join(home, '.voiceclaw');
  const systemdDir = join(xdgConfigHome, 'systemd', 'user');
  const autostartDir = join(xdgConfigHome, 'autostart');

  return {
    configDir,
    configFile: join(configDir, 'bridge.json'),
    systemdDir,
    unitFile: join(systemdDir, 'voiceclaw-companion-bridge.service'),
    autostartDir,
    autostartFile: join(autostartDir, 'voiceclaw-companion.desktop'),
    dataDir: join(xdgDataHome, 'voiceclaw-companion'),
    cacheDir: join(xdgCacheHome, 'voiceclaw-companion'),
  };
}
