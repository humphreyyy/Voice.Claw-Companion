import { execFileSync } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

export const CHATGPT_BUNDLED_CODEX_PATH = '/Applications/ChatGPT.app/Contents/Resources/codex';
export const VERIFIED_GPT_LIVE_CODEX_MIN_VERSION = '0.146.0-alpha.3.1';

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

export function parseCodexVersion(value = '') {
  const match = String(value || '').match(/\b(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\b/);
  if (!match) return null;
  return {
    raw: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ''}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

export function compareCodexVersions(left, right) {
  const a = typeof left === 'string' ? parseCodexVersion(left) : left;
  const b = typeof right === 'string' ? parseCodexVersion(right) : right;
  if (!a || !b) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length ? -1 : 1;
  }
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined || bPart === undefined) return aPart === undefined ? -1 : 1;
    if (aPart === bPart) continue;
    const aNumeric = /^\d+$/.test(aPart);
    const bNumeric = /^\d+$/.test(bPart);
    if (aNumeric && bNumeric) return Number(aPart) > Number(bPart) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aPart > bPart ? 1 : -1;
  }
  return 0;
}

function isExecutable(candidate) {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function codexVersionAtPath(candidate) {
  try {
    const output = execFileSync(candidate, ['--version'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseCodexVersion(output)?.raw || null;
  } catch {
    return null;
  }
}

/**
 * Prefer the newer ChatGPT-bundled Codex only when it is at least the exact build
 * with which GPT Live V3 admission was verified. An explicit operator override
 * remains authoritative, and selecting a binary never claims backend admission.
 */
export function selectCodexAppServerExecutable({
  explicitPath = process.env.VOICECLAW_CODEX_BIN || '',
  pathCandidate = executablePath('codex'),
  bundledCandidate = process.env.VOICECLAW_CHATGPT_CODEX_BIN || CHATGPT_BUNDLED_CODEX_PATH,
  preferBundledRealtimeV3 = process.env.VOICECLAW_CODEX_PREFER_BUNDLED_V3 !== '0',
  executableCheck = isExecutable,
  versionReader = codexVersionAtPath,
} = {}) {
  const describe = (path, source, available = executableCheck(path)) => {
    const version = available ? versionReader(path) : null;
    return {
      path,
      source,
      version,
      available,
      verifiedV3Build: source === 'chatgpt-bundled'
        && !!version
        && compareCodexVersions(version, VERIFIED_GPT_LIVE_CODEX_MIN_VERSION) >= 0,
    };
  };

  if (String(explicitPath || '').trim()) {
    const selected = describe(String(explicitPath).trim(), 'explicit', true);
    return Object.freeze({ ...selected, reason: 'operator-override' });
  }

  const pathCodex = describe(pathCandidate, 'path');
  const bundledCodex = describe(bundledCandidate, 'chatgpt-bundled');
  const bundledIsEligible = preferBundledRealtimeV3
    && bundledCodex.verifiedV3Build
    && (!pathCodex.available
      || !pathCodex.version
      || compareCodexVersions(bundledCodex.version, pathCodex.version) > 0);

  if (bundledIsEligible) {
    return Object.freeze({
      ...bundledCodex,
      reason: pathCodex.available
        ? 'newer-verified-gpt-live-bundle'
        : 'verified-gpt-live-bundle',
    });
  }
  if (pathCodex.available) {
    return Object.freeze({ ...pathCodex, reason: 'path-default' });
  }
  if (bundledCodex.available) {
    return Object.freeze({ ...bundledCodex, reason: 'only-available-candidate' });
  }
  return Object.freeze({ ...pathCodex, reason: 'unresolved-path-default' });
}
