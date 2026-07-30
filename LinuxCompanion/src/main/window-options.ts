import type { BrowserWindowConstructorOptions } from 'electron';

export function companionWindowOptions(
  preloadPath: string,
): BrowserWindowConstructorOptions {
  return {
    width: 1_120,
    height: 760,
    minWidth: 920,
    minHeight: 660,
    show: false,
    backgroundColor: '#08111f',
    title: 'VoiceClaw Companion',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
    },
  };
}

export function isElectronSmokeTest(argv: readonly string[]): boolean {
  return argv.includes('--smoke-test');
}
