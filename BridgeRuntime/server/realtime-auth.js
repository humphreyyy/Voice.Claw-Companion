import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import {
  accessTokenFromValidatedVoiceAccessTokenDelegation,
  validatedVoiceAccessTokenDelegationForPayload,
} from './voice-credential-boundary.js';
import {
  configuredOpenClawAgentDirectories,
  parseOpenClawConfig,
} from './openclaw-config.js';

const HOME = homedir();
const execFileAsync = promisify(execFile);
const BRIDGE_CONFIG_FILE = join(HOME, '.voiceclaw', 'bridge.json');
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || join(HOME, '.openclaw', 'openclaw.json');
const OPENCLAW_INSTALL_PATH = process.env.OPENCLAW_INSTALL_PATH || join(HOME, '.openclaw');
const OPENAI_CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_CHATGPT_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_REALTIME_CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const OPENAI_OAUTH_REFRESH_SKEW_MS = 2 * 60 * 1000;
const SQLITE3_BIN = process.env.SQLITE3_BIN || '/usr/bin/sqlite3';

export const REALTIME_AUTH_MODE_API_KEY = 'api-key';
export const REALTIME_AUTH_MODE_OPENCLAW_OAUTH = 'openclaw-oauth';

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
    return parseOpenClawConfig(readFileSync(OPENCLAW_CONFIG, 'utf8'));
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

export function selectRealtimeSidebandBearer({
  authMode,
  clientSecret = '',
  apiKey = '',
} = {}) {
  return normalizeRealtimeAuthMode(authMode) === REALTIME_AUTH_MODE_OPENCLAW_OAUTH
    ? nonEmptyString(clientSecret)
    : nonEmptyString(apiKey);
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
  for (const agentDir of configuredOpenClawAgentDirectories(cfg, { home: HOME })) dirs.add(agentDir);

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
    ...loadOpenAIChatGPTOAuthProfilesFromBridgeConfig(),
    ...await loadOpenAIChatGPTOAuthProfilesFromSqlite(),
    ...await loadOpenAIChatGPTOAuthProfilesFromJson(),
  ];

  profiles.sort((left, right) => {
    const priority = (candidate) => candidate.storeKind === 'bridge' ? 0 : candidate.storeKind === 'sqlite' ? 1 : 2;
    const leftPriority = priority(left);
    const rightPriority = priority(right);
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return right.expiresMs - left.expiresMs;
  });
  return profiles;
}

function loadOpenAIChatGPTOAuthProfilesFromBridgeConfig() {
  const cfg = readBridgeConfig();
  const access = nonEmptyString(cfg.ChatGPTOAuthAccessToken || cfg.openAIChatGPTOAuthAccessToken || cfg.openAIOAuthAccessToken);
  const refresh = nonEmptyString(cfg.ChatGPTOAuthRefreshToken || cfg.openAIChatGPTOAuthRefreshToken || cfg.openAIOAuthRefreshToken);
  if (!access && !refresh) return [];
  return [{
    storeKind: 'bridge',
    storePath: BRIDGE_CONFIG_FILE,
    profileId: 'voiceclaw-bridge-chatgpt-oauth',
    profile: {
      type: 'oauth',
      provider: 'openai',
      access,
      refresh,
      expires: cfg.ChatGPTOAuthExpiresAt || cfg.openAIChatGPTOAuthExpiresAt || cfg.openAIOAuthExpiresAt || 0,
      accountId: cfg.ChatGPTOAuthAccountID || cfg.openAIChatGPTOAuthAccountID || cfg.openAIOAuthAccountID || '',
    },
    expiresMs: normalizeOpenAIAuthExpiryMs(cfg.ChatGPTOAuthExpiresAt || cfg.openAIChatGPTOAuthExpiresAt || cfg.openAIOAuthExpiresAt),
  }];
}

async function persistRefreshedOpenAIChatGPTOAuthProfile(_candidate, refreshed) {
  try {
    // OpenClaw stores are import sources only. Refreshes belong to VoiceClaw's
    // private bridge config so this integration never rewrites another
    // runtime's auth database or JSON configuration.
    await persistOpenAIChatGPTOAuthBridgeConfig(refreshed);
  } catch (error) {
    console.warn('[realtime-auth] failed to persist refreshed OpenAI OAuth profile in VoiceClaw bridge config:', error?.message || String(error));
  }
}

