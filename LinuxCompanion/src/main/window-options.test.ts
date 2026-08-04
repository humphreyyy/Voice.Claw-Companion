// @vitest-environment node

import { describe, expect, it } from 'vitest';

import electronViteConfig from '../../electron.vite.config';
import { preloadBundlePath } from './preload-path';
import {
  companionWindowOptions,
  developmentRendererURL,
  isElectronSmokeTest,
} from './window-options';

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

  it('uses an injected renderer URL only for a normal development launch', () => {
    const input = { environmentURL: 'http://127.0.0.1:5175' };
    expect(developmentRendererURL({
      ...input,
      isPackaged: false,
      isSmokeTest: false,
    })).toBe(input.environmentURL);
    expect(developmentRendererURL({
      ...input,
      isPackaged: false,
      isSmokeTest: true,
    })).toBeUndefined();
    expect(developmentRendererURL({
      ...input,
      isPackaged: true,
      isSmokeTest: false,
    })).toBeUndefined();
  });

  it('builds and loads a CommonJS preload that works inside the sandbox', () => {
    const config = electronViteConfig as {
      preload?: {
        build?: {
          rollupOptions?: {
            output?: { format?: string; entryFileNames?: string };
          };
        };
      };
    };
    expect(config.preload?.build?.rollupOptions?.output).toMatchObject({
      format: 'cjs',
      entryFileNames: '[name].cjs',
    });
    expect(preloadBundlePath('/app/out/main')).toBe('/app/out/preload/index.cjs');
  });
});
