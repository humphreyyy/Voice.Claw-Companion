// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { companionWindowOptions, isElectronSmokeTest } from './window-options';

describe('Electron window security', () => {
  it('uses a context-isolated renderer without Node integration', () => {
    const options = companionWindowOptions('/app/preload/index.js');
    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: '/app/preload/index.js',
    });
  });

  it('recognizes only the explicit Electron startup smoke flag', () => {
    expect(isElectronSmokeTest(['electron', '.', '--smoke-test'])).toBe(true);
    expect(isElectronSmokeTest(['electron', '.'])).toBe(false);
  });
});
