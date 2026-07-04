import { accessSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

const EXECUTABLE_SEARCH_PATHS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  '/opt/local/bin',
];

export function normalizeProcessPath() {
  const current = String(process.env.PATH || '')
    .split(':')
    .filter(Boolean);
  const merged = [...current];
  for (const entry of EXECUTABLE_SEARCH_PATHS) {
    if (!merged.includes(entry)) merged.push(entry);
  }
  process.env.PATH = merged.join(':');
  return process.env.PATH;
}

export function executablePath(name) {
  if (String(name || '').includes('/')) return name;
  normalizeProcessPath();
  for (const dir of process.env.PATH.split(':').filter(Boolean)) {
    try {
      const candidate = join(dir, name);
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return name;
}