async function persistOpenAIChatGPTOAuthBridgeConfig(token) {
  const access = nonEmptyString(token?.access);
  const refresh = nonEmptyString(token?.refresh);
  if (!access && !refresh) return;
  const current = readBridgeConfig();
  const next = {
    ...current,
    ChatGPTOAuthAccessToken: access || current.ChatGPTOAuthAccessToken || '',
    ChatGPTOAuthRefreshToken: refresh || current.ChatGPTOAuthRefreshToken || '',
    ChatGPTOAuthExpiresAt: token?.expires || current.ChatGPTOAuthExpiresAt || 0,
    ChatGPTOAuthAccountID: nonEmptyString(token?.accountId) || current.ChatGPTOAuthAccountID || '',
  };
  await mkdir(dirname(BRIDGE_CONFIG_FILE), { recursive: true });
  await writeFile(BRIDGE_CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
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
        await persistOpenAIChatGPTOAuthBridgeConfig({
          access,
          refresh: candidate.profile.refresh,
          expires: candidate.expiresMs,
          accountId: candidate.profile.accountId || chatGPTAccountIdFromAccessToken(access),
        });
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

async function resolveOpenClawOAuthBearer(
  validateToken,
  requestPayload = {},
  credentialDelegation = null,
) {
  const validatedDelegation = credentialDelegation
    || validatedVoiceAccessTokenDelegationForPayload(requestPayload);
  if (validatedDelegation) {
    const delegatedAccessToken = accessTokenFromValidatedVoiceAccessTokenDelegation(
      validatedDelegation,
    );
    await validateOpenClawOAuthToken(delegatedAccessToken, validateToken);
    return delegatedAccessToken;
  }

  try {
    const token = await resolveOpenClawOAuthBearerFromProfileStore(validateToken);
    if (token) return token;
  } catch (error) {
    throw new Error(`No usable OpenClaw OpenAI OAuth profile could be imported read-only: ${error?.message || String(error)}`);
  }
  throw new Error('No OpenClaw OpenAI OAuth profile is available for read-only import. Sign in with ChatGPT in VoiceClaw Realtime or configure OpenClaw OAuth, then pair again.');
}

export async function resolveOpenAIChatGPTOAuthBearer(validateToken, requestPayload = {}) {
  return await resolveOpenClawOAuthBearer(validateToken, requestPayload);
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

export async function resolveRealtimeBearer({ req, session, apiKey, credentialDelegation = null }) {
  const preferences = realtimeAuthPreferences(req);

  if (preferences.mode === REALTIME_AUTH_MODE_API_KEY) {
    if (!apiKey) {
      throw new Error('OpenAI API key is not configured.');
    }
    return {
      bearer: apiKey,
      sidebandBearer: selectRealtimeSidebandBearer({
        authMode: REALTIME_AUTH_MODE_API_KEY,
        apiKey,
      }),
      source: REALTIME_AUTH_MODE_API_KEY,
      preferences,
    };
  }

  try {
    let clientSecret = null;
    await resolveOpenClawOAuthBearer(async (authToken) => {
      clientSecret = await createRealtimeClientSecret({ authToken, session });
    }, {}, credentialDelegation);
    return {
      bearer: clientSecret.value,
      // Sideband control joins the exact call created with this scoped client
      // secret. The long-lived ChatGPT OAuth token can mint the secret, but it
      // cannot join the resulting call_id and is rejected as call_id_not_found.
      sidebandBearer: selectRealtimeSidebandBearer({
        authMode: REALTIME_AUTH_MODE_OPENCLAW_OAUTH,
        clientSecret: clientSecret.value,
        apiKey,
      }),
      source: credentialDelegation ? 'paired-phone-delegation' : REALTIME_AUTH_MODE_OPENCLAW_OAUTH,
      expiresAt: clientSecret.expiresAt,
      preferences,
    };
  } catch (error) {
    if (preferences.fallbackToAPIKey && apiKey) {
      return {
        bearer: apiKey,
        sidebandBearer: selectRealtimeSidebandBearer({
          authMode: REALTIME_AUTH_MODE_API_KEY,
          apiKey,
        }),
        source: 'api-key-fallback',
        oauthError: error?.message || String(error),
        preferences,
      };
    }

    const baseMessage = error?.message || String(error);
    const phoneHint = preferences.source === 'paired-phone'
      ? ' The paired phone selected OAuth but did not provide a valid access-token delegation, so the Companion tried its local OpenClaw OAuth profile instead.'
      : '';
    throw new Error(`${baseMessage}${phoneHint}${preferences.fallbackToAPIKey ? ' API-key fallback is enabled, but no API key was available.' : ' API-key fallback is off.'}`);
  }
}

export async function buildRealtimeAuthStatus({ req, apiKey, probe = false, model = 'gpt-realtime-2.1-mini', voice = 'marin' }) {
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
