import { join } from 'node:path';

export function preloadBundlePath(mainBundleDirectory: string): string {
  return join(mainBundleDirectory, '..', 'preload', 'index.cjs');
}
