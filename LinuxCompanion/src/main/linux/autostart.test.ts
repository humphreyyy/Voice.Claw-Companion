// @vitest-environment node

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AutostartStore } from './autostart';
import { linuxPaths, type LinuxOwnedPaths } from './paths';

describe('AutostartStore', () => {
  let root: string;
  let paths: LinuxOwnedPaths;
  let store: AutostartStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'voiceclaw-autostart-'));
    paths = linuxPaths({
      home: join(root, 'home'),
      env: { XDG_CONFIG_HOME: join(root, 'config') },
    });
    store = new AutostartStore(paths);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates the exact owned desktop entry with mode 0644', async () => {
    expect(await store.isEnabled()).toBe(false);
    expect(await store.setEnabled(
      true,
      '/opt/VoiceClaw Companion/voiceclaw-companion',
    )).toBe(true);
    expect(await fs.readFile(paths.autostartFile, 'utf8')).toBe(`[Desktop Entry]
Type=Application
Name=VoiceClaw Companion
Comment=Open VoiceClaw Companion at login
Exec="/opt/VoiceClaw Companion/voiceclaw-companion"
Terminal=false
Categories=Utility;
X-GNOME-Autostart-enabled=true
`);
    expect((await fs.stat(paths.autostartFile)).mode & 0o777).toBe(0o644);
    expect(await store.isEnabled()).toBe(true);
  });

  it('disables only the owned entry and preserves neighboring files', async () => {
    await store.setEnabled(true, '/opt/voiceclaw');
    await fs.writeFile(join(paths.autostartDir, 'keep.desktop'), 'keep');
    expect(await store.setEnabled(false, '/ignored')).toBe(false);
    await expect(fs.access(paths.autostartFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(join(paths.autostartDir, 'keep.desktop'), 'utf8')).toBe('keep');
    expect(await store.isEnabled()).toBe(false);
  });
});
