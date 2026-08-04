import { access, chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';

import type { LinuxOwnedPaths } from './paths';

const UNSAFE_EXECUTABLE = /[\u0000\r\n"]/u;

function renderDesktopEntry(executablePath: string): string {
  if (executablePath.length === 0 || UNSAFE_EXECUTABLE.test(executablePath)) {
    throw new Error('Autostart executable path contains unsupported characters.');
  }
  return `[Desktop Entry]
Type=Application
Name=VoiceClaw Companion
Comment=Open VoiceClaw Companion at login
Exec="${executablePath}"
Terminal=false
Categories=Utility;
X-GNOME-Autostart-enabled=true
`;
}

export class AutostartStore {
  public constructor(private readonly paths: LinuxOwnedPaths) {}

  public async isEnabled(): Promise<boolean> {
    return access(this.paths.autostartFile).then(() => true, () => false);
  }

  public async setEnabled(enabled: boolean, executablePath: string): Promise<boolean> {
    if (!enabled) {
      await unlink(this.paths.autostartFile).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
      return false;
    }

    const tempFile = `${this.paths.autostartFile}.tmp`;
    await mkdir(this.paths.autostartDir, { recursive: true, mode: 0o700 });
    await writeFile(tempFile, renderDesktopEntry(executablePath), { mode: 0o644 });
    await chmod(tempFile, 0o644);
    await rename(tempFile, this.paths.autostartFile);
    return true;
  }
}
