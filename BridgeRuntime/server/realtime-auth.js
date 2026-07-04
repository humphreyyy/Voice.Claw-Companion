import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const HOME = homedir();
const execFileAsync = promisify(execFile);
const BRIDGE_CONFIG_FILE = join(HOME, '.voiceclaw', 'bridge.json');
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw';
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || join(HOME, '.openclaw', 'openclaw.json');
const OPENCLAW_INSTALL_PATH = process.env.OPENCLAW_INSTALL_PATH || join(HOME, '.openclaw');
const OPENAI_CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_CHATGPT_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_REALTIME_CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const OPENAI_OAUTH_REFRESH_SKEW_MS = 2 * 60 * 1000;
const SQLITE3_BIN = process.env.SQLITE3_BIN || '/usr/bin/sqlite3';

export const REALTIME_AUTH_MODE_API_KEY = 'api-key';
export const REALTIME_AUTH_MODE_OPENCLAW_OAUTH = 'openclaw-oauth';

let providerAuthModulePromise = null;
const openAIOAuthRefreshes = new Map();

export function readBridgeConfig() {
  try {
    return JSON.parse(readFileSync(BRIDGE_CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function readOpenClawConfig() {
  try {
    return JSON.parse(readFileSync(OPENCLAW_CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

export function normalizeRealtimeAuthMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === REALTIME_AUTH_MODE_OPENCLAW_OAUTH || normalized === 'oauth' || normalized === 'openclaw') {
    return REALTIME_AUTH_MODE_OPENCLAW_OAUTH;
  }
  return REALTIME_AUTH_MODE_API_KEY;
}

export function parseRealtimeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function nonEmptyString(value = '') {
  return String(value || '').trim();
}

function normalizeOpenAIAuthExpiryMs(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function isUsableOpenAIOAuthProfile(profile) {
  const provider = nonEmptyString(profile?.provider).toLowerCase();
  return profile
    && profile.type === 'oauth'
    && ['openai', 'openai-codex'].includes(provider)
    && (nonEmptyString(profile.access) || nonEmptyString(profile.refresh));
}

async function listOpenClawAgentDirs(roots) {
  const dirs = new Set();
  const cfg = readOpenClawConfig();
  const configuredAgents = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
  for (const agent of configuredAgents) {
    const agentDir = nonEmptyString(agent?.agentDir);
    if (agentDir) dirs.add(agentDir);
  }

  for (const root of roots) {
    dirs.add(join(root, 'agent'));
    dirs.add(join(root, 'agents', 'main', 'agent'));

    const agentsRoot = join(root, 'agents');
    try {
      for (const entry of await readdir(agentsRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.add(join(agentsRoot, entry.name, 'agent'));
      }
    } catch {
      // Older OpenClaw installs may not have per-agent auth profile stores.
    }
  }

  return [...dirs];
}

function sqliteLiteral(value = '') {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function readSqliteJsonRows(sqlitePath, sql) {
  try {
    const { stdout } = await execFileAsync(SQLITE3_BIN, ['-json', sqlitePath, sql], {
      timeout: 5000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const trimmed = stdout.trim();
    return trimmed ? JSON.parse(trimmed) : [];
  } catch {
    return [];
  }
}

async function runSqliteScript(sqlitePath, script) {
  await new Promise((resolve, reject) => {
    const proc = spawn(SQLITE3_BIN, [sqlitePath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('sqlite3 update timed out'));
    }, 5000);
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`sqlite3 update failed with code ${code}: ${stderr.slice(0, 300)}`));
      }
    });
    proc.stdin.end(script);
  });
}

async function listOpenClawAuthSqliteStorePaths() {
  const roots = new Set([
    OPENCLAW_INSTALL_PATH,
    dirname(OPENCLAW_CONFIG),
    join(HOME, '.openclaw'),
  ].map(nonEmptyString).filter(Boolean));
  const paths = new Set();

  if (process.env.OPENCLAW_AUTH_SQLITE_STORES) {
    for (const item of process.env.OPENCLAW_AUTH_SQLITE_STORES.split(':')) {
      const path = nonEmptyString(item);
      if (path) paths.add(path);
    }
  }

  for (const root of roots) {
    paths.add(join(root, 'openclaw-agent.sqlite'));
  }
  for (const agentDir of await listOpenClawAgentDirs(roots)) {
    paths.add(join(agentDir, 'openclaw-agent.sqlite'));
  }

  return [...paths].filter((path) => existsSync(path));
}

async function listOpenClawAuthJsonStorePaths() {
  const roots = new Set([
    OPENCLAW_INSTALL_PATH,
    dirname(OPENCLAW_CONFIG),
    join(HOME, '.openclaw'),
  ].map(nonEmptyString).filter(Boolean));
  const paths = new Set();

  if (process.env.OPENCLAW_AUTH_PROFILES) {
    for (const item of process.env.OPENCLAW_AUTH_PROFILES.split(':')) {
      const path = nonEmptyString(item);
      if (path) paths.add(path);
    }
  }

  for (const root of roots) {
    paths.add(join(root, 'auth-profiles.json'));
  }
  for (const agentDir of await listOpenClawAgentDirs(roots)) {
    paths.add(join(agentDir, 'auth-profiles.json'));
  }

  return [...paths];
}

async function loadOpenAIChatGPTOAuthProfilesFromSqlite() {
  const profiles = [];
  for (const storePath of await listOpenClawAuthSqliteStorePaths()) {
    const rows = await readSqliteJsonRows(storePath, 'select rowid, store_json from auth_profile_store order by rowid;');
    for (const row of rows) {
      let store;
      try {
        store = JSON.parse(row.store_json || '{}');
      } catch {
        continue;
      }

      const entries = store?.profiles && typeof store.profiles === 'object' ? store.profiles : {};
      for (const [profileId, profile] of Object.entries(entries)) {
        if (!isUsableOpenAIOAuthProfile(profile)) continue;
        profiles.push({
          storeKind: 'sqlite',
          storePath,
          sqliteRowId: row.rowid,
          profileId,
          profile,
          expiresMs: normalizeOpenAIAuthExpiryMs(profile.expires),
        });
      }
    }
  }
  return profiles;
}

async function loadOpenAIChatGPTOAuthProfilesFromJson() {
  const profiles = [];
  for (const storePath of await listOpenClawAuthJsonStorePaths()) {
    let store;
    try {
      store = JSON.parse(await readFile(storePath, 'utf8'));
    } catch {
      continue;
    }

    const entries = store?.profiles && typeof store.profiles === 'object' ? store.profiles : {};
    for (const [profileId, profile] of Object.entries(entries)) {
      if (!isUsableOpenAIOAuthProfile(profile)) continue;
      profiles.push({
        storeKind: 'json',
        storePath,
        profileId,
        profile,
        expiresMs: normalizeOpenAIAuthExpiryMs(profile.expires),
      });
    }
  }
  return profiles;
}

async function loadOpenAIChatGPTOAuthProfiles() {
  const profiles = [
    ...await loadOpenAIChatGPTOAuthProfilesFromSqlite(),
    ...await loadOpenAIChatGPTOAuthProfilesFromJson(),
  ];

  profiles.sort((left, right) => {
    const leftPriority = left.storeKind === 'sqlite' ? 0 : 1;
    const rightPriority = right.storeKind === 'sqlite' ? 0 : 1;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return right.expiresMs - left.expiresMs;
  });
  return profiles;
}

async function persistRefreshedOpenAIChatGPTOAuthProfile(candidate, refreshed) {
  try {
    if (candidate.storeKind === 'sqlite') {
      const rows = await readSqliteJsonRows(
        candidate.storePath,
        `select rowid, store_json from auth_profile_store where rowid = ${Number(candidate.sqliteRowId) || 0};`
      );
      const row = rows[0];
      if (!row) return;
      const store = JSON.parse(row.store_json || '{}');
      const current = store?.profiles?.[candidate.profileId];
      if (!isUsableOpenAIOAuthProfile(current)) return;
      store.profiles[candidate.profileId] = {
        ...current,
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
        accountId: refreshed.accountId || current.accountId,
      };
      await runSqliteScript(candidate.storePath, [
        'begin immediate;',
        `update auth_profile_store set store_json = ${sqliteLiteral(JSON.stringify(store))} where rowid = ${Number(candidate.sqliteRowId) || 0};`,
        'commit;',
      ].join('\n'));
      return;
    }

    const store = JSON.parse(await readFile(candidate.storePath, 'utf8'));
    const current = store?.profiles?.[candidate.profileId];
    if (!isUsableOpenAIOAuthProfile(current)) return;
    store.profiles[candidate.profileId] = {
      ...current,
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
      accountId: refreshed.accountId || current.accountId,
    };
    await writeFile(candidate.storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    console.warn('[realtime-auth] failed to persist refreshed OpenAI OAuth profile:', error?.message || String(error));
  }
}

function chatGPTAccountIdFromAccessToken(accessToken = '') {
  const parts = String(accessToken || '').split('.');
  if (parts.length < 2) return '';
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const candidates = [
      payload['https://api.openai.com/auth']?.chatgpt_account_id,
      payload.chatgpt_account_id,
      payload.account_id,
      payload.organization_id,
      payload.sub,
    ];
    return candidates.map(nonEmptyString).find(Boolean) || '';
  } catch {
    return '';
  }
}

async function refreshOpenAIChatGPTOAuthProfile(candidate) {
  const refresh = nonEmptyString(candidate.profile.refresh);
  if (!refresh) throw new Error('OpenAI OAuth profile has no refresh token');

  const key = `${candidate.storeKind || 'json'}\0${candidate.storePath}\0${candidate.sqliteRowId || ''}\0${candidate.profileId}`;
  if (openAIOAuthRefreshes.has(key)) return await openAIOAuthRefreshes.get(key);

  const refreshPromise = (async () => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: OPENAI_CHATGPT_CLIENT_ID,
    });
    const response = await fetch(OPENAI_CHATGPT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI OAuth refresh failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    let json;
    try { json = JSON.parse(text); } catch { json = {}; }
    const access = nonEmptyString(json.access_token);
    const nextRefresh = nonEmptyString(json.refresh_token);
    const expiresIn = Number(json.expires_in || 0);
    if (!access || !nextRefresh || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error('OpenAI OAuth refresh response was missing access_token, refresh_token, or expires_in');
    }

    const refreshed = {
      access,
      refresh: nextRefresh,
      expires: Date.now() + Math.max(0, expiresIn * 1000 - OPENAI_OAUTH_REFRESH_SKEW_MS),
      accountId: chatGPTAccountIdFromAccessToken(access) || candidate.profile.accountId || '',
    };
    await persistRefreshedOpenAIChatGPTOAuthProfile(candidate, refreshed);
    return refreshed;
  })().finally(() => openAIOAuthRefreshes.delete(key));

  openAIOAuthRefreshes.set(key, refreshPromise);
  return await refreshPromise;
}

async function validateOpenClawOAuthToken(token, validateToken) {
  if (/^sk-/.test(token)) {
    throw new Error('OpenClaw returned an API-key auth profile, not a ChatGPT/Codex OAuth profile.');
  }
  if (validateToken) await validateToken(token);
}

async function resolveOpenClawOAuthBearerFromProfileStore(validateToken) {
  const profiles = await loadOpenAIChatGPTOAuthProfiles();
  const now = Date.now();
  const refreshErrors = [];

  for (const candidate of profiles) {
    const access = nonEmptyString(candidate.profile.access);
    if (access && candidate.expiresMs > now + OPENAI_OAUTH_REFRESH_SKEW_MS) {
      try {
        await validateOpenClawOAuthToken(access, validateToken);
        return access;
      } catch (error) {
        refreshErrors.push(`${candidate.profileId} (${candidate.storeKind || 'json'} access): ${error?.message || String(error)}`);
      }
    }

    if (!nonEmptyString(candidate.profile.refresh)) continue;
    try {
      const refreshed = await refreshOpenAIChatGPTOAuthProfile(candidate);
      await validateOpenClawOAuthToken(refreshed.access, validateToken);
      return refreshed.access;
    } catch (error) {
      refreshErrors.push(`${candidate.profileId} (${candidate.storeKind || 'json'} refresh): ${error?.message || String(error)}`);
    }
  }

  if (profiles.length && refreshErrors.length) {
    throw new Error(`OpenClaw OpenAI OAuth profiles were found, but refresh failed: ${refreshErrors.join('; ')}`);
  }
  return '';
}

export function realtimeAuthPreferences(req) {
  const bridgeConfig = readBridgeConfig();
  const requestedMode = req?.headers?.['x-voiceclaw-realtime-auth-mode']
    ?? req?.headers?.['x-voiceclaw-auth-mode'];
  const configuredMode = process.env.VOICECLAW_REALTIME_AUTH_MODE
    ?? bridgeConfig.realtimeAuthMode
    ?? REALTIME_AUTH_MODE_OPENCLAW_OAUTH;
  const requestedFallback = req?.headers?.['x-voiceclaw-realtime-auth-fallback']
    ?? req?.headers?.['x-voiceclaw-api-key-fallback'];
  const configuredFallback = process.env.VOICECLAW_REALTIME_AUTH_FALLBACK_TO_API_KEY
    ?? bridgeConfig.realtimeAuthFallbackToAPIKey;

  return {
    mode: normalizeRealtimeAuthMode(requestedMode ?? configuredMode),
    fallbackToAPIKey: parseRealtimeBoolean(requestedFallback, parseRealtimeBoolean(configuredFallback, false)),
    source: requestedMode === undefined ? 'companion-default' : 'paired-phone',
  };
}

function bearerFromPairedPhoneClientSecret(req) {
  const value = String(req?.headers?.['x-voiceclaw-realtime-client-secret'] || '').trim();
  if (!value) return '';
  return value;
}

function resolveOpenClawPackageRoot() {
  try {
    const binRealPath = realpathSync(OPENCLAW_BIN);
    const binDir = dirname(binRealPath);
    if (existsSync(join(binDir, 'dist', 'plugin-sdk', 'provider-auth.js'))) {
      return binDir;
    }
  } catch {}

  const candidates = [
    join(OPENCLAW_INSTALL_PATH, 'node_modules', 'openclaw'),
    OPENCLAW_INSTALL_PATH,
    '/opt/homebrew/lib/node_modules/openclaw',
    '/usr/local/lib/node_modules/openclaw',
  ];

  return candidates.find((candidate) => existsSync(join(candidate, 'dist', 'plugin-sdk', 'provider-auth.js'))) || '';
}

async function loadOpenClawProviderAuthModule() {
  if (providerAuthModulePromise) return providerAuthModulePromise;

  providerAuthModulePromise = (async () => {
    const packageRoot = resolveOpenClawPackageRoot();
    if (!packageRoot) {
      throw new Error('OpenClaw provider auth module was not found. Install or update OpenClaw 2026.5.12 or later.');
    }

    return import(pathToFileURL(join(packageRoot, 'dist', 'plugin-sdk', 'provider-auth.js')).href);
  })();

  return providerAuthModulePromise;
}

async function resolveOpenClawOAuthBearerFromProviderModule(validateToken) {
  const providerAuth = await loadOpenClawProviderAuthModule();
  const cfg = readOpenClawConfig();
  let lastError = null;

  for (const provider of ['openai-codex', 'openai']) {
    try {
      const token = await providerAuth.resolveProviderAuthProfileApiKey({ provider, cfg });
      if (token) {
        await validateOpenClawOAuthToken(token, validateToken);
        return token;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return '';
}

async function resolveOpenClawOAuthBearer(validateToken) {
  let profileStoreError = null;
  try {
    const token = await resolveOpenClawOAuthBearerFromProfileStore(validateToken);
    if (token) {
      return token;
    }
  } catch (error) {
    profileStoreError = error;
  }

  let token = '';
  try {
    token = await resolveOpenClawOAuthBearerFromProviderModule(validateToken);
  } catch (error) {
    const profileMessage = profileStoreError ? ` Direct auth-profile fallback also failed: ${profileStoreError.message || String(profileStoreError)}` : '';
    throw new Error(`${error?.message || String(error)}${profileMessage}`);
  }

  if (!token) {
    const profileMessage = profileStoreError ? ` Direct auth-profile fallback failed: ${profileStoreError.message || String(profileStoreError)}` : '';
    throw new Error(`No OpenClaw OpenAI OAuth profile is available. Run: openclaw models auth login --provider openai --set-default.${profileMessage}`);
  }

  return token;
}

export async function createRealtimeClientSecret({ authToken, session }) {
  const response = await fetch(OPENAI_REALTIME_CLIENT_SECRETS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ session }),
  });
  const body = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(body || '{}');
  } catch {}

  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || body || `HTTP ${response.status}`;
    throw new Error(`GPT-Realtime-2 client secret failed: ${detail}`);
  }

  const clientSecret = payload?.value || payload?.client_secret?.value;
  if (!clientSecret) {
    throw new Error('GPT-Realtime-2 client secret response did not include a value.');
  }

  return {
    value: clientSecret,
    expiresAt: typeof payload?.expires_at === 'number' ? payload.expires_at : undefined,
  };
}

export async function resolveRealtimeBearer({ req, session, apiKey }) {
  const preferences = realtimeAuthPreferences(req);

  if (preferences.mode === REALTIME_AUTH_MODE_API_KEY) {
    if (!apiKey) {
      throw new Error('OpenAI API key is not configured.');
    }
    return {
      bearer: apiKey,
      sidebandBearer: apiKey,
      source: REALTIME_AUTH_MODE_API_KEY,
      preferences,
    };
  }

  const pairedPhoneClientSecret = bearerFromPairedPhoneClientSecret(req);
  if (pairedPhoneClientSecret) {
    return {
      bearer: pairedPhoneClientSecret,
      // The Realtime sideband connection is part of the same session. Prefer a
      // server API key if configured, otherwise use the phone-minted short-lived
      // client secret for the Companion-owned sideband connection as well.
      sidebandBearer: apiKey || pairedPhoneClientSecret,
      source: 'paired-phone-oauth',
      preferences,
    };
  }

  try {
    let clientSecret = null;
    const oauthBearer = await resolveOpenClawOAuthBearer(async (authToken) => {
      clientSecret = await createRealtimeClientSecret({ authToken, session });
    });
    return {
      bearer: clientSecret.value,
      // OpenAI's sideband WebSocket examples use a server API key. OAuth can
      // mint the client secret used by the iPhone, but prefer the API key for
      // server-owned tool control when the user supplied one.
      sidebandBearer: apiKey || oauthBearer,
      source: REALTIME_AUTH_MODE_OPENCLAW_OAUTH,
      expiresAt: clientSecret.expiresAt,
      preferences,
    };
  } catch (error) {
    if (preferences.fallbackToAPIKey && apiKey) {
      return {
        bearer: apiKey,
        sidebandBearer: apiKey,
        source: 'api-key-fallback',
        oauthError: error?.message || String(error),
        preferences,
      };
    }

    const baseMessage = error?.message || String(error);
    const phoneHint = preferences.source === 'paired-phone'
      ? ' The paired phone selected OAuth but did not provide an iPhone-minted GPT-Realtime-2 client secret, so the Companion tried its local OpenClaw OAuth profile instead.'
      : '';
    throw new Error(`${baseMessage}${phoneHint}${preferences.fallbackToAPIKey ? ' API-key fallback is enabled, but no API key was available.' : ' API-key fallback is off.'}`);
  }
}

export async function buildRealtimeAuthStatus({ req, apiKey, probe = false, model = 'gpt-realtime-2', voice = 'marin' }) {
  const preferences = realtimeAuthPreferences(req);
  const status = {
    ok: true,
    mode: preferences.mode,
    effectiveSource: preferences.source,
    fallbackToAPIKey: preferences.fallbackToAPIKey,
    apiKeyAvailable: Boolean(apiKey),
    openClawOAuth: {
      checked: false,
      available: false,
    },
  };

  if (preferences.mode !== REALTIME_AUTH_MODE_OPENCLAW_OAUTH && !probe) {
    return status;
  }

  status.openClawOAuth.checked = true;
  try {
    await resolveOpenClawOAuthBearer(probe
      ? async (authToken) => {
        await createRealtimeClientSecret({
          authToken,
          session: {
            type: 'realtime',
            model,
            audio: {
              output: { voice },
            },
          },
        });
      }
      : undefined);
    status.openClawOAuth.available = true;

    if (probe) {
      status.openClawOAuth.clientSecretProbe = 'passed';
    }
  } catch (error) {
    status.openClawOAuth.available = false;
    status.openClawOAuth.error = error?.message || String(error);
    if (probe) status.openClawOAuth.clientSecretProbe = 'failed';
  }

  return status;
}
